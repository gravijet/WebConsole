'use strict';
// Unprivileged readers for /proc and /sys. Every function is allowed to fail softly.

const fs = require('fs');
const os = require('os');

const read = (f) => fs.readFileSync(f, 'utf8');
const tryRead = (f) => { try { return read(f); } catch { return null; } };
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

const CLK_TCK = 100;
const PAGE = 4096;

// ------------------------------------------------------------------ cpu

function cpuStat() {
  const out = { all: null, cores: [], ctxt: 0, intr: 0, forks: 0, running: 0, blocked: 0, btime: 0 };
  for (const line of read('/proc/stat').split('\n')) {
    if (line.startsWith('cpu')) {
      const p = line.trim().split(/\s+/);
      const v = p.slice(1, 11).map(num);
      const rec = {
        user: v[0], nice: v[1], system: v[2], idle: v[3], iowait: v[4],
        irq: v[5], softirq: v[6], steal: v[7], guest: v[8] || 0,
      };
      rec.total = rec.user + rec.nice + rec.system + rec.idle + rec.iowait + rec.irq + rec.softirq + rec.steal;
      if (p[0] === 'cpu') out.all = rec; else out.cores.push(rec);
    } else if (line.startsWith('ctxt ')) out.ctxt = num(line.split(' ')[1]);
    else if (line.startsWith('intr ')) out.intr = num(line.split(' ')[1]);
    else if (line.startsWith('processes ')) out.forks = num(line.split(' ')[1]);
    else if (line.startsWith('procs_running ')) out.running = num(line.split(' ')[1]);
    else if (line.startsWith('procs_blocked ')) out.blocked = num(line.split(' ')[1]);
    else if (line.startsWith('btime ')) out.btime = num(line.split(' ')[1]);
  }
  return out;
}

function cpuInfo() {
  const txt = tryRead('/proc/cpuinfo') || '';
  const mhz = [];
  let model = '';
  let cache = '';
  let flags = 0;
  for (const line of txt.split('\n')) {
    if (line.startsWith('model name') && !model) model = line.split(':')[1].trim();
    else if (line.startsWith('cpu MHz')) mhz.push(num(line.split(':')[1]));
    else if (line.startsWith('cache size') && !cache) cache = line.split(':')[1].trim();
    else if (line.startsWith('flags') && !flags) flags = line.split(':')[1].trim().split(' ').length;
  }
  return { model: model.replace(/\(R\)|\(TM\)|CPU /g, '').replace(/\s+/g, ' ').trim(), mhz, cache, flags };
}

// ------------------------------------------------------------------ memory

function memInfo() {
  const m = {};
  for (const line of read('/proc/meminfo').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) {
      const raw = line.slice(i + 1).trim();
      m[line.slice(0, i)] = parseInt(raw, 10) * (raw.endsWith('kB') ? 1024 : 1);
    }
  }
  const cache = (m.Cached || 0) + (m.SReclaimable || 0) - (m.Shmem || 0);
  return {
    raw: m,
    total: m.MemTotal, free: m.MemFree, avail: m.MemAvailable || 0,
    buffers: m.Buffers || 0, cache,
    used: m.MemTotal - m.MemFree - cache - (m.Buffers || 0),
    shmem: m.Shmem || 0, slab: m.Slab || 0, dirty: m.Dirty || 0, anon: m.AnonPages || 0, mapped: m.Mapped || 0,
    active: m.Active || 0, inactive: m.Inactive || 0, pageTables: m.PageTables || 0,
    commit: m.Committed_AS || 0, commitLimit: m.CommitLimit || 0,
    swapTotal: m.SwapTotal || 0, swapUsed: (m.SwapTotal || 0) - (m.SwapFree || 0), swapCached: m.SwapCached || 0,
  };
}

const VM_KEYS = ['pgfault', 'pgmajfault', 'pswpin', 'pswpout', 'pgpgin', 'pgpgout', 'oom_kill', 'pgscan_kswapd', 'pgscan_direct', 'allocstall_normal'];
function vmStat() {
  const out = {};
  const want = new Set(VM_KEYS);
  for (const line of read('/proc/vmstat').split('\n')) {
    const i = line.indexOf(' ');
    if (i > 0 && want.has(line.slice(0, i))) out[line.slice(0, i)] = num(line.slice(i + 1));
  }
  return out;
}

function swaps() {
  const txt = tryRead('/proc/swaps');
  if (!txt) return [];
  return txt.split('\n').slice(1).filter(Boolean).map((l) => {
    const p = l.split(/\s+/);
    return { name: p[0], type: p[1], size: num(p[2]) * 1024, used: num(p[3]) * 1024, prio: num(p[4]) };
  });
}

// ------------------------------------------------------------------ pressure (PSI)

function psi() {
  const out = {};
  for (const kind of ['cpu', 'memory', 'io']) {
    const txt = tryRead(`/proc/pressure/${kind}`);
    if (!txt) continue;
    out[kind] = {};
    for (const line of txt.split('\n')) {
      const m = /^(some|full)\s+avg10=([\d.]+)\s+avg60=([\d.]+)\s+avg300=([\d.]+)\s+total=(\d+)/.exec(line);
      if (m) out[kind][m[1]] = { a10: num(m[2]), a60: num(m[3]), a300: num(m[4]), total: num(m[5]) };
    }
  }
  return out;
}

// ------------------------------------------------------------------ load / misc

function loadAvg() {
  const p = read('/proc/loadavg').trim().split(/\s+/);
  const [run, total] = p[3].split('/').map(num);
  return { l1: num(p[0]), l5: num(p[1]), l15: num(p[2]), run, total, lastPid: num(p[4]) };
}

const uptime = () => {
  const p = read('/proc/uptime').split(' ');
  return { up: num(p[0]), idle: num(p[1]) };
};

function sysLimits() {
  const fn = (tryRead('/proc/sys/fs/file-nr') || '0 0 0').trim().split(/\s+/).map(num);
  return {
    fdAlloc: fn[0], fdMax: fn[2],
    entropy: num(tryRead('/proc/sys/kernel/random/entropy_avail')),
    pidMax: num(tryRead('/proc/sys/kernel/pid_max')),
    threadsMax: num(tryRead('/proc/sys/kernel/threads-max')),
  };
}

function rebootRequired() {
  if (!fs.existsSync('/var/run/reboot-required')) return { required: false, pkgs: [] };
  const pkgs = (tryRead('/var/run/reboot-required.pkgs') || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return { required: true, pkgs: [...new Set(pkgs)].slice(0, 12) };
}

// ------------------------------------------------------------------ network

function netDev() {
  const out = {};
  for (const line of read('/proc/net/dev').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const p = line.slice(i + 1).trim().split(/\s+/).map(num);
    out[line.slice(0, i).trim()] = { rxB: p[0], rxP: p[1], rxE: p[2], rxD: p[3], txB: p[8], txP: p[9], txE: p[10], txD: p[11] };
  }
  return out;
}

function pairTable(file) {
  const out = {};
  const lines = (tryRead(file) || '').split('\n');
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const h = lines[i].split(/\s+/);
    const v = lines[i + 1].split(/\s+/);
    const proto = h[0].replace(':', '');
    if (!proto || proto !== v[0].replace(':', '')) continue;
    out[proto] = {};
    for (let j = 1; j < h.length; j++) out[proto][h[j]] = num(v[j]);
  }
  return out;
}
const snmp = () => pairTable('/proc/net/snmp');
const netstat = () => pairTable('/proc/net/netstat');

function sockStat() {
  const out = {};
  for (const line of (tryRead('/proc/net/sockstat') || '').split('\n')) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i);
    const p = line.slice(i + 1).trim().split(/\s+/);
    out[key] = {};
    for (let j = 0; j + 1 < p.length; j += 2) out[key][p[j]] = num(p[j + 1]);
  }
  return out;
}

const TCP_STATES = { '01': 'established', '02': 'syn_sent', '03': 'syn_recv', '04': 'fin_wait1', '05': 'fin_wait2', '06': 'time_wait', '07': 'close', '08': 'close_wait', '09': 'last_ack', '0A': 'listen', '0B': 'closing' };

function hexAddr(h) {
  if (h.length === 8) return [3, 2, 1, 0].map((i) => parseInt(h.substr(i * 2, 2), 16)).join('.');
  if (/^0+$/.test(h)) return '::';
  if (/^0{24}01000000$/i.test(h)) return '::1';
  return 'ipv6';
}

/** TCP connection states + listening sockets (aggregated per port). */
function tcpTable() {
  const states = {};
  const listen = new Map();
  for (const [file, v6] of [['/proc/net/tcp', false], ['/proc/net/tcp6', true]]) {
    const lines = (tryRead(file) || '').split('\n');
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      if (!l) continue;
      const p = l.trim().split(/\s+/);
      const st = TCP_STATES[p[3]] || 'other';
      states[st] = (states[st] || 0) + 1;
      if (p[3] === '0A') {
        const [a, port] = p[1].split(':');
        const addr = hexAddr(a);
        const portN = parseInt(port, 16);
        const scope = addr === '127.0.0.1' || addr === '::1' ? 'lokal' : addr === '0.0.0.0' || addr === '::' ? 'alle Schnittstellen' : `nur ${addr}`;
        const key = `${portN}`;
        const cur = listen.get(key);
        if (!cur) listen.set(key, { port: portN, scope, v6: v6 });
        else if (cur.scope === 'lokal' && scope !== 'lokal') cur.scope = scope;
      }
    }
  }
  return { states, listen: [...listen.values()].sort((a, b) => a.port - b.port) };
}

function udpSockets() {
  let n = 0;
  for (const f of ['/proc/net/udp', '/proc/net/udp6']) n += Math.max(0, (tryRead(f) || '').split('\n').length - 2);
  return n;
}

function ifaceInfo(name) {
  const base = `/sys/class/net/${name}`;
  const speed = num(tryRead(`${base}/speed`));
  return {
    state: (tryRead(`${base}/operstate`) || '').trim(),
    mtu: num(tryRead(`${base}/mtu`)),
    speed: speed > 0 ? speed : null,
  };
}

function ifaceKind(name) {
  if (name === 'lo') return 'Loopback';
  if (name.startsWith('veth')) return 'Container';
  if (name.startsWith('docker') || name.startsWith('br-')) return 'Bridge';
  if (/^(eth|en|ens|eno)/.test(name)) return 'Physisch';
  return 'Virtuell';
}

function addresses() {
  const out = {};
  let all = {};
  try { all = os.networkInterfaces(); } catch { return out; } // needs AF_NETLINK; never fatal
  for (const [name, list] of Object.entries(all)) out[name] = list.map((a) => `${a.address}/${a.cidr ? a.cidr.split('/')[1] : ''}`.replace(/\/$/, ''));
  return out;
}

// ------------------------------------------------------------------ disks

function diskStats() {
  const out = {};
  for (const line of read('/proc/diskstats').split('\n')) {
    const p = line.trim().split(/\s+/);
    const name = p[2];
    if (!name || /^(loop|ram|zram|dm-|sr|fd)/.test(name)) continue;
    if (!fs.existsSync(`/sys/block/${name}`)) continue; // whole disks only
    out[name] = {
      rIO: num(p[3]), rSec: num(p[5]), rMs: num(p[6]),
      wIO: num(p[7]), wSec: num(p[9]), wMs: num(p[10]),
      inflight: num(p[11]), busyMs: num(p[12]), weightedMs: num(p[13]),
    };
  }
  return out;
}

function diskMeta(name) {
  const b = `/sys/block/${name}`;
  return {
    size: num(tryRead(`${b}/size`)) * 512,
    model: (tryRead(`${b}/device/model`) || '').trim(),
    rotational: (tryRead(`${b}/queue/rotational`) || '').trim() === '1',
    scheduler: ((tryRead(`${b}/queue/scheduler`) || '').match(/\[([^\]]+)\]/) || [])[1] || '',
  };
}

const FS_REAL = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'vfat', 'f2fs', 'ntfs', 'ntfs3', 'zfs', 'exfat']);
const FS_TMP = new Set(['/run', '/dev/shm', '/tmp']);

function filesystems() {
  const seen = new Set();
  const out = [];
  for (const line of (tryRead('/proc/mounts') || '').split('\n')) {
    const p = line.split(' ');
    if (p.length < 3) continue;
    const [dev, mount, type] = [p[0], p[1].replace(/\\040/g, ' '), p[2]];
    if (!(FS_REAL.has(type) || (type === 'tmpfs' && FS_TMP.has(mount)))) continue;
    if (seen.has(dev + mount) || (FS_REAL.has(type) && seen.has(dev))) continue;
    seen.add(dev + mount);
    seen.add(dev);
    try {
      const s = fs.statfsSync(mount);
      const total = s.blocks * s.bsize;
      const used = (s.blocks - s.bfree) * s.bsize;
      out.push({
        mount, dev, type, total, used, avail: s.bavail * s.bsize,
        reserved: (s.bfree - s.bavail) * s.bsize,
        inodes: s.files, inodesUsed: s.files - s.ffree,
        persistent: FS_REAL.has(type),
      });
    } catch {}
  }
  return out;
}

// ------------------------------------------------------------------ processes

let pwCache = { at: 0, map: new Map() };
function userName(uid) {
  if (Date.now() - pwCache.at > 60_000) {
    pwCache = { at: Date.now(), map: new Map() };
    for (const l of (tryRead('/etc/passwd') || '').split('\n')) {
      const p = l.split(':');
      if (p.length > 2 && !pwCache.map.has(+p[2])) pwCache.map.set(+p[2], p[0]);
    }
  }
  return pwCache.map.get(uid) || String(uid);
}

/** "0::/system.slice/nginx.service" -> { kind, name } */
function cgroupOf(pid) {
  const txt = tryRead(`/proc/${pid}/cgroup`);
  if (!txt) return null;
  const path = (txt.split('\n').find((l) => l.startsWith('0::')) || '').slice(3);
  const parts = path.split('/').filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const unit = [...parts].reverse().find((s) => /\.(service|scope)$/.test(s)) || last;
  if (/^docker-[0-9a-f]{64}\.scope$/.test(unit)) return { kind: 'docker', name: unit.slice(7, 19) };
  if (/^session-\d+\.scope$/.test(unit)) return { kind: 'session', name: 'Anmeldesitzung' };
  if (unit.endsWith('.service')) return { kind: 'service', name: unit };
  return { kind: 'other', name: unit || '-' };
}

/**
 * One pass over /proc/<pid>. Returns { prev (for the next call), total, threads, states,
 * kernel, list[] (user processes) }.
 */
function scanProcesses(prev, dt, bootTime, upNow) {
  const next = new Map();
  const list = [];
  const states = {};
  let threads = 0;
  let kernel = 0;
  let total = 0;
  for (const pid of fs.readdirSync('/proc')) {
    const c = pid.charCodeAt(0);
    if (c < 48 || c > 57) continue;
    let txt;
    try { txt = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { continue; }
    const rp = txt.lastIndexOf(')');
    if (rp < 0) continue;
    const comm = txt.slice(txt.indexOf('(') + 1, rp);
    const f = txt.slice(rp + 2).split(' ');
    const state = f[0];
    const ppid = +f[1];
    const ticks = +f[11] + +f[12];
    const nth = +f[17];
    const start = +f[19];
    const rss = +f[21] * PAGE;
    total++;
    threads += nth;
    states[state] = (states[state] || 0) + 1;
    const key = +pid;
    const old = prev.get(key);
    next.set(key, { ticks, start });
    if (ppid === 2 || key === 2) { kernel++; continue; }
    const cpu = old && old.start === start && dt > 0 ? Math.max(0, ((ticks - old.ticks) / (dt * CLK_TCK)) * 100) : 0;
    let uid = 0;
    try { uid = fs.statSync(`/proc/${pid}`).uid; } catch {}
    list.push({
      pid: key, name: comm, user: userName(uid), state, cpu, rss, threads: nth,
      age: Math.max(0, upNow - start / CLK_TCK), cpuTime: ticks / CLK_TCK,
    });
  }
  return { prev: next, total, threads, states, kernel, list };
}

module.exports = {
  CLK_TCK, cpuStat, cpuInfo, memInfo, vmStat, swaps, psi, loadAvg, uptime, sysLimits, rebootRequired,
  netDev, snmp, netstat, sockStat, tcpTable, udpSockets, ifaceInfo, ifaceKind, addresses,
  diskStats, diskMeta, filesystems, scanProcesses, cgroupOf, tryRead, read,
};
