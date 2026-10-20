'use strict';
// Samples the machine once per second, keeps three history tiers, assembles the detail
// snapshot, and turns threshold crossings / changes into events and active alerts.

const os = require('os');
const fs = require('fs');
const http = require('http');
const { performance } = require('perf_hooks');
const proc = require('./proc');
const slow = require('./slow');
const { FIELDS, CORES } = require('./fields');
const { Rollup } = require('./history');

const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const rate = (cur, prev, dt) => (cur == null || prev == null || dt <= 0 ? 0 : Math.max(0, (cur - prev) / dt));

function defaultIface() {
  try {
    for (const line of proc.read('/proc/net/route').split('\n').slice(1)) {
      const p = line.split('\t');
      if (p[1] === '00000000') return p[0];
    }
  } catch {}
  return 'eth0';
}

function osPretty() {
  try { return /PRETTY_NAME="([^"]+)"/.exec(proc.read('/etc/os-release'))[1]; } catch { return os.type(); }
}

function create({ store, settings, events, dockerFile, statusUrl }) {
  const IFACE = process.env.NET_IFACE || defaultIface();
  const RAW_SIZE = 600;
  const raw = [];
  const t10 = new Rollup(10_000, 720);
  const t60 = new Rollup(60_000, 1440);
  const listeners = { sample: [], detail: [], slow: [] };
  const emit = (k, v) => { for (const fn of listeners[k]) { try { fn(v); } catch {} } };

  const services = new slow.Services();
  const sites = new slow.Sites(store, settings, events);

  const saved = store.load('history.json', {});
  const now0 = Date.now();
  t10.pts = (saved.t10 || []).filter((p) => p.t > now0 - t10.size * t10.step);
  t60.pts = (saved.t60 || []).filter((p) => p.t > now0 - t60.size * t60.step);

  // ---------------------------------------------------------------- state
  const S = {
    prev: null,
    nginx: { ok: false, requests: 0, accepts: 0, handled: 0, active: 0, reading: 0, writing: 0, waiting: 0, ts: 0, rate: 0, connRate: 0 },
    rates: { ifaces: {}, disks: {} },
    procs: { at: 0, prev: new Map(), data: null, list: [] },
    tcp: { states: {}, listen: [] },
    udp: 0,
    lastFsAt: 0, fs: [],
    docker: { ok: false, containers: [] },
    certs: [], certsAt: 0,
    internet: { targets: [], lat: [], dns: null, hist: [] },
    users: [], time: null, reboot: { required: false, pkgs: [] },
    cpuinfo: proc.cpuInfo(), cpuinfoAt: Date.now(),
    swaps: [], limits: proc.sysLimits(),
    sample: null,
    clients: 0,
    active: new Map(),     // alert key -> { level, title, detail, since }
    cond: new Map(),       // key -> { on, off, activeCount }
    ports: null,
    lastBtime: saved.btime || null,
  };

  const info = {
    host: os.hostname(), os: osPretty(), kernel: os.release(), arch: os.arch(),
    cpu: S.cpuinfo.model || (os.cpus()[0] || {}).model, cores: CORES, ram: os.totalmem(), iface: IFACE, node: process.version,
  };

  // ---------------------------------------------------------------- alerts (threshold conditions with hysteresis)
  function watch(key, isOn, spec, minSecs = 0, clearSecs = 10) {
    let c = S.cond.get(key);
    if (!c) { c = { on: 0, off: 0 }; S.cond.set(key, c); }
    const act = S.active.get(key);
    if (isOn) {
      c.on++; c.off = 0;
      if (!act && c.on >= minSecs) {
        S.active.set(key, { level: spec.level, title: spec.title, detail: spec.detail || '', since: Date.now() });
        events.add({ level: spec.level, kind: spec.kind || 'alert', title: spec.title, detail: spec.detail || '' });
      } else if (act && (act.detail !== spec.detail || act.title !== spec.title)) {
        act.detail = spec.detail || ''; act.title = spec.title;
        if (spec.level !== act.level) act.level = spec.level;
      }
    } else {
      c.off++; c.on = 0;
      if (act && c.off >= clearSecs) {
        S.active.delete(key);
        events.add({ level: 'ok', kind: spec.kind || 'alert', title: `${spec.clear || spec.title} – wieder normal`, detail: `Dauer: ${Math.round((Date.now() - act.since) / 1000)} s` });
      }
    }
  }
  const clearAlertsOf = (prefix) => { for (const k of [...S.active.keys()]) if (k.startsWith(prefix)) S.active.delete(k); };

  // ---------------------------------------------------------------- nginx stub_status
  function pollNginx() {
    const req = http.get(statusUrl, { timeout: 800 }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { b += c; });
      res.on('end', () => {
        const a = /Active connections:\s+(\d+)/.exec(b);
        const t = /\n\s*(\d+)\s+(\d+)\s+(\d+)/.exec(b);
        const w = /Reading:\s+(\d+)\s+Writing:\s+(\d+)\s+Waiting:\s+(\d+)/.exec(b);
        if (!a || !t || !w) { S.nginx.ok = false; return; }
        const n = performance.now();
        const o = S.nginx;
        const next = { ok: true, accepts: +t[1], handled: +t[2], requests: +t[3], active: Math.max(0, +a[1] - 1), reading: +w[1], writing: Math.max(0, +w[2] - 1), waiting: +w[3], ts: n, rate: o.rate, connRate: o.connRate };
        if (o.ok && next.requests >= o.requests && n > o.ts) {
          const dt = (n - o.ts) / 1000;
          next.rate = Math.max(0, next.requests - o.requests - 1) / dt; // our own poll is one request
          next.connRate = Math.max(0, next.accepts - o.accepts) / dt;
        }
        S.nginx = next;
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => { S.nginx.ok = false; });
  }

  // ---------------------------------------------------------------- the 1 Hz tick
  function tick() {
    const mono = performance.now();
    const cur = {
      mono, cpu: proc.cpuStat(), mem: proc.memInfo(), vm: proc.vmStat(), net: proc.netDev(), snmp: proc.snmp(),
      netstat: proc.netstat(), disk: proc.diskStats(), load: proc.loadAvg(), psi: proc.psi(), up: proc.uptime(),
    };
    if (mono - S.lastFsAt > 15_000) { S.fs = proc.filesystems(); S.lastFsAt = mono; S.limits = proc.sysLimits(); S.swaps = proc.swaps(); S.reboot = proc.rebootRequired(); }
    if (Date.now() - S.cpuinfoAt > 5000) { S.cpuinfo = proc.cpuInfo(); S.cpuinfoAt = Date.now(); }
    const tcp = proc.tcpTable();
    S.tcp = tcp;
    if (Math.floor(mono / 5000) !== Math.floor((S.prev ? S.prev.mono : 0) / 5000)) S.udp = proc.udpSockets();

    const p = S.prev;
    S.prev = cur;
    if (!p) return;
    const dt = (mono - p.mono) / 1000;

    // ---- cpu time breakdown
    const a = cur.cpu.all;
    const b = p.cpu.all;
    const dTot = Math.max(1, a.total - b.total);
    const pc = (k) => clamp((100 * (a[k] - b[k])) / dTot, 0, 100);
    const cu = pc('user') + pc('nice');
    const cs = pc('system');
    const ci = pc('irq') + pc('softirq');
    const cw = pc('iowait');
    const ct = pc('steal');
    const sample = {
      t: Date.now(),
      cpu: r1(clamp(cu + cs + ci + ct, 0, 100)), cu: r1(cu), cs: r1(cs), ci: r1(ci), cw: r1(cw), ct: r1(ct),
      l1: cur.load.l1, l5: cur.load.l5, l15: cur.load.l15, run: cur.cpu.running, blk: cur.cpu.blocked, proc: cur.load.total,
      thr: S.procs.data ? S.procs.data.threads : 0,
      ctx: Math.round(rate(cur.cpu.ctxt, p.cpu.ctxt, dt)), intr: Math.round(rate(cur.cpu.intr, p.cpu.intr, dt)), fork: r1(rate(cur.cpu.forks, p.cpu.forks, dt)),
    };
    cur.cpu.cores.forEach((c, i) => {
      const pcore = p.cpu.cores[i] || c;
      const d = Math.max(1, c.total - pcore.total);
      sample[`c${i}`] = r1(clamp(100 * (1 - (c.idle + c.iowait - pcore.idle - pcore.iowait) / d), 0, 100));
    });

    // ---- pressure
    const ps = cur.psi;
    const g = (k, t, w) => (ps[k] && ps[k][t] ? ps[k][t][w] : 0);
    Object.assign(sample, {
      pc10: g('cpu', 'some', 'a10'), pc60: g('cpu', 'some', 'a60'), pc300: g('cpu', 'some', 'a300'),
      pm10: g('memory', 'some', 'a10'), pm60: g('memory', 'some', 'a60'), pm300: g('memory', 'some', 'a300'), pmf10: g('memory', 'full', 'a10'),
      pi10: g('io', 'some', 'a10'), pi60: g('io', 'some', 'a60'), pi300: g('io', 'some', 'a300'), pif10: g('io', 'full', 'a10'),
    });

    // ---- memory
    const m = cur.mem;
    Object.assign(sample, {
      mu: m.used, mc: m.cache, mb: m.buffers, mf: m.free, ma: m.avail, msh: m.shmem, msl: m.slab, mdirty: m.dirty,
      manon: m.anon, mmap: m.mapped, mact: m.active, minact: m.inactive, mpt: m.pageTables, mcommit: m.commit,
      su: m.swapUsed, sc: m.swapCached,
      pgf: Math.round(rate(cur.vm.pgfault, p.vm.pgfault, dt)), pgmaj: r2(rate(cur.vm.pgmajfault, p.vm.pgmajfault, dt)),
      swin: r2(rate(cur.vm.pswpin, p.vm.pswpin, dt)), swout: r2(rate(cur.vm.pswpout, p.vm.pswpout, dt)),
      pgin: Math.round(rate(cur.vm.pgpgin, p.vm.pgpgin, dt) * 1024), pgout: Math.round(rate(cur.vm.pgpgout, p.vm.pgpgout, dt) * 1024),
      scan: Math.round(rate((cur.vm.pgscan_kswapd || 0) + (cur.vm.pgscan_direct || 0), (p.vm.pgscan_kswapd || 0) + (p.vm.pgscan_direct || 0), dt)),
    });

    // ---- network: per interface, primary + container aggregate in the sample
    const ifRates = {};
    let vrx = 0; let vtx = 0;
    for (const [name, c] of Object.entries(cur.net)) {
      const o = p.net[name] || c;
      const r = {
        rx: rate(c.rxB, o.rxB, dt), tx: rate(c.txB, o.txB, dt), rxp: rate(c.rxP, o.rxP, dt), txp: rate(c.txP, o.txP, dt),
        rxe: rate(c.rxE, o.rxE, dt), txe: rate(c.txE, o.txE, dt), rxd: rate(c.rxD, o.rxD, dt), txd: rate(c.txD, o.txD, dt),
      };
      ifRates[name] = r;
      if (name.startsWith('veth')) { vrx += r.rx; vtx += r.tx; }
    }
    S.rates.ifaces = ifRates;
    const pr = ifRates[IFACE] || { rx: 0, tx: 0, rxp: 0, txp: 0, rxe: 0, txe: 0, rxd: 0, txd: 0 };
    Object.assign(sample, {
      rx: Math.round(pr.rx), tx: Math.round(pr.tx), rxp: Math.round(pr.rxp), txp: Math.round(pr.txp),
      rxe: r2(pr.rxe), txe: r2(pr.txe), rxd: r2(pr.rxd), txd: r2(pr.txd), vrx: Math.round(vrx), vtx: Math.round(vtx),
    });

    // ---- tcp / udp
    const T = cur.snmp.Tcp || {};
    const T0 = p.snmp.Tcp || {};
    const U = cur.snmp.Udp || {};
    const U0 = p.snmp.Udp || {};
    const st = tcp.states;
    Object.assign(sample, {
      tIn: Math.round(rate(T.InSegs, T0.InSegs, dt)), tOut: Math.round(rate(T.OutSegs, T0.OutSegs, dt)), tRet: r2(rate(T.RetransSegs, T0.RetransSegs, dt)),
      tAO: r2(rate(T.ActiveOpens, T0.ActiveOpens, dt)), tPO: r2(rate(T.PassiveOpens, T0.PassiveOpens, dt)),
      tRst: r2(rate(T.OutRsts, T0.OutRsts, dt)), tFail: r2(rate(T.AttemptFails, T0.AttemptFails, dt)),
      uIn: Math.round(rate(U.InDatagrams, U0.InDatagrams, dt)), uOut: Math.round(rate(U.OutDatagrams, U0.OutDatagrams, dt)),
      est: st.established || 0, tw: st.time_wait || 0, cwt: st.close_wait || 0, lst: st.listen || 0,
      fw: (st.fin_wait1 || 0) + (st.fin_wait2 || 0), syn: (st.syn_recv || 0) + (st.syn_sent || 0),
    });

    // ---- web server
    const ng = S.nginx;
    Object.assign(sample, ng.ok
      ? { req: r1(ng.rate), act: ng.active, rdg: ng.reading, wrg: ng.writing, wtg: ng.waiting }
      : { req: null, act: null, rdg: null, wrg: null, wtg: null });

    // ---- disks
    const diskRates = {};
    for (const [name, c] of Object.entries(cur.disk)) {
      const o = p.disk[name] || c;
      const dR = c.rIO - o.rIO;
      const dW = c.wIO - o.wIO;
      diskRates[name] = {
        rBps: rate(c.rSec * 512, o.rSec * 512, dt), wBps: rate(c.wSec * 512, o.wSec * 512, dt),
        rIops: rate(c.rIO, o.rIO, dt), wIops: rate(c.wIO, o.wIO, dt),
        rLat: dR > 0 ? (c.rMs - o.rMs) / dR : 0, wLat: dW > 0 ? (c.wMs - o.wMs) / dW : 0,
        util: clamp((c.busyMs - o.busyMs) / (dt * 10), 0, 100), queue: Math.max(0, (c.weightedMs - o.weightedMs) / (dt * 1000)),
        rTotal: c.rSec * 512, wTotal: c.wSec * 512, rIO: c.rIO, wIO: c.wIO, inflight: c.inflight,
      };
    }
    S.rates.disks = diskRates;
    const primary = Object.keys(cur.disk).sort((x, y) => (cur.disk[y].rSec + cur.disk[y].wSec) - (cur.disk[x].rSec + cur.disk[x].wSec))[0];
    S.primaryDisk = primary;
    const dr = diskRates[primary] || { rBps: 0, wBps: 0, rIops: 0, wIops: 0, rLat: 0, wLat: 0, util: 0, queue: 0 };
    const root = S.fs.find((f) => f.mount === '/') || S.fs[0];
    Object.assign(sample, {
      dr: Math.round(dr.rBps), dw: Math.round(dr.wBps), dri: r1(dr.rIops), dwi: r1(dr.wIops), drl: r2(dr.rLat), dwl: r2(dr.wLat),
      dq: r2(dr.queue), du: r1(dr.util),
      dsu: root ? root.used : 0, dsi: root && root.inodes ? r2((root.inodesUsed / root.inodes) * 100) : 0,
    });

    // ---- system + latency + docker
    Object.assign(sample, {
      fd: S.limits.fdAlloc, ent: S.limits.entropy, usr: S.users.length,
      lat1: S.internet.lat[0] ?? null, lat2: S.internet.lat[1] ?? null, lat3: S.internet.lat[2] ?? null, dns: S.internet.dns,
    });
    const dk = S.docker.containers || [];
    Object.assign(sample, {
      dcpu: r1(dk.reduce((s, c) => s + (c.cpu || 0), 0)), dmem: dk.reduce((s, c) => s + (c.memUsage || 0), 0),
      dcnt: dk.filter((c) => c.state === 'running').length,
    });

    // totals kept for the detail view
    S.totals = { cpu: cur.cpu, vm: cur.vm, net: cur.net, snmp: cur.snmp, netstat: cur.netstat, mem: cur.mem, load: cur.load, psi: cur.psi, up: cur.up, disk: cur.disk };

    raw.push(sample);
    if (raw.length > RAW_SIZE) raw.splice(0, raw.length - RAW_SIZE);
    t10.add(sample);
    t60.add(sample);
    S.sample = sample;
    detect(sample, cur, p, dt);
    emit('sample', sample);
  }

  // ---------------------------------------------------------------- detectors
  function detect(s, cur, p, dt) {
    const al = settings.get().alerts;
    const cores = CORES;

    watch('cpu', al.cpu.on && s.cpu >= al.cpu.pct, { level: 'warn', kind: 'cpu', title: `CPU-Last über ${al.cpu.pct} %`, detail: `${s.cpu} % aktuell`, clear: 'CPU-Last' }, al.cpu.seconds);
    watch('load', al.load.on && s.l1 > cores * al.load.factor, { level: 'warn', kind: 'cpu', title: `Load Average hoch (${s.l1})`, detail: `Grenze: ${r1(cores * al.load.factor)} bei ${cores} Kernen`, clear: 'Load Average' }, 30);
    const availPct = (cur.mem.avail / cur.mem.total) * 100;
    watch('mem', al.memAvail.on && availPct < al.memAvail.pct, { level: availPct < al.memAvail.pct / 2 ? 'crit' : 'warn', kind: 'memory', title: `Wenig Arbeitsspeicher verfügbar (${r1(availPct)} %)`, detail: `Grenze: ${al.memAvail.pct} %`, clear: 'Arbeitsspeicher' }, 20);
    const swapPct = cur.mem.swapTotal ? (cur.mem.swapUsed / cur.mem.swapTotal) * 100 : 0;
    watch('swap', al.swapUse.on && swapPct > al.swapUse.pct, { level: 'warn', kind: 'memory', title: `Swap stark belegt (${r1(swapPct)} %)`, detail: '', clear: 'Swap' }, 30);
    watch('psi-mem', al.psiMem.on && (s.pmf10 > al.psiMem.pct || s.pm10 > al.psiMem.pct * 4), { level: 'warn', kind: 'memory', title: 'Speicherdruck (Prozesse warten auf RAM)', detail: `PSI some ${s.pm10} %, full ${s.pmf10} % (10 s)`, clear: 'Speicherdruck' }, 10);
    const errs = s.rxe + s.txe + s.rxd + s.txd;
    watch('net-err', al.netErrors.on && errs > al.netErrors.perSec, { level: 'warn', kind: 'network', title: 'Netzwerkfehler oder verworfene Pakete', detail: `${r1(errs)}/s auf ${IFACE}`, clear: 'Netzwerkfehler' }, 15);
    const retr = s.tOut > 100 ? (s.tRet / s.tOut) * 100 : 0;
    watch('retrans', al.retrans.on && retr > al.retrans.pct, { level: 'warn', kind: 'network', title: `Viele TCP-Neuübertragungen (${r1(retr)} %)`, detail: '', clear: 'TCP-Neuübertragungen' }, 30);

    const oomNow = cur.vm.oom_kill;
    if (p.vm.oom_kill != null && oomNow > p.vm.oom_kill) {
      events.add({ level: 'crit', kind: 'memory', title: 'Prozess vom OOM-Killer beendet', detail: `${oomNow - p.vm.oom_kill} Prozess(e), insgesamt ${oomNow} seit Start`, key: 'oom', cooldown: 30_000 });
    }

    // filesystems (refreshed every 15 s)
    for (const f of S.fs) {
      if (!f.persistent) continue;
      const pct = (f.used / (f.used + f.avail)) * 100;
      watch(`fs:${f.mount}`, al.disk.on && pct > al.disk.pct, { level: pct > 97 ? 'crit' : 'warn', kind: 'disk', title: `${f.mount} zu ${r1(pct)} % belegt`, detail: `${f.dev}, Grenze ${al.disk.pct} %`, clear: `Festplatte ${f.mount}` }, 1, 30);
      const ip = f.inodes ? (f.inodesUsed / f.inodes) * 100 : 0;
      watch(`inode:${f.mount}`, al.inode.on && ip > al.inode.pct, { level: 'warn', kind: 'disk', title: `Inodes auf ${f.mount} zu ${r1(ip)} % belegt`, detail: '', clear: `Inodes ${f.mount}` }, 1, 30);
    }

    watch('reboot', al.reboot.on && S.reboot.required, { level: 'warn', kind: 'system', title: 'Neustart erforderlich', detail: S.reboot.pkgs.length ? `Pakete: ${S.reboot.pkgs.join(', ')}` : '', clear: 'Neustart-Hinweis' }, 1, 30);

    // listening ports appearing / disappearing
    const set = new Map(S.tcp.listen.map((l) => [l.port, l]));
    if (S.ports === null) S.ports = { ports: set, pending: null };
    else {
      const known = S.ports.ports;
      const sig = [...set.keys()].sort().join(',');
      const knownSig = [...known.keys()].sort().join(',');
      if (sig !== knownSig) {
        if (S.ports.pending === sig) {
          if (al.ports.on) {
            for (const [port, l] of set) if (!known.has(port)) events.add({ level: l.scope === 'lokal' ? 'info' : 'warn', kind: 'network', title: `Neuer Port ${port} (TCP) offen`, detail: l.scope, key: `port-open-${port}`, cooldown: 60_000 });
            for (const [port] of known) if (!set.has(port)) events.add({ level: 'info', kind: 'network', title: `Port ${port} (TCP) geschlossen`, detail: '', key: `port-close-${port}`, cooldown: 60_000 });
          }
          S.ports = { ports: set, pending: null };
        } else S.ports.pending = sig;
      } else S.ports.pending = null;
    }
  }

  // ---------------------------------------------------------------- processes
  function scanProcs() {
    const mono = performance.now();
    const dt = S.procs.at ? (mono - S.procs.at) / 1000 : 0;
    const up = proc.uptime().up;
    const res = proc.scanProcesses(S.procs.prev, dt, 0, up);
    S.procs.prev = res.prev;
    S.procs.at = mono;
    const dockerNames = new Map((S.docker.containers || []).map((c) => [c.id, c.name]));
    const top = settings.get().processes.top;
    for (const pr of res.list) {
      const cg = proc.cgroupOf(pr.pid);
      pr.group = cg ? (cg.kind === 'docker' ? (dockerNames.get(cg.name) || cg.name) : cg.name) : null;
      pr.groupKind = cg ? cg.kind : null;
    }
    const list = res.list;
    const byUser = new Map();
    const byName = new Map();
    const byGroup = new Map();
    for (const pr of list) {
      const u = byUser.get(pr.user) || { user: pr.user, count: 0, rss: 0, cpu: 0 };
      u.count++; u.rss += pr.rss; u.cpu += pr.cpu; byUser.set(pr.user, u);
      const n = byName.get(pr.name) || { name: pr.name, count: 0, rss: 0, cpu: 0 };
      n.count++; n.rss += pr.rss; n.cpu += pr.cpu; byName.set(pr.name, n);
      const gname = pr.group || '-';
      const gr = byGroup.get(gname) || { name: gname, kind: pr.groupKind, count: 0, rss: 0, cpu: 0 };
      gr.count++; gr.rss += pr.rss; gr.cpu += pr.cpu; byGroup.set(gname, gr);
    }
    const sorted = (arr, k) => arr.slice().sort((a, b) => b[k] - a[k]);
    S.procs.list = list;
    S.procs.data = {
      at: Date.now(), total: res.total, threads: res.threads, kernel: res.kernel, states: res.states, userProcs: list.length,
      topCpu: sorted(list, 'cpu').slice(0, top), topMem: sorted(list, 'rss').slice(0, top),
      byUser: sorted([...byUser.values()], 'rss'), byName: sorted([...byName.values()], 'rss').slice(0, 30),
      byGroup: sorted([...byGroup.values()], 'rss').slice(0, 30),
    };
  }

  // ---------------------------------------------------------------- slower refreshers
  // Services: only changes that matter. Oneshot/timer units flip states constantly and stay silent.
  const loops = new Map(); // unit -> { times[], total }
  const svcHidden = (id) => settings.get().services.hidden.includes(id);
  services.onChange = (u, prev) => {
    if (!settings.get().alerts.services.on || svcHidden(u.id)) return;
    if (u.sub === 'auto-restart' || prev.sub === 'auto-restart') return; // handled by the crash-loop alert
    if (u.active === 'failed' && prev.active !== 'failed') {
      events.add({ level: 'crit', kind: 'service', title: `${u.id} fehlgeschlagen`, detail: u.result ? `Ergebnis: ${u.result}` : '', key: `svc-fail-${u.id}`, cooldown: 300_000 });
    } else if (prev.sub === 'running' && u.sub !== 'running' && u.active !== 'failed') {
      events.add({ level: 'warn', kind: 'service', title: `${u.id} wurde beendet`, detail: `${prev.active}/${prev.sub} → ${u.active}/${u.sub}`, key: `svc-stop-${u.id}`, cooldown: 120_000 });
    } else if (u.sub === 'running' && prev.sub !== 'running') {
      events.add({ level: 'ok', kind: 'service', title: `${u.id} läuft`, detail: `${prev.active}/${prev.sub} → ${u.active}/${u.sub}`, key: `svc-run-${u.id}`, cooldown: 120_000 });
    }
  };
  services.onRestart = (u, delta) => {
    const l = loops.get(u.id) || { times: [], total: 0 };
    const now = Date.now();
    l.times.push(...Array(Math.min(delta, 50)).fill(now));
    l.total = u.restarts;
    loops.set(u.id, l);
  };
  services.afterRefresh = (list) => {
    const al = settings.get().alerts.services;
    const now = Date.now();
    const hidden = new Set(settings.get().services.hidden);
    // crash loops: 3 or more automatic restarts within a minute; clears after two quiet minutes
    for (const [id, l] of loops) {
      l.times = l.times.filter((t) => now - t < 120_000);
      const lastMin = l.times.filter((t) => now - t < 60_000).length;
      const key = `svcloop:${id}`;
      const act = S.active.get(key);
      if (al.on && !hidden.has(id) && lastMin >= 3) {
        const detail = `${lastMin} automatische Neustarts in der letzten Minute, insgesamt ${l.total}`;
        if (!act) { S.active.set(key, { level: 'crit', title: `${id} startet dauernd neu`, detail, since: now }); events.add({ level: 'crit', kind: 'service', title: `${id} startet dauernd neu (Crash-Loop)`, detail }); } else act.detail = detail;
      } else if (act && (!l.times.length || hidden.has(id) || !al.on)) {
        S.active.delete(key);
        events.add({ level: 'ok', kind: 'service', title: `${id} startet nicht mehr dauernd neu`, detail: '' });
        loops.delete(id);
      }
    }
    // services that are currently failed stay visible as an active alert
    for (const u of list) {
      const key = `svcfail:${u.id}`;
      const act = S.active.get(key);
      const bad = al.on && u.active === 'failed' && !hidden.has(u.id);
      if (bad && !act) S.active.set(key, { level: 'warn', title: `${u.id} ist fehlgeschlagen`, detail: u.result ? `Ergebnis: ${u.result}` : 'Zustand: failed', since: now });
      else if (!bad && act) S.active.delete(key);
    }
  };

  let dockerPrev = null;
  function refreshDocker() {
    const d = slow.dockerSnapshot(dockerFile);
    S.docker = d;
    const al = settings.get().alerts;
    if (!d.ok || d.stale) { return; }
    const cur = new Map(d.containers.map((c) => [c.name, c]));
    if (dockerPrev && al.docker.on) {
      for (const [n, c] of cur) {
        const o = dockerPrev.get(n);
        if (!o) events.add({ level: 'info', kind: 'docker', title: `Container ${n} erscheint`, detail: c.status || '', key: `dk-new-${n}`, cooldown: 30_000 });
        else {
          if (o.state !== c.state) events.add({ level: c.state === 'running' ? 'ok' : 'warn', kind: 'docker', title: `Container ${n}: ${o.state} → ${c.state}`, detail: c.status || '', key: `dk-st-${n}-${c.state}`, cooldown: 20_000 });
          if (o.health !== c.health && c.health) events.add({ level: c.health === 'unhealthy' ? 'crit' : 'ok', kind: 'docker', title: `Container ${n}: Health ${o.health || '–'} → ${c.health}`, detail: '', key: `dk-h-${n}-${c.health}`, cooldown: 20_000 });
          if (o.startedAt && c.startedAt && o.startedAt !== c.startedAt) events.add({ level: 'warn', kind: 'docker', title: `Container ${n} neu gestartet`, detail: '', key: `dk-rs-${n}`, cooldown: 20_000 });
        }
      }
      for (const n of dockerPrev.keys()) if (!cur.has(n)) events.add({ level: 'warn', kind: 'docker', title: `Container ${n} verschwunden`, detail: '', key: `dk-gone-${n}`, cooldown: 30_000 });
    }
    dockerPrev = cur;
  }

  async function refreshInternet() {
    const targets = settings.get().internet.targets;
    const [lat, dnsMs] = await Promise.all([
      Promise.all(targets.map((t) => slow.tcpPing(t.host, t.port))),
      slow.dnsTime(settings.get().internet.dnsName),
    ]);
    S.internet = { targets, lat, dns: dnsMs };
  }

  async function refreshCerts() {
    const hosts = [...new Set([...sites.hosts.keys(), ...sites.targets().map((t) => t.host)])];
    S.certs = await slow.certs(hosts);
    S.certsAt = Date.now();
    const al = settings.get().alerts;
    if (al.certDays.on) {
      for (const c of S.certs) {
        if (c.days <= al.certDays.days) events.add({ level: c.days <= 5 ? 'crit' : 'warn', kind: 'cert', title: `Zertifikat läuft in ${c.days} Tagen ab`, detail: c.hosts.join(', '), key: `cert-${c.hosts[0]}`, cooldown: 86_400_000 });
      }
    }
  }

  async function refreshMisc() {
    [S.users, S.time] = await Promise.all([slow.loggedIn(), slow.timeInfo()]);
  }

  // ---------------------------------------------------------------- payloads
  const rnd = (o) => { const r = {}; for (const [k, v] of Object.entries(o)) r[k] = typeof v === 'number' ? Math.round(v * 100) / 100 : v; return r; };

  function detail() {
    const T = S.totals;
    if (!T) return null;
    const cpu = T.cpu;
    const CT = proc.CLK_TCK;
    const toSec = (c) => ({ user: c.user / CT, nice: c.nice / CT, system: c.system / CT, idle: c.idle / CT, iowait: c.iowait / CT, irq: c.irq / CT, softirq: c.softirq / CT, steal: c.steal / CT });
    const al = settings.get();
    const ifaces = [];
    let vethN = 0; const vethAgg = { rx: 0, tx: 0, rxp: 0, txp: 0, rxe: 0, txe: 0, rxd: 0, txd: 0, rxT: 0, txT: 0 };
    const addrs = proc.addresses();
    for (const [name, c] of Object.entries(T.net)) {
      const r = S.rates.ifaces[name] || {};
      if (name.startsWith('veth')) {
        vethN++;
        for (const k of ['rx', 'tx', 'rxp', 'txp', 'rxe', 'txe', 'rxd', 'txd']) vethAgg[k] += r[k] || 0;
        vethAgg.rxT += c.rxB; vethAgg.txT += c.txB;
        continue;
      }
      const meta = proc.ifaceInfo(name);
      ifaces.push({
        name, kind: proc.ifaceKind(name), ...meta, addrs: addrs[name] || [], primary: name === IFACE,
        rx: r.rx || 0, tx: r.tx || 0, rxp: r.rxp || 0, txp: r.txp || 0, rxe: r.rxe || 0, txe: r.txe || 0, rxd: r.rxd || 0, txd: r.txd || 0,
        rxT: c.rxB, txT: c.txB, rxPT: c.rxP, txPT: c.txP, rxET: c.rxE, txET: c.txE, rxDT: c.rxD, txDT: c.txD,
      });
    }
    if (vethN) ifaces.push({ name: `veth × ${vethN}`, kind: 'Container', state: 'up', addrs: [], aggregate: true, ...vethAgg });

    const disks = Object.entries(S.rates.disks).map(([dev, r]) => ({ dev, primary: dev === S.primaryDisk, ...proc.diskMeta(dev), ...r }));
    const dock = S.docker;
    return {
      t: Date.now(),
      cpu: {
        times: toSec(cpu.all), cores: cpu.cores.map(toSec), mhz: S.cpuinfo.mhz, cache: S.cpuinfo.cache, flags: S.cpuinfo.flags,
        ctxt: cpu.ctxt, intr: cpu.intr, forks: cpu.forks, running: cpu.running, blocked: cpu.blocked, btime: cpu.btime,
      },
      psi: T.psi, load: T.load,
      mem: { ...T.mem, raw: undefined }, swaps: S.swaps,
      vm: T.vm,
      net: {
        primary: IFACE, ifaces, tcp: S.tcp.states, listen: S.tcp.listen, udp: S.udp,
        snmpTcp: T.snmp.Tcp || {}, snmpUdp: T.snmp.Udp || {}, snmpIp: T.snmp.Ip || {},
        sock: proc.sockStat(),
        retransTotal: (T.snmp.Tcp || {}).RetransSegs, outSegsTotal: (T.snmp.Tcp || {}).OutSegs,
      },
      web: S.nginx.ok ? { ok: true, requests: S.nginx.requests, accepts: S.nginx.accepts, handled: S.nginx.handled, active: S.nginx.active, reading: S.nginx.reading, writing: S.nginx.writing, waiting: S.nginx.waiting, rate: r1(S.nginx.rate), connRate: r1(S.nginx.connRate) } : { ok: false },
      disks, fs: S.fs,
      procs: S.procs.data,
      sys: {
        uptime: T.up.up, idle: T.up.idle, btime: cpu.btime, limits: S.limits, reboot: S.reboot, users: S.users, time: S.time,
        pidMax: S.limits.pidMax, lastPid: T.load.lastPid, cpuinfo: { model: S.cpuinfo.model, cache: S.cpuinfo.cache, flags: S.cpuinfo.flags },
        self: { rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed, up: process.uptime(), clients: S.clients, node: process.version, pid: process.pid, history: { raw: raw.length, t10: t10.pts.length, t60: t60.pts.length } },
      },
      docker: { ok: dock.ok, stale: dock.stale, age: dock.age, containers: dock.containers || [] },
      alerts: [...S.active].map(([key, a]) => ({ key, ...a })),
      internet: { targets: S.internet.targets, lat: S.internet.lat, dns: S.internet.dns, dnsName: al.internet.dnsName },
    };
  }

  function slowPayload() {
    const list = services.list;
    const light = sites.list.map((s) => ({ ...s, hist: s.hist.slice(-48).map((h) => h.ms) }));
    return {
      sites: light, certs: S.certs, certsAt: S.certsAt,
      services: {
        total: list.length, active: list.filter((u) => u.active === 'active').length, running: list.filter((u) => u.sub === 'running').length,
        failed: list.filter((u) => u.active === 'failed').length, at: services.at,
      },
      now: Date.now(), uptime: proc.uptime().up,
    };
  }

  function rawDump() {
    const readVm = () => { const o = {}; for (const l of (proc.tryRead('/proc/vmstat') || '').split('\n')) { const i = l.indexOf(' '); if (i > 0) o[l.slice(0, i)] = Number(l.slice(i + 1)); } return o; };
    const readKv = (f) => { const o = {}; for (const l of (proc.tryRead(f) || '').split('\n')) { const i = l.indexOf(':'); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); } return o; };
    const m = proc.memInfo();
    return {
      t: Date.now(),
      meminfo: m.raw, vmstat: readVm(), snmp: proc.snmp(), netstat: proc.netstat(), sockstat: proc.sockStat(),
      stat: (proc.tryRead('/proc/stat') || '').split('\n').filter((l) => /^(cpu|ctxt|btime|processes|procs_)/.test(l)),
      loadavg: (proc.tryRead('/proc/loadavg') || '').trim(), uptime: (proc.tryRead('/proc/uptime') || '').trim(),
      version: (proc.tryRead('/proc/version') || '').trim(), cmdlineBoot: (proc.tryRead('/proc/cmdline') || '').trim().split(' ').filter((x) => !/(password|secret|token|key)/i.test(x)).join(' '),
      cpuinfo: S.cpuinfo, limits: proc.sysLimits(), swaps: proc.swaps(), diskstats: S.totals ? S.totals.disk : {}, netdev: S.totals ? S.totals.net : {},
      mounts: (proc.tryRead('/proc/mounts') || '').split('\n').filter(Boolean).filter((l) => !/ (\/var\/lib\/docker|\/proc|\/sys|\/dev\/pts)/.test(l)).slice(0, 80),
      psi: proc.psi(),
      interrupts: (proc.tryRead('/proc/interrupts') || '').split('\n').slice(0, 40),
      osRelease: readKv('/etc/os-release'),
      ifaces: Object.keys(S.totals ? S.totals.net : {}).filter((n) => !n.startsWith('veth')).map((n) => ({ name: n, ...proc.ifaceInfo(n), addrs: proc.addresses()[n] || [] })),
    };
  }

  // ---------------------------------------------------------------- history access
  function history(tier, since = 0) {
    const pts = tier === 't10' ? t10.pts : tier === 't60' ? t60.pts : raw;
    const step = tier === 't10' ? 10_000 : tier === 't60' ? 60_000 : 1000;
    return { step, pts: since ? pts.filter((p) => p.t > since) : pts };
  }

  function save() {
    store.save('history.json', { v: 3, savedAt: Date.now(), btime: S.lastBtime, t10: t10.pts, t60: t60.pts });
    sites.persist();
    events.save();
  }

  function start() {
    // detect a reboot since the last run
    try {
      const bt = proc.cpuStat().btime;
      if (S.lastBtime && Math.abs(bt - S.lastBtime) > 5) {
        events.add({ level: 'warn', kind: 'system', title: 'Server wurde neu gestartet', detail: `Vorheriger Start: ${new Date(S.lastBtime * 1000).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })}` });
      }
      S.lastBtime = bt;
    } catch {}
    const safeTick = () => { try { tick(); } catch (e) { console.error('tick:', e.message); } };
    safeTick();
    setInterval(safeTick, 1000);
    setInterval(pollNginx, 1000);
    pollNginx();
    refreshDocker();
    setInterval(refreshDocker, 5000);
    const procLoop = () => { if (S.clients > 0 || !S.procs.data || performance.now() - S.procs.at > 20_000) { try { scanProcs(); } catch (e) { console.error('scan:', e.message); } } };
    procLoop();
    setInterval(procLoop, 3000);
    setInterval(() => { try { const d = detail(); if (d) emit('detail', d); } catch (e) { console.error('detail:', e.message); } }, 4000);
    refreshMisc();
    setInterval(refreshMisc, 30_000);
    refreshInternet();
    setInterval(refreshInternet, 10_000);
    services.refresh().then(() => emit('slow', slowPayload())).catch(() => {});
    setInterval(() => services.refresh().then(() => emit('slow', slowPayload())).catch(() => {}), 5000);
    const runSites = () => sites.run().then(() => { emit('slow', slowPayload()); return refreshCerts(); }).then(() => emit('slow', slowPayload())).catch((e) => console.error('sites:', e.message));
    runSites();
    let siteTimer;
    const arm = () => { clearTimeout(siteTimer); siteTimer = setTimeout(async () => { await sites.run().then(() => emit('slow', slowPayload())).catch(() => {}); arm(); }, settings.get().sites.interval * 1000); };
    arm();
    settings.onChange(() => { arm(); sites.build(); sites.run().then(() => emit('slow', slowPayload())).catch(() => {}); });
    setInterval(() => refreshCerts().then(() => emit('slow', slowPayload())).catch(() => {}), 3_600_000);
    setInterval(save, 5 * 60_000);
  }

  return {
    start, save, history, info, detail, slowPayload, rawDump, sites, services,
    raw: () => raw, sample: () => S.sample, state: S,
    processes: () => ({ summary: S.procs.data, list: S.procs.list }),
    on: (k, fn) => listeners[k].push(fn),
    setClients: (n) => { S.clients = n; },
    flush: () => { t10.flush(); t60.flush(); },
  };
}

module.exports = { create };
