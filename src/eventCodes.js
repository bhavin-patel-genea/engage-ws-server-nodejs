'use strict';

const GENERATED_CODES = require('./generatedAuditCodes.json');

/**
 * ENGAGE audit event code lookup table.
 *
 * Source: ENGAGE - Audits - 0.22.xlsm (DbmAuditEvents + DbmAuditData List)
 *
 * This file keeps curated/manual classifications for important events.
 * Any audit code not listed below falls back to workbook-generated titles
 * from src/generatedAuditCodes.json so the UI shows a readable description
 * instead of a raw "Event 0x...." placeholder.
 *
 * result values:
 *   'granted'  — access was permitted
 *   'denied'   — access was rejected (with a reason)
 *   'alert'    — security / hardware alarm requiring attention
 *   'warning'  — degraded state (low battery, comm error, etc.)
 *   'info'     — normal operational event
 */
const CODES = {
  // ── Credential / Access (0x0500) ─────────────────────────────────────────
  0x0501: { category: 'Access',    title: 'Lockdown Active',               result: 'alert'   },
  0x0502: { category: 'Access',    title: 'Access Granted',                result: 'granted' },
  0x0503: { category: 'Access',    title: 'Lock Secured',                  result: 'info'    },
  0x0507: { category: 'Access',    title: 'Access Granted (Pass-Through)', result: 'granted' },
  0x0508: { category: 'Access',    title: 'Denied — Schedule Violation',   result: 'denied'  },
  0x0509: { category: 'Access',    title: 'Denied — Credential Not Active',result: 'denied'  },
  0x050A: { category: 'Access',    title: 'Denied — Credential Expired',   result: 'denied'  },
  0x050B: { category: 'Access',    title: 'Denied — Unknown Credential',   result: 'denied'  },
  0x050C: { category: 'Access',    title: 'Denied — Restricted Mode',      result: 'denied'  },
  0x050D: { category: 'Access',    title: 'Denied — Lockout',              result: 'denied'  },
  0x050E: { category: 'Access',    title: 'Access Granted (One-Time Use)', result: 'granted' },
  0x0517: { category: 'Schedule',  title: 'Auto Schedule Event',           result: 'info'    },
  0x0518: { category: 'Schedule',  title: 'Holiday Schedule Event',        result: 'info'    },
  0x0540: { category: 'Access',    title: 'Access Denied',                 result: 'denied'  },
  0x0541: { category: 'Access',    title: 'Access Blocked',                result: 'denied'  },
  0x0550: { category: 'Access',    title: 'Two-Factor Auth Required',      result: 'info'    },
  0x0551: { category: 'Access',    title: 'Two-Factor (Two Users)',        result: 'info'    },
  0x0552: { category: 'Access',    title: 'One-Factor (Two Users)',        result: 'info'    },

  // ── Door / Switch (0x0700) ────────────────────────────────────────────────
  0x0700: { category: 'Door',      title: 'Forced Door',                   result: 'alert'   },
  0x0701: { category: 'Door',      title: 'Door Propped Open',             result: 'alert'   },
  0x0702: { category: 'Door',      title: 'Tamper Detected',               result: 'alert'   },
  0x0703: { category: 'Door',      title: 'DPS Tamper',                    result: 'alert'   },
  0x0704: { category: 'Door',      title: 'Request to Exit (REX)',         result: 'info'    },
  0x070B: { category: 'Door',      title: 'Input Button Press',            result: 'info'    },
  0x0721: { category: 'Door',      title: 'Door Opened',                   result: 'info'    },
  0x0722: { category: 'Door',      title: 'Door Closed',                   result: 'info'    },
  0x0723: { category: 'Door',      title: 'Mechanical Override',           result: 'warning' },

  // ── Lock State Overrides (0x0F00) ─────────────────────────────────────────
  0x0F00: { category: 'Lock',      title: 'Schedule: Passage Mode',        result: 'info'    },
  0x0F01: { category: 'Lock',      title: 'Schedule: Secure Mode',         result: 'info'    },
  0x0F02: { category: 'Lock',      title: 'Schedule: Momentary Unlock',    result: 'info'    },
  0x0F03: { category: 'Lock',      title: 'Schedule: Holiday Restricted',  result: 'info'    },
  0x0F04: { category: 'Lock',      title: 'Freeze: Secure Mode',           result: 'info'    },
  0x0F05: { category: 'Lock',      title: 'Freeze: Passage Mode',          result: 'info'    },

  // ── Power (0x0100) ────────────────────────────────────────────────────────
  0x0100: { category: 'Power',     title: 'Low Battery',                   result: 'warning' },
  0x0101: { category: 'Power',     title: 'Critical Battery',              result: 'alert'   },
  0x0102: { category: 'Power',     title: 'Battery Level Report',          result: 'info'    },
  0x0103: { category: 'Power',     title: 'Power Source Change',           result: 'info'    },
  0x0104: { category: 'Power',     title: 'Power Voltage Report',          result: 'info'    },

  // ── Bluetooth (0x0200) ────────────────────────────────────────────────────
  0x0200: { category: 'BLE',       title: 'BLE App Connected',             result: 'info'    },
  0x0201: { category: 'BLE',       title: 'BLE App Disconnected',          result: 'info'    },

  // ── Database (0x0600) ─────────────────────────────────────────────────────
  0x0600: { category: 'Database',  title: 'Database Error',                result: 'warning' },
  0x0601: { category: 'Database',  title: 'Doorfile Update Successful',   result: 'info'    },
  0x0602: { category: 'Database',  title: 'Start Audit Upload',            result: 'info'    },
  0x0603: { category: 'Database',  title: 'Database Sort Status',          result: 'info'    },
  0x0604: { category: 'Database',  title: 'User Database Corrupt',         result: 'alert'   },
  0x0605: { category: 'Database',  title: 'Unread Audits Overwritten',     result: 'warning' },
  0x0606: { category: 'Database',  title: 'Doorfile Partial Database Download', result: 'warning' },
  0x0607: { category: 'Database',  title: 'Doorfile Partial Database Download Fault', result: 'warning' },

  // ── Firmware / System (0x0800) ────────────────────────────────────────────
  0x0800: { category: 'Firmware',  title: 'Lock Programmed',               result: 'info'    },
  0x0801: { category: 'Firmware',  title: 'Firmware Reset',                result: 'warning' },
  0x0802: { category: 'Firmware',  title: 'Firmware Update',               result: 'info'    },
  0x0803: { category: 'Firmware',  title: 'Firmware Image Invalid',        result: 'alert'   },

  // ── Clock / RTCC (0x0A00) ─────────────────────────────────────────────────
  0x0A00: { category: 'System',    title: 'DST Time Change',               result: 'info'    },
  0x0A01: { category: 'System',    title: 'RTCC Error',                    result: 'warning' },
  0x0A02: { category: 'System',    title: 'Clock Updated',                 result: 'info'    },

  // ── Gateway (0x1000) ──────────────────────────────────────────────────────
  0x1000: { category: 'Gateway',   title: 'Gateway Linked',                result: 'info'    },
  0x1001: { category: 'Gateway',   title: 'Gateway Link Failed',           result: 'alert'   },
  0x1002: { category: 'Gateway',   title: 'Gateway Comm Established',      result: 'info'    },
  0x1003: { category: 'Gateway',   title: 'Gateway Comm Error',            result: 'warning' },

  // ── Integrity / HMAC (0x1100) ─────────────────────────────────────────────
  0x1100: { category: 'Security',  title: 'HMAC Validation Passed',        result: 'info'    },
  0x1101: { category: 'Security',  title: 'HMAC Validation Failed',        result: 'alert'   },

  // ── Ethernet / WebSocket (0x1200) ─────────────────────────────────────────
  0x1200: { category: 'Network',   title: 'Ethernet Cable Status',         result: 'info'    },
  0x1204: { category: 'Network',   title: 'WebSocket Status',              result: 'info'    },
  0x1205: { category: 'Network',   title: 'WebSocket Closed',              result: 'warning' },
  0x1206: { category: 'Network',   title: 'CA Auth Failure',               result: 'alert'   },

  // ── Credential Not In DB (0x1300) ─────────────────────────────────────────
  0x1300: { category: 'Access',    title: 'Credential Not In Database',    result: 'denied'  },

  // ── Config (0x0400) ───────────────────────────────────────────────────────
  0x0400: { category: 'Config',    title: 'Config Updated',                result: 'info'    },
  0x0401: { category: 'Config',    title: 'Invalid Lock Parameter',        result: 'warning' },
};

// Schedule event sub-type data descriptions (DbmAuditData List, 0x0517/0x0518)
const SCHEDULE_DATA = {
  0:  'Secure Start',
  1:  'Passage Start',
  2:  'Holiday Passage',
  10: 'Secure End',
  11: 'Holiday Secure Start',
  12: 'Holiday Secure End',
};

// WS status event data values (0x1204)
const WS_STATUS_DATA = {
  1: 'WS Host Connected',
  2: 'WS Host Disconnected',
};

const DATABASE_STATUS_DATA = {
  0x0601: {
    0: 'Database download and Audit upload',
  },
  0x0603: {
    0: 'Database Presorted',
    1: 'Database Not Presorted',
    255: 'Unknown Database Presorting',
  },
  0x0605: {
    0: 'Device',
    1: 'Gateway',
  },
  0x0607: {
    0: 'Out of Order',
    1: 'Timeout',
  },
};

/**
 * Parse the ENGAGE eventType field into { code, data }.
 *
 * The gateway sends eventType as an 8-character hex string encoding two
 * concatenated 16-bit fields from the ENGAGE audit spec:
 *
 *   "0f010000"  →  auditEvent = 0x0F01 (Secured),  auditData = 0x0000
 *   "05020000"  →  auditEvent = 0x0502 (Granted),   auditData = 0x0000
 *   "05080100"  →  auditEvent = 0x0508 (Denied),    auditData = 0x0001
 *
 * Also handles plain numeric codes (e.g. 1282) and "0x..." prefixed strings.
 *
 * @param {number|string} eventType
 * @returns {{ code: number, data: number }}
 */
function _parse(eventType) {
  if (typeof eventType === 'string') {
    const s = eventType.replace(/^0x/i, '');
    if (s.length === 8) {
      // 8-char hex: first 4 = event code, last 4 = audit data
      return { code: parseInt(s.slice(0, 4), 16), data: parseInt(s.slice(4), 16) };
    }
    if (s.length === 4) {
      return { code: parseInt(s, 16), data: 0 };
    }
    return { code: parseInt(s, 10) || 0, data: 0 };
  }
  return { code: Number(eventType), data: 0 };
}

/**
 * Return human-readable metadata for an ENGAGE event type code.
 * @param {number|string} eventType
 * @returns {{ category: string, title: string, result: string, data: number }}
 */
function lookupEvent(eventType) {
  const { code, data } = _parse(eventType);
  const codeKey = code.toString(16).toUpperCase().padStart(4, '0');
  const generated = GENERATED_CODES[`0x${codeKey}`] || GENERATED_CODES[`0X${codeKey}`];
  const manual = CODES[code] || {};
  const entry = {
    category: generated?.category || manual.category || 'System',
    title: generated?.title || manual.title || `Event 0x${codeKey}`,
    result: manual.result || 'info',
  };
  return { ...entry, data };
}

/**
 * Return workbook-style mapping fields derived from ENGAGE - Audits - 0.22.xlsm.
 *
 * This exposes the same conceptual columns users see in the Allegion workbook:
 * Caption, Description, Audit/Alert, Event, Data, and Data Description.
 *
 * @param {number|string} eventType
 * @returns {{
 *   matched: boolean,
 *   caption: string,
 *   description: string,
 *   auditAlert: string,
 *   eventHex: string,
 *   dataHex: string,
 *   dataValue: number,
 *   dataDescription: string,
 *   sourceCategory: string,
 * }}
 */
function lookupWorkbookRow(eventType) {
  const { code, data } = _parse(eventType);
  const codeKey = code.toString(16).toUpperCase().padStart(4, '0');
  const generated = GENERATED_CODES[`0x${codeKey}`] || GENERATED_CODES[`0X${codeKey}`] || null;

  return {
    matched: !!generated,
    caption: generated?.caption || '',
    description: generated?.title || '',
    auditAlert: generated?.auditAlert || '',
    eventHex: `0x${codeKey}`,
    dataHex: `0x${data.toString(16).toUpperCase().padStart(4, '0')}`,
    dataValue: data,
    dataDescription: generated?.dataDescription || '',
    sourceCategory: generated?.sourceCategory || '',
  };
}

/**
 * Build a human-readable reason string from the event type and body.
 * The audit data embedded in the eventType string takes precedence over body fields.
 * @param {number|string} eventType
 * @param {string|object} eventBody  JSON string or parsed object
 * @returns {string}
 */
function buildReason(eventType, eventBody) {
  const { code, data: embeddedData } = _parse(eventType);

  let body = {};
  try {
    body = typeof eventBody === 'string' ? JSON.parse(eventBody) : (eventBody || {});
  } catch { /* ignore parse errors */ }

  // Prefer audit data embedded in eventType string; fall back to body fields
  const bodyData = body.auditData !== undefined ? body.auditData : (body.eventData !== undefined ? body.eventData : body.data);
  const data = embeddedData || bodyData;

  if (code === 0x0517 || code === 0x0518) return SCHEDULE_DATA[data] || '';
  if (code === 0x1204) return WS_STATUS_DATA[data] || '';
  if (DATABASE_STATUS_DATA[code]) return DATABASE_STATUS_DATA[code][data] || '';
  if (code === 0x0102 || code === 0x0104) {
    const level = body.batteryLevel ?? body.level ?? body.voltage;
    return level !== undefined ? String(level) : '';
  }
  // 0x1300 — Credential Not In Database: audit data = card bit count
  if (code === 0x1300 && data > 0) return `${data}-bit card presented`;

  return '';
}

/**
 * Extract the card bit count from a 0x1300 (Credential Not In Database) event.
 * The audit data field encodes the bit count of the presented card.
 * @param {number|string} eventType
 * @returns {number|null}
 */
function extractCardBitCount(eventType) {
  const { code, data } = _parse(eventType);
  if (code === 0x1300 && data > 0) return data;
  return null;
}

/**
 * Extract RAW card bytes from 0x1300-series audit events.
 *
 * Per Allegion "Examining Card Data" presentation (slide 6-7):
 * The lock sends raw card data in REVERSE byte order (LSB first) across
 * sequential 0x1301-0x1304 events. Each event's 16-bit data field contains
 * 2 bytes of card data.
 *
 * Example for a 37-bit card (from training):
 *   "event": "13000025"   → bit count = 0x25 = 37
 *   "event": "13010628"   → trailing 2 bytes (LSB)
 *   "event": "13025e31"   → middle 2 bytes
 *   "event": "13030081"   → leading 2 bytes (MSB, left-padded with 0x00)
 *
 * Reconstruction: reverse event order → 0081 + 5e31 + 0628 → 0x00815E310628
 * Strip leading padding → 0x815E310628
 * This IS the raw card data left-shifted to byte boundary (the clear PrimeCR data bytes).
 *
 * @param {string[]} auditCodes  Array of raw event type strings
 * @returns {{ cardBitCount: number|null, rawCardHex: string|null, clearPrimeCrHex: string|null, auditDataChunks: object }}
 */
function extractRawCardBytesFromAuditCodes(auditCodes) {
  let cardBitCount = null;
  const dataBySeq = {}; // seq (1-4) → 16-bit data value

  for (const code of (auditCodes || [])) {
    const parsed = _parse(code);
    if (parsed.code === 0x1300) {
      cardBitCount = parsed.data;
    }
    if (parsed.code >= 0x1301 && parsed.code <= 0x1304) {
      const seq = parsed.code - 0x1300; // 1, 2, 3, or 4
      dataBySeq[seq] = parsed.data;
    }
  }

  if (!cardBitCount || Object.keys(dataBySeq).length === 0) {
    return { cardBitCount, rawCardHex: null, clearPrimeCrHex: null, auditDataChunks: dataBySeq };
  }

  // Reconstruct bytes: highest seq = leading (MSB), lowest seq = trailing (LSB)
  const maxSeq = Math.max(...Object.keys(dataBySeq).map(Number));
  const allBytes = [];
  for (let seq = maxSeq; seq >= 1; seq--) {
    const val = dataBySeq[seq] || 0;
    allBytes.push((val >> 8) & 0xFF); // high byte of 16-bit data
    allBytes.push(val & 0xFF);        // low byte of 16-bit data
  }

  // The events pack to nearest 2-byte boundary with leading zero padding.
  // Actual data bytes = ceil(bitCount / 8). Strip any leading zero padding.
  const actualDataBytes = Math.ceil(cardBitCount / 8);
  const leadingPadding = allBytes.length - actualDataBytes;
  const dataBytes = leadingPadding > 0 ? allBytes.slice(leadingPadding) : allBytes;

  // Build clear PrimeCR: data bytes + pad with 0xFF to 16 bytes
  const clearBuf = Buffer.alloc(16, 0xFF);
  Buffer.from(dataBytes).copy(clearBuf, 0);

  return {
    cardBitCount,
    rawCardHex: Buffer.from(dataBytes).toString('hex'),
    clearPrimeCrHex: clearBuf.toString('hex'),
    auditDataChunks: dataBySeq,
  };
}

/**
 * Extract card data embedded in the 0x1300-series audit event codes.
 * Uses the raw byte reconstruction to decode FC and card number for known formats.
 *
 * @param {string[]} auditCodes  Array of raw event type strings
 * @returns {{ cardNumber: string|null, facilityCode: string|null, cardBitCount: number|null, rawCardHex: string|null, clearPrimeCrHex: string|null }}
 */
function extractCardDataFromAuditCodes(auditCodes) {
  const raw = extractRawCardBytesFromAuditCodes(auditCodes);

  let cardNumber = null;
  let facilityCode = null;

  if (raw.rawCardHex && raw.cardBitCount) {
    // Decode FC and card number from raw bits for common formats
    const buf = Buffer.from(raw.rawCardHex, 'hex');
    const bits = [];
    for (let i = 0; i < raw.cardBitCount; i++) {
      const byteIdx = Math.floor(i / 8);
      const bitIdx = 7 - (i % 8);
      bits.push((buf[byteIdx] >> bitIdx) & 1);
    }

    if (raw.cardBitCount === 26) {
      // H10301: [EP 1][FC 8][Card 16][OP 1]
      facilityCode = 0;
      for (let i = 1; i <= 8; i++) facilityCode = (facilityCode << 1) | bits[i];
      cardNumber = 0;
      for (let i = 9; i <= 24; i++) cardNumber = (cardNumber << 1) | bits[i];
    } else if (raw.cardBitCount === 37) {
      // H10304: [EP 1][FC 16][Card 19][OP 1]
      facilityCode = 0;
      for (let i = 1; i <= 16; i++) facilityCode = (facilityCode << 1) | bits[i];
      cardNumber = 0;
      for (let i = 17; i <= 35; i++) cardNumber = (cardNumber << 1) | bits[i];
    }
  }

  return {
    cardNumber: cardNumber !== null ? String(cardNumber) : null,
    facilityCode: facilityCode !== null ? String(facilityCode) : null,
    cardBitCount: raw.cardBitCount,
    rawCardHex: raw.rawCardHex,
    clearPrimeCrHex: raw.clearPrimeCrHex,
  };
}

module.exports = {
  lookupEvent,
  lookupWorkbookRow,
  buildReason,
  extractCardBitCount,
  extractCardDataFromAuditCodes,
  extractRawCardBytesFromAuditCodes,
};
