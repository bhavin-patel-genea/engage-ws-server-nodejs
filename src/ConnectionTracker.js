'use strict';

const fs = require('fs');
const path = require('path');

/**
 * ConnectionTracker — Tracks gateway connect/disconnect events and measures
 * reconnection gap durations.
 *
 * Primary use case: measure how long the gateway is offline during the
 * mandatory 24-hour lifecycle disconnect. This data answers the question:
 * "When the gateway disconnects every 24 hours, how long does it take to
 * come back online?"
 *
 * Stores data in a JSON file so it persists across server restarts.
 */
class ConnectionTracker {
  /**
   * @param {string} filePath  Path to the JSON file (default: ./data/connections.json)
   */
  constructor(filePath = './data/connections.json') {
    this.filePath = filePath;

    // In-memory state
    this.events = [];            // all connection events
    this.gaps = [];              // computed reconnection gaps
    this._lastDisconnect = {};   // sn → ISO timestamp of last disconnect (for gap calc)
    this._dirty = false;
    this._saveTimer = null;

    // Ensure data directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._load();

    // Debounced save: flush every 5 seconds if dirty
    this._saveTimer = setInterval(() => {
      if (this._dirty) this._save();
    }, 5_000);

    process.on('beforeExit', () => this.close());
  }

  /**
   * Record a gateway connection event.
   * If there's a previous disconnect for this SN, calculate the gap.
   *
   * @param {string} sn       Gateway serial number
   * @param {string} [authType]  'first' | 'reauth' (from routes.js detection)
   * @returns {{ gapSeconds: number|null }}  The reconnection gap, or null if first connect
   */
  recordConnect(sn, authType = 'unknown') {
    const now = new Date().toISOString();

    this.events.push({
      sn,
      eventType: 'connected',
      authType,
      timestamp: now,
    });

    // Calculate reconnection gap
    let gapSeconds = null;
    const lastDisconnect = this._lastDisconnect[sn];
    if (lastDisconnect) {
      gapSeconds = (new Date(now).getTime() - new Date(lastDisconnect).getTime()) / 1000;

      this.gaps.push({
        sn,
        disconnectedAt: lastDisconnect,
        reconnectedAt: now,
        gapSeconds: Math.round(gapSeconds * 100) / 100, // 2 decimal places
        authType,
      });

      console.log(
        `[ConnectionTracker] Gateway ${sn} reconnected — gap: ${gapSeconds.toFixed(2)}s` +
        ` (${authType === 'reauth' ? '24-hour re-auth' : authType})`
      );

      delete this._lastDisconnect[sn];
    } else {
      console.log(`[ConnectionTracker] Gateway ${sn} connected (first connection)`);
    }

    this._dirty = true;
    return { gapSeconds };
  }

  /**
   * Record a gateway disconnection event.
   *
   * @param {string} sn  Gateway serial number
   */
  recordDisconnect(sn) {
    const now = new Date().toISOString();

    this.events.push({
      sn,
      eventType: 'disconnected',
      timestamp: now,
    });

    this._lastDisconnect[sn] = now;
    this._dirty = true;

    console.log(`[ConnectionTracker] Gateway ${sn} disconnected at ${now}`);
  }

  /**
   * Get reconnection gap history for a gateway (most recent first).
   *
   * @param {string} [sn]     Filter by gateway SN (null = all)
   * @param {number} [limit]  Max entries (default: 20)
   * @returns {object[]}
   */
  getReconnectionHistory(sn = null, limit = 20) {
    let results = [...this.gaps].reverse();
    if (sn) {
      results = results.filter(g => g.sn === sn);
    }
    return results.slice(0, limit);
  }

  /**
   * Get average reconnection gap in seconds for a gateway.
   *
   * @param {string} [sn]  Filter by gateway SN (null = all)
   * @returns {{ averageSeconds: number|null, count: number }}
   */
  getAverageGap(sn = null) {
    let relevant = this.gaps;
    if (sn) {
      relevant = relevant.filter(g => g.sn === sn);
    }
    if (relevant.length === 0) return { averageSeconds: null, count: 0 };

    const total = relevant.reduce((sum, g) => sum + g.gapSeconds, 0);
    return {
      averageSeconds: Math.round((total / relevant.length) * 100) / 100,
      count: relevant.length,
    };
  }

  /**
   * Get connection event log (most recent first).
   *
   * @param {string} [sn]     Filter by SN
   * @param {number} [limit]  Max entries (default: 50)
   * @returns {object[]}
   */
  getEvents(sn = null, limit = 50) {
    let results = [...this.events].reverse();
    if (sn) {
      results = results.filter(e => e.sn === sn);
    }
    return results.slice(0, limit);
  }

  /**
   * Get summary stats for dashboard display.
   * @returns {object}
   */
  getStats() {
    const avg = this.getAverageGap();
    return {
      totalEvents: this.events.length,
      totalGaps: this.gaps.length,
      averageGapSeconds: avg.averageSeconds,
      lastGap: this.gaps.length > 0 ? this.gaps[this.gaps.length - 1] : null,
    };
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        this.events = Array.isArray(data.events) ? data.events : [];
        this.gaps = Array.isArray(data.gaps) ? data.gaps : [];
        this._lastDisconnect = data._lastDisconnect || {};
        console.log(
          `[ConnectionTracker] Loaded ${this.events.length} events, ` +
          `${this.gaps.length} reconnection gaps from ${this.filePath}`
        );
      } else {
        console.log(`[ConnectionTracker] No existing file — starting fresh (${this.filePath})`);
      }
    } catch (err) {
      console.error(`[ConnectionTracker] Failed to load ${this.filePath}: ${err.message} — starting fresh`);
      this.events = [];
      this.gaps = [];
      this._lastDisconnect = {};
    }
  }

  _save() {
    try {
      const data = {
        events: this.events,
        gaps: this.gaps,
        _lastDisconnect: this._lastDisconnect,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.error(`[ConnectionTracker] Failed to save ${this.filePath}: ${err.message}`);
    }
  }

  close() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) {
      this._save();
    }
  }
}

module.exports = ConnectionTracker;
