// Central client state: live samples, history tiers, latest detail/slow data, events, settings.
// Views subscribe with store.on(type, fn): 'sample' | 'detail' | 'slow' | 'event' | 'range' | 'pause' | 'settings' | 'conn'.

import { isNum } from './fmt.js';

export const RANGES = {
  '10m': { ms: 600_000, label: '10 Min', tier: 'raw', step: 1000 },
  '1h': { ms: 3_600_000, label: '1 Std', tier: 't10', step: 10_000 },
  '6h': { ms: 21_600_000, label: '6 Std', tier: 't60', step: 60_000 },
  '24h': { ms: 86_400_000, label: '24 Std', tier: 't60', step: 60_000 },
};

const handlers = new Map();
const store = {
  info: null, raw: [], t10: [], t60: [], detail: null, slow: null, events: [], settings: null, account: null,
  range: '10m', paused: false, pausedAt: 0, skew: 0, connected: false, lastMsg: 0, bootAt: 0,
  loaded: { t10: false, t60: false },
  on(type, fn) {
    if (!handlers.has(type)) handlers.set(type, new Set());
    handlers.get(type).add(fn);
    return () => handlers.get(type).delete(fn);
  },
  emit(type, v) { const set = handlers.get(type); if (set) for (const fn of [...set]) { try { fn(v); } catch (e) { console.error(type, e); } } },
  now() { return this.paused ? this.pausedAt : Date.now() + this.skew; },
  last() { return this.raw[this.raw.length - 1] || null; },
};

// ------------------------------------------------------------------ api

async function request(method, url, body) {
  const opts = { method, credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.headers['X-SD'] = '1'; opts.body = JSON.stringify(body); }
  const r = await fetch(url, opts);
  if (r.status === 401) { location.replace('/login'); throw new Error('unauthenticated'); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) { const e = new Error((j && j.error) || `HTTP ${r.status}`); e.status = r.status; e.retry = j && j.retry; e.code = j && j.code; e.expect = j && j.expect; throw e; }
  return j;
}
export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b = {}) => request('PUT', u, b),
};

// ------------------------------------------------------------------ history tiers

/** points for the selected range; tiers get the newest raw sample appended so the line reaches "now" */
store.pts = function pts(range = this.range) {
  const r = RANGES[range];
  if (r.tier === 'raw') return { pts: this.raw, step: 1000 };
  const base = r.tier === 't10' ? this.t10 : this.t60;
  const last = this.last();
  const tail = last && (!base.length || last.t > base[base.length - 1].t) ? [last] : [];
  return { pts: tail.length ? base.concat(tail) : base, step: r.step };
};

async function fetchTier(tier) {
  const cur = store[tier];
  const since = cur.length ? cur[cur.length - 1].t : 0;
  const r = await api.get(`/api/history?tier=${tier}&since=${since}`);
  if (since === 0) store[tier] = r.pts;
  else if (r.pts.length) {
    store[tier] = cur.concat(r.pts);
    const max = tier === 't10' ? 720 : 1440;
    if (store[tier].length > max) store[tier].splice(0, store[tier].length - max);
  }
  store.loaded[tier] = true;
  return r;
}

store.ensureTier = async function ensureTier(range = this.range) {
  const tier = RANGES[range].tier;
  if (tier === 'raw') return;
  await fetchTier(tier);
  this.emit('range', this.range);
};

/** value change versus `ageMs` ago, using the finest tier that covers it */
store.delta = function delta(key, ageMs, windowMs = 60_000) {
  const cur = this.last();
  if (!cur || !isNum(cur[key])) return null;
  const target = cur.t - ageMs;
  const src = ageMs <= 540_000 ? this.raw : ageMs <= 7_000_000 ? this.t10 : this.t60;
  if (!src.length || src[0].t > target + windowMs) return null;
  let sum = 0; let n = 0;
  for (const p of src) { if (Math.abs(p.t - target) <= windowMs && isNum(p[key])) { sum += p[key]; n++; } }
  if (!n) return null;
  const past = sum / n;
  return { cur: cur[key], past, diff: cur[key] - past, rel: past ? (cur[key] - past) / Math.abs(past) : null };
};

/** last n values of `key` over the selected range (for sparklines) */
store.series = function series(key, maxPoints = 60) {
  const { pts } = this.pts();
  const r = RANGES[this.range];
  const t0 = this.now() - r.ms;
  const out = [];
  for (let i = pts.length - 1; i >= 0 && pts[i].t >= t0; i--) out.push(pts[i][key]);
  out.reverse();
  if (out.length <= maxPoints) return out;
  const k = out.length / maxPoints;
  return Array.from({ length: maxPoints }, (_, i) => out[Math.min(out.length - 1, Math.floor(i * k))]);
};

// ------------------------------------------------------------------ bootstrap + stream

function apply(b) {
  store.skew = b.now - Date.now();
  store.info = b.info;
  store.raw = b.raw;
  if (b.detail) store.detail = b.detail;
  store.slow = b.slow;
  store.events = b.events || store.events;
  store.settings = b.settings;
  store.account = b.account;
}

store.bootstrap = async function bootstrap() {
  apply(await api.get('/api/bootstrap'));
  this.bootAt = performance.now();
  fetchTier('t60').then(() => this.emit('range', this.range)).catch(() => {});
};

store.connect = function connect() {
  const es = new EventSource('/api/stream');
  let dropped = false;
  es.onmessage = (e) => {
    let s;
    try { s = JSON.parse(e.data); } catch { return; }
    this.lastMsg = performance.now();
    if (!this.connected) { this.connected = true; this.emit('conn', true); }
    this.raw.push(s);
    if (this.raw.length > 700) this.raw.splice(0, this.raw.length - 650);
    this.emit('sample', s);
  };
  es.addEventListener('detail', (e) => { try { this.detail = JSON.parse(e.data); this.emit('detail', this.detail); } catch {} });
  es.addEventListener('slow', (e) => { try { this.slow = JSON.parse(e.data); this.emit('slow', this.slow); } catch {} });
  es.addEventListener('evt', (e) => {
    try { const ev = JSON.parse(e.data); this.events.unshift(ev); if (this.events.length > 1000) this.events.length = 1000; this.emit('event', ev); } catch {}
  });
  es.onerror = async () => {
    dropped = true;
    if (this.connected) { this.connected = false; this.emit('conn', false); }
    try { const r = await fetch('/auth/status', { credentials: 'same-origin' }); const j = await r.json(); if (!j.authed) location.replace('/login'); } catch {}
  };
  es.onopen = async () => {
    if (!dropped) return;
    dropped = false;
    try { apply(await api.get('/api/bootstrap')); this.emit('range', this.range); this.emit('detail', this.detail); this.emit('slow', this.slow); } catch {}
  };
  setInterval(() => {
    const live = performance.now() - this.lastMsg < 4500;
    if (live !== this.connected) { this.connected = live; this.emit('conn', live); }
  }, 1500);
};

store.setRange = function setRange(r) {
  if (!RANGES[r]) return;
  this.range = r;
  try { localStorage.setItem('sd.range', r); } catch {}
  this.emit('range', r);
  this.ensureTier(r).catch(() => {});
};

store.togglePause = function togglePause() {
  this.paused = !this.paused;
  if (this.paused) this.pausedAt = Date.now() + this.skew;
  this.emit('pause', this.paused);
};

store.saveSettings = async function saveSettings(patch) {
  const r = await api.put('/api/settings', patch);
  this.settings = r.settings;
  this.discovered = r.discovered;
  this.emit('settings', this.settings);
  return r;
};

// keep the tiers fresh while the page is open
setInterval(() => { if (store.loaded.t60 && !document.hidden) fetchTier('t60').then(() => store.emit('range', store.range)).catch(() => {}); }, 60_000);
setInterval(() => { if (store.loaded.t10 && store.range === '1h' && !document.hidden) fetchTier('t10').then(() => store.emit('range', store.range)).catch(() => {}); }, 15_000);

export { store };
