// scripts/gateway-simulator.js
//
// Simulates a complete Schlage ENGAGE gateway client for local testing.
//
// What it does:
//   1. Performs the HTTPS credential handshake (POST /engage/newCredentials)
//   2. Opens a WebSocket connection using the returned one-time password
//   3. Receives the event subscription message from the server
//   4. Handles ALL incoming requests from the server and sends realistic responses:
//        - GET /gateway/scanList           → returns fake BLE scan results
//        - GET /edgeDevices/linkList       → returns two simulated edge devices
//        - GET /edgeDevices/lockStatus     → returns current lock states
//        - GET /edgeDevices/:id/lockStatus → status of a specific device
//        - PUT /edgeDevices/lockControl    → broadcast lock control (all devices)
//        - PUT /edgeDevices/:id/lockControl→ lock control for one device
//
// Usage (from project root):
//   node scripts\gateway-simulator.js [serialNumber]
//
// Default serial: AABBCCDDEEFF0011
// Run the server first:
//   node server.js
// Then in a second terminal run this script, then in a third terminal run:
//   node scripts\send-lock-commands.js

'use strict';

const crypto    = require('crypto');
const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const WebSocket = require('ws');

// ── Configuration ─────────────────────────────────────────────────────────────
const config      = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.json'), 'utf8'));
const SERVER_HOST   = '127.0.0.1';
const SERVER_PORT   = config.server_port || 8999;
const SSL_ENABLED   = config.ssl_info?.ssl_enabled === true;
const SITE_KEY_FILE = path.join(__dirname, '..', 'config', 'sitekey');

const SERIAL_NUMBER = process.argv[2]
  ? process.argv[2].toUpperCase()
  : 'AABBCCDDEEFF0011';

// ── Simulated devices attached to this gateway ────────────────────────────────
// lockState can be: 'locked' | 'unlocked' | 'momentaryUnlock'
const DEVICES = [
  { linkId: 'dev00001', mainSn: 'a100000000001234', deviceName: 'Front Door', modelType: 'nde' },
  { linkId: 'dev00002', mainSn: 'a100000000005678', deviceName: 'Back Door',  modelType: 'nde' },
];

// Mutable state map — updated when the server sends lock commands
const deviceState = {};
DEVICES.forEach(d => { deviceState[d.linkId] = 'locked'; });
const databaseTransferState = {};
const activeDoorfiles = {};
const lockConfigState = {};
DEVICES.forEach((device, index) => {
  lockConfigState[device.linkId] = {
    invCrdAudEn: index === 0 ? 'F' : 'T',
    auditIDEn: 'T',
    proxConfHID: 'T',
    proxConfGE4001: 'T',
    proxConfGE4002: 'F',
    proxConfAWID: 'T',
    proxConfGECASI: 'T',
    uid14443: 'F',
    mi14443: 'T',
    mip14443: 'T',
    noc14443: 'T',
    uid15693: 'T',
    iClsUID40b: 'T',
  };
});
let activeWs = null;

// ── AES-256-CBC Credential Challenge ─────────────────────────────────────────
// Mirrors exactly what a real gateway firmware does.
function buildCredentialBody(siteKey, sn) {
  // 16-byte timestamp (Unix seconds in the last 8 bytes, rest zeros)
  const tsBuf = Buffer.alloc(16, 0);
  tsBuf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 8);

  // 16-byte serial number (ASCII, zero-padded)
  const snBuf = Buffer.alloc(16, 0);
  Buffer.from(sn.toLowerCase(), 'ascii').copy(snBuf, 0, 0, Math.min(16, sn.length));

  // Encrypt: AES-256-CBC, zero IV, no padding (plaintext is already 2 blocks)
  const plaintext = Buffer.concat([tsBuf, snBuf]);
  const cipher    = crypto.createCipheriv('aes-256-cbc', siteKey, Buffer.alloc(16, 0));
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Outer envelope: base64("<sn_lower>:<hex_ciphertext>:1")
  const inner = `${sn.toLowerCase()}:${encrypted.toString('hex')}:1`;
  return Buffer.from(inner, 'ascii').toString('base64');
}

function postNewCredentials(siteKey, sn) {
  return new Promise((resolve, reject) => {
    const body = buildCredentialBody(siteKey, sn);
    const opts = {
      hostname       : SERVER_HOST,
      port           : SERVER_PORT,
      path           : '/engage/newCredentials',
      method         : 'POST',
      headers        : {
        'Content-Type'   : 'application/octet-stream',
        'Content-Length' : Buffer.byteLength(body),
      },
    };
    if (SSL_ENABLED) opts.rejectUnauthorized = false; // self-signed cert
    const transport = SSL_ENABLED ? https : http;
    const req = transport.request(opts, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data.trim());
        else reject(new Error(`HTTP ${res.statusCode}: ${data.trim()}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Request Router ────────────────────────────────────────────────────────────
// Receives a parsed ENGAGE request from the server and returns a response JSON.
function routeRequest(requestId, method, reqPath, messageBody, ws) {
  const parts = reqPath.replace(/^\//, '').split('/'); // ['edgeDevices','dev00001','lockControl']

  // ── GET /gateway/scanList
  if (method === 'GET' && reqPath === '/gateway/scanList') {
    return ok(requestId, {
      gatewayScanList: DEVICES.map(d => ({
        signalQuality : 'High',
        modelType     : d.modelType,
        deviceName    : d.deviceName,
        mainSn        : d.mainSn,
      })),
    });
  }

  // ── GET /edgeDevices/linkList
  if (method === 'GET' && reqPath === '/edgeDevices/linkList') {
    return ok(requestId, {
      edgeDeviceLinkList: DEVICES.map(d => ({
        linkId     : d.linkId,
        mainSn     : d.mainSn,
        deviceName : d.deviceName,
        modelType  : d.modelType,
      })),
    });
  }

  // ── GET /edgeDevices/lockStatus  (broadcast — all devices)
  if (method === 'GET' && reqPath === '/edgeDevices/lockStatus') {
    return ok(requestId, {
      edgeDeviceLockStatus: DEVICES.map(d => ({
        linkId     : d.linkId,
        deviceName : d.deviceName,
        lockState  : deviceState[d.linkId],
      })),
    });
  }

  // ── GET /edgeDevices/:linkId/lockStatus
  if (method === 'GET' && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'lockStatus') {
    const linkId = parts[1];
    if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);
    const dev = DEVICES.find(d => d.linkId === linkId);
    return ok(requestId, { linkId, deviceName: dev.deviceName, lockState: deviceState[linkId] });
  }

  // ── GET /edgeDevices/:linkId/params
  if (method === 'GET' && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'params') {
    return getDeviceParams(requestId, parts[1]);
  }

  // ── PUT /edgeDevices/:linkId/config
  if (method === 'PUT' && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'config') {
    return updateDeviceConfig(requestId, parts[1], messageBody);
  }

  // ── PUT /edgeDevices/lockControl  (broadcast — all devices)
  if ((method === 'PUT' || method === 'POST') && reqPath === '/edgeDevices/lockControl') {
    return applyLockControl(requestId, null, messageBody, /*broadcast=*/true);
  }

  // ── PUT /edgeDevices/:linkId/lockControl  (single device)
  if ((method === 'PUT' || method === 'POST') && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'lockControl') {
    return applyLockControl(requestId, parts[1], messageBody, /*broadcast=*/false);
  }

  // ── PUT /edgeDevices/:linkId/database
  if (method === 'PUT' && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'database') {
    return applyDatabaseUpdate(requestId, parts[1], messageBody, ws);
  }

  // ── DELETE /edgeDevices/:linkId/database
  if (method === 'DELETE' && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'database') {
    return cancelDatabaseUpdate(requestId, parts[1]);
  }

  // ── GET /edgeDevices/:linkId/dbDownloadStatus
  if (method === 'GET' && parts.length === 3 && parts[0] === 'edgeDevices' && parts[2] === 'dbDownloadStatus') {
    return getDatabaseDownloadStatus(requestId, parts[1]);
  }

  // ── Unknown
  console.log(`    ⚠  Unhandled: ${method} ${reqPath}`);
  return err(requestId, '404', `path not found: ${method} ${reqPath}`);
}

function applyLockControl(requestId, linkId, messageBody, broadcast) {
  let nextState;
  try {
    const body = JSON.parse(messageBody);
    nextState = body?.lockControl?.lockState?.nextLockState;
    if (!nextState) throw new Error('missing nextLockState');
  } catch (e) {
    return err(requestId, '400', `invalid lockControl body: ${e.message}`);
  }

  if (broadcast) {
    DEVICES.forEach(d => { deviceState[d.linkId] = nextState; });
    const label = stateLabel(nextState);
    console.log(`    ✔  Broadcast ${label} applied to all ${DEVICES.length} device(s)`);
    printDeviceTable();
    return ok(requestId, { result: 'success', appliedState: nextState, devicesAffected: DEVICES.length });
  } else {
    if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);
    deviceState[linkId] = nextState;
    const dev   = DEVICES.find(d => d.linkId === linkId);
    const label = stateLabel(nextState);
    console.log(`    ✔  ${label} applied to ${dev ? dev.deviceName : linkId} (${linkId})`);
    printDeviceTable();
    return ok(requestId, { result: 'success', linkId, appliedState: nextState });
  }
}

function getDeviceParams(requestId, linkId) {
  if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);

  const dev = DEVICES.find(d => d.linkId === linkId);
  return ok(requestId, {
    params: {
      linkId,
      deviceName: dev?.deviceName || linkId,
      modelType: dev?.modelType || 'nde',
      ...lockConfigState[linkId],
    },
  });
}

function updateDeviceConfig(requestId, linkId, messageBody) {
  if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);

  let parsed;
  try {
    parsed = JSON.parse(messageBody);
  } catch (e) {
    return err(requestId, '400', `invalid config payload: ${e.message}`);
  }

  const config = parsed?.config;
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return err(requestId, '400', 'config payload is required');
  }

  lockConfigState[linkId] = {
    ...lockConfigState[linkId],
    ...config,
  };

  console.log(`    ✔  Reader settings updated for ${linkId}: ${Object.keys(config).join(', ')}`);
  return ok(requestId, {
    result: 'success',
    linkId,
    appliedConfig: lockConfigState[linkId],
  });
}

function ok(requestId, body) {
  return { requestId, response: { status: '200', messageBody: JSON.stringify(body) } };
}
function err(requestId, status, msg) {
  return { requestId, response: { status, messageBody: JSON.stringify({ error: msg }) } };
}
function stateLabel(state) {
  const labels = { locked: '🔒 LOCK', unlocked: '🔓 UNLOCK', momentaryUnlock: '⚡ QUICK GRANT' };
  return labels[state] || state;
}
function printDeviceTable() {
  console.log('    ┌─────────┬────────────────┬─────────────────┐');
  console.log('    │ linkId  │ Name           │ State           │');
  console.log('    ├─────────┼────────────────┼─────────────────┤');
  DEVICES.forEach(d => {
    const id    = d.linkId.padEnd(7);
    const name  = d.deviceName.padEnd(14);
    const state = stateLabel(deviceState[d.linkId]).padEnd(15);
    console.log(`    │ ${id} │ ${name} │ ${state} │`);
  });
  console.log('    └─────────┴────────────────┴─────────────────┘');
}

function applyDatabaseUpdate(requestId, linkId, messageBody, ws) {
  if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);

  let parsed;
  try {
    parsed = JSON.parse(messageBody);
  } catch (e) {
    return err(requestId, '400', `invalid database payload: ${e.message}`);
  }

  const userCount = parsed?.db?.usrRcrd?.add?.length || 0;
  const scheduleCount = parsed?.db?.schedules?.length || 0;
  activeDoorfiles[linkId] = parsed;
  databaseTransferState[linkId] = {
    state: 'inProgress',
    progress: 0,
    startedAt: new Date().toISOString(),
    userCount,
    scheduleCount,
    lastPayloadVersion: parsed?.nxtDbVerTS || null,
  };

  console.log(`    ✔  Database accepted for ${linkId} (${userCount} users, ${scheduleCount} schedules)`);

  setTimeout(() => {
    if (!databaseTransferState[linkId] || databaseTransferState[linkId].state === 'cancelled') return;
    databaseTransferState[linkId].state = 'inProgress';
    databaseTransferState[linkId].progress = 50;
    databaseTransferState[linkId].updatedAt = new Date().toISOString();
  }, 800);

  setTimeout(() => {
    if (!databaseTransferState[linkId] || databaseTransferState[linkId].state === 'cancelled') return;
    databaseTransferState[linkId].state = 'completed';
    databaseTransferState[linkId].progress = 100;
    databaseTransferState[linkId].updatedAt = new Date().toISOString();
    sendAuditEvent(ws, linkId, '06000000', {
      edgeDevice: {
        linkId,
        audits: [
          { event: '06000000' },
        ],
      },
    });
  }, 1800);

  return ok(requestId, {
    result: 'accepted',
    linkId,
    progress: 0,
    status: 'inProgress',
  });
}

function cancelDatabaseUpdate(requestId, linkId) {
  if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);

  databaseTransferState[linkId] = {
    ...(databaseTransferState[linkId] || {}),
    state: 'cancelled',
    progress: null,
    updatedAt: new Date().toISOString(),
  };

  return ok(requestId, {
    result: 'cancelled',
    linkId,
  });
}

function getDatabaseDownloadStatus(requestId, linkId) {
  if (!(linkId in deviceState)) return err(requestId, '404', `linkId '${linkId}' not found`);

  const status = databaseTransferState[linkId] || {
    state: 'idle',
    progress: null,
    updatedAt: null,
    userCount: activeDoorfiles[linkId]?.db?.usrRcrd?.add?.length || 0,
    scheduleCount: activeDoorfiles[linkId]?.db?.schedules?.length || 0,
  };

  return ok(requestId, {
    dbDownloadStatus: {
      state: status.state,
      progress: status.progress,
      updatedAt: status.updatedAt || null,
      userCount: status.userCount || 0,
      scheduleCount: status.scheduleCount || 0,
      lastPayloadVersion: status.lastPayloadVersion || null,
    },
  });
}

function sendAuditEvent(ws, linkId, eventType, body) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const payload = {
    eventId: Date.now(),
    event: {
      eventType,
      source: 'edgeDevice',
      deviceId: linkId,
      eventBody: JSON.stringify(body),
    },
  };
  ws.send(JSON.stringify(payload));
  console.log(`    ↳ audit event ${eventType} emitted for ${linkId}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(60));
  console.log('  ENGAGE Gateway Simulator');
  console.log('═'.repeat(60));
  console.log(`  Serial  : ${SERIAL_NUMBER}`);
  const protocol = SSL_ENABLED ? 'wss' : 'ws';
  console.log(`  Server  : ${protocol}://${SERVER_HOST}:${SERVER_PORT}/engage_wss`);
  console.log(`  TLS     : ${SSL_ENABLED ? 'enabled (self-signed)' : 'disabled'}`);
  console.log('');

  // Load sitekey
  if (!fs.existsSync(SITE_KEY_FILE)) {
    console.error(`ERROR: Sitekey not found: ${SITE_KEY_FILE}`);
    process.exit(1);
  }
  const siteKey = Buffer.from(
    fs.readFileSync(SITE_KEY_FILE, 'utf8').trim().slice(0, 64), 'hex'
  );

  // Phase 1 — HTTP credential handshake
  console.log('[1/3] POST /engage/newCredentials ...');
  let password;
  try {
    password = await postNewCredentials(siteKey, SERIAL_NUMBER);
    console.log(`      ✔  Password received (${password.length} chars)`);
  } catch (e) {
    console.error(`      ✘  ${e.message}`);
    console.error('      Is the server running?  →  node server.js');
    process.exit(1);
  }

  // Phase 2 — WebSocket upgrade
  console.log('[2/3] WebSocket upgrade ...');
  const authB64 = Buffer.from(`${SERIAL_NUMBER}:${password}`, 'utf8').toString('base64');
  const wsOpts = { headers: { Authorization: `Basic ${authB64}` } };
  if (SSL_ENABLED) wsOpts.rejectUnauthorized = false; // self-signed cert
  const ws = new WebSocket(
    `${protocol}://${SERVER_HOST}:${SERVER_PORT}/engage_wss`,
    ['engage.v1.gateway.allegion.com'],
    wsOpts
  );

  ws.on('open', () => {
    activeWs = ws;
    console.log('[3/3] ✔  Connected — waiting for commands\n');
    console.log('  Simulated devices:');
    printDeviceTable();
    console.log('');
    console.log('  Press Ctrl+C to disconnect.');
    console.log('─'.repeat(60));
  });

  ws.on('message', (data) => {
    const text = Buffer.isBuffer(data) ? data.toString('utf8') : data;
    let msg;
    try { msg = JSON.parse(text); } catch (e) {
      console.log(`[RAW] ${text}`);
      return;
    }

    // Subscription message from server — just acknowledge, no response needed
    if (msg.subscriptionId !== undefined) {
      console.log(`[SUBSCRIPTION] id=${msg.subscriptionId} gateway=${msg.subscription?.[0]?.eventingEnabled} edgeDevice=${msg.subscription?.[1]?.eventingEnabled}`);
      return;
    }

    // Request from server
    if (msg.requestId !== undefined && msg.request) {
      const { requestId, request: { method, path: reqPath, messageBody = '' } } = msg;
      console.log(`\n[REQUEST] id=${requestId}  ${method} ${reqPath}`);
      if (messageBody) {
        try {
          console.log(`  body: ${JSON.stringify(JSON.parse(messageBody))}`);
        } catch (_) {
          console.log(`  body: ${messageBody}`);
        }
      }

      const response = routeRequest(requestId, method, reqPath, messageBody, ws);
      ws.send(JSON.stringify(response));

      try {
        const rb = JSON.parse(response.response.messageBody);
        console.log(`[RESPONSE] status=${response.response.status} → ${JSON.stringify(rb)}`);
      } catch (_) {
        console.log(`[RESPONSE] status=${response.response.status}`);
      }
      return;
    }

    console.log(`[UNKNOWN MESSAGE] ${text}`);
  });

  // ws library automatically replies to binary pings with pong frames
  ws.on('ping', () => process.stdout.write('·'));

  ws.on('close', (code, reason) => {
    activeWs = null;
    console.log(`\n[DISCONNECTED] code=${code}  reason=${reason.toString() || '(none)'}`);
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error(`\n[ERROR] ${err.message}`);
    process.exit(1);
  });
}

main().catch(e => { console.error(e.message); process.exit(1); });
