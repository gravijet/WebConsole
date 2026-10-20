'use strict';
// Change log: everything notable that happened on the box (service state, thresholds,
// site outages, containers, ports, logins ...). Persisted, newest first.

class Events {
  constructor(store, max = 1000) {
    this.store = store;
    this.max = max;
    this.list = store.load('events.json', { events: [] }).events || [];
    this.listeners = [];
    this.recent = new Map(); // dedupe key -> last time
    this.seq = this.list.reduce((m, e) => Math.max(m, e.id || 0), 0);
    this.dirty = false;
  }

  on(fn) { this.listeners.push(fn); }

  /** level: info | warn | crit | ok. key + cooldownMs suppress repeats of the same thing. */
  add({ level = 'info', kind, title, detail = '', key = null, cooldown = 0 }) {
    const now = Date.now();
    if (key) {
      const last = this.recent.get(key) || 0;
      if (now - last < cooldown) return null;
      this.recent.set(key, now);
    }
    const e = { id: ++this.seq, t: now, level, kind, title, detail };
    this.list.unshift(e);
    if (this.list.length > this.max) this.list.length = this.max;
    this.dirty = true;
    for (const fn of this.listeners) { try { fn(e); } catch {} }
    return e;
  }

  recentList(n = 100) { return this.list.slice(0, n); }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    this.store.save('events.json', { events: this.list });
  }
}

module.exports = { Events };
