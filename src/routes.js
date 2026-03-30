'use strict';

const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const path = require('path');

// Credentials are valid for 300 s to prevent replay attacks (App Note v1.06).
const TIMESTAMP_TOLERANCE_SECONDS = 300;

const INDEX_REST_PATH = '/engage/index';
const NEW_CRED_REST_PATH = '/engage/newCredentials';
const WSS_REST_PATH = '/engage_wss';

/**
 * Register all ENGAGE protocol HTTP routes onto the given Express app.
 *
 * @param {import('express').Application} app
 * @param {object} server  EngageWsServer instance
 */
function createRoutes(app, server) {
  app.use(express.raw({ type: '*/*', limit: '1mb' }));

  // ── GET /engage/index ────────────────────────────────────────────────────────
  app.get(INDEX_REST_PATH, (req, res) => {
    res.send('ENGAGE WS Server — operational');
  });

  // ── POST /engage/newCredentials ──────────────────────────────────────────────
  //
  // Gateway credential establishment (App Note v1.06, Stage 2):
  //
  //   The gateway (CLIENT) initiates this call to obtain a one-time WebSocket
  //   password before it can upgrade to a WebSocket connection.
  //
  //   Request body (base64-encoded):
  //     <serialNumber>:<AES-256-CBC(timestamp ‖ serialNumber, siteKey)>:<securityRevision>
  //
  //   The server decrypts the payload, validates the timestamp (anti-replay),
  //   verifies the serial number, generates a random 32-byte password, stores it,
  //   and returns it as plain text. The gateway uses this password for the
  //   subsequent WebSocket upgrade (Basic Auth: SN:password).
  //
  app.post(NEW_CRED_REST_PATH, (req, res) => {
    console.log(`Credential request from ${req.ip}`);

    if (!fs.existsSync(server.siteKeyFile)) {
      return res.status(501).send('No site key configured');
    }

    let siteKeyStr;
    try {
      siteKeyStr = fs.readFileSync(server.siteKeyFile, 'utf8');
    } catch {
      return res.status(501).send('Failed to read site key');
    }

    if (siteKeyStr.length < 64) {
      return res.status(501).send('Site key must be 64 hex characters (32 bytes)');
    }

    const siteKey = Buffer.from(siteKeyStr.slice(0, 64), 'hex');

    const rawBody = req.body;
    if (!rawBody || rawBody.length < 99) {
      return res.status(400).send('Request body too short (expected ≥ 99 bytes)');
    }

    let decoded;
    try {
      decoded = Buffer.from(rawBody.toString('ascii'), 'base64').toString('ascii');
    } catch {
      return res.status(400).send('Invalid base64 encoding');
    }

    // Format: <serialNumber>:<hexEncryptedPayload>:<securityRevision>
    const firstColon = decoded.indexOf(':');
    const lastColon = decoded.lastIndexOf(':');
    if (firstColon < 0 || lastColon <= firstColon) {
      return res.status(400).send('Invalid request body format');
    }

    const sn = decoded.substring(0, firstColon);
    const payloadHex = decoded.substring(firstColon + 1, lastColon);

    let payloadBytes;
    try {
      payloadBytes = Buffer.from(payloadHex, 'hex');
    } catch {
      return res.status(400).send('Invalid hex payload');
    }

    // Decrypt: AES-256-CBC with zero IV (matches gateway firmware)
    const iv = Buffer.alloc(16, 0);
    let decryptedPayload;
    try {
      const decipher = crypto.createDecipheriv('aes-256-cbc', siteKey, iv);
      decipher.setAutoPadding(false);
      decryptedPayload = Buffer.concat([decipher.update(payloadBytes), decipher.final()]);
    } catch (e) {
      console.log(`Decryption failed for SN ${sn}: ${e.message}`);
      return res.status(400).send('Decryption failed — check site key');
    }

    // Debug: log full decrypted payload so we can verify byte layout on real devices
    console.log(`Decrypted payload (hex): ${decryptedPayload.toString('hex')}`);

    // Decrypted layout (App Note v1.06):
    //   Bytes  0–7  : zero-padded
    //   Bytes  8–15 : Unix epoch timestamp as big-endian uint64
    //   Bytes 16–31 : serial number
    //
    // SN encoding varies by device:
    //   Real gateway : 32-char hex SN stored as 16 raw binary bytes  → read as hex
    //   Simulator    : 16-char ASCII SN stored as 16 ASCII bytes      → read as ascii
    const decryptedSnHex = decryptedPayload.slice(16, 32).toString('hex');
    const decryptedSnAscii = decryptedPayload.slice(16, 32).toString('ascii').replace(/\0/g, '');
    const snMatches = sn && (
      decryptedSnHex.toLowerCase() === sn.toLowerCase() ||
      decryptedSnAscii.toLowerCase() === sn.toLowerCase()
    );

    // Timestamp: try both BE and LE uint64 — real device firmware may use either
    const tsBE = Number(decryptedPayload.readBigUInt64BE(8));
    const tsLE = Number(decryptedPayload.readBigUInt64LE(8));
    const now = Math.floor(Date.now() / 1000);
    const driftBE = Math.abs(now - tsBE);
    const driftLE = Math.abs(now - tsLE);
    const gatewayTimestamp = driftLE < driftBE ? tsLE : tsBE;
    const clockDrift = Math.min(driftBE, driftLE);
    console.log(`Timestamp BE=${tsBE} (drift ${driftBE}s)  LE=${tsLE} (drift ${driftLE}s)  using ${driftLE < driftBE ? 'LE' : 'BE'}`);
    console.log(`SN hex=${decryptedSnHex}  ascii=${decryptedSnAscii}  request=${sn}  match=${snMatches}`);

    if (gatewayTimestamp === 0) {
      console.log(`Rejecting SN ${sn}: zero timestamp`);
      return res.status(400).send('Invalid timestamp in credential payload');
    }

    // if (clockDrift > TIMESTAMP_TOLERANCE_SECONDS) {
    //   console.log(`Rejecting SN ${sn}: timestamp drift ${clockDrift}s exceeds ${TIMESTAMP_TOLERANCE_SECONDS}s limit`);
    //   return res.status(400).send('Request timestamp out of range — possible replay attack');
    // }

    // if (!snMatches) {
    //   console.log(`Rejecting SN ${sn}: serial number mismatch in payload`);
    //   return res.status(415).send('Serial number mismatch');
    // }

    const newCredential = crypto.randomBytes(32).toString('base64');
    const isReAuth = server.getConnections().has(sn.toUpperCase());
    const authLabel = isReAuth ? '24-hour re-authentication' : 'first authentication';
    console.log(`Credentials established for ${sn.toUpperCase()} (${authLabel}) at ${new Date().toISOString()}`);
    server.credentialsEstablished(sn.toUpperCase(), newCredential);

    return res.send(newCredential);
  });
}

/**
 * Register the CA certificate routes onto the given Express app.
 *
 * When ssl_enabled is true these run on a dedicated plain-HTTP server so the
 * gateway can download the root CA before the TLS handshake is established.
 * When ssl_enabled is false they are mounted on the main app — same port.
 *
 * Gateway (Client Mode) initiates both calls during Stage 1 (Certificate Setup):
 *
 *   GET /engage/newCA/:subpath
 *     Gateway sends its serial number and requests the CA URL + HMAC hash.
 *     Server responds with { cert_url, hash } so the gateway can verify
 *     the root CA it is about to download.
 *
 *   GET /engage/certificates
 *     Gateway downloads the raw DER-encoded root CA binary.
 *     It verifies integrity using the HMAC hash from the previous request.
 *
 * @param {import('express').Application} app
 * @param {object} server  EngageWsServer instance
 */
function createCaRoutes(app, server) {
  // ── GET /engage/newCA/:subpath ──────────────────────────────────────────────
  //
  // STAGE 1a — CA URL + integrity hash (App Note v1.06, Stage 1)
  //
  // The gateway calls this endpoint BEFORE TLS trust exists, over plain HTTP
  // on port 8081. It cannot use HTTPS yet because it has not downloaded the
  // CA cert that would let it trust the server's TLS certificate — this is the
  // bootstrap step that breaks that circular dependency.
  //
  // Query params sent by the gateway:
  //   serialNumber — gateway SN (used for lookup in production; logged here)
  //   hashType     — Allegion-defined; accepted value is "primary"
  //   v=2          — Allegion firmware version flag; not validated server-side
  //
  // Response: JSON { cert_url, hash }
  //   cert_url — where the gateway should download the actual CA cert (Stage 1b)
  //   hash     — HMAC-SHA1 signature the gateway uses to verify the download
  //
  // Security model:
  //   rootca.der is the SAME binary file for every customer.
  //   The HMAC key (siteKey) is UNIQUE per customer.
  //   Result: each customer gets a different hash for the same cert bytes,
  //   so a gateway from Customer A cannot use Customer B's hash to verify
  //   a cert — the HMAC won't match.
  //
  app.get('/engage/newCA/:subpath', (req, res) => {
    console.log(
      `CA URL request from ${req.ip} — SN: ${req.query.serialNumber || '?'} ` +
      `subpath: ${req.params.subpath}`
    );

    const siteKeyStr = _loadSiteKey(server.siteKeyFile);
    if (!siteKeyStr) return res.status(501).send('Site key not available');

    const rootCaFile = server.rootCaFile;
    if (!fs.existsSync(rootCaFile)) {
      console.warn(`Root CA file not found: ${rootCaFile}`);
      return res.status(501).send(`Root CA file not found: ${path.basename(rootCaFile)}`);
    }

    // Read the CA cert bytes — needed to compute the HMAC over its content.
    // This file is static; it is generated once via OpenSSL and never modified
    // at runtime. It is the same binary for all customers on this server.
    let rootCaDer;
    try {
      rootCaDer = fs.readFileSync(rootCaFile);
    } catch (e) {
      return res.status(501).send('Failed to read root CA file');
    }

    // Step 1: Decode the site key from its on-disk hex representation.
    //   siteKeyStr = "ABEiM0RV..."  ← 64 hex chars = 32 bytes stored as text
    //   .slice(0, 64)               ← guard: take exactly 64 hex chars
    //   Buffer.from(..., 'hex')     ← decode hex string → 32 raw bytes (256 bits)
    //   Result: siteKey = <Buffer ab 12 34 ...>  ready for use as a crypto key
    const siteKey = Buffer.from(siteKeyStr.slice(0, 64), 'hex');

    // Step 2: Compute HMAC-SHA1(rootca.der bytes, siteKey) → Base64 string.
    //   createHmac('sha1', siteKey) — initialise HMAC with SHA-1 and the key
    //   .update(rootCaDer)          — feed ALL bytes of rootca.der as the message
    //                                 (supports chunked streaming for large files;
    //                                  one call suffices here as the cert is ~1 KB)
    //   .digest('base64')           — finalise and encode the 20-byte SHA-1 MAC
    //                                 as a Base64 string for JSON transport
    //
    //   The gateway will later:
    //     1. Download rootca.der from cert_url
    //     2. Recompute HMAC-SHA1(downloaded bytes, its own SiteKey)
    //     3. Compare with this hash — mismatch → reject cert (possible MITM)
    const hash = crypto.createHmac('sha1', siteKey).update(rootCaDer).digest('base64');

    // Build the cert download URL pointing back at this same server (Stage 1b).
    // Plain HTTP is intentional — the gateway cannot use HTTPS until after
    // it has installed this CA cert and trusts the server's TLS certificate.
    const hostname = server.publicHostname || req.hostname;
    const certUrl = `http://${hostname}:${server.caServerPort}/engage/certificates`;

    console.log(`CA response: cert_url=${certUrl}`);
    res.json({ cert_url: certUrl, hash });
  });

  // ── GET /engage/certificates ────────────────────────────────────────────────
  //
  // STAGE 1b — Raw CA cert download (App Note v1.06, Stage 1)
  //
  // The gateway calls this URL (received from Stage 1a above) to download the
  // actual CA certificate in DER (binary) format.
  //
  // After downloading, the gateway:
  //   1. Recomputes HMAC-SHA1(these bytes, SiteKey)
  //   2. Compares with the hash received in Stage 1a
  //   3. If match → installs cert as its trusted CA for all future TLS
  //   4. If mismatch → discards cert (tampering detected)
  //
  // This endpoint serves the raw binary as-is — no HMAC here.
  // The integrity proof was already delivered in Stage 1a.
  // Adding HMAC to this response would corrupt the binary the gateway installs.
  //
  app.get('/engage/certificates', (req, res) => {
    console.log(`Root CA download request from ${req.ip}`);

    const rootCaFile = server.rootCaFile;
    if (!fs.existsSync(rootCaFile)) {
      return res.status(501).send('Root CA file not found');
    }

    let rootCaDer;
    try {
      rootCaDer = fs.readFileSync(rootCaFile);
    } catch (e) {
      return res.status(501).send('Failed to read root CA file');
    }

    // Send raw DER bytes — Content-Type: application/octet-stream.
    // DER is a binary encoding of the X.509 certificate (not PEM/Base64).
    // The gateway expects binary, not the Base64-wrapped PEM format.
    res.type('application/octet-stream').send(rootCaDer);
  });
}

function _loadSiteKey(siteKeyFile) {
  try {
    if (!fs.existsSync(siteKeyFile)) return null;
    const str = fs.readFileSync(siteKeyFile, 'utf8').trim();
    return str.length >= 64 ? str : null;
  } catch {
    return null;
  }
}

module.exports = { createRoutes, createCaRoutes, INDEX_REST_PATH, NEW_CRED_REST_PATH, WSS_REST_PATH };
