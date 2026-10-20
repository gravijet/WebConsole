'use strict';
const fs = require('fs');
const path = require('path');
const { FIELDS, MAXED } = require('./fields');

const round = (v) => (Math.abs(v) >= 1000 ? Math.round(v) : Math.round(v * 100) / 100);

class Rollup {
  constructor(step, size) { this.step = step; this.size = size; this.pts = []; this.cur = null; }
  add(s) {
    const b = Math.floor(s.t / this.step) * this.step;
    if (!this.cur || this.cur.b !== b) { this.flush(); this.cur = { b, n: {}, sum: {}, max: {} }; }
    const c = this.cur;
    for (const k of FIELDS) {
      const v = s[k];
      if (v == null) continue;
      c.n[k] = (c.n[k] || 0) + 1;
      c.sum[k] = (c.sum[k] || 0) + v;
    }
    for (const k of MAXED) { const v = s[k]; if (v != null && !(c.max[k] >= v)) c.max[k] = v; }
  }
  flush() {
    const c = this.cur;
    if (!c) return;
    const p = { t: c.b + this.step / 2 };
    for (const k of FIELDS) if (c.n[k]) p[k] = round(c.sum[k] / c.n[k]);
    for (const k of MAXED) if (c.max[k] != null) p[`${k}Max`] = round(c.max[k]);
    this.pts.push(p);
    if (this.pts.length > this.size) this.pts.splice(0, this.pts.length - this.size);
    this.cur = null;
  }
}

/** Atomic JSON persistence in the state directory. */
function makeStore(dir) {
  const file = (name) => path.join(dir, name);
  return {
    load(name, fallback) {
      try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
    },
    save(name, data, mode = 0o600) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${file(name)}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data), { mode });
        fs.renameSync(tmp, file(name));
      } catch (e) {
        console.error(`save ${name} failed: ${e.message}`);
      }
    },
    file,
  };
}

module.exports = { Rollup, makeStore, round };
