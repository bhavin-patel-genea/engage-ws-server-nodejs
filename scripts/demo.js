'use strict';

/**
 * scripts/demo.js — ENGAGE Gateway Dashboard
 *
 * Full demo entry point. Starts the ENGAGE WebSocket server and mounts a web
 * dashboard with real-time device control.
 *
 * Usage:
 *   npm run demo
 *
 * What this script does:
 *   1. Creates EngageWsServer (handles gateway credential + WebSocket lifecycle)
 *   2. Listens for gateway:connected / gateway:disconnected / engage:event via EventEmitter
 *   3. On gateway connect → auto-discovers linked devices (linkList + lockStatus)
 *   4. Broadcasts state changes to dashboard clients over Server-Sent Events (SSE)
 *   5. Exposes REST API for lock control
 *   6. Serves the static dashboard from public/
 *
 * ── Gateway (Client Mode) initiation sequence ────────────────────────────────
 *
 *   Stage 1 — Certificate setup (gateway → server, HTTP):
 *     GET  /engage/newCA/:subpath    → HMAC-signed CA URL
 *     GET  /engage/certificates      → rootca.der binary
 *
 *   Stage 2 — Credential establishment (gateway → server, HTTP):
 *     POST /engage/newCredentials
 *       Body: Base64( SN : AES-256-CBC(timestamp ‖ SN, siteKey) : securityRevision )
 *       Server validates timestamp, verifies SN, issues a 32-byte random password.
 *
 *   Stage 3 — WebSocket upgrade (gateway → server):
 *     GET /engage_wss  (HTTP Upgrade)
 *       Authorization: Basic Base64(SN:password)
 *       Sec-WebSocket-Protocol: engage.v1.gateway.allegion.com
 *       Server validates credentials → 101 Switching Protocols
 *
 *   Stage 4 — Event subscription (server → gateway, over WebSocket):
 *     Server sends EngageEventSubscription immediately after upgrade.
 *     Without this the gateway sends no events.
 *
 *   Stages 5–7 — Application use (server → gateway, over WebSocket):
 *     Server sends EngageRequest messages (HTTP-style PUT/GET over WebSocket).
 *     Gateway responds with EngageResponse; also pushes EngageEvent asynchronously.
 *
 *   Stage 8 — 24-hour reconnection (gateway → server):
 *     Gateway drops the connection every 24 h and repeats Stages 2–4.
 */

const path = require('path');
process.chdir(path.join(__dirname, '..'));

const express = require('express');
const EngageWsServer = require('../src/EngageWsServer');
const { EngageRequest } = require('../src/EngageWsProtocol');
const { lookupEvent, buildReason } = require('../src/eventCodes');

// ── State ──────────────────────────────────────────────────────────────────────

const gateways = new Map(); // sn → { sn, connectedAt }
const devices = new Map(); // sn → [{ linkId, deviceName, modelType, lockState }]
const eventLog = [];        // recent ENGAGE events (capped at 200)
const sseClients = new Set(); // active SSE response objects

// ── SSE broadcast ──────────────────────────────────────────────────────────────

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

// ── Gateway lifecycle ──────────────────────────────────────────────────────────

async function onGatewayConnected(sn) {
  const conn = server.getConnections().get(sn);
  gateways.set(sn, {
    sn,
    connectedAt: new Date().toISOString(),
    lastAuthAt:  conn?.lastAuthAt || null,
  });
  broadcast('gateway:connected', gateways.get(sn));
  console.log(`[dashboard] Gateway connected: ${sn}`);

  await discoverDevices(sn).catch(err =>
    console.error(`[dashboard] Device discovery failed for ${sn}: ${err.message}`)
  );
}

function onGatewayDisconnected(sn) {
  gateways.delete(sn);
  devices.delete(sn);
  broadcast('gateway:disconnected', { sn });
  console.log(`[dashboard] Gateway disconnected: ${sn}`);
}

// ── Device discovery ───────────────────────────────────────────────────────────

/**
 * Discover all edge devices linked to a gateway by sending:
 *   GET /edgeDevices/linkList    — device inventory
 *   GET /edgeDevices/lockStatus  — current lock states (best-effort)
 *
 * Both calls are initiated by the SERVER over the existing WebSocket connection
 * (the gateway is acting as the HTTP server in this exchange).
 */
async function discoverDevices(sn) {
  console.log(`[dashboard] Discovering devices for ${sn}…`);

  const linkRes = await request(sn, 'GET', '/edgeDevices/linkList', '', 15);
  if (!linkRes || linkRes.responseStatus !== '200') {
    console.log(`[dashboard] linkList failed for ${sn} (status: ${linkRes?.responseStatus ?? 'timeout'})`);
    return;
  }

  let rawList = [];
  try {
    const body = JSON.parse(linkRes.responseMessageBody);
    rawList = body.edgeDeviceLinkList || body.linkList || (Array.isArray(body) ? body : []);
  } catch {
    console.log(`[dashboard] Could not parse linkList response for ${sn}`);
    return;
  }

  const deviceList = rawList.map(d => ({
    linkId: d.linkId || d.link_id || '—',
    deviceName: d.deviceName || d.name || d.linkId || '—',
    modelType: d.modelType || d.type || '—',
    lockState: '?',
  }));

  // Enrich with live lock states
  const statusRes = await request(sn, 'GET', '/edgeDevices/lockStatus', '', 15);
  if (statusRes?.responseStatus === '200') {
    try {
      const body = JSON.parse(statusRes.responseMessageBody);
      const statusList = body.edgeDeviceLockStatus || body.lockStatus || [];
      const stateMap = Object.fromEntries(statusList.map(s => [s.linkId, s.lockState || '?']));
      deviceList.forEach(d => { if (stateMap[d.linkId]) d.lockState = stateMap[d.linkId]; });
    } catch { /* enrichment is optional */ }
  }

  devices.set(sn, deviceList);
  broadcast('device:list', { sn, devices: deviceList });
  console.log(`[dashboard] Discovered ${deviceList.length} device(s) for ${sn}`);
}

// ── Request helper ─────────────────────────────────────────────────────────────

async function request(sn, method, reqPath, body, timeoutSec = 30) {
  const req = new EngageRequest(server.getNewRequestId(), method, reqPath, body);
  if (server.sendMsg(sn, req) !== 0) return null;
  // waitForResponse resolves the Promise for exactly this requestId —
  // concurrent requests to the same gateway cannot receive each other's responses.
  return server.waitForResponse(sn, req.requestId, timeoutSec);
}

// ── JSON body middleware ───────────────────────────────────────────────────────

// express.raw() in routes.js buffers all request bodies as Buffer.
// This middleware parses JSON from that Buffer for our API routes.
function parseJsonBody(req, res, next) {
  if (Buffer.isBuffer(req.body)) {
    try {
      req.body = JSON.parse(req.body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid JSON body' });
    }
  }
  next();
}

// ── Server setup ───────────────────────────────────────────────────────────────

const server = new EngageWsServer({
  onConnectionMade: sn => { onGatewayConnected(sn); },
  onConnectionLost: sn => { onGatewayDisconnected(sn); },
});

// Forward gateway events to SSE clients, enriched with human-readable metadata
server.on('engage:event', ({ sn, event }) => {
  // Parse the event body — the gateway wraps audit events inside
  // body.edgeDevice.audits[] or body.gateway.audits[]
  let body = {};
  try {
    body = typeof event.eventBody === 'string'
      ? JSON.parse(event.eventBody)
      : (event.eventBody || {});
  } catch { /* ignore */ }

  const container = body.edgeDevice || body.gateway || {};
  const audits = Array.isArray(container.audits) ? container.audits : [];

  // Real audit event code lives in audits[0].event (e.g. "0f010000")
  // Fall back to the outer eventType only if audits array is empty
  const auditCode = audits.length > 0 ? audits[0].event : event.eventType;
  const linkId = container.linkId || event.eventDeviceId;

  const lookup = lookupEvent(auditCode);

  const entry = {
    sn,
    eventType: auditCode,
    category: lookup.category,
    title: lookup.title,
    result: lookup.result,
    reason: buildReason(auditCode, body),
    source: event.eventSource,
    deviceId: linkId,
    body: event.eventBody,
    timestamp: new Date().toISOString(),
  };

  // Keep local lock state cache in sync when gateway reports a state change
  const LOCK_STATE_MAP = {
    '0f000000': 'passage',   // Lock State: Passage
    '0f010000': 'secure',    // Lock State: Secured
    '0f020000': 'momentaryUnlock',
  };
  const mappedState = auditCode ? LOCK_STATE_MAP[String(auditCode).toLowerCase()] : null;
  if (mappedState && linkId) {
    const list = devices.get(sn);
    if (list) {
      list.forEach(d => { if (d.linkId === linkId) d.lockState = mappedState; });
      broadcast('device:list', { sn, devices: list });
    }
  }

  eventLog.unshift(entry);
  if (eventLog.length > 200) eventLog.pop();
  broadcast('engage:event', entry);
});

// ── Mount dashboard routes (before startServer) ────────────────────────────────

const app = server.app;

// Static files (serves public/index.html at /)
app.use(express.static(path.join(__dirname, '../public')));

// GET /api/stream — Server-Sent Events for real-time dashboard updates
app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  // Send full current state immediately so the page renders without waiting
  const initPayload = {
    port: server.port,
    gateways: Array.from(gateways.values()),
    devices: Object.fromEntries(devices),
    events: eventLog.slice(0, 50),
  };
  res.write(`event: init\ndata: ${JSON.stringify(initPayload)}\n\n`);

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// POST /api/lock — Send a lock control command to a gateway device
//
// Handles the 24-hour gateway re-authentication window transparently:
//   1. Send the command.
//   2. If the gateway is not connected (or drops mid-request), wait up to 30 s
//      for it to complete re-auth and reconnect.
//   3. Retry the command once on reconnect.
//   4. Only return an error if the gateway does not come back within 30 s.
//
// From the user's perspective: the unlock button may take a few extra seconds
// during the brief re-auth window, but the command succeeds automatically.
app.post('/api/lock', parseJsonBody, async (req, res) => {
  const { gateway_sn, link_id, action } = req.body || {};

  if (!gateway_sn || !link_id || !action) {
    return res.status(400).json({ error: 'gateway_sn, link_id, and action are required' });
  }

  const validActions = ['secure', 'passage', 'momentaryUnlock'];
  if (!validActions.includes(action)) {
    return res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` });
  }

  const msgBody = JSON.stringify({ lockControl: { lockState: { nextLockState: action } } });
  const reqPath = link_id === 'all'
    ? '/edgeDevices/lockControl'
    : `/edgeDevices/${link_id}/lockControl`;

  // First attempt
  let response = await request(gateway_sn, 'PUT', reqPath, msgBody, 15);

  if (response === null) {
    // null = gateway not connected OR dropped mid-request (e.g. 24 h re-auth).
    // Wait up to 30 s for it to reconnect, then retry the command once.
    console.log(`[lock] No response from ${gateway_sn} — waiting up to 30 s for gateway reconnect`);
    broadcast('lock:retrying', { sn: gateway_sn, link_id, action });

    const reconnected = await server.waitForGateway(gateway_sn, 30_000);
    if (!reconnected) {
      return res.status(503).json({
        error: 'Gateway did not reconnect within 30 seconds. Please try again.',
        retryable: true,
      });
    }

    console.log(`[lock] Gateway ${gateway_sn} reconnected — retrying lock command`);
    response = await request(gateway_sn, 'PUT', reqPath, msgBody, 15);
  }

  if (!response) {
    return res.status(503).json({
      error: 'Lock command failed after reconnect. Please try again.',
      retryable: true,
    });
  }

  // Update local cache and broadcast the new state
  if (response.responseStatus === '200') {
    const list = devices.get(gateway_sn);
    if (list) {
      list.forEach(d => {
        if (link_id === 'all' || d.linkId === link_id) d.lockState = action;
      });
      broadcast('device:list', { sn: gateway_sn, devices: list });
    }
    broadcast('lock:result', { sn: gateway_sn, link_id, action, status: response.responseStatus });
  }

  res.json({ status: response.responseStatus, body: response.responseMessageBody });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.startServer();

console.log('');
console.log('  ┌─────────────────────────────────────────────────┐');
console.log('  │         ENGAGE Gateway Dashboard                │');
console.log('  ├─────────────────────────────────────────────────┤');
console.log(`  │  Dashboard  →  http://localhost:${server.port}`.padEnd(52) + '│');
console.log(`  │  Gateway WS →  ws://localhost:${server.port}/engage_wss`.padEnd(52) + '│');
console.log('  ├─────────────────────────────────────────────────┤');
console.log('  │  Simulator  →  node scripts/gateway-simulator.js│');
console.log('  └─────────────────────────────────────────────────┘');
console.log('');
