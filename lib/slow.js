'use strict';
// Slower, partly external data: systemd units, docker snapshot, websites (discovered from the
// nginx configuration, probed with real requests), TLS certificates, internet latency, sessions.

const fs = require('fs');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFile } = require('child_process');
const { performance } = require('perf_hooks');
const proc = require('./proc');

const sh = (cmd, args, timeout = 6000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 << 20 }, (err, stdout) => resolve(String(stdout || '')));
});

const unset = (v) => (v === undefined || v === '' || v === '[not set]' || v === '18446744073709551615' ? null : Number(v));

// ------------------------------------------------------------------ systemd services (all of them)

class Services {
  constructor() {
    this.list = [];
    this.prevCpu = new Map();
    this.at = 0;
    this.onChange = null; // (unit, prev, kind)
    this.onRestart = null; // (unit, delta)
    this.afterRefresh = null; // (list)
    this.prevState = new Map();
  }

  async refresh() {
    const listOut = await sh('systemctl', ['list-units', '--type=service', '--all', '--no-legend', '--plain', '--no-pager']);
    const units = [];
    for (const line of listOut.split('\n')) {
      const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(line.trim());
      if (m) units.push({ id: m[1], load: m[2], active: m[3], sub: m[4] });
    }
    const live = units.filter((u) => u.active !== 'inactive' || u.load !== 'loaded').map((u) => u.id);
    const props = {};
    if (live.length) {
      const out = await sh('systemctl', ['show', ...live, '--no-pager', '-p',
        'Id,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,TasksCurrent,NRestarts,ActiveEnterTimestampMonotonic,Result,ExecMainStatus,IOReadBytes,IOWriteBytes'], 9000);
      for (const block of out.split('\n\n')) {
        const kv = {};
        for (const l of block.split('\n')) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
        if (kv.Id) props[kv.Id] = kv;
      }
    }
    const upNow = proc.uptime().up;
    const nowMs = performance.now();
    const next = [];
    for (const u of units) {
      const kv = props[u.id] || {};
      const cpuNs = unset(kv.CPUUsageNSec);
      let cpu = null;
      const prev = this.prevCpu.get(u.id);
      if (cpuNs != null && prev && nowMs > prev.t) cpu = Math.max(0, ((cpuNs - prev.ns) / 1e9) / ((nowMs - prev.t) / 1000) * 100);
      if (cpuNs != null) this.prevCpu.set(u.id, { ns: cpuNs, t: nowMs });
      const mono = unset(kv.ActiveEnterTimestampMonotonic);
      next.push({
        id: u.id, load: u.load, active: u.active, sub: u.sub,
        enabled: kv.UnitFileState || null,
        pid: unset(kv.MainPID) || null,
        mem: unset(kv.MemoryCurrent), cpu, tasks: unset(kv.TasksCurrent),
        restarts: unset(kv.NRestarts) || 0,
        since: u.active === 'active' && mono ? Math.max(0, upNow - mono / 1e6) : null,
        result: kv.Result && kv.Result !== 'success' ? kv.Result : null,
        exit: unset(kv.ExecMainStatus),
        ioR: unset(kv.IOReadBytes), ioW: unset(kv.IOWriteBytes),
      });
    }
    // state changes and restart counters -> callbacks (the collector decides what is worth an event)
    if (this.prevState.size) {
      for (const u of next) {
        const p = this.prevState.get(u.id);
        if (!p) continue;
        if (u.restarts > p.restarts && this.onRestart) this.onRestart(u, u.restarts - p.restarts);
        if ((p.active !== u.active || p.sub !== u.sub) && this.onChange) this.onChange(u, p, 'change');
      }
    }
    this.prevState = new Map(next.map((u) => [u.id, { active: u.active, sub: u.sub, restarts: u.restarts }]));
    this.list = next;
    this.at = Date.now();
    if (this.afterRefresh) this.afterRefresh(next);
  }
}

// ------------------------------------------------------------------ docker snapshot (written by a root helper)

function dockerSnapshot(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...d, age: Math.max(0, Date.now() - d.t), stale: Date.now() - d.t > 60_000, ok: true };
  } catch { return { ok: false, containers: [], age: null, stale: true }; }
}

// ------------------------------------------------------------------ websites

const NGINX_DIRS = ['/etc/nginx/sites-enabled', '/etc/nginx/conf.d'];
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/** hostnames from every `server_name` in the nginx configuration, with the file they come from */
function discoverHosts() {
  const found = new Map();
  for (const dir of NGINX_DIRS) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (/\.(disabled|bak|dpkg-\w+)/.test(f) || f.endsWith('~')) continue;
      let txt;
      try { txt = fs.readFileSync(path.join(dir, f), 'utf8'); } catch { continue; }
      for (const m of txt.replace(/#.*$/gm, '').matchAll(/server_name\s+([^;]+);/g)) {
        for (const h of m[1].trim().split(/\s+/)) {
          const host = h.toLowerCase();
          if (!HOST_RE.test(host)) continue;
          if (!found.has(host)) found.set(host, f);
        }
      }
    }
  }
  return found;
}

function decodeTitle(html) {
  const m = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html);
  if (!m) return null;
  return m[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim().slice(0, 140) || null;
}

/** one request with timing breakdown; follows up to 4 redirects to find the final page + title */
function probe(urlStr, hop = 0) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let u;
    try { u = new URL(urlStr); } catch { return finish({ ok: false, code: 0, error: 'URL' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const t0 = performance.now();
    const tm = { dns: null, connect: null, tls: null, ttfb: null };
    const req = lib.request(u, {
      method: 'GET', timeout: 9000, agent: false,
      headers: { 'User-Agent': 'xeon1-console-probe/2.0', Accept: 'text/html,*/*;q=0.5', 'Accept-Encoding': 'identity' },
    }, (res) => {
      tm.ttfb = Math.round(performance.now() - t0);
      const code = res.statusCode;
      const loc = res.headers.location;
      const first = {
        code, ms: tm.ttfb, timing: tm,
        server: (res.headers.server || '').slice(0, 60) || null,
        type: (res.headers['content-type'] || '').split(';')[0] || null,
        location: loc ? String(loc).slice(0, 200) : null,
        error: null,
      };
      if (code >= 300 && code < 400 && loc && hop < 4) {
        res.destroy();
        let next;
        try { next = new URL(loc, u).href; } catch { return finish({ ...first, ok: true, final: null, title: null }); }
        return probe(next, hop + 1).then((r) => finish({ ...first, ok: first.code < 500 && r.ok !== false, final: r.final || next, finalCode: r.code, title: r.title }));
      }
      if (!/html/.test(first.type || '')) { res.destroy(); return finish({ ...first, ok: code < 500, final: u.href, finalCode: code, title: null }); }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 65536 || /<\/title>/i.test(body)) { res.destroy(); }
      });
      res.on('close', () => finish({ ...first, ok: code < 500, final: u.href, finalCode: code, title: decodeTitle(body) }));
      res.on('error', () => finish({ ...first, ok: code < 500, final: u.href, finalCode: code, title: decodeTitle(body) }));
    });
    req.on('socket', (s) => {
      s.on('lookup', () => { tm.dns = Math.round(performance.now() - t0); });
      s.on('connect', () => { tm.connect = Math.round(performance.now() - t0); });
      s.on('secureConnect', () => { tm.tls = Math.round(performance.now() - t0); });
    });
    req.on('timeout', () => { req.destroy(); finish({ ok: false, code: 0, ms: null, timing: tm, error: 'Zeitüberschreitung' }); });
    req.on('error', (e) => finish({ ok: false, code: 0, ms: null, timing: tm, error: (e.code || e.message || 'Fehler').toString().slice(0, 60) }));
    req.end();
  });
}

class Sites {
  constructor(store, settings, events) {
    this.store = store;
    this.settings = settings;
    this.events = events;
    this.state = new Map();   // key -> { hist[], checks, ok, since, last, fails }
    this.hosts = new Map();   // discovered host -> source file
    this.list = [];
    this.running = false;
    const saved = store.load('sites.json', {});
    for (const [k, v] of Object.entries(saved)) this.state.set(k, { ...v, last: v.last || null, fails: 0 });
  }

  targets() {
    const s = this.settings.get().sites;
    const out = [];
    if (s.auto) {
      for (const [host, file] of this.hosts) {
        if (s.disabled.includes(host)) continue;
        out.push({ key: host, host, url: `https://${host}/`, source: `nginx: ${file}`, custom: false });
      }
    }
    for (const c of s.custom) {
      const u = new URL(c.url);
      out.push({ key: c.url, host: u.hostname, url: c.url, source: 'manuell hinzugefügt', custom: true, customName: c.name });
    }
    return out;
  }

  /** all discovered hostnames, including disabled ones (for the settings page) */
  discovered() {
    const s = this.settings.get().sites;
    return [...this.hosts].map(([host, file]) => ({ host, file, enabled: !s.disabled.includes(host) }));
  }

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      this.hosts = discoverHosts();
      const targets = this.targets();
      const queue = [...targets];
      const results = new Map();
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          results.set(t.key, await probe(t.url));
        }
      };
      await Promise.all(Array.from({ length: 6 }, worker));
      const now = Date.now();
      const names = this.settings.get().sites.names;
      for (const t of targets) {
        const r = results.get(t.key);
        let st = this.state.get(t.key);
        if (!st) { st = { hist: [], checks: 0, ok: 0, since: now, last: null, fails: 0 }; this.state.set(t.key, st); }
        // A name that has no DNS record is a configuration fact, not an outage: neutral, no counters, no alerts.
        if (!r.ok && /^(ENOTFOUND|ENODATA)$/.test(r.error || '')) { st.last = { ...r, nodns: true, t: now }; st.fails = 0; continue; }
        const prevOk = st.last ? st.last.ok : null;
        st.checks++;
        if (r.ok) { st.ok++; st.fails = 0; } else st.fails++;
        st.last = { ...r, t: now };
        st.hist.push({ t: now, ms: r.ok ? r.ms : null, code: r.code, ok: r.ok });
        if (st.hist.length > 360) st.hist.shift();
        const label = names[t.host] || t.customName || t.host;
        const al = this.settings.get().alerts;
        if (al.sites.on && prevOk === true && st.fails === 2) {
          this.events.add({ level: 'crit', kind: 'site', title: `${label} nicht erreichbar`, detail: r.error || `HTTP ${r.code}`, key: `site-down-${t.key}`, cooldown: 600_000 });
        } else if (al.sites.on && prevOk === false && r.ok && st.fails === 0 && st.wasDown) {
          this.events.add({ level: 'ok', kind: 'site', title: `${label} wieder erreichbar`, detail: `${r.ms} ms`, key: `site-up-${t.key}`, cooldown: 60_000 });
        }
        st.wasDown = st.fails >= 2 ? true : (r.ok ? false : st.wasDown);
        if (al.siteSlow.on && r.ok && r.ms > al.siteSlow.ms) {
          this.events.add({ level: 'warn', kind: 'site', title: `${label} antwortet langsam`, detail: `${r.ms} ms (Grenze ${al.siteSlow.ms} ms)`, key: `site-slow-${t.key}`, cooldown: 900_000 });
        }
      }
      // forget state of targets that no longer exist
      const keys = new Set(targets.map((t) => t.key));
      for (const k of [...this.state.keys()]) if (!keys.has(k)) this.state.delete(k);
      this.build(targets);
      this.persist();
    } finally {
      this.running = false;
    }
  }

  build(targets = this.targets()) {
    const names = this.settings.get().sites.names;
    this.list = targets.map((t) => {
      const st = this.state.get(t.key);
      const last = st && st.last;
      const ms = (st ? st.hist.filter((h) => h.ms != null).map((h) => h.ms) : []);
      return {
        key: t.key, host: t.host, url: t.url, source: t.source, custom: t.custom,
        name: names[t.host] || t.customName || null,
        nodns: !!(last && last.nodns),
        ok: last && !last.nodns ? last.ok : null,
        code: last ? last.code : null,
        ms: last ? last.ms : null,
        timing: last ? last.timing : null,
        title: last ? last.title : null,
        final: last ? last.final : null,
        location: last ? last.location : null,
        server: last ? last.server : null,
        type: last ? last.type : null,
        error: last ? last.error : null,
        checkedAt: last ? last.t : null,
        checks: st ? st.checks : 0,
        up: st && st.checks ? Math.round((st.ok / st.checks) * 10000) / 100 : null,
        since: st ? st.since : null,
        avg: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null,
        min: ms.length ? Math.min(...ms) : null,
        max: ms.length ? Math.max(...ms) : null,
        hist: st ? st.hist : [],
      };
    });
  }

  persist() {
    const o = {};
    for (const [k, v] of this.state) o[k] = { hist: v.hist, checks: v.checks, ok: v.ok, since: v.since, last: v.last };
    this.store.save('sites.json', o);
  }
}

// ------------------------------------------------------------------ certificates (as served by the local nginx)

function certOf(host) {
  return new Promise((resolve) => {
    const sock = tls.connect({ host: '127.0.0.1', port: 443, servername: host, rejectUnauthorized: false, timeout: 4000 }, () => {
      const c = sock.getPeerCertificate();
      sock.end();
      if (!c || !c.valid_to) return resolve(null);
      const to = new Date(c.valid_to).getTime();
      resolve({
        subject: (c.subject && (c.subject.CN || c.subject.O)) || null,
        issuer: (c.issuer && (c.issuer.O || c.issuer.CN)) || null,
        from: new Date(c.valid_from).getTime(), to,
        days: Math.floor((to - Date.now()) / 86400000),
        san: (c.subjectaltname || '').split(', ').map((s) => s.replace(/^DNS:/, '')).filter(Boolean).slice(0, 12),
        fp: c.fingerprint256 || c.fingerprint,
      });
    });
    sock.on('error', () => resolve(null));
    sock.on('timeout', () => { sock.destroy(); resolve(null); });
  });
}

async function certs(hosts) {
  const byFp = new Map();
  for (const host of hosts) {
    const c = await certOf(host);
    if (!c) continue;
    const e = byFp.get(c.fp) || { ...c, hosts: [] };
    e.hosts.push(host);
    byFp.set(c.fp, e);
  }
  return [...byFp.values()].map(({ fp, ...rest }) => rest).sort((a, b) => a.to - b.to);
}

// ------------------------------------------------------------------ internet latency

function tcpPing(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const s = net.connect({ host, port, timeout }, () => {
      const ms = performance.now() - t0;
      s.destroy();
      resolve(Math.round(ms * 10) / 10);
    });
    s.on('error', () => resolve(null));
    s.on('timeout', () => { s.destroy(); resolve(null); });
  });
}

async function dnsTime(name) {
  const t0 = performance.now();
  try {
    await new dns.promises.Resolver({ timeout: 2000, tries: 1 }).resolve4(name);
    return Math.round((performance.now() - t0) * 10) / 10;
  } catch { return null; }
}

// ------------------------------------------------------------------ small system facts

async function loggedIn() {
  const out = await sh('who', []);
  return out.split('\n').filter(Boolean).map((l) => {
    const p = l.trim().split(/\s+/);
    return { user: p[0], tty: p[1], since: `${p[2]} ${p[3]}` };
  });
}

async function timeInfo() {
  const [td, ch] = await Promise.all([sh('timedatectl', ['show']), sh('chronyc', ['tracking'])]);
  const kv = {};
  for (const l of td.split('\n')) { const i = l.indexOf('='); if (i > 0) kv[l.slice(0, i)] = l.slice(i + 1); }
  const chrony = {};
  for (const l of ch.split('\n')) {
    const i = l.indexOf(':');
    if (i > 0) chrony[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
  return {
    timezone: kv.Timezone || null, ntpSynced: kv.NTPSynchronized === 'yes', ntp: kv.NTP === 'yes', rtcLocal: kv.LocalRTC === 'yes',
    chrony: Object.keys(chrony).length ? chrony : null,
  };
}

module.exports = { Services, dockerSnapshot, Sites, certs, discoverHosts, tcpPing, dnsTime, loggedIn, timeInfo, sh, probe };
