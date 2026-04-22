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
const crypto = require('crypto');
process.chdir(path.join(__dirname, '..'));

const express = require('express');
const EngageWsServer = require('../src/EngageWsServer');
const { EngageRequest } = require('../src/EngageWsProtocol');
const { lookupEvent, lookupWorkbookRow, buildReason, extractCardBitCount, extractCardDataFromAuditCodes, extractRawCardBytesFromAuditCodes } = require('../src/eventCodes');
const { encryptClearPrimeCr } = require('../src/PrimeCredential');
const AuditStore = require('../src/AuditStore');
const EventTraceLogger = require('../src/EventTraceLogger');
const ConnectionTracker = require('../src/ConnectionTracker');
const { AccessStateStore } = require('../src/AccessStateStore');
const AccessControlService = require('../src/AccessControlService');
const log = require('../src/logger');

// ── State ──────────────────────────────────────────────────────────────────────

const gateways = new Map(); // sn → { sn, connectedAt }
const devices = new Map(); // sn → [{ linkId, deviceName, modelType, lockState }]
const auditStore = new AuditStore('./data/audits.json', 48);     // 48-hour retention
const eventTraceLogger = new EventTraceLogger('./data/egw-event-trace.log');
const connectionTracker = new ConnectionTracker('./data/connections.json');
const accessStateStore = new AccessStateStore('./data/access-state.json');
const accessService = new AccessControlService(accessStateStore, { siteKeyFile: './config/sitekey' });
const sseClients = new Set(); // active SSE response objects
const recentAccessEvents = [];
const LOCK_SETTING_BOOLEAN_KEYS = [
  'invCrdAudEn',
  'auditIDEn',
  'proxConfHID',
  'proxConfGECASI',
  'proxConfAWID',
  'uid14443',
  'mi14443',
  'mip14443',
  'noc14443',
  'uid15693',
  'iClsUID40b',
];
const databasePushStates = new Map(); // linkId → status object
const databasePollers = new Map(); // linkId → interval handle
const gatewayApiTraffic = [];
const gatewayNetworkStats = new Map(); // sn -> aggregate diagnostics
const gatewayPendingCredentials = new Map(); // sn -> pending basic-auth session
const gatewayCommittedCredentials = new Map(); // username -> committed basic-auth session

const DEFAULT_GATEWAY_API_USER = process.env.ENGAGE_GATEWAY_DEFAULT_USER || 'EngageGatewayDefaultUser';
const DEFAULT_GATEWAY_API_PASSWORD = process.env.ENGAGE_GATEWAY_DEFAULT_PASSWORD || 'EngageGatewayDefaultPassword';
const GATEWAY_API_LOG_LIMIT = 250;
const GATEWAY_API_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

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

function formatGatewayTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function recordGatewayTraffic(entry) {
  gatewayApiTraffic.unshift({
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (gatewayApiTraffic.length > GATEWAY_API_LOG_LIMIT) {
    gatewayApiTraffic.length = GATEWAY_API_LOG_LIMIT;
  }
}

function clipForLog(value, maxLen = 1200) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return text.length > maxLen ? `${text.slice(0, maxLen)}\n... [truncated ${text.length - maxLen} chars]` : text;
}

function logGatewayRequestStage(stage, details = {}) {
  const lines = [
    '',
    `=== EGW Request ${stage} ===`,
    `Gateway SN   : ${details.sn || 'unknown'}`,
    `Category     : ${details.category || 'gateway-request'}`,
    `Source       : ${details.source || 'server'}`,
    `Method/Path  : ${(details.method || '').toUpperCase()} ${details.path || ''}`.trim(),
  ];

  if (details.requestId !== undefined) lines.push(`Request ID    : ${details.requestId}`);
  if (details.responseStatus !== undefined) lines.push(`HTTP Status   : ${details.responseStatus}`);
  if (details.durationMs !== undefined) lines.push(`Duration      : ${details.durationMs} ms`);
  if (details.notes) lines.push(`Notes         : ${details.notes}`);
  if (details.requestBody !== undefined && details.requestBody !== '') {
    lines.push('Request Body  :');
    lines.push(clipForLog(details.requestBody));
  }
  if (details.responseBody !== undefined && details.responseBody !== null && details.responseBody !== '') {
    lines.push('Response Body :');
    lines.push(clipForLog(details.responseBody));
  }

  console.log(lines.join('\n'));
}

function logGatewayEventProcessing(stage, details = {}) {
  const lines = [
    '',
    `=== EGW Event ${stage} ===`,
    `Gateway SN   : ${details.sn || 'unknown'}`,
    `Source       : ${details.source || 'unknown'}`,
    `Device       : ${details.deviceId || '—'}`,
  ];

  if (details.eventId !== undefined) lines.push(`Event ID      : ${details.eventId}`);
  if (details.rawEventType !== undefined) lines.push(`Raw eventType : ${details.rawEventType}`);
  if (details.auditCode !== undefined) lines.push(`Parsed Code   : ${details.auditCode}`);
  if (details.auditCount !== undefined) lines.push(`Audit Count   : ${details.auditCount}`);
  if (details.category) lines.push(`Mapped Cat.   : ${details.category}`);
  if (details.title) lines.push(`Mapped Title  : ${details.title}`);
  if (details.reason) lines.push(`Reason        : ${details.reason}`);
  if (details.mappingStatus) lines.push(`Workbook Map  : ${details.mappingStatus}`);
  if (details.caption) lines.push(`Workbook Cap. : ${details.caption}`);
  if (details.eventHex) lines.push(`Workbook Event: ${details.eventHex}`);
  if (details.dataHex) lines.push(`Workbook Data : ${details.dataHex}`);
  if (details.dataDescription) lines.push(`Data Meaning  : ${details.dataDescription}`);
  if (details.explanation) lines.push(`Processing    : ${details.explanation}`);
  if (details.rawPayload !== undefined && details.rawPayload !== '') {
    lines.push('Raw Payload   :');
    lines.push(clipForLog(details.rawPayload));
  }

  console.log(lines.join('\n'));
}

function traceGatewayEvent(stage, details = {}) {
  eventTraceLogger.trace(stage, details);
}

function normalizeStatsPath(reqPath = '') {
  return String(reqPath || '')
    .replace(/\/edgeDevices\/[^/]+\/database/g, '/edgeDevices/{linkId}/database')
    .replace(/\/edgeDevices\/[^/]+\/dbDownloadStatus/g, '/edgeDevices/{linkId}/dbDownloadStatus')
    .replace(/\/edgeDevices\/[^/]+\/config/g, '/edgeDevices/{linkId}/config')
    .replace(/\/edgeDevices\/[^/]+\/params/g, '/edgeDevices/{linkId}/params')
    .replace(/\/edgeDevices\/[^/]+\/audits/g, '/edgeDevices/{linkId}/audits')
    .replace(/\/edgeDevices\/[^/]+\/lockControl/g, '/edgeDevices/{linkId}/lockControl')
    .replace(/\/edgeDevices\/[^/]+\/lockStatus/g, '/edgeDevices/{linkId}/lockStatus')
    .replace(/\/edgeDevices\/[^/]+\/time/g, '/edgeDevices/{linkId}/time')
    .replace(/\/edgeDevices\/[^/]+$/g, '/edgeDevices/{linkId}');
}

function extractLinkIdFromPath(reqPath = '') {
  const match = String(reqPath || '').match(/^\/edgeDevices\/([^/]+)/);
  if (!match) return null;
  const linkId = match[1];
  return ['linkList', 'lockControl', 'lockStatus', 'audits'].includes(linkId) ? null : linkId;
}

function updateGatewayNetworkStats(sn, entry) {
  if (!sn) return;

  const current = gatewayNetworkStats.get(sn) || {
    sn,
    firstSeenAt: new Date().toISOString(),
    updatedAt: null,
    totals: {
      requests: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
    },
    byPath: {},
    byLinkId: {},
  };

  current.updatedAt = new Date().toISOString();
  current.totals.requests += 1;
  if (entry.responseStatus === 'timeout') current.totals.timeouts += 1;
  else if (String(entry.responseStatus) === '200') current.totals.successes += 1;
  else current.totals.failures += 1;

  const normalizedPath = normalizeStatsPath(entry.path);
  const pathStats = current.byPath[normalizedPath] || {
    path: normalizedPath,
    requests: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    lastMethod: null,
    lastResponseStatus: null,
    lastDurationMs: null,
    lastSeenAt: null,
  };
  pathStats.requests += 1;
  if (entry.responseStatus === 'timeout') pathStats.timeouts += 1;
  else if (String(entry.responseStatus) === '200') pathStats.successes += 1;
  else pathStats.failures += 1;
  pathStats.lastMethod = entry.method;
  pathStats.lastResponseStatus = entry.responseStatus;
  pathStats.lastDurationMs = entry.durationMs;
  pathStats.lastSeenAt = current.updatedAt;
  current.byPath[normalizedPath] = pathStats;

  const linkId = extractLinkIdFromPath(entry.path);
  if (linkId) {
    const linkStats = current.byLinkId[linkId] || {
      linkId,
      requests: 0,
      successes: 0,
      failures: 0,
      timeouts: 0,
      lastPath: null,
      lastResponseStatus: null,
      lastSeenAt: null,
    };
    linkStats.requests += 1;
    if (entry.responseStatus === 'timeout') linkStats.timeouts += 1;
    else if (String(entry.responseStatus) === '200') linkStats.successes += 1;
    else linkStats.failures += 1;
    linkStats.lastPath = entry.path;
    linkStats.lastResponseStatus = entry.responseStatus;
    linkStats.lastSeenAt = current.updatedAt;
    current.byLinkId[linkId] = linkStats;
  }

  gatewayNetworkStats.set(sn, current);
}

function parseBasicAuth(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.startsWith('Basic ')) return null;

  try {
    const decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator < 0) return null;
    return {
      username: decoded.slice(0, separator),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
  }
}

function defaultGatewayCredentialsMatch(auth) {
  return auth?.username === DEFAULT_GATEWAY_API_USER && auth?.password === DEFAULT_GATEWAY_API_PASSWORD;
}

function resolveGatewaySn(req, preferredSn = null) {
  const directCandidates = [
    preferredSn,
    req.headers['x-gateway-sn'],
    req.query?.gateway_sn,
    req.body?.gateway_sn,
    req.gatewaySession?.targetSn,
  ].filter(Boolean).map(value => String(value).trim().toUpperCase());

  for (const sn of directCandidates) {
    if (gateways.has(sn)) return sn;
  }

  const connected = Array.from(gateways.keys());
  if (connected.length === 1) return connected[0];
  return null;
}

function requireDefaultGatewayAuth(req, res, next) {
  const auth = parseBasicAuth(req);
  if (!defaultGatewayCredentialsMatch(auth)) {
    res.set('WWW-Authenticate', 'Basic realm="ENGAGE Gateway Setup"');
    return res.status(401).json({ error: 'Default gateway credentials are required' });
  }
  req.gatewayAuth = auth;
  next();
}

function requireGatewayApiSession(req, res, next) {
  const auth = parseBasicAuth(req);
  if (!auth) {
    res.set('WWW-Authenticate', 'Basic realm="ENGAGE Gateway API"');
    return res.status(401).json({ error: 'Basic authentication is required' });
  }

  const session = gatewayCommittedCredentials.get(auth.username);
  if (!session || session.password !== auth.password) {
    res.set('WWW-Authenticate', 'Basic realm="ENGAGE Gateway API"');
    return res.status(401).json({ error: 'Invalid gateway API credentials. Initialize them with GET/PUT /gateway/newCredentials first.' });
  }

  if ((Date.now() - session.committedAtMs) > GATEWAY_API_SESSION_TTL_MS) {
    gatewayCommittedCredentials.delete(auth.username);
    res.set('WWW-Authenticate', 'Basic realm="ENGAGE Gateway API"');
    return res.status(401).json({ error: 'Gateway API credentials expired. Re-run GET/PUT /gateway/newCredentials.' });
  }

  req.gatewayAuth = auth;
  req.gatewaySession = session;
  next();
}

function getGatewayDeviceSnapshot(sn) {
  const linkedDevices = devices.get(sn) || [];
  const connection = server.getConnections().get(sn);
  return {
    gatewayDeviceInfo: {
      serialNumber: sn,
      connectionName: connection?.connectionName || null,
      connectedAt: gateways.get(sn)?.connectedAt || null,
      lastAuthAt: gateways.get(sn)?.lastAuthAt || null,
      protocol: connection?.connection?.engageProtocol || null,
      linkedDeviceCount: linkedDevices.length,
      linkedDevices,
    },
  };
}

function getGatewayTimeSnapshot(sn) {
  return {
    gatewayTime: {
      serialNumber: sn,
      rtcTime: formatGatewayTimestamp(),
      source: 'api-playground-host',
      linkedDeviceCount: (devices.get(sn) || []).length,
    },
  };
}

function getGatewayScanSnapshot(sn) {
  return {
    scanList: (devices.get(sn) || []).map(device => ({
      linkId: device.linkId,
      deviceName: device.deviceName,
      modelType: device.modelType,
      discovered: true,
      source: 'linked-device-cache',
    })),
  };
}

function getGatewayNetworkStatisticsSnapshot(sn) {
  const stats = gatewayNetworkStats.get(sn) || {
    sn,
    firstSeenAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    totals: { requests: 0, successes: 0, failures: 0, timeouts: 0 },
    byPath: {},
    byLinkId: {},
  };

  return {
    gatewayNetworkStatistics: {
      sn,
      totals: stats.totals,
      byPath: Object.values(stats.byPath),
      byLinkId: Object.values(stats.byLinkId),
      firstSeenAt: stats.firstSeenAt,
      updatedAt: stats.updatedAt,
    },
  };
}

function getGatewayEventLogSnapshot(sn, limit = 100) {
  const items = gatewayApiTraffic
    .filter(entry => !sn || entry.sn === sn)
    .slice(0, limit);

  return {
    gatewayEventLog: items,
  };
}

function filterAuditEntries(linkId = null, sn = null, limit = 200) {
  return auditStore.getAll(1000)
    .filter(entry => !sn || entry.sn === sn)
    .filter(entry => !linkId || String(entry.linkId || '') === String(linkId))
    .slice(0, limit);
}

function normalizeTfFlag(value) {
  if (value === true || value === false) return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['t', 'true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['f', 'false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  return null;
}

function toTfFlag(value) {
  return normalizeTfFlag(value) ? 'T' : 'F';
}

function extractLockSettingsSource(parsed) {
  const candidates = [];
  const pushCandidate = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      candidates.push(value);
    }
  };

  pushCandidate(parsed);
  pushCandidate(parsed?.params);
  pushCandidate(parsed?.config);
  pushCandidate(parsed?.edgeDeviceParams);
  pushCandidate(parsed?.edgeDeviceParams?.params);
  pushCandidate(parsed?.edgeDeviceParams?.config);
  pushCandidate(parsed?.edgeDeviceConfig);
  pushCandidate(parsed?.edgeDeviceConfig?.params);
  pushCandidate(parsed?.edgeDeviceConfig?.config);
  pushCandidate(parsed?.readerParams);
  pushCandidate(parsed?.readerParameters);
  pushCandidate(parsed?.lockParams);
  pushCandidate(parsed?.lockParameters);
  pushCandidate(parsed?.data);
  pushCandidate(parsed?.data?.params);
  pushCandidate(parsed?.data?.config);
  // edgeDevice nested structure: settings live inside config.lockPrmtrs and config.rdrPrmtrs
  pushCandidate(parsed?.edgeDevice?.config);
  pushCandidate(parsed?.edgeDevice?.config?.lockPrmtrs);
  pushCandidate(parsed?.edgeDevice?.config?.rdrPrmtrs);

  return Object.assign({}, ...candidates);
}

function normalizeLockSettings(responseBody) {
  const parsed = parseJsonSafe(responseBody) || {};
  const source = extractLockSettingsSource(parsed);
  const values = {};
  const supported = {};

  for (const key of LOCK_SETTING_BOOLEAN_KEYS) {
    const normalized = normalizeTfFlag(source[key]);
    supported[key] = normalized !== null;
    values[key] = normalized ?? false;
  }

  const ge4001 = normalizeTfFlag(source.proxConfGE4001);
  const ge4002 = normalizeTfFlag(source.proxConfGE4002);
  supported.geProxFormat = ge4001 !== null || ge4002 !== null;
  values.geProxFormat = ge4002 ? '4002' : ge4001 ? '4001' : 'disabled';

  return {
    values,
    supported,
    raw: parsed,
  };
}

function buildLockSettingsConfig(values) {
  if (!values || typeof values !== 'object') {
    throw new Error('Lock setting values are required');
  }

  const config = {};
  for (const key of LOCK_SETTING_BOOLEAN_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const normalized = normalizeTfFlag(values[key]);
    if (normalized === null) {
      throw new Error(`Setting ${key} must be enabled or disabled`);
    }
    config[key] = toTfFlag(normalized);
  }

  if (Object.prototype.hasOwnProperty.call(values, 'geProxFormat')) {
    const geFormat = String(values.geProxFormat || 'disabled').trim().toLowerCase();
    if (!['disabled', '4001', '4002'].includes(geFormat)) {
      throw new Error('GE prox format must be 4001, 4002, or disabled');
    }
    config.proxConfGE4001 = geFormat === '4001' ? 'T' : 'F';
    config.proxConfGE4002 = geFormat === '4002' ? 'T' : 'F';
  }

  if (Object.keys(config).length === 0) {
    throw new Error('No lock settings were provided');
  }

  return { config };
}

function responseErrorMessage(response, fallback) {
  const parsed = parseJsonSafe(response?.responseMessageBody);
  return parsed?.error || fallback;
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
    const body = parseJsonSafe(linkRes.responseMessageBody);
    rawList = body?.edgeDeviceLinkList || body?.linkList || (Array.isArray(body) ? body : []);
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
      const body = parseJsonSafe(statusRes.responseMessageBody);
      const statusList = body?.edgeDeviceLockStatus || body?.lockStatus || [];
      const stateMap = Object.fromEntries(statusList.map(s => [s.linkId, s.lockState || '?']));
      deviceList.forEach(d => { if (stateMap[d.linkId]) d.lockState = stateMap[d.linkId]; });
    } catch { /* enrichment is optional */ }
  }

  devices.set(sn, deviceList);
  broadcast('device:list', { sn, devices: deviceList });
  console.log(`[dashboard] Discovered ${deviceList.length} device(s) for ${sn}`);
}

// ── Request helper ─────────────────────────────────────────────────────────────

async function request(sn, method, reqPath, body, timeoutSec = 30, meta = {}) {
  const startedAt = Date.now();
  const req = new EngageRequest(server.getNewRequestId(), method, reqPath, body);
  const parsedRequestBody = parseJsonSafe(body) ?? body ?? '';
  logGatewayRequestStage('OUTBOUND', {
    sn,
    category: meta.category || 'gateway-request',
    source: meta.source || 'server',
    method,
    path: reqPath,
    requestId: req.requestId,
    requestBody: parsedRequestBody,
    notes: meta.notes || null,
  });
  if (server.sendMsg(sn, req) !== 0) {
    recordGatewayTraffic({
      sn,
      category: meta.category || 'gateway-request',
      method,
      path: reqPath,
      responseStatus: 'offline',
      durationMs: 0,
      source: meta.source || 'server',
      requestBody: parsedRequestBody,
      notes: meta.notes || null,
    });
    updateGatewayNetworkStats(sn, {
      method,
      path: reqPath,
      responseStatus: 'offline',
      durationMs: 0,
    });
    logGatewayRequestStage('OFFLINE', {
      sn,
      category: meta.category || 'gateway-request',
      source: meta.source || 'server',
      method,
      path: reqPath,
      requestId: req.requestId,
      responseStatus: 'offline',
      durationMs: 0,
      requestBody: parsedRequestBody,
      notes: 'Gateway connection was not available when the request was sent.',
    });
    return null;
  }
  // waitForResponse resolves the Promise for exactly this requestId —
  // concurrent requests to the same gateway cannot receive each other's responses.
  const response = await server.waitForResponse(sn, req.requestId, timeoutSec);
  const durationMs = Date.now() - startedAt;
  const parsedResponseBody = parseJsonSafe(response?.responseMessageBody) ?? response?.responseMessageBody ?? null;
  recordGatewayTraffic({
    sn,
    category: meta.category || 'gateway-request',
    method,
    path: reqPath,
    responseStatus: response?.responseStatus ?? 'timeout',
    durationMs,
    source: meta.source || 'server',
    requestBody: parsedRequestBody,
    responseBody: parsedResponseBody,
    notes: meta.notes || null,
  });
  updateGatewayNetworkStats(sn, {
    method,
    path: reqPath,
    responseStatus: response?.responseStatus ?? 'timeout',
    durationMs,
  });
  logGatewayRequestStage(response ? 'INBOUND' : 'TIMEOUT', {
    sn,
    category: meta.category || 'gateway-request',
    source: meta.source || 'server',
    method,
    path: reqPath,
    requestId: req.requestId,
    responseStatus: response?.responseStatus ?? 'timeout',
    durationMs,
    requestBody: parsedRequestBody,
    responseBody: parsedResponseBody,
    notes: response ? (meta.notes || null) : `No gateway response within ${timeoutSec}s timeout.`,
  });
  return response;
}

// ── JSON body middleware ───────────────────────────────────────────────────────

// express.raw() in routes.js buffers all request bodies as Buffer.
// This middleware parses JSON from that Buffer for our API routes.
function parseJsonBody(req, res, next) {
  if (Buffer.isBuffer(req.body)) {
    if (req.body.length === 0) {
      req.body = {};
      return next();
    }
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

// ── Event consolidation ───────────────────────────────────────────────────────
// A single card swipe generates multiple rapid-fire audit events from the
// gateway (e.g. 0x0540 + 0x1300 + 0x1301 + 0x1302 all within ~5ms).  We buffer
// events per device and flush once they stop arriving, producing one consolidated
// event log entry and one access-swipe-feed entry per physical card presentation.

const EVENT_CONSOLIDATION_MS = 500; // flush after this quiet period
const eventBuffer = new Map(); // key = “sn:linkId” → { timer, items[] }

// Store last denied card raw data per lock — for “Learn Card from Swipe” feature
const lastDeniedCard = new Map(); // key = linkId → { cardBitCount, rawCardHex, clearPrimeCrHex, cardNumber, facilityCode, timestamp }

const LOCK_STATE_MAP = {
  '0f000000': 'passage',
  '0f010000': 'secure',
  '0f020000': 'momentaryUnlock',
};

function auditCodeValue(auditCode) {
  if (typeof auditCode === 'number') return auditCode;
  const raw = String(auditCode || '').replace(/^0x/i, '');
  if (raw.length >= 4) return parseInt(raw.slice(0, 4), 16);
  return Number.parseInt(raw, 10) || 0;
}

function isCredentialNarrativeEvent(auditCode) {
  const code = auditCodeValue(auditCode);
  return new Set([
    0x0508,
    0x0509,
    0x050A,
    0x050B,
    0x050C,
    0x050D,
    0x050E,
    0x0540,
    0x0541,
    0x1300,
  ]).has(code);
}

/**
 * Parse a single gateway event into a structured item we can merge later.
 */
function parseGatewayEvent(sn, event) {
  let body = {};
  try {
    body = typeof event.eventBody === 'string'
      ? JSON.parse(event.eventBody)
      : (event.eventBody || {});
  } catch { /* ignore */ }

  const container = body.edgeDevice || body.gateway || {};
  const audits = Array.isArray(container.audits) ? container.audits : [];
  logGatewayEventProcessing('RAW INPUT', {
    sn,
    source: event.eventSource,
    deviceId: event.eventDeviceId,
    eventId: event.eventId,
    rawEventType: event.eventType,
    auditCount: audits.length,
    explanation: audits.length > 0
      ? 'EGW sent an audits[] payload. This project will evaluate each audit entry and derive workbook Event/Data from the audit code.'
      : 'EGW did not send audits[]. This project will fall back to event.eventType and try to map that value to the workbook.',
    rawPayload: event.eventBody,
  });
  traceGatewayEvent('raw_input', {
    sn,
    eventId: event.eventId,
    eventType: event.eventType,
    eventSource: event.eventSource,
    eventDeviceId: event.eventDeviceId,
    auditCount: audits.length,
    explanation: audits.length > 0
      ? 'Used EGW audits[] payload as the source for downstream parsing.'
      : 'audits[] missing; downstream parsing will fall back to EGW eventType.',
    rawEventBody: event.eventBody,
  });

  // Flatten multi-audit messages into individual items
  const items = [];
  if (audits.length > 1) {
    const sourceKey = body.edgeDevice ? 'edgeDevice' : (body.gateway ? 'gateway' : null);
    audits.forEach(auditItem => {
      const code = auditItem?.event || event.eventType;
      const scopedBody = sourceKey
        ? { ...body, [sourceKey]: { ...container, audits: [auditItem] } }
        : body;
      items.push({
        sn,
        auditCode: code,
        linkId: container.linkId || event.eventDeviceId,
        source: event.eventSource,
        body: scopedBody,
        rawBody: typeof event.eventBody === 'string' ? JSON.stringify(scopedBody) : scopedBody,
        container,
        mergedAccessBody: { ...body, ...container, ...auditItem },
        credentialReport: container.credentialReport || null,
      });
    });
  } else {
    const code = audits.length > 0 ? audits[0].event : event.eventType;
    items.push({
      sn,
      auditCode: code,
      linkId: container.linkId || event.eventDeviceId,
      source: event.eventSource,
      body,
      rawBody: event.eventBody,
      container,
      mergedAccessBody: { ...body, ...container, ...(audits[0] || {}) },
      credentialReport: container.credentialReport || null,
    });
  }

  items.forEach((item, index) => {
    const workbook = lookupWorkbookRow(item.auditCode);
    logGatewayEventProcessing(`PARSED ITEM #${index + 1}`, {
      sn,
      source: item.source,
      deviceId: item.linkId,
      rawEventType: event.eventType,
      auditCode: item.auditCode,
      category: lookupEvent(item.auditCode).category,
      title: lookupEvent(item.auditCode).title,
      mappingStatus: workbook.matched ? 'Matched ENGAGE - Audits - 0.22.xlsm row' : 'No workbook row match',
      caption: workbook.caption || '',
      eventHex: workbook.eventHex,
      dataHex: workbook.dataHex,
      dataDescription: workbook.dataDescription || '',
      explanation: audits.length > 0
        ? 'Item came from audits[] entry supplied by EGW.'
        : 'Item came from fallback event.eventType because audits[] was absent.',
      rawPayload: item.rawBody,
    });
    traceGatewayEvent('parsed_item', {
      sn,
      itemIndex: index + 1,
      source: item.source,
      linkId: item.linkId,
      rawEventType: event.eventType,
      auditCode: item.auditCode,
      workbookMapping: workbook,
      appLookup: lookupEvent(item.auditCode),
      explanation: audits.length > 0
        ? 'Parsed from EGW audits[] entry.'
        : 'Parsed from fallback event.eventType.',
      rawPayload: item.rawBody,
    });
  });

  return items;
}

/**
 * Flush a consolidated event group: emit one event-log entry and one access event.
 */
function flushEventGroup(items) {
  if (items.length === 0) return;

  const sn = items[0].sn;
  const linkId = items[0].linkId;
  const ts = new Date().toISOString();

  // Collect data across all items in the group
  let primaryItem = null;       // the main Access event (granted/denied)
  let detailItem = null;        // more-specific Access event (e.g. 0x1300 with reason)
  let credentialReport = null;
  let cardBitCount = null;
  const lockStateChanges = [];

  for (const item of items) {
    const lookup = lookupEvent(item.auditCode);

    // Grab credentialReport from any item that has it
    if (!credentialReport && item.credentialReport?.length) {
      credentialReport = item.credentialReport;
    }

    // Extract card bit count from 0x1300 audit data
    const bits = extractCardBitCount(item.auditCode);
    if (bits) cardBitCount = bits;

    // Track lock state changes
    const mappedState = LOCK_STATE_MAP[String(item.auditCode).toLowerCase()];
    if (mappedState) lockStateChanges.push(mappedState);

    // Pick the primary event — prefer the most specific Access event
    if (lookup.category === 'Access') {
      if (!primaryItem) {
        primaryItem = item;
      } else {
        // Prefer event with a more specific reason (e.g. 0x1300 over 0x0540)
        const prevLookup = lookupEvent(primaryItem.auditCode);
        const prevReason = buildReason(primaryItem.auditCode, primaryItem.body);
        const curReason = buildReason(item.auditCode, item.body);
        if (!prevReason && curReason) {
          // Swap: current becomes primary, previous becomes detail
          detailItem = primaryItem;
          primaryItem = item;
        } else if (!detailItem) {
          detailItem = item;
        }
      }
    }
  }

  // Apply lock state changes
  for (const mappedState of lockStateChanges) {
    if (linkId) {
      const list = devices.get(sn);
      if (list) {
        list.forEach(d => { if (d.linkId === linkId) d.lockState = mappedState; });
        broadcast('device:list', { sn, devices: list });
      }
    }
  }

  // Extract card data embedded in 0x1300-series audit codes (fallback when credentialReport is absent)
  const allAuditCodes = items.map(i => i.auditCode);
  const auditCardData = extractCardDataFromAuditCodes(allAuditCodes);
  if (auditCardData.cardBitCount && !cardBitCount) cardBitCount = auditCardData.cardBitCount;

  // ── "Learn Card from Swipe" — capture raw card bytes on denied events ──
  // Per Allegion training: audit events 0x1301-0x1304 contain the raw card bytes
  // in reverse order. These are the EXACT bytes the lock reads from the card,
  // left-shifted to byte boundary. We store them so the user can "enroll" the card
  // by using these exact bytes as the clear PrimeCR (pad with 0xFF, encrypt, push).
  if (linkId && auditCardData.clearPrimeCrHex) {
    const isDenied = items.some(i => {
      const l = lookupEvent(i.auditCode);
      return l.result === 'denied';
    });
    if (isDenied) {
      const deniedInfo = {
        cardBitCount: auditCardData.cardBitCount,
        rawCardHex: auditCardData.rawCardHex,
        clearPrimeCrHex: auditCardData.clearPrimeCrHex,
        cardNumber: auditCardData.cardNumber,
        facilityCode: auditCardData.facilityCode,
        timestamp: ts,
        auditCodes: allAuditCodes,
      };
      lastDeniedCard.set(linkId, deniedInfo);
      console.log(`[LearnCard] Captured denied card on ${linkId}: ${auditCardData.cardBitCount}-bit, raw=${auditCardData.rawCardHex}, clearPrimeCr=${auditCardData.clearPrimeCrHex}`);
      logGatewayEventProcessing('AUDIT CARD EXTRACTION', {
        sn,
        source: items[0]?.source,
        deviceId: linkId,
        category: 'Access',
        title: 'Denied credential extracted from 0x1300-series audit events',
        reason: auditCardData.cardNumber ? `Decoded card ${auditCardData.cardNumber}` : '',
        explanation: 'This project reconstructed raw card bytes from EGW audit events 0x1301-0x1304 for Learn Card from Swipe.',
        rawPayload: deniedInfo,
      });
      traceGatewayEvent('audit_card_extraction', {
        sn,
        source: items[0]?.source,
        linkId,
        explanation: 'Reconstructed raw card bytes and clear PrimeCR from 0x1300-series EGW audit events.',
        extracted: deniedInfo,
      });
      broadcast('denied-card', { linkId, ...deniedInfo });
    }
  }

  // Inject credentialReport into the primary item's mergedAccessBody if found in any sibling
  if (primaryItem && credentialReport) {
    primaryItem.mergedAccessBody.credentialReport = credentialReport;
  }

  // Build the consolidated event-log entry from the primary access event (or first item)
  const mainItem = primaryItem || items[0];
  const mainLookup = lookupEvent(mainItem.auditCode);

  // Combine titles from primary + detail for a richer description
  const detailLookup = detailItem ? lookupEvent(detailItem.auditCode) : null;
  const combinedTitle = detailLookup && detailLookup.title !== mainLookup.title
    ? `${mainLookup.title} — ${detailLookup.title}`
    : mainLookup.title;
  const combinedReason = buildReason(mainItem.auditCode, mainItem.body)
    || (detailItem ? buildReason(detailItem.auditCode, detailItem.body) : '')
    || '';

  const entry = {
    sn,
    eventType: mainItem.auditCode,
    category: mainLookup.category,
    title: combinedTitle,
    result: mainLookup.result,
    reason: combinedReason,
    source: mainItem.source,
    deviceId: linkId,
    body: mainItem.rawBody,
    timestamp: ts,
    workbookMapping: lookupWorkbookRow(mainItem.auditCode),
  };

  logGatewayEventProcessing('FINAL APP EVENT', {
    sn,
    source: mainItem.source,
    deviceId: linkId,
    auditCode: mainItem.auditCode,
    category: entry.category,
    title: entry.title,
    reason: entry.reason,
    mappingStatus: entry.workbookMapping?.matched ? 'Matched ENGAGE workbook row' : 'No workbook match',
    caption: entry.workbookMapping?.caption || '',
    eventHex: entry.workbookMapping?.eventHex || '',
    dataHex: entry.workbookMapping?.dataHex || '',
    dataDescription: entry.workbookMapping?.dataDescription || '',
    explanation: 'This is the normalized event stored by the project and sent to the dashboard/API Playground.',
    rawPayload: entry.body,
  });
  traceGatewayEvent('final_app_event', {
    sn,
    source: mainItem.source,
    linkId,
    auditCode: mainItem.auditCode,
    workbookMapping: entry.workbookMapping,
    finalEvent: {
      eventType: entry.eventType,
      category: entry.category,
      title: entry.title,
      result: entry.result,
      reason: entry.reason,
      source: entry.source,
      deviceId: entry.deviceId,
      timestamp: entry.timestamp,
    },
    explanation: 'Normalized event emitted by this project after processing EGW raw input and workbook mapping.',
    rawPayload: entry.body,
  });

  // Build access event if the primary event is an Access category
  const lockInfo = linkId ? findLock(linkId, sn) : null;
  if (mainLookup.category === 'Access' && isCredentialNarrativeEvent(mainItem.auditCode)) {
    const accessLookup = accessService.resolveAccessEvent(linkId, mainItem.mergedAccessBody);
    const lockName = lockInfo?.deviceName || linkId || 'Unknown Lock';

    // Use audit-code-extracted card data as fallback when credentialReport decryption has no result
    let presentedCardNumber = accessLookup.presentedCardNumber || null;
    let decodedCredential = accessLookup.decodedCredential || null;
    if (!presentedCardNumber && auditCardData.cardNumber) {
      presentedCardNumber = auditCardData.cardNumber;
      // Build a synthetic decodedCredential from audit code data
      const allFormats = [
        ...require('../src/defaultCardFormats').map(f => ({ ...f, source: 'builtin', id: f.value })),
        ...(accessService.store.getSnapshot().customCardFormats || []).map(f => ({ ...f, source: 'custom' })),
      ];
      const matchedFormat = cardBitCount
        ? allFormats.find(f => f.payload && Number(f.payload.total_card_bits) === cardBitCount)
        : null;
      decodedCredential = {
        cardNumber: auditCardData.cardNumber,
        facilityCode: auditCardData.facilityCode,
        formatLabel: matchedFormat?.label || (cardBitCount ? `${cardBitCount}-bit` : null),
        formatValue: matchedFormat?.value || null,
        formatSource: matchedFormat?.source || null,
        formatId: matchedFormat?.source === 'custom' ? matchedFormat.id : (matchedFormat?.value || null),
        totalBits: cardBitCount,
      };
    }

    // Rebuild subject with card data if we now have it
    const subject = accessLookup.user?.name
      ? accessLookup.user.name
      : accessLookup.user
        ? `User ${accessLookup.user.usrID}`
        : presentedCardNumber
          ? `Card ${presentedCardNumber}`
          : accessLookup.subject;

    const detail = combinedTitle
      ? combinedTitle.replace(/^Access Granted(?: \(Pass-Through\)| \(One-Time Use\))?$/i, '').replace(/^Denied\s+[—-]\s*/i, '').trim()
      : '';
    const prefix = mainLookup.result === 'granted'
      ? 'Access granted'
      : mainLookup.result === 'denied'
        ? 'Access denied'
        : (entry.title || 'Access event');

    let friendlyText = `${prefix} for ${subject} at ${lockName}`;
    if (mainLookup.result === 'denied') {
      const denialDetail = detail || combinedReason || '';
      if (denialDetail) friendlyText += ` — ${denialDetail}`;
    }

    entry.displaySubject = subject;
    entry.lockName = lockName;
    entry.friendlyText = friendlyText;
    entry.presentedCardNumber = presentedCardNumber;
    entry.decodedCredential = decodedCredential;
    entry.cardBitCount = cardBitCount || null;

    const accessEvent = {
      id: `${ts}-${sn}-${linkId || 'gateway'}`,
      sn,
      linkId,
      lockName,
      result: mainLookup.result,
      title: combinedTitle,
      friendlyText,
      subject,
      presentedCardNumber,
      decodedCredential,
      cardBitCount: cardBitCount || null,
      timestamp: ts,
      user: accessLookup.user,
      reason: combinedReason,
    };
    recentAccessEvents.unshift(accessEvent);
    if (recentAccessEvents.length > 25) recentAccessEvents.pop();
    broadcast('access:event', accessEvent);
  }

  auditStore.insert(entry);
  broadcast('engage:event', entry);
}

// Forward gateway events to SSE clients, enriched with human-readable metadata
server.on('engage:event', ({ sn, event }) => {
  // ── Detailed event log ──────────────────────────────────────────────────────
  const ts = new Date().toISOString();
  const rawBodyStr = typeof event.eventBody === 'string'
    ? event.eventBody
    : JSON.stringify(event.eventBody);
  console.log(`\n╔══ GW EVENT [${ts}] ══════════════════════════════════`);
  console.log(`║  Gateway SN : ${sn}`);
  console.log(`║  Event ID   : ${event.eventId}`);
  console.log(`║  Event Type : ${event.eventType}`);
  console.log(`║  Source     : ${event.eventSource}`);
  console.log(`║  Device ID  : ${event.eventDeviceId || '—'}`);
  console.log(`║  Body       : ${rawBodyStr}`);
  console.log(`╚═══════════════════════════════════════════════════════`);

  recordGatewayTraffic({
    sn,
    category: 'gateway-event',
    method: 'EVENT',
    path: `/events/${event.eventSource || 'gateway'}`,
    responseStatus: 'event',
    durationMs: 0,
    source: 'gateway',
    responseBody: {
      eventId: event.eventId,
      eventType: event.eventType,
      eventSource: event.eventSource,
      eventDeviceId: event.eventDeviceId,
      eventBody: parseJsonSafe(event.eventBody) ?? event.eventBody,
    },
  });

  const parsed = parseGatewayEvent(sn, event);

  for (const item of parsed) {
    const bufferKey = `${sn}:${item.linkId || 'gateway'}`;
    let group = eventBuffer.get(bufferKey);

    if (!group) {
      group = { timer: null, items: [] };
      eventBuffer.set(bufferKey, group);
    }

    // Clear previous flush timer — more events are arriving
    if (group.timer) clearTimeout(group.timer);

    group.items.push(item);

    // Schedule flush after quiet period
    group.timer = setTimeout(() => {
      eventBuffer.delete(bufferKey);
      flushEventGroup(group.items);
    }, EVENT_CONSOLIDATION_MS);
  }
});

// ── Mount dashboard routes (before startServer) ────────────────────────────────

const app = server.app;

function parseGatewayRequestBody(req) {
  if (req.body == null) return '';
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (typeof req.body === 'string') return req.body;
  if (typeof req.body === 'object' && Object.keys(req.body).length === 0) return '';
  return JSON.stringify(req.body);
}

function gatewayResponsePayload(response) {
  return parseJsonSafe(response?.responseMessageBody) ?? response?.responseMessageBody ?? null;
}

function multipleGatewaySelectionError(res) {
  return res.status(400).json({
    error: 'Multiple gateways are connected. Specify the target gateway with the X-Gateway-SN header or gateway_sn query parameter.',
    connectedGateways: Array.from(gateways.keys()),
  });
}

async function proxyGatewayRoute(req, res, options = {}) {
  const sn = resolveGatewaySn(req, options.gatewaySn);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }

  const method = options.method || req.method;
  const reqPath = options.path || req.path;
  const body = Object.prototype.hasOwnProperty.call(options, 'body')
    ? options.body
    : parseGatewayRequestBody(req);

  const response = await request(sn, method, reqPath, body, options.timeoutSec || 30, {
    category: 'compat-route',
    source: 'postman-compat',
    notes: options.notes || null,
  });

  if (!response) {
    if (typeof options.onTimeout === 'function') {
      return res.status(200).json(options.onTimeout(sn));
    }
    return res.status(503).json({ error: `Gateway ${sn} did not respond`, gateway_sn: sn, path: reqPath });
  }

  if (typeof options.onSuccess === 'function') {
    await options.onSuccess(response, sn);
  }

  const parsed = gatewayResponsePayload(response);
  const httpStatus = Number.parseInt(response.responseStatus, 10);
  if (Number.isFinite(httpStatus)) {
    return res.status(httpStatus).json(parsed ?? {});
  }
  return res.json(parsed ?? {});
}

// Static files (serves public/index.html at /)
app.use(express.static(path.join(__dirname, '../public')));

app.get('/gateway/newCredentials', requireDefaultGatewayAuth, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available to initialize credentials for' });
  }

  const username = `gateway-${sn.slice(-8).toLowerCase()}`;
  const password = crypto.randomBytes(18).toString('base64url');
  const pending = {
    username,
    password,
    targetSn: sn,
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
  };
  gatewayPendingCredentials.set(sn, pending);

  res.json({
    user: pending.username,
    password: pending.password,
    gateway_sn: sn,
    message: 'Call PUT /gateway/newCredentials with the default credentials to commit this API session.',
  });
});

app.put('/gateway/newCredentials', requireDefaultGatewayAuth, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available to commit credentials for' });
  }

  const pending = gatewayPendingCredentials.get(sn);
  if (!pending) {
    return res.status(409).json({ error: 'No pending gateway credentials exist. Call GET /gateway/newCredentials first.' });
  }

  for (const [username, session] of gatewayCommittedCredentials.entries()) {
    if (session.targetSn === sn) {
      gatewayCommittedCredentials.delete(username);
    }
  }

  const committed = {
    ...pending,
    committedAt: new Date().toISOString(),
    committedAtMs: Date.now(),
  };
  gatewayCommittedCredentials.set(committed.username, committed);
  gatewayPendingCredentials.delete(sn);

  res.json({
    user: committed.username,
    password: committed.password,
    gateway_sn: sn,
    committedAt: committed.committedAt,
  });
});

app.get('/gateway/time', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onTimeout: (sn) => getGatewayTimeSnapshot(sn),
  });
});

app.put('/gateway/config', requireGatewayApiSession, parseJsonBody, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/gateway/deviceInfo', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onTimeout: (sn) => getGatewayDeviceSnapshot(sn),
  });
});

app.get('/gateway/scanList', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onTimeout: (sn) => getGatewayScanSnapshot(sn),
  });
});

app.post('/edgeDevices', requireGatewayApiSession, parseJsonBody, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onSuccess: async (_response, sn) => { await discoverDevices(sn); },
  });
});

app.get('/edgeDevices/linkList', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onSuccess: async (_response, sn) => { await discoverDevices(sn); },
  });
});

app.put('/edgeDevices/lockControl', requireGatewayApiSession, parseJsonBody, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/edgeDevices/lockStatus', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.delete('/edgeDevices/:linkId', requireGatewayApiSession, async (req, res, next) => {
  if (req.params.linkId === 'audits') return next();
  await proxyGatewayRoute(req, res, {
    onSuccess: async (_response, sn) => { await discoverDevices(sn); },
  });
});

app.put('/edgeDevices/:linkId/database', requireGatewayApiSession, parseJsonBody, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onSuccess: async (response, sn) => {
      const linkId = req.params.linkId;
      updateDatabasePushState(linkId, {
        sn,
        status: String(response.responseStatus) === '200' ? 'in-progress' : 'failed',
        progress: 0,
        responseStatus: response.responseStatus,
        rawPushResponse: gatewayResponsePayload(response),
        requestPayload: parseJsonSafe(parseGatewayRequestBody(req)) ?? parseGatewayRequestBody(req),
        summary: { mode: 'compat-database' },
      });
      if (String(response.responseStatus) === '200') {
        startDbStatusPolling(sn, linkId);
      }
    },
  });
});

app.delete('/edgeDevices/:linkId/database', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res, {
    onSuccess: async (response, sn) => {
      const linkId = req.params.linkId;
      if (databasePollers.has(linkId)) {
        clearInterval(databasePollers.get(linkId));
        databasePollers.delete(linkId);
      }
      updateDatabasePushState(linkId, {
        sn,
        status: String(response.responseStatus) === '200' ? 'cancelled' : 'failed',
        progress: null,
        responseStatus: response.responseStatus,
        rawCancelResponse: gatewayResponsePayload(response),
      });
    },
  });
});

app.get('/edgeDevices/:linkId/dbDownloadStatus', requireGatewayApiSession, async (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  try {
    const liveStatus = await fetchDbDownloadStatus(sn, req.params.linkId);
    updateDatabasePushState(req.params.linkId, {
      sn,
      status: liveStatus.state,
      progress: liveStatus.progress,
      rawStatus: liveStatus.raw,
      responseStatus: liveStatus.responseStatus,
    });
    res.json(liveStatus.raw ?? liveStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/edgeDevices/:linkId/config', requireGatewayApiSession, parseJsonBody, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.delete('/edgeDevices/:linkId/config', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/edgeDevices/:linkId/params', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/edgeDevices/:linkId/audits', requireGatewayApiSession, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  res.json({
    linkId: req.params.linkId,
    gateway_sn: sn,
    audits: filterAuditEntries(req.params.linkId, sn),
  });
});

app.delete('/edgeDevices/:linkId/audits', requireGatewayApiSession, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  const removed = auditStore.deleteWhere(entry =>
    entry.sn === sn && String(entry.linkId || '') === String(req.params.linkId)
  );
  res.json({
    linkId: req.params.linkId,
    gateway_sn: sn,
    cleared: removed,
  });
});

app.get('/edgeDevices/audits', requireGatewayApiSession, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  res.json({
    gateway_sn: sn,
    audits: filterAuditEntries(null, sn),
  });
});

app.delete('/edgeDevices/audits', requireGatewayApiSession, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  const removed = auditStore.deleteWhere(entry => entry.sn === sn);
  res.json({
    gateway_sn: sn,
    cleared: removed,
  });
});

app.put('/edgeDevices/:linkId/lockControl', requireGatewayApiSession, parseJsonBody, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/edgeDevices/:linkId/lockStatus', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/edgeDevices/:linkId/time', requireGatewayApiSession, async (req, res) => {
  await proxyGatewayRoute(req, res);
});

app.get('/gateway/gatewayNetworkStatistics', requireGatewayApiSession, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  res.json(getGatewayNetworkStatisticsSnapshot(sn));
});

app.get('/gateway/gatewayEventLog', requireGatewayApiSession, (req, res) => {
  const sn = resolveGatewaySn(req);
  if (!sn) {
    if (gateways.size > 1) return multipleGatewaySelectionError(res);
    return res.status(404).json({ error: 'No connected gateway is available' });
  }
  res.json(getGatewayEventLogSnapshot(sn));
});

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

  const validActions = ['secure', 'passage', 'momentaryUnlock', 'frozenSecure', 'frozenPassage'];
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
// GET /api/access/lock-settings/:linkId â€” Fetch current reader/audit settings for one lock
app.get('/api/access/lock-settings/:linkId', async (req, res) => {
  const linkId = req.params.linkId;
  const lockInfo = findLock(linkId, req.query.gateway_sn || null);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const response = await request(lockInfo.sn, 'GET', `/edgeDevices/${linkId}/params`, '', 15);
    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond to the lock settings request' });
    }
    if (String(response.responseStatus) !== '200') {
      const statusCode = Number.parseInt(response.responseStatus, 10);
      return res.status(Number.isFinite(statusCode) ? statusCode : 502).json({
        error: responseErrorMessage(response, `Lock settings request failed (${response.responseStatus})`),
      });
    }

    res.json({
      ok: true,
      lock: lockInfo,
      settings: {
        ...normalizeLockSettings(response.responseMessageBody),
        fetchedAt: new Date().toISOString(),
        responseStatus: response.responseStatus,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/access/lock-settings/:linkId â€” Update reader/audit settings for one lock
app.put('/api/access/lock-settings/:linkId', parseJsonBody, async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.body?.gateway_sn || req.query.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const payload = buildLockSettingsConfig(req.body?.values || {});
    const response = await request(
      lockInfo.sn,
      'PUT',
      `/edgeDevices/${linkId}/config`,
      JSON.stringify(payload),
      20
    );

    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond to the lock settings update' });
    }
    if (String(response.responseStatus) !== '200') {
      const statusCode = Number.parseInt(response.responseStatus, 10);
      return res.status(Number.isFinite(statusCode) ? statusCode : 502).json({
        error: responseErrorMessage(response, `Lock settings update failed (${response.responseStatus})`),
      });
    }

    let settings = {
      ...normalizeLockSettings({ config: payload.config }),
      fetchedAt: new Date().toISOString(),
      responseStatus: response.responseStatus,
    };

    const readBack = await request(lockInfo.sn, 'GET', `/edgeDevices/${linkId}/params`, '', 15);
    if (readBack && String(readBack.responseStatus) === '200') {
      settings = {
        ...normalizeLockSettings(readBack.responseMessageBody),
        fetchedAt: new Date().toISOString(),
        responseStatus: readBack.responseStatus,
      };
    }

    res.json({
      ok: true,
      lock: lockInfo,
      settings,
      response: parseJsonSafe(response.responseMessageBody) ?? response.responseMessageBody,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

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

    const requestPayload = preview.payload;
    const response = await request(
      lockInfo.sn,
      'PUT',
      `/edgeDevices/${linkId}/database`,
      JSON.stringify(requestPayload),
      20
    );

    if (!response) {
      updateDatabasePushState(linkId, {
        sn: lockInfo.sn,
        status: 'failed',
        error: 'Gateway did not respond to the database push request',
        requestPayload,
        summary: preview.summary,
      });
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
      requestPayload,
      summary: preview.summary,
    });
    startDbStatusPolling(lockInfo.sn, linkId);

    res.json({
      ok: String(response.responseStatus) === '200',
      lock: lockInfo,
      preview: preview.summary,
      initialResponse: rawResponse ?? response.responseMessageBody,
      requestPayload,
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

// GET /api/access/pull/:linkId — Read lock DB status via dbDownloadStatus
// NOTE: ENGAGE gateway does not support GET on /database — only PUT.
// The dbDownloadStatus endpoint returns userCount, scheduleCount, state, etc.
app.get('/api/access/pull/:linkId', async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.query.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const liveStatus = await fetchDbDownloadStatus(lockInfo.sn, linkId);
    const pushState = updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: liveStatus.state,
      progress: liveStatus.progress,
      rawStatus: liveStatus.raw,
      responseStatus: liveStatus.responseStatus,
    });
    res.json({
      ok: true,
      lockStatus: liveStatus,
      pushState,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/access/rawpush/:linkId — Push a raw doorfile for diagnostic testing.
// Accepts a complete JSON payload OR a raw encryptedPrimeCr hex to test with.
// This bypasses our encoding entirely so we can isolate whether the issue is
// our PrimeCR encoding or the database delivery mechanism.
app.post('/api/access/rawpush/:linkId', parseJsonBody, async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.body?.gateway_sn || req.query.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    let payload;

    if (req.body?.rawPayload) {
      // Use caller-provided full payload
      payload = req.body.rawPayload;
    } else if (req.body?.encryptedPrimeCr) {
      // Build minimal spec-conforming doorfile with caller's encrypted PrimeCR
      payload = {
        db: {
          usrRcrd: {
            deleteAll: 1,
            delete: [],
            update: [],
            add: [{
              usrID: Number(req.body.usrID) || 20020,
              adaEn: 0,
              fnctn: 'norm',
              crSch: 1,
              actDtTm: '20000101000000',
              expDtTm: '21350101000000',
              primeCr: String(req.body.encryptedPrimeCr).trim(),
              prCrTyp: 'card',
              scndCrTyp: 'null',
            }],
          },
          schedules: [{
            days: ['Su','Mo','Tu','We','Th','Fr','Sa'],
            strtHr: 0, strtMn: 0, lngth: 1440,
          }],
          holidays: [],
          autoUnlock: [],
        },
        dbDwnLdTm: '',
        nxtDbVerTS: `0x${Date.now().toString(16).padStart(16, '0')}`,
      };
    } else {
      return res.status(400).json({
        error: 'Provide either rawPayload (full JSON) or encryptedPrimeCr (hex string)',
        example: {
          encryptedPrimeCr: '2ccdb42e3c61b8b23385f832fcb7b7f8',
          gateway_sn: lockInfo.sn,
        },
      });
    }

    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    console.log(`[RawPush] Sending raw doorfile to ${linkId}:`, payloadStr.slice(0, 500));

    const response = await request(lockInfo.sn, 'PUT', `/edgeDevices/${linkId}/database`, payloadStr, 20);
    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond' });
    }

    const rawResponse = parseJsonSafe(response.responseMessageBody);
    updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: String(response.responseStatus) === '200' ? 'pushing' : 'failed',
      progress: 0,
      rawPushResponse: rawResponse ?? response.responseMessageBody,
      responseStatus: response.responseStatus,
      requestPayload: payload,
      summary: { mode: 'raw-diagnostic' },
    });

    if (String(response.responseStatus) === '200') {
      startDbStatusPolling(lockInfo.sn, linkId);
    }

    res.json({
      ok: String(response.responseStatus) === '200',
      responseStatus: response.responseStatus,
      sentPayload: payload,
      gatewayResponse: rawResponse ?? response.responseMessageBody,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/access/last-denied/:linkId — Get the last denied card raw data for "Learn Card from Swipe"
app.get('/api/access/last-denied/:linkId', (req, res) => {
  const linkId = req.params.linkId;
  const denied = lastDeniedCard.get(linkId);
  if (!denied) {
    return res.json({ ok: false, message: 'No denied card captured yet. Swipe a card on the lock first.' });
  }
  // Encrypt the clear PrimeCR for preview
  let encryptedPrimeCrHex = null;
  try {
    const siteKey = accessService._cachedSiteKey || (() => {
      try { return require('fs').readFileSync(accessService.siteKeyFile, 'utf8').trim(); } catch { return null; }
    })();
    if (siteKey && denied.clearPrimeCrHex) {
      const result = encryptClearPrimeCr(denied.clearPrimeCrHex, siteKey);
      encryptedPrimeCrHex = result.encryptedHex;
    }
  } catch (err) {
    console.warn('[LearnCard] Failed to encrypt:', err.message);
  }

  res.json({
    ok: true,
    linkId,
    ...denied,
    encryptedPrimeCrHex,
  });
});

// POST /api/access/enroll-swipe/:linkId — Enroll the last denied card using raw bytes from audit events
// This uses the EXACT bytes the lock read from the card → guaranteed PrimeCR match
app.post('/api/access/enroll-swipe/:linkId', parseJsonBody, async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.body?.gateway_sn || req.query.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  const denied = lastDeniedCard.get(linkId);
  if (!denied || !denied.clearPrimeCrHex) {
    return res.status(400).json({ error: 'No denied card captured. Swipe a card on the lock first.' });
  }

  try {
    const siteKey = accessService._cachedSiteKey || (() => {
      try { return require('fs').readFileSync(accessService.siteKeyFile, 'utf8').trim(); } catch { return null; }
    })();
    if (!siteKey) {
      return res.status(500).json({ error: 'Site key not available' });
    }

    const { encryptedHex, clearHex } = encryptClearPrimeCr(denied.clearPrimeCrHex, siteKey);
    const userName = req.body?.name || `Swiped Card (${denied.cardBitCount}-bit)`;
    const usrID = Number(req.body?.usrID) || (20000 + Math.floor(Math.random() * 40000));

    // Build doorfile matching Allegion's exact format
    const payload = {
      db: {
        usrRcrd: {
          deleteAll: 1,
          delete: [],
          update: [],
          add: [{
            usrID,
            adaEn: 0,
            fnctn: 'norm',
            crSch: 1,
            actDtTm: '20000101000000',
            expDtTm: '21350101000000',
            primeCr: encryptedHex,
            prCrTyp: 'card',
            scndCrTyp: 'null',
          }],
        },
        schedules: [{
          days: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
          strtHr: 0, strtMn: 0, lngth: 1440,
        }],
        holidays: [],
        autoUnlock: [],
      },
      dbDwnLdTm: '',
      nxtDbVerTS: `0x${Date.now().toString(16).padStart(16, '0')}`,
    };

    console.log(`[EnrollSwipe] Enrolling swiped card on ${linkId}: usrID=${usrID}, clearPrimeCr=${clearHex}, encryptedPrimeCr=${encryptedHex}`);
    console.log(`[EnrollSwipe] Payload:`, JSON.stringify(payload));

    const response = await request(lockInfo.sn, 'PUT', `/edgeDevices/${linkId}/database`, JSON.stringify(payload), 20);
    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond' });
    }

    const rawResponse = parseJsonSafe(response.responseMessageBody);
    const ok = String(response.responseStatus) === '200';

    updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: ok ? 'pushing' : 'failed',
      progress: 0,
      rawPushResponse: rawResponse ?? response.responseMessageBody,
      responseStatus: response.responseStatus,
      requestPayload: payload,
      summary: {
        mode: 'enroll-swipe',
        userCount: 1,
        usrID,
        cardBitCount: denied.cardBitCount,
        rawCardHex: denied.rawCardHex,
        clearPrimeCrHex: clearHex,
        encryptedPrimeCrHex: encryptedHex,
        cardNumber: denied.cardNumber,
        facilityCode: denied.facilityCode,
      },
    });

    if (ok) {
      startDbStatusPolling(lockInfo.sn, linkId);
    }

    res.json({
      ok,
      responseStatus: response.responseStatus,
      enrolled: {
        usrID,
        cardBitCount: denied.cardBitCount,
        rawCardHex: denied.rawCardHex,
        clearPrimeCrHex: clearHex,
        encryptedPrimeCrHex: encryptedHex,
        cardNumber: denied.cardNumber,
        facilityCode: denied.facilityCode,
      },
      sentPayload: payload,
      gatewayResponse: rawResponse ?? response.responseMessageBody,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/access/clear/:linkId — Clear all credentials from the lock
app.post('/api/access/clear/:linkId', parseJsonBody, async (req, res) => {
  const linkId = req.params.linkId;
  const gatewaySn = req.body?.gateway_sn || req.query.gateway_sn || null;
  const lockInfo = findLock(linkId, gatewaySn);
  if (!lockInfo) {
    return res.status(404).json({ error: `Lock ${linkId} was not found` });
  }

  try {
    const clearPayload = {
      db: {
        usrRcrd: { deleteAll: 1, delete: [], update: [], add: [] },
        schedules: [{ days: ['Su','Mo','Tu','We','Th','Fr','Sa'], strtHr: 0, strtMn: 0, lngth: 1440 }],
        holidays: [],
        autoUnlock: [],
      },
      dbDwnLdTm: '',
      nxtDbVerTS: `0x${Date.now().toString(16).padStart(16, '0')}`,
    };

    const response = await request(
      lockInfo.sn,
      'PUT',
      `/edgeDevices/${linkId}/database`,
      JSON.stringify(clearPayload),
      20
    );

    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond to the clear database request' });
    }

    const rawResponse = parseJsonSafe(response.responseMessageBody);
    updateDatabasePushState(linkId, {
      sn: lockInfo.sn,
      status: String(response.responseStatus) === '200' ? 'clearing' : 'failed',
      progress: 0,
      rawPushResponse: rawResponse ?? response.responseMessageBody,
      responseStatus: response.responseStatus,
      requestPayload: clearPayload,
      summary: { mode: 'clear-all', userCount: 0, scheduleCount: 1 },
    });

    if (String(response.responseStatus) === '200') {
      startDbStatusPolling(lockInfo.sn, linkId);
    }

    // Also clear local users assigned to this lock
    const clearLocal = req.body?.clearLocal !== false; // default true
    let removedUsers = 0;
    if (clearLocal) {
      accessService.store.mutate((state) => {
        const before = state.users.length;
        state.users = state.users.filter(u => {
          if (!Array.isArray(u.lockIds)) return true;
          // Remove this lock from the user's lockIds
          u.lockIds = u.lockIds.filter(id => id !== linkId);
          // If user has no more locks, remove them entirely
          return u.lockIds.length > 0;
        });
        removedUsers = before - state.users.length;
      });
    }

    res.json({
      ok: String(response.responseStatus) === '200',
      responseStatus: response.responseStatus,
      initialResponse: rawResponse ?? response.responseMessageBody,
      requestPayload: clearPayload,
      removedLocalUsers: removedUsers,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
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

// POST /api/playground/send — Generic proxy: send any ENGAGE WebSocket API request to a gateway
app.post('/api/playground/send', parseJsonBody, async (req, res) => {
  const { gateway_sn, method, path: reqPath, body: reqBody } = req.body || {};
  if (!gateway_sn || !method || !reqPath) {
    return res.status(400).json({ error: 'gateway_sn, method, and path are required' });
  }
  const validMethods = ['GET', 'POST', 'PUT', 'DELETE'];
  if (!validMethods.includes(method.toUpperCase())) {
    return res.status(400).json({ error: `method must be one of: ${validMethods.join(', ')}` });
  }
  const sn = gateway_sn.toUpperCase();
  if (!gateways.has(sn)) {
    return res.status(404).json({ error: `Gateway ${sn} is not connected` });
  }
  const bodyStr = reqBody ? (typeof reqBody === 'string' ? reqBody : JSON.stringify(reqBody)) : '';
  const sentAt = new Date().toISOString();
  try {
    const response = await request(sn, method.toUpperCase(), reqPath, bodyStr, 30, {
      category: 'playground-send',
      source: 'api-playground',
    });
    if (!response) {
      return res.status(503).json({ error: 'Gateway did not respond within timeout', sentAt, sentMethod: method.toUpperCase(), sentPath: reqPath, sentBody: reqBody || null });
    }
    const parsedBody = parseJsonSafe(response.responseMessageBody);
    res.json({
      ok: true,
      responseStatus: response.responseStatus,
      responseBody: parsedBody ?? response.responseMessageBody,
      sentAt,
      sentMethod: method.toUpperCase(),
      sentPath: reqPath,
      sentBody: reqBody || null,
      receivedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message, sentAt, sentMethod: method.toUpperCase(), sentPath: reqPath, sentBody: reqBody || null });
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
