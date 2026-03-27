'use strict';

/**
 * server.js — Minimal entry point.
 *
 * Starts the ENGAGE WebSocket server with no application logic attached.
 * Use scripts/demo.js for the full dashboard + device control API.
 *
 * Usage:
 *   node server.js
 */

const EngageWsServer = require('./src/EngageWsServer');

const server = new EngageWsServer({
  onConnectionMade: (sn) => { console.log(`Gateway connected: ${sn}`); },
  onConnectionLost: (sn) => { console.log(`Gateway disconnected: ${sn}`); },
});

server.startServer();
