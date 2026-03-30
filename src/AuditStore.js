'use strict';

const fs = require('fs');
const path = require('path');

/**
 * AuditStore — JSON file-based audit log persistence with configurable TTL.
 *
 * Stores ENGAGE gateway audit events to a JSON file so they survive server
 * restarts. Automatically prunes entries older than the retention window.
 *
 * Design decisions (POC):
 *   - JSON file (no external database dependency)
 *   - Debounced writes (flush every 5 s) to avoid excessive disk I/O
 *   - Prune on every insert (cheap at POC event volumes)
 *   - Production should replace this with PostgreSQL/DynamoDB
 */
class AuditStore {
  /**
   * @param {string} filePath        Path to the JSON file (default: ./data/audits.json)
   * @param {number} retentionHours  How long to keep entries (default: 48 hours)
   */
  constructor(filePath = './data/audits.json', retentionHours = 48) {
    this.filePath = filePath;
    this.retentionMs = retentionHours * 60 * 60 * 1000;
    this.entries = [];
    this._dirty = false;
    this._saveTimer = null;

    // Ensure data directory exists
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._load();

    // Debounced save: flush to disk every 5 seconds if dirty
    this._saveTimer = setInterval(() => {
      if (this._dirty) this._save();
    }, 5_000);

    // Flush on process exit
    process.on('beforeExit', () => this.close());
  }

  /**
   * Insert an audit event entry.
   * Auto-prunes expired entries on each insert.
   *
   * @param {object} entry  Audit event object (from engage:event handler)
   */
  insert(entry) {
    this.entries.unshift({
      ...entry,
      _storedAt: new Date().toISOString(),
    });
    this._prune();
    this._dirty = true;
  }

  /**
   * Query audit entries by gateway serial number and time range.
   *
   * @param {string} [sn]     Filter by gateway serial number (null = all)
   * @param {Date}   [since]  Only entries after this date (null = no filter)
   * @param {number} [limit]  Max entries to return (default: 100)
   * @returns {object[]}
   */
  query(sn = null, since = null, limit = 100) {
    let results = this.entries;

    if (sn) {
      results = results.filter(e => e.sn === sn);
    }
    if (since) {
      const sinceTime = since.getTime();
      results = results.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
    }

    return results.slice(0, limit);
  }

  /**
   * Get most recent entries (for dashboard init).
   *
   * @param {number} limit  Max entries to return (default: 50)
   * @returns {object[]}
   */
  getAll(limit = 50) {
    return this.entries.slice(0, limit);
  }

  /**
   * Get total count of stored entries.
   * @returns {number}
   */
  get size() {
    return this.entries.length;
  }

  /**
   * Get retention info for logging.
   * @returns {{ total: number, oldestAt: string|null, retentionHours: number }}
   */
  getStats() {
    return {
      total: this.entries.length,
      oldestAt: this.entries.length > 0
        ? this.entries[this.entries.length - 1].timestamp
        : null,
      retentionHours: this.retentionMs / (60 * 60 * 1000),
    };
  }

  /**
   * Remove entries older than the retention window.
   */
  _prune() {
    const cutoff = Date.now() - this.retentionMs;
    const before = this.entries.length;
    this.entries = this.entries.filter(e => {
      const ts = new Date(e._storedAt || e.timestamp).getTime();
      return ts >= cutoff;
    });
    if (this.entries.length < before) {
      const pruned = before - this.entries.length;
      console.log(`[AuditStore] Pruned ${pruned} entries older than ${this.retentionMs / 3600000}h (${this.entries.length} remaining)`);
    }
  }

  /**
   * Load entries from disk on startup.
   */
  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8');
        const data = JSON.parse(raw);
        this.entries = Array.isArray(data) ? data : [];
        this._prune(); // remove expired entries on load
        console.log(`[AuditStore] Loaded ${this.entries.length} entries from ${this.filePath}`);
      } else {
        console.log(`[AuditStore] No existing file — starting fresh (${this.filePath})`);
      }
    } catch (err) {
      console.error(`[AuditStore] Failed to load ${this.filePath}: ${err.message} — starting fresh`);
      this.entries = [];
    }
  }

  /**
   * Write entries to disk (called by debounce timer).
   */
  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.entries, null, 2), 'utf8');
      this._dirty = false;
    } catch (err) {
      console.error(`[AuditStore] Failed to save ${this.filePath}: ${err.message}`);
    }
  }

  /**
   * Flush pending writes and stop the save timer.
   */
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

module.exports = AuditStore;
