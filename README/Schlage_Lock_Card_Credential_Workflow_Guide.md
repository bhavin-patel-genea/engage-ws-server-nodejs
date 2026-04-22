# Schlage IP Lock - Card Credential Workflow Guide

> **Scope:** End-to-end card credential handling for Schlage ENGAGE LE wireless locks over IP gateway (WebSocket protocol).
> **Audience:** Integration engineers, access control developers, AI agents assisting with ENGAGE lock provisioning.
> **Source of truth:** Allegion ENGAGE WebSockets App Note, Allegion IP-mode training materials, and verified POC implementation.

---

## Table of Contents

1. [Extracting Card Details from Event Logs](#1-extracting-card-details-from-event-logs)
2. [Adding a Card to the Lock](#2-adding-a-card-to-the-lock)
3. [Encryption Details](#3-encryption-details)
4. [Site Key Clarification](#4-site-key-clarification)
5. [Card Format Support](#5-card-format-support)
6. [Debugging & Troubleshooting](#6-debugging--troubleshooting)
7. [AI Skill Compatibility Note](#7-ai-skill-compatibility-note)

---

## 1. Extracting Card Details from Event Logs

### 1.1 How Events Arrive

The Allegion gateway forwards lock audit events over WebSocket as JSON messages:

```json
{
  "eventId": 42,
  "event": {
    "eventType": "auditEvent",
    "source": "engage.v1.gateway.allegion.com",
    "deviceId": "GATEWAY_SERIAL",
    "eventBody": "{\"linkId\":\"AB12CD34\",\"auditCode\":\"05400000\",\"dateTime\":\"2026-04-06T10:15:30Z\"}"
  }
}
```

A **single card swipe** generates **multiple rapid-fire events** (within ~5 ms). These must be **consolidated** (buffered ~500 ms) to get the full picture.

### 1.2 Event Codes for Card Access

| Hex Code | Name                           | Result  | Meaning                         |
| -------- | ------------------------------ | ------- | ------------------------------- |
| `0x0502` | Access Granted                 | granted | Card matched, access allowed    |
| `0x0507` | Access Granted (Pass-Through)  | granted | Granted during passage mode     |
| `0x0508` | Denied - Schedule Violation    | denied  | Card valid but outside schedule |
| `0x0509` | Denied - Credential Not Active | denied  | Card not yet active (actDtTm)   |
| `0x050A` | Denied - Credential Expired    | denied  | Card past expiry (expDtTm)      |
| `0x050B` | Denied - Unknown Credential    | denied  | Card not in database            |
| `0x0540` | Access Denied                  | denied  | Generic denial                  |
| `0x1300` | Credential Not In Database     | denied  | Bit count in audit data field   |

### 1.3 Raw Card Data from 0x1300-Series Events

When a card is denied, the lock sends the raw card bytes across **sequential audit events**:

| Event Code | Content                              | Byte Order                 |
| ---------- | ------------------------------------ | -------------------------- |
| `0x1300`   | Card bit count (in data field)       | N/A                        |
| `0x1301`   | Trailing 2 bytes of card data        | LSB (lowest significance)  |
| `0x1302`   | Middle 2 bytes                       | ...                        |
| `0x1303`   | Leading 2 bytes                      | MSB (highest significance) |
| `0x1304`   | Extra leading 2 bytes (if > 48 bits) | MSB (if present)           |

Each event's `auditCode` is an 8-character hex string encoding two 16-bit fields:

```
"13000025"  =>  event=0x1300, data=0x0025 (37 decimal = 37-bit card)
"13010628"  =>  event=0x1301, data=0x0628
"13025e31"  =>  event=0x1302, data=0x5E31
"13030081"  =>  event=0x1303, data=0x0081
```

**Parsing the 8-character hex string:**

```
Characters [0..3] = event code (e.g. "1300" = 0x1300)
Characters [4..7] = audit data (e.g. "0025" = 0x0025 = 37)
```

### 1.4 Reconstructing Raw Card Bytes (Step-by-Step)

**Input:** Audit codes from a denied 37-bit card swipe:

```
0x1300 data=0x0025 (37 bits)
0x1301 data=0x0628 (trailing)
0x1302 data=0x5E31 (middle)
0x1303 data=0x0081 (leading)
```

**Step 1: Reverse event order (highest sequence first)**

```
0x1303: 0x0081  =>  bytes [00, 81]
0x1302: 0x5E31  =>  bytes [5E, 31]
0x1301: 0x0628  =>  bytes [06, 28]
```

Concatenated: `00 81 5E 31 06 28` (6 bytes)

**Step 2: Strip leading padding**

Actual bytes needed = ceil(37 / 8) = 5 bytes. Leading padding = 6 - 5 = 1 byte.

Strip 1 byte: `81 5E 31 06 28` (5 bytes = `815E310628`)

**Step 3: This IS the raw card data, left-shifted to byte boundary**

The raw card hex `815E310628` contains all 37 bits of card data.

### 1.5 Decoding Facility Code and Card Number from Raw Bits

Once you have the raw bytes, decode based on the bit format:

**26-bit H10301:**

```
Bit Layout: [EP:1][FC:8][Card:16][OP:1]
Positions:   0     1-8   9-24     25
```

**37-bit H10304:**

```
Bit Layout: [EP:1][FC:16][Card:19][OP:1]
Positions:   0     1-16   17-35    36
```

**Decoding example (37-bit card, raw hex `815E310628`):**

```
Binary: 10000001 01011110 00110001 00000110 00101000
        ^        ^^^^^^^^ ^^^^^^^^ ^^                  = FC bits [1..16]
                                     ^^^ ^^^^^^^^ ^^^^ = Card bits [17..35]
Bit 0 (EP):   1
Bits 1-16:    0000001010111100 = FC 700 (example)
Bits 17-35:   0110001000001100101 = Card 802 (example)
Bit 36 (OP):  0
```

### 1.6 Decoding Algorithm (Code)

```javascript
function decodeFromRawBytes(rawHex, bitCount) {
  const buf = Buffer.from(rawHex, "hex");
  const bits = [];
  for (let i = 0; i < bitCount; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    bits.push((buf[byteIdx] >> bitIdx) & 1);
  }

  if (bitCount === 26) {
    // H10301: [EP:1][FC:8][Card:16][OP:1]
    let fc = 0;
    for (let i = 1; i <= 8; i++) fc = (fc << 1) | bits[i];
    let card = 0;
    for (let i = 9; i <= 24; i++) card = (card << 1) | bits[i];
    return { facilityCode: fc, cardNumber: card, format: "H10301" };
  }

  if (bitCount === 37) {
    // H10304: [EP:1][FC:16][Card:19][OP:1]
    let fc = 0;
    for (let i = 1; i <= 16; i++) fc = (fc << 1) | bits[i];
    let card = 0;
    for (let i = 17; i <= 35; i++) card = (card << 1) | bits[i];
    return { facilityCode: fc, cardNumber: card, format: "H10304" };
  }

  return {
    facilityCode: null,
    cardNumber: null,
    format: `${bitCount}-bit unknown`,
  };
}
```

---

## 2. Adding a Card to the Lock

### 2.1 Prerequisites

| Requirement | Details                                                   |
| ----------- | --------------------------------------------------------- |
| Gateway     | Allegion ENGAGE IP gateway, connected via WebSocket (TLS) |
| Lock        | Schlage LE wireless lock, linked to gateway               |
| Site Key    | 32-byte (256-bit) hex key, shared between server and lock |
| Card        | Physical card (HID Prox, iCLASS, MIFARE, DESFire, etc.)   |
| Card Data   | Either known FC/Card# + format, OR raw bytes from a swipe |

### 2.2 Method A: Known Card Number + Format (Calculated PrimeCR)

Use this when you know the card format, facility code, and card number.

**Step 1: Select card format**

Choose from built-in formats or define a custom WIEGAND format:

| Format                | Bits | FC Bits | Card Bits | FC Range  | Card Range    |
| --------------------- | ---- | ------- | --------- | --------- | ------------- |
| H10301                | 26   | 8       | 16        | 0-255     | 0-65535       |
| H10302                | 37   | 0       | 35        | N/A       | 0-34359738367 |
| H10304                | 37   | 16      | 19        | 0-65535   | 0-524287      |
| H5XXXX (Corp 1000-35) | 35   | 12      | 20        | 0-4095    | 0-1048575     |
| H2XXXX (Corp 1000-48) | 48   | 22      | 23        | 0-4194303 | 0-8388607     |

**Step 2: Build raw credential bits**

1. Create a zero-filled bit array of `total_card_bits` length
2. Place cardholder ID bits at `cardholder_id_start_bit` (with optional offset)
3. Place facility code bits at `facility_code_start_bit`
4. Calculate even parity over `total_even_parity_bits` starting at `even_parity_start_bit`
5. Calculate odd parity over `total_odd_parity_bits` starting at `odd_parity_start_bit`
6. If `is_reverse_card_format`: reverse the entire bit array

**Step 3: Pack into clear PrimeCR (16 bytes)**

1. Convert bit array to byte string (pad last byte with trailing zeros if needed)
2. If `is_reversal_of_bytes`: reverse the byte array
3. Copy into a 16-byte buffer pre-filled with `0xFF`
4. Result = **Clear PrimeCR** (16 bytes)

**Step 4: Encrypt PrimeCR**

```
AES-256-CBC(key=siteKey, iv=0x00*16, data=clearPrimeCR) => encryptedPrimeCR
```

With a zero IV and a single 16-byte block, this is functionally equivalent to AES-256-ECB.

**Step 5: Build doorfile JSON and push**

See Section 2.4.

### 2.3 Method B: Learn Card from Swipe (Raw Bytes - Recommended)

Use this when you don't know the card format or the printed number doesn't match the encoded data. **This is the most reliable method** because it uses the exact bytes the lock reads from the card.

**Step 1: Swipe the card (gets denied)**

The card must NOT be in the lock's database. The lock generates 0x1300-series audit events.

**Step 2: Capture raw bytes from audit events**

Extract raw card bytes from 0x1301-0x1304 events as described in Section 1.4.

**Step 3: Build clear PrimeCR from raw bytes**

```
rawCardHex (e.g. "815E310628")
  => copy into 16-byte buffer filled with 0xFF
  => clearPrimeCR = "815E310628FFFFFFFFFFFFFFFFFFFFFF" (32 hex chars)
```

**Step 4: Encrypt with site key**

```
AES-256-CBC(key=siteKey, iv=0x00*16, data=clearPrimeCR) => encryptedPrimeCR
```

**Step 5: Build doorfile and push** (see Section 2.4)

### 2.4 Doorfile JSON Structure

The doorfile is pushed via WebSocket as an HTTP-style `PUT` request to `/edgeDevices/{linkId}/database`.

**Minimal working doorfile (Allegion training sample format):**

```json
{
  "db": {
    "usrRcrd": {
      "deleteAll": 1,
      "delete": [],
      "update": [],
      "add": [
        {
          "usrID": 20020,
          "adaEn": 0,
          "fnctn": "norm",
          "crSch": 1,
          "actDtTm": "20000101000000",
          "expDtTm": "21350101000000",
          "primeCr": "7a749873c4b3f54dfdd31b3f82e67e55",
          "prCrTyp": "card",
          "scndCrTyp": "null"
        }
      ]
    },
    "schedules": [
      {
        "days": ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"],
        "strtHr": 0,
        "strtMn": 0,
        "lngth": 1440
      }
    ],
    "holidays": [],
    "autoUnlock": []
  },
  "dbDwnLdTm": "",
  "nxtDbVerTS": "0x123456789012345"
}
```

### 2.5 Doorfile Field Reference

| Field        | Type         | Description                                                      | Example            |
| ------------ | ------------ | ---------------------------------------------------------------- | ------------------ |
| `deleteAll`  | int          | 1 = wipe existing users before adding                            | `1`                |
| `usrID`      | int          | Unique user identifier (1-65534)                                 | `20020`            |
| `adaEn`      | int          | ADA mode (0=off, 1=on, extended unlock time)                     | `0`                |
| `fnctn`      | string       | User function: "norm", "passage", "lockout"                      | `"norm"`           |
| `crSch`      | int or int[] | Schedule index (1-based). Integer for single, array for multiple | `1`                |
| `actDtTm`    | string       | Activation datetime (YYYYMMDDHHmmss)                             | `"20000101000000"` |
| `expDtTm`    | string       | Expiration datetime (YYYYMMDDHHmmss)                             | `"21350101000000"` |
| `primeCr`    | string       | Encrypted PrimeCR (32 hex chars, lowercase)                      | `"7a749873..."`    |
| `prCrTyp`    | string       | Primary credential type                                          | `"card"`           |
| `scndCrTyp`  | string       | Secondary credential type                                        | `"null"`           |
| `lngth`      | int          | Schedule duration in minutes. Use **1440** for 24-hour           | `1440`             |
| `nxtDbVerTS` | string       | Hex timestamp for version tracking                               | `"0x..."`          |

### 2.6 Key Rules for Doorfile

1. **`lngth` must be 1440** for a 24-hour schedule. Allegion's training samples all use 1440. The spec says range 1-1439 in Table 3, but working samples contradict this.
2. **`crSch` as integer** for single-schedule assignment (not wrapped in an array). Some LE firmware rejects `[1]` but accepts `1`.
3. **`primeCr` values must be pre-sorted** by their clear (decrypted) value in ascending order. Unsorted records cause lookup failures.
4. **Duplicate `primeCr` values** must be removed. The lock treats duplicates as "unsorted" and rejects credential lookups.
5. **`deleteAll: 1`** wipes the existing database before adding. This is the simplest mode for full-replace provisioning.

### 2.7 Pushing the Doorfile via Gateway

The gateway uses a WebSocket request/response pattern:

**Server sends:**

```json
{
  "requestId": 100,
  "request": {
    "method": "PUT",
    "URI": "/edgeDevices/AB12CD34/database",
    "messageBody": "{...doorfile JSON...}"
  }
}
```

**Gateway responds:**

```json
{
  "requestId": 100,
  "response": {
    "status": "200",
    "messageBody": "{\"status\":\"ok\"}"
  }
}
```

After a successful `200`, the gateway transfers the database to the lock over BLE. Monitor progress via `0x0601` (Doorfile Update Successful) audit events.

---

## 3. Encryption Details

### 3.1 Credential Encryption (PrimeCR)

| Layer   | Algorithm   | Key                 | IV                   | Block Size |
| ------- | ----------- | ------------------- | -------------------- | ---------- |
| PrimeCR | AES-256-CBC | Site Key (32 bytes) | All zeros (16 bytes) | 16 bytes   |

Since the clear PrimeCR is exactly 16 bytes (one AES block) and the IV is all zeros, this is functionally identical to AES-256-ECB for a single block.

**Encryption flow:**

```
Clear PrimeCR (16 bytes)
  => AES-256-CBC encrypt (key=siteKey, iv=0x00*16, no padding)
  => Encrypted PrimeCR (16 bytes = 32 hex chars)
```

**Decryption flow (for reading back):**

```
Encrypted PrimeCR (16 bytes)
  => AES-256-CBC decrypt (key=siteKey, iv=0x00*16, no padding)
  => Clear PrimeCR (16 bytes)
```

### 3.2 Communication Encryption

| Path              | Protocol                   | Encryption                                                                                      |
| ----------------- | -------------------------- | ----------------------------------------------------------------------------------------------- |
| Card to Lock      | RFID/NFC                   | Technology-dependent (Wiegand = unencrypted bit stream; MIFARE/DESFire = mutual authentication) |
| Lock to Gateway   | BLE (Bluetooth Low Energy) | Allegion proprietary (encrypted, managed by gateway firmware)                                   |
| Gateway to Server | WebSocket over TLS         | Mutual TLS with client certificates                                                             |

### 3.3 TLS Configuration (Gateway to Server)

The WebSocket connection uses **mutual TLS (mTLS)**:

- **Server certificate**: Signed by a Root CA that the gateway trusts
- **Gateway certificate**: The gateway presents its own cert; server validates against the Root CA
- **Root CA**: Shared between gateway and server (provisioned during gateway setup)
- **Protocol**: `wss://` (WebSocket Secure) on port 443 (or configured port)

---

## 4. Site Key Clarification

### 4.1 What Is the Site Key?

The **Site Key** is a 256-bit (32-byte) AES encryption key used to encrypt and decrypt PrimeCR credential data. Every card credential stored in the lock is encrypted with this key.

### 4.2 Format and Value

| Property       | Value                            |
| -------------- | -------------------------------- |
| Length         | 32 bytes (256 bits)              |
| Representation | 64-character hex string          |
| Storage        | Plain text file on server        |
| Example        | `a1b2c3d4e5f6...` (64 hex chars) |

### 4.3 Where It Is Configured

| Location                   | Purpose                                                      |
| -------------------------- | ------------------------------------------------------------ |
| Server: `./config/sitekey` | File containing the 64-char hex string                       |
| Lock                       | Programmed during initial setup (via BLE app or gateway)     |
| Gateway                    | Does NOT hold the site key; it passes encrypted data through |

The site key on the server and in the lock **must match exactly**. A mismatch means every credential push will silently fail (the lock will decrypt to wrong bytes and never match a presented card).

### 4.4 Impact on Card Encoding

```
                    Server Side                              Lock Side
                    ───────────                              ─────────
Card Data ──> Clear PrimeCR ──> AES-256(siteKey) ──>  Encrypted PrimeCR
                                                           (stored in lock DB)

                                                      Card Swipe ──> Raw Bytes
                                                           │
                                                      Clear PrimeCR (from card)
                                                           │
                                                      AES-256(siteKey) ──> Encrypted
                                                           │
                                                      Compare with DB ──> Grant/Deny
```

If the site key is wrong, the lock's encrypted version of the presented card won't match the stored encrypted PrimeCR, even if the raw card bytes are identical.

### 4.5 Verifying the Site Key

To verify your site key is correct:

1. Take a known card's clear PrimeCR (e.g., from Learn Card from Swipe)
2. Encrypt it with your site key
3. Push it to the lock
4. Swipe the card
5. If granted => site key is correct

**Using an online AES tool for verification:**

- Algorithm: AES-256
- Mode: ECB (or CBC with IV = `00000000000000000000000000000000`)
- Key format: **Hex** (NOT "Plaintext")
- Input: Clear PrimeCR hex (32 chars)
- Output: Should match the encrypted PrimeCR you pushed

---

## 5. Card Format Support

### 5.1 Supported Card Technologies

The Schlage LE lock supports multiple card reader technologies. Which ones are active depends on the lock's configuration:

| Technology     | Frequency | Config Flag        | Notes                                        |
| -------------- | --------- | ------------------ | -------------------------------------------- |
| HID Prox       | 125 kHz   | `proxConfHID: "T"` | Wiegand-based formats (H10301, H10304, etc.) |
| MIFARE Classic | 13.56 MHz | `mi14443: "T"`     | ISO 14443 Type A                             |
| MIFARE DESFire | 13.56 MHz | `mi14443: "T"`     | ISO 14443 Type A                             |
| iCLASS         | 13.56 MHz | `iclass: "T"`      | HID iCLASS/SE                                |
| SEOS           | 13.56 MHz | `seos: "T"`        | HID SEOS                                     |

### 5.2 Built-In Wiegand Formats

| Format Code | Label            | Total Bits | FC Bits        | Card ID Bits    | FC Range    | Card Range       |
| ----------- | ---------------- | ---------- | -------------- | --------------- | ----------- | ---------------- |
| H10301      | 26-bit Standard  | 26         | 8 (bits 1-8)   | 16 (bits 9-24)  | 0-255       | 0-65535          |
| H10302      | 37-bit No FC     | 37         | 0              | 35 (bits 1-35)  | N/A         | 0-34,359,738,367 |
| H10304      | 37-bit With FC   | 37         | 16 (bits 1-16) | 19 (bits 17-35) | 0-65535     | 0-524,287        |
| H5XXXX      | Corp 1000 35-bit | 35         | 12 (bits 2-13) | 20 (bits 14-33) | 0-4095      | 0-1,048,575      |
| H2XXXX      | Corp 1000 48-bit | 48         | 22 (bits 2-23) | 23 (bits 24-46) | 0-4,194,303 | 0-8,388,607      |

### 5.3 Bit Layout: H10301 (26-bit Standard)

```
Bit:  0    1  2  3  4  5  6  7  8    9  10 11 12 13 14 15 16 17 18 19 20 21 22 23 24   25
      ├─EP─┤  ├───── Facility Code (8 bits) ─────┤  ├──────────── Card Number (16 bits) ──────────┤  ├─OP─┤
      Even                                                                                          Odd
      Parity                                                                                        Parity
      (bits 0-12)                                                                                   (bits 13-25)
```

- **EP (Even Parity)**: Bit 0. Set so bits 0-12 have even number of 1s.
- **OP (Odd Parity)**: Bit 25. Set so bits 13-25 have odd number of 1s.

### 5.4 Bit Layout: H10304 (37-bit With FC)

```
Bit:  0    1  ...  16    17  ...  35    36
      ├─EP─┤  ├── FC (16 bits) ──┤  ├── Card (19 bits) ──┤  ├─OP─┤
      Even Parity (bits 0-18)         Odd Parity (bits 18-36)
```

### 5.5 Detailed Working Example: Allegion Training Card 802

**Known values:**

- Format: H10304 (37-bit with FC)
- Facility Code: (encoded in bits)
- Card Number: 802
- usrID: 20020

**Step 1: Build bit array**

Using the H10304 format:

- Total bits: 37
- Place card number 802 at bits 17-35 (19 bits): `0000000001100100010`
- Place facility code at bits 1-16 (16 bits)
- Calculate even parity (bit 0) and odd parity (bit 36)

**Step 2: Convert to bytes, pad to 16 bytes**

```
Raw bits => byte-aligned => e.g. 815E310628
Pad with 0xFF: 815E310628FFFFFFFFFFFFFFFFFFFFFF
```

This gives the **Clear PrimeCR**: `815E310628FFFFFFFFFFFFFFFFFFFFFF`

**Step 3: Encrypt with site key**

```
AES-256-CBC(key=siteKey, iv=zeros, data=815E310628FFFFFFFFFFFFFFFFFFFFFF)
  => 7a749873c4b3f54dfdd31b3f82e67e55
```

This gives the **Encrypted PrimeCR**: `7a749873c4b3f54dfdd31b3f82e67e55`

**Step 4: Use in doorfile**

```json
{
  "usrID": 20020,
  "adaEn": 0,
  "fnctn": "norm",
  "crSch": 1,
  "actDtTm": "20000101000000",
  "expDtTm": "21350101000000",
  "primeCr": "7a749873c4b3f54dfdd31b3f82e67e55",
  "prCrTyp": "card",
  "scndCrTyp": "null"
}
```

### 5.6 MIFARE / Smart Cards (e.g., Schlage 9551)

MIFARE-based smart cards (13.56 MHz) do **not** use Wiegand bit formatting. The printed serial number on the card (e.g., "010984") is typically a badge/asset number and does **not** directly map to the credential data the lock reads.

**For MIFARE/DESFire/iCLASS cards, the only reliable method is:**

1. **Learn Card from Swipe** (Method B in Section 2.3)
2. Swipe the card on the lock (denied)
3. Capture the raw bytes from 0x1300-series events
4. Use those bytes as the clear PrimeCR

The lock reads a CSN (Card Serial Number) or sector data and presents it as raw bytes. There is no standard mapping from printed number to these bytes.

---

## 6. Debugging & Troubleshooting

### 6.1 Card Not Recognized (No LED Blink on Swipe)

| Check                    | Action                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------- |
| Card technology enabled? | Verify lock config has the correct tech flag set (e.g., `mi14443: "T"` for MIFARE) |
| Card in range?           | Hold card flat against the lock reader for 1-2 seconds                             |
| Lock battery OK?         | Check for `0x0100` (Low Battery) or `0x0101` (Critical Battery) events             |
| Lock linked to gateway?  | Check for `0x1000` (Gateway Linked) event                                          |

### 6.2 Card Denied - Unknown Credential (0x050B)

The card was read but not found in the lock's database.

| Step | What to Check                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------- |
| 1    | Was the doorfile pushed successfully? Check for `0x0601` (Doorfile Update Successful)                     |
| 2    | Does the PrimeCR match? Compare the clear PrimeCR from raw bytes (Section 1.4) against what you encrypted |
| 3    | Is the site key correct? (Section 4.5)                                                                    |
| 4    | Was the card format correct? Use "Learn Card from Swipe" to verify raw bytes                              |
| 5    | Is the database sorted? PrimeCR values must be pre-sorted by clear value                                  |

### 6.3 Card Denied - Schedule Violation (0x0508)

The card is valid but the schedule doesn't allow access right now.

| Step | What to Check                                                        |
| ---- | -------------------------------------------------------------------- |
| 1    | Is `lngth` set to `1440`? (not 1439)                                 |
| 2    | Does the schedule include today's day? (e.g., `"Sa"` for Saturday)   |
| 3    | Is `crSch` pointing to the correct schedule index (1-based)?         |
| 4    | Does the schedule array in the doorfile actually include all 7 days? |

### 6.4 Wrong Card Number in Logs

| Symptom                      | Root Cause                                                          | Fix                                                         |
| ---------------------------- | ------------------------------------------------------------------- | ----------------------------------------------------------- |
| FC/Card decoded incorrectly  | Wrong card format assumed                                           | Use raw bytes from 0x1300-series instead of guessing format |
| Printed number doesn't match | Card is MIFARE/smart card, printed number is badge ID               | Use "Learn Card from Swipe"                                 |
| Different number each swipe  | Multiple card technologies active, lock reading different interface | Disable unused card tech in lock config                     |

### 6.5 Site Key / Encryption Mismatch

**Symptoms:**

- Doorfile pushes successfully (0x0601) but all cards are denied
- Raw bytes from denied swipe match expected clear PrimeCR, but access still denied

**Diagnosis:**

```
1. Capture raw bytes from card swipe (Section 1.4)
2. Build clear PrimeCR: rawBytes + pad 0xFF to 16 bytes
3. Encrypt with YOUR site key
4. Push doorfile with this encrypted PrimeCR
5. Swipe again

If still denied => site key on server does NOT match site key in lock
```

**Fix:** Re-provision the lock with the correct site key, or update the server's `config/sitekey` file to match the lock.

### 6.6 Database Push Fails

| Error                           | Cause                                   | Fix                                    |
| ------------------------------- | --------------------------------------- | -------------------------------------- |
| Gateway response `404`          | Lock linkId not found or lock offline   | Verify linkId, check lock is paired    |
| Gateway response `503`          | Gateway cannot reach lock               | Check BLE range, battery, interference |
| No response (timeout)           | Gateway disconnected or busy            | Check WebSocket connection, retry      |
| `0x0606` Partial Download       | Transfer interrupted                    | Re-push the doorfile                   |
| `0x0607` Partial Download Fault | Out-of-order or timeout during transfer | Re-push the doorfile                   |

### 6.7 Quick Decision Tree

```
Card swipe => No LED reaction?
  => Check card tech config + battery + BLE link

Card swipe => Red LED (denied)?
  => Check 0x1300-series events for raw bytes
  => Is card in DB?
     NO  => Push doorfile with correct PrimeCR
     YES => Check schedule (lngth=1440, correct crSch index)
            Check site key match
            Check PrimeCR sort order (pre-sort by clear value)

Card swipe => Green LED (granted)?
  => Working correctly
```

---

## 7. AI Skill Compatibility Note

### 7.1 Using This Document as an AI Skill

This document is structured for direct use as a Claude skill or reusable AI instruction set. Each section can be independently referenced.

**Invocation patterns:**

| User Intent                          | Relevant Section(s) |
| ------------------------------------ | ------------------- |
| "Decode card data from these events" | Section 1.3-1.6     |
| "Add this card to the lock"          | Section 2.2 or 2.3  |
| "Build a doorfile for card X"        | Section 2.4-2.6     |
| "Why is my card denied?"             | Section 6.1-6.7     |
| "What is the site key?"              | Section 4           |
| "Encrypt this PrimeCR"               | Section 3.1         |

### 7.2 Input/Output Expectations

**For card data extraction:**

```
INPUT:  Array of auditCode strings ["13000025", "13010628", "13025e31", "13030081"]
OUTPUT: {
  cardBitCount: 37,
  rawCardHex: "815e310628",
  clearPrimeCrHex: "815e310628ffffffffffffffffffffff",
  facilityCode: <decoded or null>,
  cardNumber: <decoded or null>
}
```

**For PrimeCR encryption:**

```
INPUT:  clearPrimeCrHex = "815e310628ffffffffffffffffffffff"
        siteKeyHex = "64-char hex string"
OUTPUT: {
  clearHex: "815e310628ffffffffffffffffffffff",
  encryptedHex: "7a749873c4b3f54dfdd31b3f82e67e55"
}
```

**For doorfile generation:**

```
INPUT:  encryptedPrimeCr, usrID, schedule config
OUTPUT: Complete doorfile JSON (Section 2.4)
```

### 7.3 Deterministic Steps Summary

1. **Raw bytes extraction**: Parse 8-char hex audit codes -> split code/data -> reverse event order -> strip padding -> raw card hex
2. **Clear PrimeCR**: Copy raw bytes into 16-byte buffer filled with 0xFF
3. **Encryption**: AES-256-CBC with zero IV and site key, no padding
4. **Doorfile**: JSON with `deleteAll:1`, sorted user records, `lngth:1440` schedule
5. **Push**: WebSocket PUT to `/edgeDevices/{linkId}/database`
6. **Verify**: Wait for `0x0601` audit event, then test swipe

### 7.4 Common Pitfalls for AI Agents

| Pitfall                                        | Correct Approach                                                     |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Using card's printed number as credential data | Always use raw bytes from 0x1300-series events for non-Wiegand cards |
| Setting `lngth: 1439`                          | Use `lngth: 1440` (Allegion's working samples)                       |
| Wrapping single `crSch` in array `[1]`         | Use integer `1` for single schedule                                  |
| Uppercase hex in `primeCr`                     | Use lowercase hex                                                    |
| Not sorting user records                       | Pre-sort `add[]` by clear PrimeCR ascending                          |
| Using AES key as "Plaintext" in tools          | Site key is a hex string; set key format to "Hex"                    |
| Assuming MIFARE serial = card number           | MIFARE CSN in events is different from printed badge number          |

---

## Appendix A: Event Code Quick Reference

| Code     | Category | Title                      | Result  |
| -------- | -------- | -------------------------- | ------- |
| `0x0502` | Access   | Access Granted             | granted |
| `0x0508` | Access   | Denied - Schedule          | denied  |
| `0x050B` | Access   | Denied - Unknown           | denied  |
| `0x0540` | Access   | Access Denied              | denied  |
| `0x0601` | Database | Doorfile Update OK         | info    |
| `0x0606` | Database | Partial Download           | warning |
| `0x1000` | Gateway  | Gateway Linked             | info    |
| `0x1300` | Access   | Card Not In DB (bit count) | denied  |
| `0x1301` | Access   | Card Data - Trailing       | denied  |
| `0x1302` | Access   | Card Data - Middle         | denied  |
| `0x1303` | Access   | Card Data - Leading        | denied  |

## Appendix B: File Locations (POC Implementation)

| File                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `src/eventCodes.js`           | Event parsing, raw card byte extraction                   |
| `src/PrimeCredential.js`      | PrimeCR generation, encryption, decryption                |
| `src/AccessControlService.js` | Doorfile building, user/schedule management               |
| `src/AccessStateStore.js`     | Persistent state (users, schedules, formats)              |
| `src/defaultCardFormats.js`   | Built-in Wiegand format definitions                       |
| `scripts/demo.js`             | Server, gateway WebSocket, REST API, Learn Card endpoints |
| `config/sitekey`              | Site key file (64-char hex)                               |
| `public/access-ui.js`         | UI logic for Access Database + Learn Card from Swipe      |
