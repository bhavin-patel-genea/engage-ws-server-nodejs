# Testing with a Real ENGAGE Gateway

This guide covers both connection modes. Choose based on your gateway firmware and environment.

---

## Mode comparison

| | Plain `ws://` | Secure `wss://` |
|---|---|---|
| `ssl_enabled` in config | `false` | `true` |
| Protocol | Plain WebSocket | TLS-encrypted WebSocket |
| Certs required | None | Root CA + Server cert |
| CA server | Built-in (same port) | Built-in (separate port 8080) |
| **Start command** | `npm run demo` | `npm run demo` |
| Supported by gateway firmware | Older / lab firmware | All production firmware |

**One command starts everything** — the CA certificate server is built into the main process. No second terminal needed.

---

## Mode 1 — Plain `ws://` (no SSL)

Use this when your gateway firmware supports unencrypted WebSocket, or for initial bring-up before issuing certificates.

### Step 1 — Find your PC's IP address

```cmd
ipconfig
```

Look for **IPv4 Address** under your active adapter. Example: `192.168.1.50`.
Your PC and gateway must be on the **same local network**.

### Step 2 — Open Windows Firewall (run as Administrator)

```cmd
netsh advfirewall firewall add rule name="ENGAGE WS Server" protocol=TCP dir=in localport=8999 action=allow
```

### Step 3 — Verify `config/config.json`

```json
{
    "server_port": 8999,
    "site_key_file": "./config/sitekey",
    "ssl_info": {
        "ssl_enabled": false
    },
    "event_subscription_info": {
        "gateway_events": true,
        "edgedevice_events": true
    }
}
```

### Step 4 — Start the server

```cmd
npm run demo
```

Expected output:
```
ENGAGE WS Server v1.2 — port 8999 (ws://host:8999/engage_wss)
CA cert routes — mounted on main server port 8999
```

### Step 5 — Configure the gateway in the ENGAGE Mobile App

Open the ENGAGE Mobile App → find your gateway → **Settings ⚙ → IP Client Configuration**:

| Field | Value |
|---|---|
| **Server URL** | `ws://192.168.1.50:8999/engage_wss` |
| **CA Server URL** | `http://192.168.1.50:8999/engage/newCA/current` |
| **Keep Alive (s)** | `30` |

> Replace `192.168.1.50` with your actual PC IP address.

Tap **Save / Apply**. The gateway will attempt to connect within ~30 seconds.

### Step 6 — Verify connection in the terminal

```
Credential request from 192.168.1.XX
Credentials established for AABBCCDDEEFF0011
Gateway connecting: 192.168.1.XX:XXXXX (SN: AABBCCDDEEFF0011)
Upgrading 192.168.1.XX:XXXXX → protocol: engage.v1.gateway.allegion.com
WebSocket open: 192.168.1.XX:XXXXX
[dashboard] Gateway connected: AABBCCDDEEFF0011
[dashboard] Discovered 2 device(s) for AABBCCDDEEFF0011
```

Open the dashboard: **http://192.168.1.50:8999**

---

## Mode 2 — Secure `wss://` (TLS / SSL)

Required for all production gateway firmware. The gateway validates the server's TLS certificate against a root CA it downloads over plain HTTP before the secure connection is established.

### Step 1 — Find your PC's IP address

```cmd
ipconfig
```

Example: `192.168.1.50`

### Step 2 — Open Windows Firewall (run as Administrator)

```cmd
REM Main WSS server
netsh advfirewall firewall add rule name="ENGAGE WS Server" protocol=TCP dir=in localport=8999 action=allow

REM Plain HTTP CA cert server (gateway downloads root CA here)
netsh advfirewall firewall add rule name="ENGAGE CA Server" protocol=TCP dir=in localport=8080 action=allow
```

### Step 3 — Generate certificates

You need a certificate chain:
```
Root CA (self-signed)
  └─ Server Certificate  (signed by Root CA, with your PC's IP as SAN)
```

#### 3.1 Install OpenSSL

**WSL / Linux / macOS** — OpenSSL is pre-installed. Verify:
```bash
openssl version
```

**Windows cmd** — OpenSSL ships with Git for Windows:
```cmd
openssl version
```
If missing, install [Git for Windows](https://git-scm.com/) then add to PATH:
```cmd
set PATH=%PATH%;C:\Program Files\Git\usr\bin
```

> **Run each command separately and wait for it to complete before running the next.**
> Each step produces an output file that the following step depends on.

#### 3.2 Create the `certs/` working directory

**WSL / bash:**
```bash
cd /mnt/c/Genea/Projects/poc/engage-ws-server-nodejs
mkdir -p certs && cd certs
```

**Windows cmd:**
```cmd
cd C:\Genea\Projects\poc\engage-ws-server-nodejs
mkdir certs && cd certs
```

---

#### 3.3 Step 1 — Generate the Root CA private key

Produces: `rootca.key`

```bash
openssl genrsa -out rootca.key 2048
```

Expected output:
```
Generating RSA private key, 2048 bit long modulus
...+++++
...+++++
e is 65537 (0x10001)
```

---

#### 3.4 Step 2 — Self-sign the Root CA certificate

Depends on: `rootca.key`
Produces: `rootca.crt`

**WSL / bash:**
```bash
openssl req -x509 -new -nodes -key rootca.key -sha256 -days 3650 \
  -out rootca.crt \
  -subj "/C=US/ST=Test/L=Test/O=EngageTest/CN=EngageTestRootCA"
```

**Windows cmd:**
```cmd
openssl req -x509 -new -nodes -key rootca.key -sha256 -days 3650 ^
  -out rootca.crt ^
  -subj "/C=US/ST=Test/L=Test/O=EngageTest/CN=EngageTestRootCA"
```

No output on success (file `rootca.crt` is created silently).

---

#### 3.5 Step 3 — Generate the server private key

Produces: `server.key`

```bash
openssl genrsa -out server.key 2048
```

---

#### 3.6 Step 4 — Generate a Certificate Signing Request (CSR)

Depends on: `server.key`
Produces: `server.csr`

Replace `192.168.1.50` with **your actual PC IP address** (from `ipconfig` / `ip addr`).

**WSL / bash:**
```bash
openssl req -new -key server.key -out server.csr \
  -subj "/C=US/ST=Test/L=Test/O=EngageTest/CN=192.168.1.50"
```

**Windows cmd:**
```cmd
openssl req -new -key server.key -out server.csr ^
  -subj "/C=US/ST=Test/L=Test/O=EngageTest/CN=192.168.1.50"
```

---

#### 3.7 Step 5 — Create the Subject Alternative Name (SAN) extension file

Produces: `san.ext`

The gateway validates that the server certificate covers the exact IP it connects to. This SAN entry is required.

Replace `192.168.1.50` with your actual PC IP (same as step 4).

**WSL / bash:**
```bash
echo "subjectAltName=IP:192.168.1.50" > san.ext
```

**Windows cmd:**
```cmd
echo subjectAltName=IP:192.168.1.50 > san.ext
```

---

#### 3.8 Step 6 — Sign the server certificate with the Root CA

Depends on: `server.csr`, `rootca.crt`, `rootca.key`, `san.ext`
Produces: `server.crt`

**WSL / bash:**
```bash
openssl x509 -req -in server.csr -CA rootca.crt -CAkey rootca.key \
  -CAcreateserial -out server.crt -days 730 -extfile san.ext
```

**Windows cmd:**
```cmd
openssl x509 -req -in server.csr -CA rootca.crt -CAkey rootca.key ^
  -CAcreateserial -out server.crt -days 730 -extfile san.ext
```

Expected output:
```
Signature ok
subject=C=US, ST=Test, L=Test, O=EngageTest, CN=192.168.1.50
Getting CA Private Key
```

---

#### 3.9 Step 7 — Verify the certificate chain

```bash
openssl verify -CAfile rootca.crt server.crt
```

Expected: `server.crt: OK`

If this does not say `OK`, do not proceed — the gateway will reject the certificate.

---

#### 3.10 Step 8 — Convert Root CA to DER format

Depends on: `rootca.crt`
Produces: `rootca.der`

The gateway firmware requires the root CA in binary DER format (not PEM text).

```bash
openssl x509 -in rootca.crt -out rootca.der -outform DER
```

---

#### 3.11 Step 9 — Copy certificate files into `config/`

Depends on: `server.crt`, `server.key`, `rootca.der`

**WSL / bash:**
```bash
cd /mnt/c/Genea/Projects/poc/engage-ws-server-nodejs

cp certs/server.crt  config/server.crt
cp certs/server.key  config/server.key
cp certs/rootca.der  config/rootca.der
```

**Windows cmd:**
```cmd
cd C:\Genea\Projects\poc\engage-ws-server-nodejs

copy certs\server.crt  config\server.crt
copy certs\server.key  config\server.key
copy certs\rootca.der  config\rootca.der
```

After this step your `config/` directory should contain:
```
config/
  config.json
  sitekey
  server.key    ← server TLS private key
  server.crt    ← server TLS certificate (signed by rootca)
  rootca.der    ← root CA in DER format (served to gateway)
```

### Step 4 — Update `config/config.json`

```json
{
    "server_port": 8999,
    "site_key_file": "./config/sitekey",
    "ssl_info": {
        "ssl_enabled": true,
        "ssl_key":  "./config/server.key",
        "ssl_cert": "./config/server.crt"
    },
    "ca_server_port": 8080,
    "root_ca_file": "./config/rootca.der",
    "event_subscription_info": {
        "gateway_events": true,
        "edgedevice_events": true
    }
}
```

### Step 5 — Start the server

```cmd
npm run demo
```

Expected output:
```
ENGAGE WS Server v1.2 — port 8999 (wss://host:8999/engage_wss)
CA cert server — port 8080 (http://host:8080/engage/newCA/current)
```

Both the WSS server and the plain-HTTP CA server are running from the same process.

### Step 6 — Configure the gateway in the ENGAGE Mobile App

Open the ENGAGE Mobile App → find your gateway → **Settings ⚙ → IP Client Configuration**:

| Field | Value |
|---|---|
| **Server URL** | `wss://192.168.1.50:8999/engage_wss` |
| **CA Server URL** | `http://192.168.1.50:8080/engage/newCA/current` |
| **Keep Alive (s)** | `30` |

> Note the protocol difference:
> - **Server URL** → `wss://` (secure)
> - **CA Server URL** → `http://` (plain HTTP — required; the gateway cannot use HTTPS before it has the CA cert)

Tap **Save / Apply**.

### Step 7 — Verify connection in the terminal

The gateway connects in two stages:

**Stage 1 — Certificate setup (gateway downloads root CA)**
```
CA URL request from 192.168.1.XX — SN: <base64-serial> subpath: current
CA response: cert_url=http://192.168.1.50:8080/engage/certificates
Root CA download request from 192.168.1.XX
```

**Stage 2 onwards — Credential + WebSocket**
```
Credential request from 192.168.1.XX
Credentials established for AABBCCDDEEFF0011
Gateway connecting: 192.168.1.XX:XXXXX (SN: AABBCCDDEEFF0011)
Upgrading 192.168.1.XX:XXXXX → protocol: engage.v1.gateway.allegion.com
WebSocket open: 192.168.1.XX:XXXXX
[dashboard] Gateway connected: AABBCCDDEEFF0011
[dashboard] Discovered 2 device(s) for AABBCCDDEEFF0011
```

Open the dashboard: **https://192.168.1.50:8999**
(your browser will warn about the self-signed cert — click through for local testing)

---

## ENGAGE Mobile App — IP Client Configuration screen

The screen layout (App Note v1.06, p.22):

```
IP CLIENT CONFIGURATION
────────────────────────────────────
Server URL      [ wss://192.168.1.50:8999/engage_wss    ]
CA Server URL   [ http://192.168.1.50:8080/engage/newCA/current ]
Keep Alive (s)  [ 30 ]

Network:  ○ Zero Config  ○ Static IP  ● DHCP
```

Bluetooth must be enabled. The app communicates with the gateway over BLE to push these settings.

---

## Gateway connection flow (Client Mode)

The gateway (not the server) initiates every step. The full lifecycle has 8 phases — Phase 0 runs once per gateway; Phases 1–7 repeat on every reconnect.

---

### Phase 0 — Certificate Setup *(once per gateway, plain HTTP)*

Before any secure connection can be established the gateway must download and trust the server's root CA.

```
Gateway → GET http://<host>:8081/engage/newCA/current
               ?serialNumber=<Base64(SN)>&hashType=primary&v=2

Server  ← 200 { "cert_url": "http://<host>:8081/engage/certificates",
                "hash": "<Base64(HMAC-SHA1(rootca.der, siteKey))>" }

Gateway → GET http://<host>:8081/engage/certificates

Server  ← rootca.der  (binary, application/octet-stream)
```

The gateway computes `HMAC-SHA1(rootca.der, ownSiteKey)` and compares it with the `hash` field. A match means the file is authentic. It then installs the root CA as its only trust anchor — **no public CAs (GoDaddy, AWS ACM) are involved**.

> Phase 0 is **skipped** on 24-hour reconnects — the root CA is cached on the gateway until it expires or a factory reset is performed.

---

### Phase 1 — Authentication *(HTTP POST, HTTPS after Phase 0)*

The gateway must authenticate before any WebSocket connection is accepted.

```
Gateway → POST /engage/newCredentials
          Body: Base64( SN : hexEncode(AES-256-CBC(timestamp‖SN, siteKey, IV=0)) : 1 )
```

Server validation steps:
1. Base64-decode the body and split on `:`
2. Hex-decode and AES-256-CBC decrypt the payload using the site key
3. Extract Unix timestamp from bytes 8–15; verify within ±300 s of server clock (anti-replay)
4. Extract serial number from bytes 16–31; verify it matches the plaintext SN
5. Generate a cryptographically random 32-byte one-time password
6. Store `SN → password` in memory (single-use — valid for this upgrade only)

```
Server  ← 200  <32-byte password, Base64-encoded>
```

If any step fails the server returns `400` or `415` and the gateway retries.

---

### Phase 2 — WebSocket Upgrade

The gateway opens a WebSocket connection using the password issued in Phase 1.

```
Gateway → GET /engage_wss  HTTP/1.1
          Authorization: Basic Base64(SN:password)
          Upgrade: websocket
          Sec-WebSocket-Protocol: engage.v1.gateway.allegion.com
          Sec-WebSocket-Version: 13
```

Server validation:
- Looks up stored `SN → password`; must match exactly
- Deletes stored credential immediately (single-use)
- Validates `Sec-WebSocket-Protocol` against allowed list
- Closes any stale socket for the same SN before accepting the new one
- Returns **401** (not 403) on failure — some gateway firmware stops retrying on 403

```
Server  ← 101 Switching Protocols
          Sec-WebSocket-Protocol: engage.v1.gateway.allegion.com
```

---

### Phase 3 — Event Subscription *(server sends immediately on open)*

The moment the connection opens, the server sends a subscription message telling the gateway which events to stream.

```json
{
  "subscriptionId": 1,
  "subscription": [
    { "source": "gateway",    "eventingEnabled": true, "subscriptionBody": {} },
    { "source": "edgeDevice", "eventingEnabled": true, "subscriptionBody": {} }
  ]
}
```

`subscriptionBody: {}` means all events. This is **mandatory** — without it the gateway sends no events. The subscription is stateless on the gateway and must be re-sent after every reconnect.

---

### Phase 4 — Request / Response *(application layer, server → gateway)*

Your application calls `sendMsg(sn, request)`. The server sends a JSON request frame over the WebSocket (mimicking HTTP over a persistent socket). The gateway responds with a matching frame.

```json
// Server sends
{ "requestId": 847392811,
  "request": { "method": "PUT",
               "path": "/edgeDevices/dev001/lockControl",
               "messageBody": "{\"lockControl\":{\"lockState\":{\"nextLockState\":\"passage\"}}}" } }

// Gateway responds
{ "requestId": 847392811,
  "response": { "status": "200", "messageBody": "..." } }
```

**Request ID correlation** — each request carries a cryptographically random **signed int32** as its `requestId` (range `1 … 2 147 483 647`). The server stores a `pendingRequests` Map per gateway connection:

```
pendingRequests = {
  847392811: { resolve: resolveA, timer: <15s timeout> },
  193847562: { resolve: resolveB, timer: <15s timeout> },
}
```

> **Why signed int32?** The gateway firmware treats `requestId` as a signed 32-bit integer. Values in the unsigned-only range (`2 147 483 648 – 4 294 967 295`) are clamped to `2 147 483 647` in the gateway's response, breaking the correlation. IDs are masked with `& 0x7FFFFFFF` to stay in the safe range.

When a response arrives `_handleResponse` calls `pendingRequests.get(requestId)` and resolves exactly the correct caller's Promise — concurrent requests to the same gateway cannot receive each other's responses. If no response arrives within 15 s, the Promise resolves with `null` and the timer entry is removed.

---

### Phase 5 — Async Events *(gateway pushes in real-time)*

The gateway pushes unsolicited event frames whenever something happens (door access, audit events, battery, etc.).

```json
{ "eventId": "...",
  "event": {
    "eventType": 0,
    "source": "edgeDevice",
    "deviceId": "dev001",
    "eventBody": "{\"edgeDevice\":{\"linkId\":\"dev001\",\"audits\":[{\"event\":\"0f010000\",\"time\":\"20260326143858\"}]}}"
  }
}
```

The `eventBody.edgeDevice.audits[0].event` field is an 8-character hex string encoding `auditEvent (4 chars) + auditData (4 chars)`. Example: `"0f010000"` → event `0x0F01` = *Lock State: Secured*, data `0x0000`.

These are decoded in `src/eventCodes.js` against the ENGAGE Audits spec (v0.22) and displayed on the dashboard as human-readable entries with result classification (Granted / Denied / Alert / Warning / Info).

---

### Phase 6 — Ping / Pong Heartbeat *(runs continuously)*

The server pings every 15 seconds. The gateway responds with a pong. If more than 3 consecutive pongs are missed (45 seconds total) the server force-closes the connection with code `1001`.

```js
// src/EngageWsServer.js
const PING_INTERVAL_MS = 15_000;
const MAX_MISSED_PINGS = 3;   // 15s × 3 = 45s total before forced disconnect
```

> For edge-device gateways uploading large user databases over BLE, increase `PING_INTERVAL_MS` to `20_000` — database operations can take up to 60 s and can still cause false-positive disconnects with shorter intervals.

---

### Phase 7 — Reconnect

The gateway automatically disconnects and re-authenticates every 24 hours, or immediately if the connection drops unexpectedly (network loss, server restart, ping timeout).

```
On disconnect:
  → Server: _connectionLost() fires
            All pending Promises resolved with null (callers unblocked immediately)
            Connection removed from validConnections map

  → Gateway: restarts from Phase 1 (credential exchange)
             Phase 0 (CA cert) is skipped — root CA is still cached
```

The full reconnect sequence is therefore **Phases 1 → 2 → 3** only. Phases 4–6 resume as soon as the new WebSocket is open.

---

## Site key

The `config/sitekey` file must contain the **64 hex character site key** (32 bytes) assigned to your site by Allegion when the gateway was commissioned. It is used to:
- Decrypt the credential payload in `POST /engage/newCredentials`
- Sign the root CA hash returned by `GET /engage/newCA/current`

If the site key is wrong, the gateway will get HTTP 415 at Stage 2 and never connect.

To update the site key:
```cmd
node -e "require('fs').writeFileSync('config/sitekey','<YOUR_64_HEX_KEY>')"
```

---

## Mode 3 — EC2 Deployment (Production / Remote)

Deploy the ENGAGE server on an AWS EC2 instance accessible over the internet via a DNS hostname.

### Key difference from local setup

On EC2 the gateway connects via a **public DNS hostname** (e.g., `mercury-api.dev-sequr.io`), not a local IP. This affects certificate SAN, config paths, and the trust chain.

### Two separate TLS trust chains — DO NOT mix them

```
GATEWAY trust chain (ENGAGE protocol):
  rootca.der → server.crt → server.key
  All self-signed, Genea-controlled.
  Gateway ONLY trusts rootca.der downloaded via Stage 1.

BROWSER trust chain (Mercury Router / public):
  public-cert.pem → intermediate-ca.pem → private-key.pem
  Issued by public CA (e.g., GoDaddy, ACM).
  For browser/API access only. Gateway does NOT use these.
```

> **⚠️ CRITICAL:** `ssl_cert` and `ssl_key` in `config.json` MUST point to the self-signed `server.crt`/`server.key`, NOT to Mercury Router or any other public CA certs. Mixing these causes the gateway to loop indefinitely on Stage 1 (see RCA below).

### Step 1 — Generate certificates with DNS SAN

```bash
mkdir -p certs && cd certs

# Root CA
openssl genrsa -out rootca.key 2048
openssl req -x509 -new -nodes -key rootca.key -sha256 -days 3650 \
  -out rootca.crt \
  -subj "/C=US/ST=Test/L=Test/O=EngageTest/CN=EngageTestRootCA"

# Server cert — use DNS name, NOT IP
openssl genrsa -out server.key 2048
openssl req -new -key server.key -out server.csr \
  -subj "/CN=mercury-api.dev-sequr.io"

echo "subjectAltName=DNS:mercury-api.dev-sequr.io" > san.ext

openssl x509 -req -in server.csr -CA rootca.crt -CAkey rootca.key \
  -CAcreateserial -out server.crt -days 3650 -extfile san.ext

# Convert to DER
openssl x509 -in rootca.crt -out rootca.der -outform DER

# Verify chain
openssl verify -CAfile rootca.crt server.crt
# Must say: server.crt: OK
```

> **SAN must use `DNS:` not `IP:`** — the gateway connects to `mercury-api.dev-sequr.io`, so the SAN must match. Using `IP:192.168.1.50` will cause TLS hostname verification failure.

### Step 2 — Copy files to EC2

```bash
# Upload to S3
aws s3 cp engage-ws-server-nodejs.zip s3://<BUCKET>/

# On EC2 via SSM
aws s3 cp s3://<BUCKET>/engage-ws-server-nodejs.zip ~
cd ~ && mkdir -p engage-ws-server-nodejs && cd engage-ws-server-nodejs
unzip ~/engage-ws-server-nodejs.zip
npm install
```

### Step 3 — config.json (use ABSOLUTE paths)

```json
{
    "server_port": 8999,
    "site_key_file": "/home/ubuntu/engage-ws-server-nodejs/config/sitekey",
    "ssl_info": {
        "ssl_enabled": true,
        "ssl_cert": "/home/ubuntu/engage-ws-server-nodejs/config/server.crt",
        "ssl_key": "/home/ubuntu/engage-ws-server-nodejs/config/server.key"
    },
    "ca_server_port": 8081,
    "public_hostname": "mercury-api.dev-sequr.io",
    "root_ca_file": "/home/ubuntu/engage-ws-server-nodejs/config/rootca.der",
    "event_subscription_info": {
        "gateway_events": true,
        "edgedevice_events": true
    }
}
```

> **⚠️ Use absolute paths.** PM2 may start the process from a different working directory, causing relative paths like `./config/sitekey` to resolve to the wrong location (returns `501 — Site key not available`).

### Step 4 — Start with PM2

```bash
sudo npm install -g pm2
cd /home/ubuntu/engage-ws-server-nodejs
pm2 start scripts/demo.js --name engage-ws
pm2 save
pm2 startup
```

### Step 5 — Security Group

| Port | Protocol | Source | Purpose |
|---|---|---|---|
| 8081 | TCP | Gateway IP range | CA cert download (plain HTTP) |
| 8999 | TCP | Gateway IP range | WSS + credential exchange (HTTPS) |

No SSH port (22) needed if using SSM.

### Step 6 — Configure gateway in ENGAGE Mobile App

| Field | Value |
|---|---|
| **Server URL** | `wss://mercury-api.dev-sequr.io:8999/engage_wss` |
| **CA Server URL** | `http://mercury-api.dev-sequr.io:8081/engage/newCA/current` |
| **Keep Alive (s)** | `30` |

### Step 7 — Verify with diagnostic commands

```bash
# Test Stage 1a — should return {"cert_url":"...","hash":"..."}
curl "http://localhost:8081/engage/newCA/current?serialNumber=TEST&hashType=primary&v=2"

# Test Stage 1b — should return 200 with binary data
curl "http://localhost:8081/engage/certificates" -o /dev/null -w "HTTP_CODE: %{http_code}\nSIZE: %{size_download}\n"

# Test TLS chain — MOST IMPORTANT
openssl s_client -connect localhost:8999 \
  -CAfile /home/ubuntu/engage-ws-server-nodejs/config/rootca.crt \
  -servername mercury-api.dev-sequr.io </dev/null 2>&1 | grep -E "Verify|depth|CN"

# Expected:
#   depth=1 CN = EngageTestRootCA
#   depth=0 CN = mercury-api.dev-sequr.io
#   Verify return code: 0 (ok)

# If you see CN = *.dev-sequr.io or Verify error → wrong cert in ssl_info
```

### Step 8 — Watch logs

```bash
pm2 logs engage-ws
```

Healthy flow:
```
CA URL request from ...              ← Stage 1a
CA response: cert_url=...            ← Stage 1a response
Root CA download request from ...    ← Stage 1b
Credential request from ...          ← Stage 2
Credentials established for XXXX...  ← Stage 2 success
Gateway connected: XXXX...           ← Stage 3 WebSocket ✅
```

---

## RCA — EC2 Deployment Debugging (March 2026)

Lessons learned from first EC2 deployment. Gateway was stuck in infinite Stage 1 loop.

### Issue 1: Site key file not found → `501`

| Symptom | Stage 1a returns `501 — Site key not available` |
|---|---|
| Root cause | `config.json` used relative path `./config/sitekey`. PM2 started from a different working directory, so the path resolved incorrectly. |
| Fix | Changed to absolute path: `/home/ubuntu/engage-ws-server-nodejs/config/sitekey` |
| Diagnostic | `curl "http://localhost:8081/engage/newCA/current?serialNumber=TEST&hashType=primary&v=2"` — if it returns 501 instead of JSON, the site key path is wrong. |

### Issue 2: rootca.der mismatch after cert regeneration

| Symptom | Stage 1a + 1b both happen but loop endlessly |
|---|---|
| Root cause | Certs were regenerated on EC2 (for SAN fix) producing a NEW rootca.der. Gateway still had the OLD rootca.der cached from initial provisioning. HMAC computed with new file ≠ HMAC gateway expects from old file. |
| Fix | Factory Default Reset (FDR) on the gateway via ENGAGE Mobile App to clear cached cert. |
| Diagnostic | `md5sum /path/to/rootca.der` on EC2 vs local — if hashes differ and gateway was provisioned with the local file, they won't match. |
| Prevention | When regenerating certs on EC2, always FDR the gateway afterward. Or copy the original cert files from the environment where the gateway was first provisioned. |

### Issue 3: Wrong TLS cert served → **main root cause**

| Symptom | Stage 1a + 1b loop, `openssl s_client` shows `CN = *.dev-sequr.io` instead of `CN = mercury-api.dev-sequr.io` |
|---|---|
| Root cause | `config.json` had `ssl_cert` pointing to Mercury Router's `public-cert.pem` (public CA, `*.dev-sequr.io`) instead of the self-signed `server.crt` (`mercury-api.dev-sequr.io`, signed by `EngageTestRootCA`). Gateway downloaded `rootca.der` (EngageTestRootCA) in Stage 1 but Stage 2 TLS presented a cert from a completely different CA → chain mismatch → TLS fails → firmware re-triggers Stage 1 → infinite loop. |
| Fix | Changed `ssl_cert`/`ssl_key` to point to self-signed `server.crt`/`server.key`. |
| Diagnostic | `openssl s_client -connect localhost:8999 -CAfile rootca.crt -servername mercury-api.dev-sequr.io` — if `Verify return code` ≠ 0 or CN doesn't match your self-signed cert, the wrong cert is configured. |
| Prevention | **Never point `ssl_cert`/`ssl_key` to public CA certs for the gateway connection.** The gateway trust chain and browser trust chain are completely separate. |

### Issue 4: SAN used `IP:` instead of `DNS:`

| Symptom | TLS handshake fails even though cert chain is valid |
|---|---|
| Root cause | `san.ext` had `subjectAltName=IP:192.168.1.50` (from local setup). Gateway connects to `mercury-api.dev-sequr.io` — hostname doesn't match IP-based SAN. |
| Fix | Changed to `subjectAltName=DNS:mercury-api.dev-sequr.io` and re-signed `server.crt`. |
| Prevention | For local testing use `IP:<your-ip>`. For EC2/production use `DNS:<your-hostname>`. |

### Quick RCA checklist for future deployments

```bash
# 1. Site key readable?
curl "http://localhost:8081/engage/newCA/current?serialNumber=TEST&hashType=primary&v=2"
# Must return JSON, not 501

# 2. rootca.der downloadable?
curl "http://localhost:8081/engage/certificates" -o /dev/null -w "%{http_code}"
# Must return 200

# 3. Correct cert served via TLS?
openssl s_client -connect localhost:8999 \
  -CAfile /home/ubuntu/engage-ws-server-nodejs/config/rootca.crt \
  -servername mercury-api.dev-sequr.io </dev/null 2>&1 | grep -E "Verify|CN"
# Must show: CN = EngageTestRootCA, CN = mercury-api.dev-sequr.io, Verify: 0 (ok)

# 4. rootca.der matches rootca.crt?
openssl x509 -in rootca.crt -outform DER -out /tmp/check.der
md5sum rootca.der /tmp/check.der
# Hashes must be identical

# 5. server.crt signed by rootca?
openssl verify -CAfile rootca.crt server.crt
# Must say: OK

# 6. SAN correct?
openssl x509 -in server.crt -text -noout | grep -A1 "Subject Alternative Name"
# Must show DNS:mercury-api.dev-sequr.io (not IP:192.168.1.50)
```

---

## Troubleshooting

### Gateway does not appear in server logs at all

- Confirm both devices are on the same LAN (local) or gateway can reach EC2 IP (remote)
- Confirm firewall rules / Security Group allows inbound on ports 8081 and 8999
- Verify gateway has a DHCP-assigned IP in the Mobile App network settings

### Stage 1a returns `501 — Site key not available`

The site key file path in `config.json` is wrong or the file is empty. Check:
```bash
cat $(grep site_key_file config.json | cut -d'"' -f4)
# Must show 64 hex characters
```
**Common cause on EC2:** relative path `./config/sitekey` + PM2 running from different directory. Use absolute paths.

### Stage 1a + 1b loop (no Stage 2)

Three possible causes — check in this order:

1. **Wrong TLS cert served** — run `openssl s_client` check (see RCA Issue 3 above)
2. **rootca.der mismatch** — compare `md5sum` between environments (see RCA Issue 2)
3. **HMAC mismatch** — site key on server doesn't match the gateway's site key

### HTTP 415 at `POST /engage/newCredentials`

The site key in `config/sitekey` does not match the key the gateway was commissioned with.

### TLS handshake error (wss mode)

1. Confirm `ssl_cert`/`ssl_key` point to self-signed certs, NOT public CA certs
2. Confirm `rootca.der` is the DER export of the same `rootca.crt` that signed `server.crt`
3. Confirm `server.crt` SAN matches the hostname gateway connects to (`DNS:` for hostname, `IP:` for IP)
4. Re-run: `openssl verify -CAfile rootca.crt server.crt` → must say `OK`
5. Re-run: `openssl s_client -connect localhost:8999 -CAfile rootca.crt` → `Verify return code: 0`

### CA URL request logs but no cert download follows

The gateway rejected the Stage 1a response — either:
- The `sitekey` used to compute the HMAC does not match the gateway's site key
- The response JSON format is wrong (check server logs for errors)

### Connection drops after ~45 seconds

Ping timeout: 15 s interval × 3 missed pings = 45 s forced disconnect. If the gateway is uploading a large user database, increase the interval in `src/EngageWsServer.js`:

```js
const PING_INTERVAL_MS = 20_000;  // increase from 5 000 to 20 000 for edge device support
```

### Can I test without a physical gateway?

Yes — use the simulator:
```cmd
REM Terminal 1
npm run demo

REM Terminal 2
node scripts/gateway-simulator.js
```

---

## Quick reference

### Plain `ws://`

```
config/config.json  →  ssl_enabled: false
Start               →  npm run demo
Dashboard           →  http://YOUR_PC_IP:8999
Mobile App
  Server URL        →  ws://YOUR_PC_IP:8999/engage_wss
  CA Server URL     →  http://YOUR_PC_IP:8999/engage/newCA/current
```

### Secure `wss://`

```
config/config.json  →  ssl_enabled: true, ssl_key, ssl_cert, ca_server_port: 8080
Start               →  npm run demo
Dashboard           →  https://YOUR_PC_IP:8999
Mobile App
  Server URL        →  wss://YOUR_PC_IP:8999/engage_wss
  CA Server URL     →  http://YOUR_PC_IP:8080/engage/newCA/current
```
