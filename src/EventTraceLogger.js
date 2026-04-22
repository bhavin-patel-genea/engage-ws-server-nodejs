'use strict';

const fs = require('fs');
const path = require('path');

class EventTraceLogger {
  constructor(filePath = './data/egw-event-trace.log') {
    this.filePath = filePath;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  trace(stage, data = {}) {
    const entry = {
      ts: new Date().toISOString(),
      stage,
      ...data,
    };

    try {
      const payload = [
        '============================================================',
        `${entry.ts} | ${stage}`,
        '============================================================',
        JSON.stringify(entry, null, 2),
        '',
      ].join('\n');
      fs.appendFileSync(this.filePath, payload, 'utf8');
    } catch (err) {
      console.warn(`[EventTraceLogger] Failed to append trace entry: ${err.message}`);
    }
  }
}

module.exports = EventTraceLogger;
