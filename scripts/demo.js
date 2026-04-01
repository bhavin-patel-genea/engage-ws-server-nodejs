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
const AuditStore = require('../src/AuditStore');
const ConnectionTracker = require('../src/ConnectionTracker');
const { AccessStateStore } = require('../src/AccessStateStore');
const AccessControlService = require('../src/AccessControlService');
const log = require('../src/logger');

// ── State ──────────────────────────────────────────────────────────────────────

const gateways = new Map(); // sn → { sn, connectedAt }
const devices = new Map(); // sn → [{ linkId, deviceName, modelType, lockState }]
const auditStore = new AuditStore('./data/audits.json', 48);     // 48-hour retention
const connectionTracker = new ConnectionTracker('./data/connections.json');
const accessStateStore = new AccessStateStore('./data/access-state.json');
const accessService = new AccessControlService(accessStateStore, { siteKeyFile: './config/sitekey' });
const sseClients = new Set(); // active SSE response objects
const recentAccessEvents = [];
const databasePushStates = new Map(); // linkId → status object
const databasePollers = new Map(); // linkId → interval handle

// ── SSE broadcast ──────────────────────────────────────────────────────────────

function broadcast(eventName, data) {
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
}

function listAvailableLocks() {
  return Array.from(devices.entries()).flatMap(([sn, list]) =>
    list.map(device => ({
      sn,
      linkId: device.linkId,
      deviceName: device.deviceName,
      modelType: device.modelType,
      lockState: device.lockState,
    }))
  );
}

function findLock(linkId, gatewaySn = null) {
  for (const [sn, list] of devices.entries()) {
    if (gatewaySn && sn !== gatewaySn) continue;
    const device = list.find(item => item.linkId === linkId);
    if (device) return { sn, ...device };
  }
  return null;
}

function snapshotPushStates() {
  return Object.fromEntries(Array.from(databasePushStates.entries()));
}

function updateDatabasePushState(linkId, patch) {
  const next = {
    linkId,
    updatedAt: new Date().toISOString(),
    ...(databasePushStates.get(linkId) || {}),
    ...patch,
  };
  databasePushStates.set(linkId, next);
  broadcast('database:status', next);
  return next;
}

function parseJsonSafe(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeDbDownloadStatus(responseStatus, responseBody) {
  const parsed = parseJsonSafe(responseBody);
  const source = parsed?.dbDownloadStatus || parsed?.downloadStatus || parsed?.status || parsed;

  let state = 'unknown';
  if (String(responseStatus) !== '200') state = 'failed';

  const normalizedText = String(
    source?.state ??
    source?.status ??
    source?.result ??
    source?.downloadState ??
    ''
  ).toLowerCase();

  if (normalizedText.includes('cancel')) state = 'cancelled';
  else if (normalizedText.includes('fail') || normalizedText.includes('error')) state = 'failed';
  else if (normalizedText.includes('complete') || normalizedText.includes('success') || normalizedText.includes('done')) state = 'completed';
  else if (normalizedText.includes('progress') || normalizedText.includes('queue') || normalizedText.includes('pending') || normalizedText.includes('process')) state = 'in-progress';

  if (source?.completed === true || source?.done === true) state = 'completed';
  if (source?.failed === true) state = 'failed';

  const progress = Number(
    source?.progress ??
    source?.percentComplete ??
    source?.percentage ??
    source?.pct ??
    source?.downloadPct ??
    NaN
  );

  return {
    state,
    progress: Number.isFinite(progress) ? progress : null,
    raw: parsed ?? responseBody,
  };
}

async function fetchDbDownloadStatus(sn, linkId) {
  const response = await request(sn, 'GET', `/edgeDevices/${linkId}/dbDownloadStatus`, '', 15);
  if (!response) {
    return {
      state: 'offline',
      progress: null,
      raw: null,
      responseStatus: null,
    };
  }

  const normalized = normalizeDbDownloadStatus(response.responseStatus, response.responseMessageBody);
  return {
    ...normalized,
    responseStatus: response.responseStatus,
  };
}

function startDbStatusPolling(sn, linkId, timeoutMs = 45_000) {
  if (databasePollers.has(linkId)) return;

  const startedAt = Date.now();
  const timer = setInterval(async () => {
    try {
      const status = await fetchDbDownloadStatus(sn, linkId);
      updateDatabasePushState(linkId, {
        sn,
        status: status.state,
        progress: status.progress,
        rawStatus: status.raw,
        responseStatus: status.responseStatus,
      });

      const finished = ['completed', 'failed', 'cancelled'].includes(status.state);
      if (finished || (Date.now() - startedAt) > timeoutMs) {
        clearInterval(timer);
        databasePollers.delete(linkId);
      }
    } catch (err) {
      updateDatabasePushState(linkId, {
        sn,
        status: 'failed',
        error: err.message,
      });
      clearInterval(timer);
      databasePollers.delete(linkId);
    }
  }, 2_000);

  databasePollers.set(linkId, timer);
}

// ── Gateway lifecycle ──────────────────────────────────────────────────────────

async function onGatewayConnected(sn) {
  const conn = server.getConnections().get(sn);
  const isReAuth = conn?.lastAuthAt != null;
  const authType = isReAuth ? 'reauth' : 'first';

  // Track reconnection timing
  const { gapSeconds } = connectionTracker.recordConnect(sn, authType);

  gateways.set(sn, {
    sn,
    connectedAt: new Date().toISOString(),
    lastAuthAt:  conn?.lastAuthAt || null,
    reconnectionGap: gapSeconds,
  });

  // Broadcast with reconnection info
  const gatewayData = gateways.get(sn);
  broadcast('gateway:connected', gatewayData);

  if (gapSeconds !== null) {
    log.reconnectionGap(sn, gapSeconds, authType);
    broadcast('reconnection:gap', { sn, gapSeconds, authType });
  }

  console.log(`[dashboard] Gateway connected: ${sn}${gapSeconds !== null ? ` (reconnect gap: ${gapSeconds.toFixed(2)}s)` : ''}`);

  await discoverDevices(sn).catch(err =>
    console.error(`[dashboard] Device discovery failed for ${sn}: ${err.message}`)
  );
}

function onGatewayDisconnected(sn) {
  // Track disconnect timing
  connectionTracker.recordDisconnect(sn);

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
  const firstAudit = audits[0] || {};

  if (audits.length > 1) {
    const sourceKey = body.edgeDevice ? 'edgeDevice' : (body.gateway ? 'gateway' : null);
    audits.forEach((auditItem, auditIndex) => {
      const auditCode = auditItem?.event || event.eventType;
      const linkId = container.linkId || event.eventDeviceId;
      const lookup = lookupEvent(auditCode);
      const auditScopedBody = sourceKey
        ? {
            ...body,
            [sourceKey]: {
              ...container,
              audits: [auditItem],
            },
          }
        : body;
      const mergedAccessBody = {
        ...body,
        ...container,
        ...auditItem,
      };
      const entry = {
        sn,
        eventType: auditCode,
        category: lookup.category,
        title: lookup.title,
        result: lookup.result,
        reason: buildReason(auditCode, auditScopedBody),
        source: event.eventSource,
        deviceId: linkId,
        body: typeof event.eventBody === 'string'
          ? JSON.stringify(auditScopedBody)
          : auditScopedBody,
        timestamp: new Date().toISOString(),
      };

      const lockInfo = linkId ? findLock(linkId, sn) : null;
      if (lookup.category === 'Access') {
        const accessLookup = accessService.resolveAccessEvent(linkId, mergedAccessBody);
        const lockName = lockInfo?.deviceName || linkId || 'Unknown Lock';
        const detail = entry.title
          ? entry.title.replace(/^Access Granted(?: \(Pass-Through\)| \(One-Time Use\))?$/i, '').replace(/^Denied\s+[â€”-]\s*/i, '').trim()
          : '';
        const prefix = lookup.result === 'granted'
          ? 'Access granted'
          : lookup.result === 'denied'
            ? 'Access denied'
            : (entry.title || 'Access event');

        let friendlyText = `${prefix} for ${accessLookup.subject} at ${lockName}`;
        if (lookup.result === 'denied') {
          const denialDetail = detail || entry.reason || '';
          if (denialDetail) friendlyText += ` â€” ${denialDetail}`;
        }

        entry.displaySubject = accessLookup.subject;
        entry.lockName = lockName;
        entry.friendlyText = friendlyText;
        entry.presentedCardNumber = accessLookup.presentedCardNumber || null;

        const accessEvent = {
          id: `${entry.timestamp}-${sn}-${linkId || 'gateway'}-${auditIndex}`,
          sn,
          linkId,
          lockName,
          result: lookup.result,
          title: entry.title,
          friendlyText,
          subject: accessLookup.subject,
          presentedCardNumber: accessLookup.presentedCardNumber || null,
          timestamp: entry.timestamp,
          user: accessLookup.user,
          reason: entry.reason,
        };
        recentAccessEvents.unshift(accessEvent);
        if (recentAccessEvents.length > 25) recentAccessEvents.pop();
        broadcast('access:event', accessEvent);
      }

      const LOCK_STATE_MAP = {
        '0f000000': 'passage',
        '0f010000': 'secure',
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

      auditStore.insert(entry);
      broadcast('engage:event', entry);
    });
    return;
  }

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

  const mergedAccessBody = {
    ...body,
    ...container,
    ...firstAudit,
  };

  const lockInfo = linkId ? findLock(linkId, sn) : null;
  if (lookup.category === 'Access') {
    const accessLookup = accessService.resolveAccessEvent(linkId, mergedAccessBody);
    const lockName = lockInfo?.deviceName || linkId || 'Unknown Lock';
    const detail = entry.title
      ? entry.title.replace(/^Access Granted(?: \(Pass-Through\)| \(One-Time Use\))?$/i, '').replace(/^Denied\s+[—-]\s*/i, '').trim()
      : '';
    const prefix = lookup.result === 'granted'
      ? 'Access granted'
      : lookup.result === 'denied'
        ? 'Access denied'
        : (entry.title || 'Access event');

    let friendlyText = `${prefix} for ${accessLookup.subject} at ${lockName}`;
    if (lookup.result === 'denied') {
      const denialDetail = detail || entry.reason || '';
      if (denialDetail) friendlyText += ` — ${denialDetail}`;
    }

    entry.displaySubject = accessLookup.subject;
    entry.lockName = lockName;
    entry.friendlyText = friendlyText;
    entry.presentedCardNumber = accessLookup.presentedCardNumber || null;

    const accessEvent = {
      id: `${entry.timestamp}-${sn}-${linkId || 'gateway'}`,
      sn,
      linkId,
      lockName,
      result: lookup.result,
      title: entry.title,
      friendlyText,
      subject: accessLookup.subject,
      presentedCardNumber: accessLookup.presentedCardNumber || null,
      timestamp: entry.timestamp,
      user: accessLookup.user,
      reason: entry.reason,
    };
    recentAccessEvents.unshift(accessEvent);
    if (recentAccessEvents.length > 25) recentAccessEvents.pop();
    broadcast('access:event', accessEvent);
  }

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

  auditStore.insert(entry);
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
    events: auditStore.getAll(50),
    recentAccessEvents,
    connectionStats: connectionTracker.getStats(),
    reconnectionHistory: connectionTracker.getReconnectionHistory(null, 10),
    databasePushStates: snapshotPushStates(),
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

// GET /api/audits — Query persistent audit log (48h retention)
app.get('/api/audits', (req, res) => {
  const { sn, since, limit } = req.query;
  const sinceDate = since ? new Date(since) : null;
  const entries = auditStore.query(sn || null, sinceDate, parseInt(limit) || 100);
  res.json({
    entries,
    stats: auditStore.getStats(),
  });
});

// GET /api/connections — Reconnection gap history and stats
app.get('/api/connections', (req, res) => {
  const { sn, limit } = req.query;
  res.json({
    history: connectionTracker.getReconnectionHistory(sn || null, parseInt(limit) || 20),
    average: connectionTracker.getAverageGap(sn || null),
    events: connectionTracker.getEvents(sn || null, 50),
    stats: connectionTracker.getStats(),
  });
});

// GET /api/access/state — Access Database UI state
app.get('/api/access/state', (req, res) => {
  res.json(accessService.getState(listAvailableLocks(), snapshotPushStates()));
});

// POST /api/access/formats — Create/update a custom card format
app.post('/api/access/formats', parseJsonBody, (req, res) => {
  try {
    const state = accessService.upsertCustomCardFormat(req.body || {});
    res.json({
      ok: true,
      customCardFormats: state.customCardFormats,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/access/formats/:id — Remove a custom card format
app.delete('/api/access/formats/:id', (req, res) => {
  try {
    const state = accessService.deleteCustomCardFormat(req.params.id);
    res.json({
      ok: true,
      customCardFormats: state.customCardFormats,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/access/schedules — Create/update a schedule
app.post('/api/access/schedules', parseJsonBody, (req, res) => {
  try {
    const state = accessService.upsertSchedule(req.body || {});
    res.json({
      ok: true,
      schedules: state.schedules,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/access/schedules/:id — Remove a schedule
app.delete('/api/access/schedules/:id', (req, res) => {
  try {
    const state = accessService.deleteSchedule(req.params.id);
    res.json({
      ok: true,
      schedules: state.schedules,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/access/users — Create/update a user credential
app.post('/api/access/users', parseJsonBody, (req, res) => {
  try {
    const state = accessService.upsertUser(req.body || {});
    res.json({
      ok: true,
      users: state.users,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/access/users/:id — Remove a user credential
app.delete('/api/access/users/:id', (req, res) => {
  try {
    const state = accessService.deleteUser(req.params.id);
    res.json({
      ok: true,
      users: state.users,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/access/preview/:linkId — Build the ENGAGE database payload for one lock
app.get('/api/access/preview/:linkId', (req, res) => {
  try {
    const linkId = req.params.linkId;
    const lockInfo = findLock(linkId, req.query.gateway_sn || null);
    if (!lockInfo) {
      return res.status(404).json({ error: `Lock ${linkId} was not found` });
    }
    res.json({
      lock: lockInfo,
      preview: accessService.buildPreview(linkId),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/access/status/:linkId — Read current database transfer status
app.get('/api/access/status/:linkId', async (req, res) => {
  const linkId = req.params.linkId;
  const lockInfo = findLock(linkId, req.query.gateway_sn || null);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const liveStatus = await fetchDbDownloadStatus(lockInfo.sn, linkId);
    const next = updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: liveStatus.state,
      progress: liveStatus.progress,
      rawStatus: liveStatus.raw,
      responseStatus: liveStatus.responseStatus,
    });
    res.json(next);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/access/push/:linkId — Push a full ENGAGE access database to one lock
app.post('/api/access/push/:linkId', parseJsonBody, async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.body?.gateway_sn || req.query.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const preview = accessService.buildPreview(linkId);
    updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: 'queued',
      progress: 0,
      summary: preview.summary,
    });

    const response = await request(
      lockInfo.sn,
      'PUT',
      `/edgeDevices/${linkId}/database`,
      JSON.stringify(preview.payload),
      20
    );

    if (!response) {
      return res.status(503).json({
        error: 'Gateway did not respond to the database push request',
        retryable: true,
      });
    }

    const rawResponse = parseJsonSafe(response.responseMessageBody);
    const next = updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: String(response.responseStatus) === '200' ? 'in-progress' : 'failed',
      progress: 0,
      rawPushResponse: rawResponse ?? response.responseMessageBody,
      responseStatus: response.responseStatus,
      summary: preview.summary,
    });
    startDbStatusPolling(lockInfo.sn, linkId);

    res.json({
      ok: String(response.responseStatus) === '200',
      lock: lockInfo,
      preview: preview.summary,
      initialResponse: rawResponse ?? response.responseMessageBody,
      status: next,
    });
  } catch (err) {
    updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: 'failed',
      error: err.message,
    });
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/access/push/:linkId — Cancel an in-flight database transfer
app.delete('/api/access/push/:linkId', async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.query.gateway_sn || req.body?.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const response = await request(lockInfo.sn, 'DELETE', `/edgeDevices/${linkId}/database`, '', 15);
    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond to the cancel request' });
    }

    if (databasePollers.has(linkId)) {
      clearInterval(databasePollers.get(linkId));
      databasePollers.delete(linkId);
    }

    const next = updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: 'cancelled',
      progress: null,
      responseStatus: response.responseStatus,
      rawCancelResponse: parseJsonSafe(response.responseMessageBody) ?? response.responseMessageBody,
    });

    res.json({
      ok: String(response.responseStatus) === '200',
      status: next,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/test/disconnect/:sn — Force-close gateway WebSocket (simulates 24h drop)
// WARNING: For development/testing ONLY. The gateway will detect the close,
// re-authenticate (Stage 2), upgrade (Stage 3), and re-subscribe (Stage 4) —
// identical to the real 24-hour lifecycle.
app.post('/api/test/disconnect/:sn', (req, res) => {
  const sn = req.params.sn.toUpperCase();
  const conn = server.getConnections().get(sn);

  if (!conn?.connection) {
    return res.status(404).json({ error: `Gateway ${sn} not connected` });
  }

  if (conn.connection.readyState !== 1 /* WebSocket.OPEN */) {
    return res.status(409).json({ error: `Gateway ${sn} connection not open (state: ${conn.connection.readyState})` });
  }

  console.log(`[test] Force-closing WebSocket for ${sn} to simulate 24h disconnect`);
  log.info('test:force-disconnect', { sn, reason: 'Simulated 24-hour lifecycle drop' });

  conn.connection.close(1000, 'Test: simulated 24-hour disconnect');

  res.json({
    status: 'disconnected',
    sn,
    message: `Gateway ${sn} WebSocket closed. Gateway should re-authenticate and reconnect within 2-5 seconds.`,
    tip: 'Monitor /api/connections to see the reconnection gap timing.',
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────

server.startServer();

console.log('');
console.log('  ┌──────────────────────────────────────────────────────┐');
console.log('  │         ENGAGE Gateway Dashboard                     │');
console.log('  ├──────────────────────────────────────────────────────┤');
console.log(`  │  Dashboard     →  http://localhost:${server.port}`.padEnd(57) + '│');
console.log(`  │  Gateway WS    →  ws://localhost:${server.port}/engage_wss`.padEnd(57) + '│');
console.log('  ├──────────────────────────────────────────────────────┤');
console.log(`  │  Audit Log     →  GET /api/audits (48h retention)`.padEnd(57) + '│');
console.log(`  │  Connections   →  GET /api/connections`.padEnd(57) + '│');
console.log(`  │  Test Disconnect→ POST /api/test/disconnect/:sn`.padEnd(57) + '│');
console.log('  ├──────────────────────────────────────────────────────┤');
console.log('  │  Simulator     →  node scripts/gateway-simulator.js  │');
console.log('  └──────────────────────────────────────────────────────┘');
console.log('');
