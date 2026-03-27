'use strict';

/**
 * cert-hosting.js
 *
 * Standalone HTTP server that serves the root CA certificate and its HMAC-signed
 * URL to connecting ENGAGE gateways. Mirrors cert-hosting.py.
 *
 * Usage:
 *   node integration/cert-hosting/cert-hosting.js [port]
 *
 * Defaults to port 80 if no port argument is provided.
 */

const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const url = require('url');

// ─── Server Settings ─────────────────────────────────────────────────────────

const DEFAULT_PORT = 80;
const SITE_KEY_FILE = 'sitekey';
const ROOT_CERT_FILE = 'rootca.der';
const NEW_CA_PATH = '/engage/newCA';
const NEW_CERT_PATH = '/engage/certificates';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeResponse(res, body, statusCode) {
  res.status(statusCode).send(body);
}

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();

/**
 * GET /engage/newCA/:subpath
 *
 * Reads the site key and root certificate, computes an HMAC-SHA1 digest of the
 * certificate, and returns a JSON object with the certificate download URL and
 * base64-encoded hash. Mirrors new_ca_url_page() in cert-hosting.py.
 */
app.get(`${NEW_CA_PATH}/:subpath`, (req, res) => {
  console.log(`Got a request for newCA from ${req.ip}`);
  console.log(`subpath == ${req.params.subpath}`);
  console.log(`query serialNumber == ${req.query.serialNumber}`);
  console.log(`query hashType == ${req.query.hashType}`);
  console.log(`query v == ${req.query.v}`);

  // Load site key
  if (!fs.existsSync(SITE_KEY_FILE)) {
    return makeResponse(res, 'site key not found', 501);
  }
  let siteKeyStr;
  try {
    siteKeyStr = fs.readFileSync(SITE_KEY_FILE, 'utf8');
  } catch (e) {
    return makeResponse(res, 'site key read error', 501);
  }

  if (siteKeyStr.length < 64) {
    return makeResponse(res, 'Invalid site key', 501);
  }

  // Load root certificate
  if (!fs.existsSync(ROOT_CERT_FILE)) {
    return makeResponse(res, 'root certificate file not found', 501);
  }
  let deviceCert;
  try {
    deviceCert = fs.readFileSync(ROOT_CERT_FILE); // binary Buffer
  } catch (e) {
    return makeResponse(res, 'root certificate not found', 501);
  }

  // Build the certificate download URL from the incoming request
  const parsed = url.parse(req.url);
  const host = req.hostname;
  const certUrl =
    desiredPort !== DEFAULT_PORT
      ? `${req.protocol}://${host}:${desiredPort}${NEW_CERT_PATH}`
      : `${req.protocol}://${host}${NEW_CERT_PATH}`;

  // HMAC-SHA1 of the raw certificate bytes using the site key (first 32 bytes)
  const siteKey = Buffer.from(siteKeyStr.slice(0, 64), 'hex');
  const digest = crypto.createHmac('sha1', siteKey).update(deviceCert).digest();
  const hashB64 = digest.toString('base64');

  const responseBody = JSON.stringify({ cert_url: certUrl, hash: hashB64 });
  console.log(`Returning: ${responseBody}`);
  res.type('application/json').send(responseBody);
});

/**
 * GET /engage/certificates
 *
 * Serves the raw DER-encoded root certificate binary. Mirrors new_ca_page().
 */
app.get(NEW_CERT_PATH, (req, res) => {
  console.log(`Got a request to download certificate from ${req.ip}`);

  if (!fs.existsSync(ROOT_CERT_FILE)) {
    return makeResponse(res, 'root certificate file not found', 501);
  }
  let cert;
  try {
    cert = fs.readFileSync(ROOT_CERT_FILE);
  } catch (e) {
    return makeResponse(res, 'No root certificate file found', 501);
  }

  res.type('application/octet-stream').send(cert);
});

// ─── Entry Point ─────────────────────────────────────────────────────────────

let desiredPort = DEFAULT_PORT;

if (process.argv.length === 3) {
  const parsed = parseInt(process.argv[2], 10);
  desiredPort = isNaN(parsed) ? DEFAULT_PORT : parsed;
} else if (process.argv.length > 3) {
  console.error('Incorrect number of arguments!');
  process.exit(1);
}

http.createServer(app).listen(desiredPort, '0.0.0.0', () => {
  console.log(`Certificate hosting server running on port ${desiredPort}`);
});
