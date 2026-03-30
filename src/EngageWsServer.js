'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const EventEmitter = require('events');
const WebSocket = require('ws');
const express = require('express');
const { validate } = require('jsonschema');

const crypto = require('crypto');
const { EngageRequest, EngageResponse, EngageEvent, EngageEventSubscription } = require('./EngageWsProtocol');
const { createRoutes, createCaRoutes } = require('./routes');
const AsyncQueue = require('./AsyncQueue');

const VERSION = '1.2';
const MAX_MSG_ID = 1_000_000;

// Both ENGAGE sub-protocols are supported (App Note v1.06, p.16).
// For edge-device deployments, increase PING_INTERVAL_MS to 20 000 ms —
// reader-controllers can take up to 60 s for large database operations.
const VALID_PROTOCOLS = [
  'engage.v1.gateway.allegion.com',
  'engage.v1.edgedevice.allegion.com',
];

const PING_INTERVAL_MS = 5_000;
const MAX_MISSED_PINGS = 3;


/**
 * EngageWsServer
 *
 * Combines an Express HTTP server and a ws WebSocket server on the same port.
 * Handles the full ENGAGE gateway lifecycle: credential establishment → WebSocket
 * upgrade → event subscription → message routing → heartbeat → graceful shutdown.
 *
 * Extends EventEmitter and emits:
 *   'gateway:connected'    (sn)
 *   'gateway:disconnected' (sn)
 *   'engage:event'         ({ sn, event: EngageEvent })
 *
 * @param {object}   options
 * @param {function} [options.onConnectionMade]        Called with (sn) when a gateway connects
 * @param {function} [options.onConnectionLost]        Called with (sn) when a gateway disconnects
 * @param {string}   [options.serverConfigSchemaFile]
 * @param {string}   [options.serverConfigFile]
 * @param {string}   [options.eventSchemaFile]
 * @param {string}   [options.responseSchemaFile]
 */
class EngageWsServer extends EventEmitter {
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

    this.siteKeyFile = '';
    this.rootCaFile = './config/rootca.der';
    this.port = 8080;
    this.caServerPort = 8080;
    this.sslEnabled = false;
    this.subscriptionId = 1;

    /**
     * validConnections: Map<sn, {
     *   password:         string,
     *   connection:       WebSocket|null,
     *   connectionName:   string,
     *   pendingRequests:  Map<requestId, { resolve: Function, timer: NodeJS.Timeout|null }>,
     *   eventQueue:       AsyncQueue|null,
     * }>
     */
    this.validConnections = new Map();

    EngageWsServer.gServer = this;

    // Load and validate server config
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

    if (config.server_port) this.port = config.server_port;
    this.siteKeyFile = config.site_key_file;
    if (config.root_ca_file) this.rootCaFile = config.root_ca_file;
    this.publicHostname = config.public_hostname || null;

    if (config.ssl_info.ssl_enabled) {
      this.sslEnabled = true;
      this.sslKey = config.ssl_info.ssl_key;
      this.sslCert = config.ssl_info.ssl_cert;
      this.sslCa = config.ssl_info.ssl_ca || null;
      this.caServerPort = config.ca_server_port || 8080;
    } else {
      // Plain HTTP: CA routes share the main port
      this.caServerPort = config.server_port || 8080;
    }

    this.gatewayEventsEnabled = config.event_subscription_info.gateway_events;
    this.edgeDeviceEventsEnabled = config.event_subscription_info.edgedevice_events;

    // Load message validation schemas
    try {
      this.responseSchema = JSON.parse(fs.readFileSync(responseSchemaFile, 'utf8'));
      this.eventSchema = JSON.parse(fs.readFileSync(eventSchemaFile, 'utf8'));
    } catch (e) {
      throw new Error(`Failed to load message schemas: ${e.message}`);
    }

    // Express app with ENGAGE HTTP routes
    this.app = express();
    createRoutes(this.app, this);

    // HTTP/HTTPS server
    if (this.sslEnabled) {
      const sslOptions = {
        key: fs.readFileSync(this.sslKey),
        cert: fs.readFileSync(this.sslCert),
      };
      if (this.sslCa) {
        sslOptions.ca = fs.readFileSync(this.sslCa);
      }
      this.httpServer = https.createServer(sslOptions, this.app);
    } else {
      this.httpServer = http.createServer(this.app);
    }

    // TCP Keep-Alive: detect dead connections at the OS level (App Note v1.06)
    this.httpServer.on('connection', (socket) => {
      socket.setKeepAlive(true, 30_000);
    });

    // CA certificate server (Stage 1 of the gateway connection flow)
    //
    // When ssl_enabled is TRUE: the gateway cannot use HTTPS to download the
    // root CA it needs to trust HTTPS — a plain HTTP server on a separate port
    // is required. We spin it up here in the same process so a single
    // `npm run demo` starts everything.
    //
    // When ssl_enabled is FALSE: CA routes are served on the main app (same
    // port, same server) since there is no TLS bootstrap problem.
    if (this.sslEnabled) {
      const caApp = express();
      createCaRoutes(caApp, this);
      this.caHttpServer = http.createServer(caApp);
    } else {
      createCaRoutes(this.app, this);
      this.caHttpServer = null;
    }

    // WebSocket server — upgrade requests are handled manually
    this.wss = new WebSocket.Server({ noServer: true });

    this.httpServer.on('upgrade', (request, socket, head) => {
      const urlPath = request.url.split('?')[0];
      if (urlPath !== '/engage_wss') {
        socket.write('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n');
        socket.destroy();
        return;
      }
      this._handleUpgrade(request, socket, head);
    });

    this.wss.on('connection', (ws) => {
      this._setupConnection(ws);
    });
  }

  // ─── WebSocket Lifecycle ─────────────────────────────────────────────────────

  /**
   * Authenticate and upgrade an HTTP upgrade request to a WebSocket connection.
   *
   * Returns HTTP 401 on auth failures so the gateway firmware triggers a
   * re-auth cycle (a 403 causes some versions to stop retrying).
   */
  _handleUpgrade(request, socket, head) {
    const authHeader = request.headers['authorization'];
    if (!authHeader) {
      console.log('WebSocket upgrade rejected: missing Authorization header');
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const basicPrefix = 'Basic ';
    const base64Creds = authHeader.startsWith(basicPrefix)
      ? authHeader.slice(basicPrefix.length)
      : null;

    if (!base64Creds) {
      console.log('WebSocket upgrade rejected: Authorization header is not Basic');
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
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
    } catch {
      console.log('WebSocket upgrade rejected: malformed Authorization header');
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const connectionName = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`Gateway connecting: ${connectionName} (SN: ${sn})`);

    if (!this.credentialsAreValid(connectionName, sn, password)) {
      console.log(`WebSocket upgrade rejected: invalid credentials for SN ${sn}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    // Duplicate connection guard: if the same gateway reconnects before the
    // ping-timeout expires, close the stale socket and accept the new one.
    const existing = this.validConnections.get(sn.toUpperCase());
    if (existing?.connection?.readyState === WebSocket.OPEN) {
      console.log(`Duplicate connection for SN ${sn.toUpperCase()} — closing stale socket`);
      existing.connection.close(1000, 'Replaced by new connection from same gateway');
    }

    // Validate sub-protocol (400 = negotiation failure, not auth failure)
    const protocolHeader = request.headers['sec-websocket-protocol'] || '';
    const protocols = protocolHeader.split(',').map(p => p.trim()).filter(Boolean);
    const selectedProtocol = protocols.find(p => VALID_PROTOCOLS.includes(p));

    if (!selectedProtocol) {
      console.log(`WebSocket upgrade rejected: unsupported sub-protocol "${protocolHeader}"`);
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    console.log(`Upgrading ${connectionName} → protocol: ${selectedProtocol}`);

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      ws.connectionName = connectionName;
      ws.engageProtocol = selectedProtocol;
      this.wss.emit('connection', ws, request);
    });
  }

  /**
   * Wire up message/close/error handlers and start the heartbeat for a new connection.
   */
  _setupConnection(ws) {
    console.log(`WebSocket open: ${ws.connectionName}`);

    ws.pingsSent = 0;
    ws.pongsReceived = 0;
    ws.isOpen = true;

    ws.on('pong', () => { ws.pongsReceived++; });

    const pingTimer = setInterval(() => {
      if (!ws.isOpen) {
        clearInterval(pingTimer);
        return;
      }
      if (ws.pingsSent - ws.pongsReceived > MAX_MISSED_PINGS) {
        console.log(`Too many missed pings — closing ${ws.connectionName}`);
        clearInterval(pingTimer);
        ws.close(1000, 'Too many missed pings');
        return;
      }
      ws.ping();
      ws.pingsSent++;
    }, PING_INTERVAL_MS);

    ws.on('message', (data, isBinary) => { this._onMessage(ws, data, isBinary); });

    ws.on('close', (code, reason) => {
      ws.isOpen = false;
      clearInterval(pingTimer);
      console.log(`WebSocket closed: ${ws.connectionName} (${reason?.toString() || code})`);
      this._connectionLost(ws.connectionName);
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error on ${ws.connectionName}: ${err.message}`);
    });

    this._connectionMade(ws.connectionName, ws);
  }

  /**
   * Parse and route an incoming WebSocket message to either the response or event queue.
   */
  _onMessage(ws, data, isBinary) {
    if (isBinary) {
      console.log(`Binary message ignored (${data.length} bytes) from ${ws.connectionName}`);
      return;
    }

    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    console.log(`Message from ${ws.connectionName}: ${text}`);

    let msgJson;
    try {
      msgJson = JSON.parse(text);
    } catch {
      console.log(`Non-JSON message discarded from ${ws.connectionName}`);
      return;
    }

    const responseResult = validate(msgJson, this.responseSchema);
    if (responseResult.valid) {
      const responseObj = new EngageResponse(
        msgJson.requestId,
        msgJson.response.status,
        msgJson.response.messageBody
      );
      console.log(`Response from ${ws.connectionName}: ${responseObj.logString()}`);
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
      console.log(`Event from ${ws.connectionName}: ${eventObj.logString()}`);
      this._handleEvent(ws.connectionName, eventObj);
      return;
    }

    console.log(
      `Message from ${ws.connectionName} failed schema validation — ` +
      `response errors: ${responseResult.errors.map(e => e.message).join(', ')}; ` +
      `event errors: ${eventResult.errors.map(e => e.message).join(', ')}`
    );
  }

  // ─── Internal Handlers ───────────────────────────────────────────────────────

  _handleResponse(connectionName, responseObj) {
    for (const [, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        const pending = conn.pendingRequests.get(responseObj.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          conn.pendingRequests.delete(responseObj.requestId);
          pending.resolve(responseObj);
        } else {
          console.log(`Response for unknown requestId ${responseObj.requestId} — discarded`);
        }
        return;
      }
    }
  }

  _handleEvent(connectionName, eventObj) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        conn.eventQueue.put(eventObj);
        this.emit('engage:event', { sn, event: eventObj });
        return;
      }
    }
  }

  _connectionMade(connectionName, ws) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        conn.connection = ws;
        conn.pendingRequests = new Map();
        conn.eventQueue = new AsyncQueue();

        const sub = new EngageEventSubscription(
          this._getNewSubscriptionId(),
          this.gatewayEventsEnabled,
          this.edgeDeviceEventsEnabled
        );
        console.log(`Sending event subscription to ${connectionName}`);
        this._sendWsMessage(ws, sub);

        this.onConnectionMade(sn);
        this.emit('gateway:connected', sn);
        return;
      }
    }
  }

  _connectionLost(connectionName) {
    for (const [sn, conn] of this.validConnections) {
      if (conn.connectionName === connectionName) {
        // Resolve all in-flight requests with null so callers don't hang
        if (conn.pendingRequests) {
          for (const { resolve, timer } of conn.pendingRequests.values()) {
            clearTimeout(timer);
            resolve(null);
          }
          conn.pendingRequests.clear();
        }
        this.validConnections.delete(sn);
        this.onConnectionLost(sn);
        this.emit('gateway:disconnected', sn);
        return;
      }
    }
    console.log(`Connection lost but not found in registry: ${connectionName}`);
  }

  _sendWsMessage(ws, msg) {
    let payload;
    if (msg instanceof EngageRequest || msg instanceof EngageEventSubscription) {
      payload = msg.createPayload();
      console.log(`Sending: ${payload}`);
    } else {
      payload = typeof msg === 'string' ? msg : JSON.stringify(msg);
    }
    ws.send(payload);
  }

  // ─── Credential Management ───────────────────────────────────────────────────

  /**
   * Register a gateway credential after a successful /engage/newCredentials handshake.
   * @param {string} sn        Serial number (uppercase)
   * @param {string} password  Base64-encoded random password
   */
  credentialsEstablished(sn, password) {
    this.validConnections.set(sn, {
      password,
      connection:      null,
      connectionName:  '',
      pendingRequests: new Map(),
      eventQueue:      null,
      lastAuthAt:      new Date().toISOString(),   // updated on every 24-hour re-auth
    });
  }

  /**
   * Validate Basic Auth credentials from a WebSocket upgrade request.
   * Side-effect: records the connectionName on the matching entry.
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

  /**
   * Generate a cryptographically random positive signed int32 request ID.
   *
   * Why not the full uint32 range?
   *   The gateway firmware treats requestId as a signed 32-bit integer.
   *   Values above 0x7FFFFFFF (2 147 483 647) are clamped to INT32_MAX in
   *   the gateway's response, so the server never sees the real requestId
   *   back and the pending Promise times out.
   *
   *   Masking with 0x7FFFFFFF keeps the random value in [0 … 2 147 483 647];
   *   the `|| 1` ensures we never emit 0 (reserved as a sentinel by some
   *   gateway firmware versions).
   *
   * Why not UUID?
   *   The Allegion response schema mandates requestId is an integer.
   */
  _getNewRequestId() {
    return (crypto.randomBytes(4).readUInt32BE(0) & 0x7FFFFFFF) || 1;
  }

  _getNewSubscriptionId() {
    const id = this.subscriptionId++;
    if (this.subscriptionId >= MAX_MSG_ID) this.subscriptionId = 0;
    return id;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Start the HTTP/WebSocket server.
   * The Node.js event loop keeps the process alive after this call returns.
   */
  startServer() {
    this.httpServer.listen(this.port, () => {
      const proto = this.sslEnabled ? 'wss' : 'ws';
      console.log(`ENGAGE WS Server v${VERSION} — port ${this.port} (${proto}://host:${this.port}/engage_wss)`);

      if (this.caHttpServer) {
        this.caHttpServer.listen(this.caServerPort, () => {
          console.log(`CA cert server — port ${this.caServerPort} (http://host:${this.caServerPort}/engage/newCA/current)`);
        });
      } else {
        console.log(`CA cert routes — mounted on main server port ${this.port}`);
      }
    });
  }

  /** Return the internal validConnections map. */
  getConnections() {
    return this.validConnections;
  }

  /**
   * Send a message to a connected gateway.
   * @param {string} connectionIndex  Serial number (map key)
   * @param {EngageRequest|EngageEventSubscription|string} engageObj
   * @returns {0|-1}
   */
  sendMsg(connectionIndex, engageObj) {
    const conn = this.validConnections.get(connectionIndex);
    if (!conn?.connection) {
      console.log(`sendMsg: no connection for ${connectionIndex}`);
      return -1;
    }
    this._sendWsMessage(conn.connection, engageObj);
    return 0;
  }

  /**
   * Wait for the response to a specific request identified by its requestId.
   *
   * Each in-flight request is registered in conn.pendingRequests keyed by its
   * unique random requestId. When _handleResponse receives a message from the
   * gateway it resolves exactly the matching Promise — no FIFO ordering assumed,
   * no cross-request interference regardless of how many concurrent callers exist.
   *
   * @param {string} sn           Gateway serial number
   * @param {number} requestId    The requestId sent with the EngageRequest
   * @param {number} [timeoutSec] Seconds to wait before resolving with null (default 10)
   * @returns {Promise<EngageResponse|null>}
   */
  waitForResponse(sn, requestId, timeoutSec = 10) {
    const conn = this.validConnections.get(sn);
    if (!conn) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = timeoutSec > 0
        ? setTimeout(() => {
            conn.pendingRequests.delete(requestId);
            console.log(`Request ${requestId} to ${sn} timed out after ${timeoutSec}s`);
            resolve(null);
          }, timeoutSec * 1000)
        : null;

      conn.pendingRequests.set(requestId, { resolve, timer });
    });
  }

  /**
   * @param {string} connectionIndex
   * @returns {number|null}
   */
  getEventQueueSize(connectionIndex) {
    const conn = this.validConnections.get(connectionIndex);
    return conn?.eventQueue ? conn.eventQueue.size() : null;
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
    if (!conn?.eventQueue) return null;
    return conn.eventQueue.get(block, timeout);
  }

  /** Expose the request ID generator for user applications that build requests. */
  getNewRequestId() {
    return this._getNewRequestId();
  }

  /**
   * Wait until a gateway with the given SN has an open WebSocket connection.
   *
   * Resolves true  immediately if the gateway is already connected.
   * Resolves true  when a gateway:connected event fires for this SN (within timeoutMs).
   * Resolves false if the timeout expires before the gateway reconnects.
   *
   * Primary use case: 24-hour re-authentication window.  The gateway closes the
   * WebSocket, re-runs the credential handshake (~2–5 s), then reconnects.
   * Callers that hold a user request can await this instead of returning an error.
   *
   * @param {string} sn          Gateway serial number (must match validConnections key — uppercase)
   * @param {number} [timeoutMs] Maximum wait time in milliseconds (default 30 000)
   * @returns {Promise<boolean>}
   */
  waitForGateway(sn, timeoutMs = 30_000) {
    const conn = this.validConnections.get(sn);
    if (conn?.connection?.readyState === 1 /* WebSocket.OPEN */) {
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('gateway:connected', onConnect);
        resolve(false);
      }, timeoutMs);

      const onConnect = (connectedSn) => {
        if (connectedSn === sn) {
          clearTimeout(timer);
          this.off('gateway:connected', onConnect);
          resolve(true);
        }
      };

      this.on('gateway:connected', onConnect);
    });
  }
}

EngageWsServer.gServer = null;

module.exports = EngageWsServer;
