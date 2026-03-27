'use strict';

/**
 * ENGAGE audit event code lookup table.
 *
 * Source: ENGAGE - Audits - 0.22.xlsm (DbmAuditEvents + DbmAuditData List)
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
  0x0600: { category: 'Database',  title: 'Database Update Complete',      result: 'info'    },
  0x0601: { category: 'Database',  title: 'Database Corrupt',              result: 'alert'   },
  0x0602: { category: 'Database',  title: 'Partial Database Download',     result: 'warning' },
  0x0603: { category: 'Database',  title: 'Database Partial Update',       result: 'warning' },

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
  const entry = CODES[code] || {
    category: 'System',
    title:    `Event 0x${code.toString(16).toUpperCase().padStart(4, '0')}`,
    result:   'info',
  };
  return { ...entry, data };
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
  if (code === 0x0102 || code === 0x0104) {
    const level = body.batteryLevel ?? body.level ?? body.voltage;
    return level !== undefined ? String(level) : '';
  }

  return '';
}

module.exports = { lookupEvent, buildReason };
