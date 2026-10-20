'use strict';
// Everything the owner can change at runtime. Strictly validated: unknown keys are dropped,
// numbers are clamped, strings are length-limited.

const DEFAULTS = {
  sites: {
    auto: true,              // discover hostnames from the nginx configuration
    interval: 30,            // seconds between probes
    disabled: [],            // hostnames that are not monitored
    custom: [],              // [{ url, name }]
    names: {},               // hostname -> display name chosen by the owner
  },
  services: {
    showInactive: false,
    hidden: [],
  },
  internet: {
    targets: [
      { name: 'Cloudflare', host: '1.1.1.1', port: 443 },
      { name: 'Google', host: '8.8.8.8', port: 443 },
      { name: 'Quad9', host: '9.9.9.9', port: 443 },
    ],
    dnsName: 'cloudflare.com',
  },
  alerts: {
    cpu: { on: true, pct: 90, seconds: 30 },
    load: { on: true, factor: 1.5 },
    memAvail: { on: true, pct: 10 },
    swapUse: { on: true, pct: 80 },
    psiMem: { on: true, pct: 5 },
    disk: { on: true, pct: 85 },
    inode: { on: true, pct: 90 },
    certDays: { on: true, days: 14 },
    siteSlow: { on: false, ms: 2000 },
    netErrors: { on: true, perSec: 5 },
    retrans: { on: true, pct: 5 },
    services: { on: true },
    docker: { on: true },
    ports: { on: true },
    sites: { on: true },
    reboot: { on: true },
  },
  processes: { top: 15 },
};

const clampNum = (v, min, max, def) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hostRe = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const hostLike = (h) => hostRe.test(h) || /^\d{1,3}(\.\d{1,3}){3}$/.test(h);

function sanitize(input, base) {
  const out = JSON.parse(JSON.stringify(base));
  const s = input || {};

  if (s.sites && typeof s.sites === 'object') {
    out.sites.auto = s.sites.auto !== false;
    out.sites.interval = clampNum(s.sites.interval, 10, 3600, base.sites.interval);
    out.sites.disabled = [...new Set((Array.isArray(s.sites.disabled) ? s.sites.disabled : []).map((h) => str(h, 253).toLowerCase()).filter(hostLike))].slice(0, 500);
    out.sites.custom = (Array.isArray(s.sites.custom) ? s.sites.custom : []).slice(0, 100).map((c) => {
      const url = str(c && c.url, 300);
      try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return null;
        return { url: u.href, name: str(c.name, 60) };
      } catch { return null; }
    }).filter(Boolean);
    out.sites.names = {};
    if (s.sites.names && typeof s.sites.names === 'object') {
      for (const [h, n] of Object.entries(s.sites.names).slice(0, 500)) {
        const host = str(h, 253).toLowerCase();
        const name = str(n, 60);
        if (hostLike(host) && name) out.sites.names[host] = name;
      }
    }
  }

  if (s.services && typeof s.services === 'object') {
    out.services.showInactive = s.services.showInactive === true;
    out.services.hidden = [...new Set((Array.isArray(s.services.hidden) ? s.services.hidden : []).map((x) => str(x, 120)).filter((x) => /^[\w@:.\\-]+\.service$/.test(x)))].slice(0, 500);
  }

  if (s.internet && typeof s.internet === 'object') {
    const t = (Array.isArray(s.internet.targets) ? s.internet.targets : []).slice(0, 3).map((x) => ({
      name: str(x && x.name, 30) || 'Ziel',
      host: str(x && x.host, 253).toLowerCase(),
      port: clampNum(x && x.port, 1, 65535, 443),
    })).filter((x) => hostLike(x.host));
    if (t.length) out.internet.targets = t;
    const d = str(s.internet.dnsName, 253).toLowerCase();
    if (hostLike(d)) out.internet.dnsName = d;
  }

  if (s.alerts && typeof s.alerts === 'object') {
    const a = s.alerts;
    const on = (k) => (a[k] && typeof a[k] === 'object' ? a[k].on !== false : base.alerts[k].on);
    for (const k of Object.keys(base.alerts)) {
      if (!a[k] || typeof a[k] !== 'object') continue;
      out.alerts[k].on = on(k);
    }
    const n = (k, f, min, max) => { if (a[k]) out.alerts[k][f] = clampNum(a[k][f], min, max, base.alerts[k][f]); };
    n('cpu', 'pct', 1, 100); n('cpu', 'seconds', 5, 3600);
    n('load', 'factor', 0.1, 20);
    n('memAvail', 'pct', 1, 90);
    n('swapUse', 'pct', 1, 100);
    n('psiMem', 'pct', 0.1, 100);
    n('disk', 'pct', 1, 100);
    n('inode', 'pct', 1, 100);
    n('certDays', 'days', 1, 365);
    n('siteSlow', 'ms', 50, 60000);
    n('netErrors', 'perSec', 0.1, 100000);
    n('retrans', 'pct', 0.1, 100);
  }

  if (s.processes && typeof s.processes === 'object') out.processes.top = Math.round(clampNum(s.processes.top, 5, 50, base.processes.top));
  return out;
}

class Settings {
  constructor(store) {
    this.store = store;
    this.value = sanitize(store.load('settings.json', {}), DEFAULTS);
    this.listeners = [];
  }
  get() { return this.value; }
  onChange(fn) { this.listeners.push(fn); }
  update(patch) {
    // merge shallowly per section so a client may send one section only
    const merged = { ...this.value };
    for (const k of Object.keys(DEFAULTS)) if (patch && patch[k] !== undefined) merged[k] = { ...this.value[k], ...patch[k] };
    this.value = sanitize(merged, DEFAULTS);
    this.store.save('settings.json', this.value);
    for (const fn of this.listeners) { try { fn(this.value); } catch {} }
    return this.value;
  }
}

module.exports = { Settings, DEFAULTS, sanitize };
