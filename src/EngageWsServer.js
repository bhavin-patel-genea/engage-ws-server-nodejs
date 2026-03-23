'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const EventEmitter = require('events');
const WebSocket = require('ws');
const express = require('express');
const { validate } = require('jsonschema');

const { EngageRequest, EngageResponse, EngageEvent, EngageEventSubscription } = require('./EngageWsProtocol');
const { createRoutes } = require('./routes');
const AsyncQueue = require('./AsyncQueue');

const VERSION = '1.1';
const MAX_MSG_ID = 1000000;
const VALID_PROTOCOLS = ['engage.v1.gateway.allegion.com'];
// NOTE (Best Practice — Schlage ENGAGE App Note v1.06, Page 16):
// For servers that support the engage.v1.edgedevice.allegion.com sub-protocol,
// the ping interval and missed-ping threshold must be tuned carefully.
// A reader-controller can take up to 60s to process a 1000-user database,
// during which time it will not respond to pings.
//
// Recommended safe values for edge device support:
//   PING_INTERVAL_MS = 20000   (20 seconds)
//   MAX_MISSED_PINGS = 3       → 60 seconds before forced disconnect
//
// Current values (5s × 3 = 15s) are suitable for gateway-only deployments
// (engage.v1.gateway.allegion.com) but will prematurely disconnect
// reader-controllers during large database operations.
// Increase PING_INTERVAL_MS to 20000 if edge device support is required.
const PING_INTERVAL_MS = 5000;
const MAX_MISSED_PINGS = 3;


/**
 * EngageWsServer
 *
 * Node.js port of the Python EngageWsServer + EngageWsServerProtocol classes.
 * Combines an Express HTTP server and a ws WebSocket server on the same port.
 *
 * Usage:
 *   const server = new EngageWsServer({ onConnectionMade, onConnectionLost });
 *   server.startServer();   // blocks (keeps event loop alive)
 */
class EngageWsServer extends EventEmitter {
  /**
   * @param {object}   options
   * @param {function} [options.onConnectionMade]       Called with (sn) when a gateway connects
   * @param {function} [options.onConnectionLost]       Called with (sn) when a gateway disconnects
   * @param {string}   [options.serverConfigSchemaFile]
   * @param {string}   [options.serverConfigFile]
   * @param {string}   [options.eventSchemaFile]
   * @param {string}   [options.responseSchemaFile]
   * @param {string}   [options.logFile]
   */
  constructor(options = {}) {
    super();

    const {
      onConnectionMade = () => {},
      onConnectionLost = () => {},
      serverConfigSchemaFile = './schema/server_config_schema.json',
      serverConfigFile = './config/config.json',
      eventSchemaFile = './schema/engage.v1.gateway.allegion.com_event_schema.json',
      responseSchemaFile = './schema/engage.v1.gateway.allegion.com_response_schema.json',
    } = options;

    this.onConnectionMade = onConnectionMade;
    this.onConnectionLost = onConnectionLost;

    // State
    this.siteKeyFile = '';
    this.port = 8080;
    this.sslEnabled = false;
    this.requestId = 1;
    this.subscriptionId = 1;

    /**
     * validConnections: Map<sn:string, {
     *   password: string,
     *   connection: WebSocket|null,
     *   connectionName: string,
     *   responseQueue: AsyncQueue|null,
     *   eventQueue: AsyncQueue|null,
     * }>
     */
    this.validConnections = new Map();

    // Expose singleton for routes (mirrors Python's EngageWsServer.g_server)
    EngageWsServer.gServer = this;

    // --- Load & validate server config ---
    let configSchema;
    try {
      configSchema = JSON.parse(fs.readFileSync(serverConfigSchemaFile, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to load server config schema: ${e.message}`);
    }

    let config;
    try {
      config = JSON.parse(fs.readFileSync(serverConfigFile, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to load server config: ${e.message}`);
    }

    const result = validate(config, configSchema);
    if (!result.valid) {
      throw new Error(`Config JSON is malformed: ${result.errors.map(e => e.message).join('; ')}`);
    }

    // Apply config values
    if (config.server_port) this.port = config.server_port;
    this.siteKeyFile = config.site_key_file;

    if (config.ssl_info.ssl_enabled) {
      this.sslEnabled = true;
      this.sslKey = config.ssl_info.ssl_key;
      this.sslCert = config.ssl_info.ssl_cert;
    }

    this.gatewayEventsEnabled = config.event_subscription_info.gateway_events;
    this.edgeDeviceEventsEnabled = config.event_subscription_info.edgedevice_events;

    // --- Load message validation schemas ---
    try {
      this.responseSchema = JSON.parse(fs.readFileSync(responseSchemaFile, 'utf8'));
      this.eventSchema = JSON.parse(fs.readFileSync(eventSchemaFile, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to load message schemas: ${e.message}`);
    }

    // --- Set up Express app ---
    this.app = express();
    createRoutes(this.app, this);

    // --- Create HTTP/HTTPS server ---
    if (this.sslEnabled) {
      const sslOptions = {
        key: fs.readFileSync(this.sslKey),
        cert: fs.readFileSync(this.sslCert),
      };
      this.httpServer = https.createServer(sslOptions, this.app);
    } else {
      this.httpServer = http.createServer(this.app);
    }

    // --- Create WebSocket server (noServer = we control the upgrade) ---
    this.wss = new WebSocket.Server({ noServer: true });

    // Route upgrade requests to the WebSocket path only
    this.httpServer.on('upgrade', (request, socket, head) => {
      const urlPath = request.url.split('?')[0];
      if (urlPath !== '/engage_wss') {
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      this._handleUpgrade(request, socket, head);
    });

    // Wire up accepted WebSocket connections
    this.wss.on('connection', (ws, request) => {
      this._setupConnection(ws);
    });
  }

  // ─── Internal WebSocket Lifecycle ───────────────────────────────────────────

  /**
   * Authenticate and upgrade an HTTP upgrade request to a WebSocket connection.
   * Mirrors EngageWsServerProtocol.onConnect() in the Python code.
   */
  _handleUpgrade(request, socket, head) {
    const authHeader = request.headers['authorization'];
    if (!authHeader) {
      console.log('Client did not provide basic auth credentials!');
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const basicPrefix = 'Basic ';
    const base64Creds = authHeader.startsWith(basicPrefix)
      ? authHeader.slice(basicPrefix.length)
      : null;

    if (!base64Creds) {
      console.log('The authorization was not in the correct format!');
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    let sn, password;
    try {
      const credStr = Buffer.from(base64Creds, 'base64').toString('utf8');
      const colonIdx = credStr.indexOf(':');
      if (colonIdx < 0) throw new Error('missing colon separator');
      sn = credStr.substring(0, colonIdx);
      password = credStr.substring(colonIdx + 1);
    } catch (e) {
      console.log('The authorization was not in the correct format!');
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const connectionName = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`Client connecting: ${connectionName}`);

    if (!this.credentialsAreValid(connectionName, sn, password)) {
      console.log('The credentials are not valid!');
      socket.write('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    // Validate WebSocket sub-protocol
    const protocolHeader = request.headers['sec-websocket-protocol'] || '';
    const protocols = protocolHeader.split(',').map(p => p.trim()).filter(Boolean);
    const selectedProtocol = protocols.find(p => VALID_PROTOCOLS.includes(p));

    if (!selectedProtocol) {
      console.log('Client did not advertise the correct protocol');
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`Credentials valid - upgrading ${connectionName} with protocol ${selectedProtocol}`);

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      ws.connectionName = connectionName;
      ws.engageProtocol = selectedProtocol;
      this.wss.emit('connection', ws, request);
    });
  }

  /**
   * Wire up message/close/error handlers and start heartbeat for a new connection.
   * Mirrors EngageWsServerProtocol.onOpen() in the Python code.
   */
  _setupConnection(ws) {
    console.log(`WebSocket connection open: ${ws.connectionName}`);

    ws.pingsSent = 0;
    ws.pongsReceived = 0;
    ws.isOpen = true;

    ws.on('pong', () => {
      ws.pongsReceived++;
    });

    // Heartbeat: send a ping every 5 seconds; drop after 3 missed pongs
    const pingTimer = setInterval(() => {
      if (!ws.isOpen) {
        clearInterval(pingTimer);
        return;
      }
      if (ws.pingsSent - ws.pongsReceived > MAX_MISSED_PINGS) {
        console.log(`Too many pings missed, closing connection to ${ws.connectionName}`);
        clearInterval(pingTimer);
        ws.close(1000, 'Too many missed pings');
        return;
      }
      ws.ping();
      ws.pingsSent++;
    }, PING_INTERVAL_MS);

    ws.on('message', (data, isBinary) => {
      this._onMessage(ws, data, isBinary);
    });

    ws.on('close', (code, reason) => {
      ws.isOpen = false;
      clearInterval(pingTimer);
      const reasonStr = reason ? reason.toString() : '';
      console.log(`WebSocket connection closed: ${reasonStr}`);
      this._connectionLost(ws.connectionName);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error on ${ws.connectionName}: ${err.message}`);
    });

    // Notify server-level logic and send initial event subscription
    this._connectionMade(ws.connectionName, ws);
  }

  /**
   * Handle an incoming WebSocket message.
   * Mirrors EngageWsServerProtocol.onMessage() in the Python code.
   */
  _onMessage(ws, data, isBinary) {
    if (isBinary) {
      console.log(`Binary message received: ${data.length} bytes`);
      return;
    }

    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    console.log(`Text message received: ${text}`);

    let msgJson;
    try {
      msgJson = JSON.parse(text);
    } catch (e) {
      console.log(`Non-JSON message received: ${text}`);
      return;
    }

    // Try response schema first, then event schema
    const responseResult = validate(msgJson, this.responseSchema);
    if (responseResult.valid) {
      const responseObj = new EngageResponse(
        msgJson.requestId,
        msgJson.response.status,
        msgJson.response.messageBody
      );
      console.log(`Valid Protocol Response from ${ws.connectionName} received! ${responseObj.logString()}`);
      this._handleResponse(ws.connectionName, responseObj);
      return;
    }

    const eventResult = validate(msgJson, this.eventSchema);
    if (eventResult.valid) {
      const eventObj = new EngageEvent(
        msgJson.eventId,
        msgJson.event.eventType,
        msgJson.event.source,
        msgJson.event.deviceId,
        msgJson.event.eventBody
      );
      console.log(`Valid Protocol Event from ${ws.connectionName} received! ${eventObj.logString()}`);
      this._handleEvent(ws.connectionName, eventObj);
      return;
    }

    console.log(
      `Received JSON did not pass response or event schema validation. ` +
      `Response errors: ${responseResult.errors.map(e => e.message).join(', ')}; ` +
      `Event errors: ${eventResult.errors.map(e => e.message).join(', ')}`
    );
  }

  // ─── Protocol-level Handlers (called by protocol logic) ─────────────────────

  _handleResponse(connectionName, responseObj) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        conn.responseQueue.put(responseObj);
        return;
      }
    }
  }

  _handleEvent(connectionName, eventObj) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        conn.eventQueue.put(eventObj);
        return;
      }
    }
  }

  _connectionMade(connectionName, ws) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        conn.connection = ws;
        conn.responseQueue = new AsyncQueue();
        conn.eventQueue = new AsyncQueue();

        // Automatically send event subscription message
        const sub = new EngageEventSubscription(
          this._getNewSubscriptionId(),
          this.gatewayEventsEnabled,
          this.edgeDeviceEventsEnabled
        );
        console.log('Sending subscription message');
        this._sendWsMessage(ws, sub);

        this.onConnectionMade(sn);
        return;
      }
    }
  }

  _connectionLost(connectionName) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        // FIXME: Ideally keep credentials and just remove the active connection,
        // so gateways can reconnect without going through credential establishment again.
        this.validConnections.delete(sn);
        this.onConnectionLost(sn);
        return;
      }
    }
    console.log('Connections list - could not find object to remove...');
  }

  /**
   * Send an EngageRequest or EngageEventSubscription (or raw string) over a WebSocket.
   */
  _sendWsMessage(ws, msg) {
    let payload;
    if (msg instanceof EngageRequest || msg instanceof EngageEventSubscription) {
      payload = msg.createPayload();
      console.log(`Sending engage message: ${payload}`);
    } else {
      payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
    }
    ws.send(payload);
  }

  // ─── Credential Management ───────────────────────────────────────────────────

  /**
   * Register a new gateway credential after the newCredentials HTTP handshake.
   * @param {string} sn        Serial number (uppercase)
   * @param {string} password  Base64-encoded random password
   */
  credentialsEstablished(sn, password) {
    this.validConnections.set(sn, {
      password,
      connection: null,
      connectionName: '',
      responseQueue: null,
      eventQueue: null,
    });
  }

  /**
   * Validate Basic Auth credentials from a WebSocket upgrade request.
   * Side-effect: stores the connectionName on the matching entry.
   *
   * @param {string} connectionName  e.g. "::1:54321"
   * @param {string} sn
   * @param {string} password
   * @returns {boolean}
   */
  credentialsAreValid(connectionName, sn, password) {
    const conn = this.validConnections.get(sn);
    if (conn && conn.password === password) {
      conn.connectionName = connectionName;
      return true;
    }
    return false;
  }

  // ─── ID Generators ───────────────────────────────────────────────────────────

  _getNewRequestId() {
    const id = this.requestId++;
    if (this.requestId >= MAX_MSG_ID) this.requestId = 0;
    return id;
  }

  _getNewSubscriptionId() {
    const id = this.subscriptionId++;
    if (this.subscriptionId >= MAX_MSG_ID) this.subscriptionId = 0;
    return id;
  }

  // ─── Public User API ─────────────────────────────────────────────────────────

  /**
   * Start the server. This call does not block in Node.js — the event loop keeps
   * the process alive. Call this last after setting up any application logic.
   *
   * @param {string} [logFile]  Currently unused (console.log is used instead)
   */
  startServer(logFile = './logs/EngageWSServer.log') {
    this.httpServer.listen(this.port, () => {
      const proto = this.sslEnabled ? 'wss' : 'ws';
      console.log(`Starting Engage WS Server version ${VERSION}`);
      console.log(`Listening on port ${this.port} (${proto}://host:${this.port}/engage_wss)`);
    });
  }

  /** Return the internal validConnections map (e.g. for HTTP endpoints). */
  getConnections() {
    return this.validConnections;
  }

  /**
   * Send a message to a connected gateway.
   * @param {string} connectionIndex  Serial number (the map key)
   * @param {EngageRequest|EngageEventSubscription|string} engageObj
   * @returns {0|-1}
   */
  sendMsg(connectionIndex, engageObj) {
    const conn = this.validConnections.get(connectionIndex);
    if (!conn || !conn.connection) {
      console.log(`Connection at index ${connectionIndex} does not exist!`);
      return -1;
    }
    this._sendWsMessage(conn.connection, engageObj);
    return 0;
  }

  /**
   * Get the number of pending responses for a connection.
   * @param {string} connectionIndex
   * @returns {number|null}
   */
  getResponseQueueSize(connectionIndex) {
    const conn = this.validConnections.get(connectionIndex);
    return conn && conn.responseQueue ? conn.responseQueue.size() : null;
  }

  /**
   * Retrieve a response from the queue.
   * @param {string}  connectionIndex
   * @param {boolean} [block=false]    If true, returns a Promise
   * @param {number}  [timeout=0]      Seconds to wait (0 = indefinite)
   * @returns {EngageResponse|null|Promise<EngageResponse|null>}
   */
  getResponseQueueItem(connectionIndex, block = false, timeout = 0) {
    const conn = this.validConnections.get(connectionIndex);
    if (!conn || !conn.responseQueue) return null;
    return conn.responseQueue.get(block, timeout);
  }

  /**
   * Get the number of pending events for a connection.
   * @param {string} connectionIndex
   * @returns {number|null}
   */
  getEventQueueSize(connectionIndex) {
    const conn = this.validConnections.get(connectionIndex);
    return conn && conn.eventQueue ? conn.eventQueue.size() : null;
  }

  /**
   * Retrieve an event from the queue.
   * @param {string}  connectionIndex
   * @param {boolean} [block=false]
   * @param {number}  [timeout=0]
   * @returns {EngageEvent|null|Promise<EngageEvent|null>}
   */
  getEventQueueItem(connectionIndex, block = false, timeout = 0) {
    const conn = this.validConnections.get(connectionIndex);
    if (!conn || !conn.eventQueue) return null;
    return conn.eventQueue.get(block, timeout);
  }

  /** Expose the ID generator for user applications that build requests. */
  getNewRequestId() {
    return this._getNewRequestId();
  }
}

// Singleton reference (mirrors Python's EngageWsServer.g_server class attribute)
EngageWsServer.gServer = null;

module.exports = EngageWsServer;
