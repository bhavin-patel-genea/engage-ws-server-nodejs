'use strict';

/**
 * logger.js — Structured JSON logger for ENGAGE WS Server.
 *
 * Wraps console.log/error with ISO timestamps and structured JSON output.
 * Production would replace this with winston/pino; for the POC, zero
 * dependencies and simple stdout JSON is sufficient.
 *
 * Usage:
 *   const log = require('./logger');
 *   log.info('gateway:connected', { sn: 'ABC123' });
 *   log.warn('clock-drift', { sn: 'ABC123', driftSeconds: 310 });
 *   log.error('tls-failure', { sn: 'ABC123', error: 'cert expired' });
 */

function formatEntry(level, event, data = {}) {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  });
}

const logger = {
  info(event, data) {
    console.log(formatEntry('info', event, data));
  },

  warn(event, data) {
    console.warn(formatEntry('warn', event, data));
  },

  error(event, data) {
    console.error(formatEntry('error', event, data));
  },

  /**
   * Log a reconnection gap event with all timing details.
   * @param {string} sn
   * @param {number} gapSeconds
   * @param {string} authType
   */
  reconnectionGap(sn, gapSeconds, authType) {
    console.log(formatEntry('info', 'gateway:reconnection-gap', {
      sn,
      gapSeconds,
      authType,
      description: `Gateway ${sn} was offline for ${gapSeconds.toFixed(2)}s`,
    }));
  },
};

module.exports = logger;
