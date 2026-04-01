'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_SCHEDULE_ID = 'schedule-default-24x7';
const DAY_ORDER = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

function nowIso() {
  return new Date().toISOString();
}

function defaultSchedule() {
  const ts = nowIso();
  return {
    id: DEFAULT_SCHEDULE_ID,
    name: '24x7 Default',
    description: 'Required ENGAGE default schedule',
    days: [...DAY_ORDER],
    strtHr: 0,
    strtMn: 0,
    lngth: 1439,
    lockIds: [],
    isDefault: true,
    createdAt: ts,
    updatedAt: ts,
  };
}

function createDefaultState() {
  return {
    version: 1,
    users: [],
    schedules: [defaultSchedule()],
    customCardFormats: [],
  };
}

class AccessStateStore {
  constructor(filePath = './data/access-state.json') {
    this.filePath = filePath;
    this.state = createDefaultState();
    this._dirty = false;
    this._saveTimer = null;

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this._load();

    this._saveTimer = setInterval(() => {
      if (this._dirty) this._save();
    }, 5_000);

    process.on('beforeExit', () => this.close());
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  mutate(mutator) {
    mutator(this.state);
    this._ensureDefaults();
    this._dirty = true;
    return this.getSnapshot();
  }

  createId(prefix) {
    return `${prefix}-${crypto.randomUUID()}`;
  }

  close() {
    if (this._saveTimer) {
      clearInterval(this._saveTimer);
      this._saveTimer = null;
    }
    if (this._dirty) this._save();
  }

  _ensureDefaults() {
    if (!Array.isArray(this.state.users)) this.state.users = [];
    if (!Array.isArray(this.state.schedules)) this.state.schedules = [];
    if (!Array.isArray(this.state.customCardFormats)) this.state.customCardFormats = [];

    const defaultIdx = this.state.schedules.findIndex(s => s.id === DEFAULT_SCHEDULE_ID || s.isDefault);
    if (defaultIdx === -1) {
      this.state.schedules.unshift(defaultSchedule());
    } else {
      const existing = this.state.schedules[defaultIdx];
      existing.id = DEFAULT_SCHEDULE_ID;
      existing.isDefault = true;
      existing.name = existing.name || '24x7 Default';
      existing.days = Array.isArray(existing.days) && existing.days.length > 0 ? existing.days : [...DAY_ORDER];
      existing.strtHr = existing.strtHr ?? 0;
      existing.strtMn = existing.strtMn ?? 0;
      existing.lngth = existing.lngth ?? 1439;
      existing.lockIds = Array.isArray(existing.lockIds) ? existing.lockIds : [];
      if (defaultIdx > 0) {
        this.state.schedules.splice(defaultIdx, 1);
        this.state.schedules.unshift(existing);
      }
    }
  }

  _load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.state = createDefaultState();
        this._dirty = true;
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      this.state = JSON.parse(raw);
      this._ensureDefaults();
    } catch (err) {
      console.warn(`[AccessStateStore] Failed to load ${this.filePath}: ${err.message}`);
      this.state = createDefaultState();
      this._dirty = true;
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
      this._dirty = false;
    } catch (err) {
      console.warn(`[AccessStateStore] Failed to save ${this.filePath}: ${err.message}`);
    }
  }
}

module.exports = {
  AccessStateStore,
  DEFAULT_SCHEDULE_ID,
  DAY_ORDER,
};
