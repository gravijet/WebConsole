'use strict';
// Processes, systemd units, logs, nginx, certificates, reboot, host identity and hardware.

const fs = require('fs');
const path = require('path');
const { run, clip, fail, UNIT_RE, NAME_RE, int, str } = require('./core');
const jobs = require('./jobs');

const SIGNALS = { TERM: 'SIGTERM', KILL: 'SIGKILL', HUP: 'SIGHUP', INT: 'SIGINT', STOP: 'SIGSTOP', CONT: 'SIGCONT', USR1: 'SIGUSR1', USR2: 'SIGUSR2' };
const UNIT_ACTIONS = { start: 1, stop: 1, restart: 1, reload: 1, 'try-restart': 1, 'reset-failed': 1, enable: 1, disable: 1, mask: 1, unmask: 1, 'reload-or-restart': 1 };
const OWN_UNITS = new Set(['server-dash-actions.service', 'server-dash-actions.socket']);
const clampLines = (n) => Math.min(2000, Math.max(10, Number.isInteger(n) ? n : 200));

async function unitExists(unit) {
  const r = await run('systemctl', ['show', '-p', 'LoadState', '--value', '--', unit], { timeout: 10_000 });
  const v = r.out.trim();
  return v === 'loaded' || v === 'masked';
}

function readProc(pid) {
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const rp = stat.lastIndexOf(')');
  const comm = stat.slice(stat.indexOf('(') + 1, rp);
  const f = stat.slice(rp + 2).split(' ');
  let uid = null;
  try { uid = +/Uid:\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))[1]; } catch {}
  return { pid, comm, ppid: +f[1], uid, nice: +f[16], threads: +f[17] };
}

async function guardPid(pid, name) {
  int(pid, 2, 4_194_304, 'Die Prozess-ID');
  const p = readProc(pid);
  if (!p) throw fail('Der Prozess existiert nicht mehr.');
  if (p.ppid === 2 || pid === 2) throw fail('Kernel-Threads lassen sich nicht beeinflussen.');
  if (pid === process.pid || pid === process.ppid) throw fail('Dieser Prozess ist geschützt.');
  const dash = await run('systemctl', ['show', '-p', 'MainPID', '--value', 'server-dash.service'], { timeout: 8000 });
  if (pid === +dash.out.trim()) throw fail('Das Dashboard kann sich nicht selbst beeinflussen. Nutze „Dienste“ → Neustart.');
  if (typeof name === 'string' && name && name !== p.comm) throw fail(`Die PID gehört inzwischen zu „${p.comm}“, nicht zu „${name}“. Liste neu laden.`);
  return p;
}

const kvLines = (text, sep = '=') => Object.fromEntries(text.split('\n').filter((l) => l.includes(sep)).map((l) => { const i = l.indexOf(sep); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));

const SINCE = { '10m': '-10min', '1h': '-1h', '6h': '-6h', '24h': '-24h', '7d': '-7d', '30d': '-30d' };

const ops = {
  async ping() { return { pong: true, uid: process.getuid() }; },

  // ------------------------------------------------------------ processes
  async 'proc.signal'({ pid, signal, name }) {
    const sig = SIGNALS[signal];
    if (!sig) throw fail('Ungültiges Signal.');
    const p = await guardPid(pid, name);
    process.kill(pid, sig);
    return { pid, name: p.comm, signal: sig };
  },

  async 'proc.renice'({ pid, nice, name }) {
    int(nice, -20, 19, 'Die Priorität');
    const p = await guardPid(pid, name);
    const r = await run('renice', ['-n', String(nice), '-p', String(pid)], { timeout: 8000 });
    if (r.code !== 0) throw fail(`Priorität konnte nicht geändert werden: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { pid, name: p.comm, nice };
  },

  async 'proc.info'({ pid }) {
    int(pid, 1, 4_194_304, 'Die Prozess-ID');
    const base = readProc(pid);
    if (!base) throw fail('Der Prozess existiert nicht mehr.');
    const rd = (f) => { try { return fs.readFileSync(`/proc/${pid}/${f}`, 'utf8'); } catch { return ''; } };
    const ln = (f) => { try { return fs.readlinkSync(`/proc/${pid}/${f}`); } catch { return null; } };
    const status = kvLines(rd('status'), ':');
    const fds = [];
    let fdCount = 0;
    try {
      const names = fs.readdirSync(`/proc/${pid}/fd`);
      fdCount = names.length;
      for (const n of names.slice(0, 400)) { try { fds.push({ fd: +n, target: fs.readlinkSync(`/proc/${pid}/fd/${n}`) }); } catch {} }
      fds.sort((a, b) => a.fd - b.fd);
    } catch {}
    const environ = rd('environ').split('\0').filter(Boolean).map((e) => e.split('=')[0]);
    const limits = rd('limits').split('\n').slice(1).filter(Boolean).map((l) => { const m = /^(.{25})\s*(\S+)\s+(\S+)\s*(.*)$/.exec(l); return m ? { name: m[1].trim(), soft: m[2], hard: m[3], unit: m[4].trim() } : null; }).filter(Boolean);
    const sm = kvLines(rd('smaps_rollup'), ':');
    const io = kvLines(rd('io'), ':');
    const cg = rd('cgroup').trim().split('\n').pop() || '';
    const sock = await run('ss', ['-H', '-tunap'], { timeout: 10_000 });
    const conns = sock.out.split('\n').filter((l) => l.includes(`pid=${pid},`)).map((l) => l.trim().split(/\s+/).slice(0, 6).join(' '));
    const children = [];
    try { for (const d of fs.readdirSync('/proc')) { if (/^\d+$/.test(d)) { const c = readProc(+d); if (c && c.ppid === pid) children.push({ pid: c.pid, name: c.comm }); } } } catch {}
    return {
      pid, name: base.comm, ppid: base.ppid, state: status.State, uid: (status.Uid || '').split('\t')[0], gid: (status.Gid || '').split('\t')[0], threads: base.threads, nice: base.nice,
      cmdline: rd('cmdline').split('\0').filter(Boolean).join(' ').slice(0, 2000), cwd: ln('cwd'), exe: ln('exe'), cgroup: cg,
      vmRss: status.VmRSS, vmSize: status.VmSize, vmSwap: status.VmSwap, pss: sm.Pss, ctxVol: status.voluntary_ctxt_switches, ctxInv: status.nonvoluntary_ctxt_switches,
      io, limits, fdCount, fds, environNames: environ.slice(0, 200), connections: conns.slice(0, 100), children: children.slice(0, 60),
    };
  },

  // ------------------------------------------------------------ units
  async 'unit.control'({ unit, action }) {
    if (typeof unit !== 'string' || !UNIT_RE.test(unit)) throw fail('Ungültiger Einheitenname.');
    if (!UNIT_ACTIONS[action]) throw fail('Ungültige Aktion.');
    if (OWN_UNITS.has(unit)) throw fail('Der Aktions-Helfer lässt sich nicht über sich selbst steuern.');
    if (unit.endsWith('.timer') && ['reload', 'try-restart', 'reload-or-restart'].includes(action)) throw fail('Für Timer nicht möglich.');
    if (!(await unitExists(unit))) throw fail('Diese Einheit existiert nicht.');
    const selfRestart = unit === 'server-dash.service' && (action === 'restart' || action === 'stop');
    if (unit === 'server-dash.service' && ['stop', 'disable', 'mask'].includes(action)) throw fail('Das Dashboard lässt sich hier nicht stoppen oder deaktivieren. Neustart ist möglich.');
    const args = [action, ...(selfRestart ? ['--no-block'] : []), '--', unit];
    const r = await run('systemctl', args, { timeout: 90_000 });
    if (r.code !== 0) throw fail(`systemctl ${action} fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    const st = await run('systemctl', ['show', '-p', 'ActiveState,SubState,Result', '--', unit], { timeout: 8000 });
    return { unit, action, state: st.out.trim().split('\n').map((l) => l.split('=')[1]).filter(Boolean).join('/') };
  },

  async 'unit.daemon-reload'() {
    const r = await run('systemctl', ['daemon-reload'], { timeout: 60_000 });
    if (r.code !== 0) throw fail(`daemon-reload fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 300)}`);
    return {};
  },

  async 'unit.info'({ unit }) {
    if (typeof unit !== 'string' || !UNIT_RE.test(unit)) throw fail('Ungültiger Einheitenname.');
    if (!(await unitExists(unit))) throw fail('Diese Einheit existiert nicht.');
    const props = ['Id', 'Description', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath', 'DropInPaths', 'MainPID', 'ControlGroup', 'User', 'Group', 'Restart', 'RestartUSec', 'NRestarts', 'ExecMainStatus', 'Result', 'MemoryCurrent', 'MemoryMax', 'TasksCurrent', 'CPUUsageNSec', 'ActiveEnterTimestamp', 'InactiveEnterTimestamp', 'Requires', 'Wants', 'After', 'Before', 'WantedBy', 'Triggers', 'TriggeredBy', 'Documentation', 'WorkingDirectory', 'Type', 'NextElapseUSecRealtime', 'LastTriggerUSec'];
    const sh = await run('systemctl', ['show', '-p', props.join(','), '--', unit], { timeout: 10_000 });
    const cat = await run('systemctl', ['cat', '--', unit], { timeout: 10_000 });
    const ex = await run('systemctl', ['show', '-p', 'ExecStart', '--value', '--', unit], { timeout: 10_000 });
    return { unit, props: kvLines(sh.out), execStart: ex.out.trim().slice(0, 1500), cat: clip(cat.out, 60_000) };
  },

  // ------------------------------------------------------------ nginx + certificates
  async 'nginx.reload'() {
    const t = await run('nginx', ['-t'], { timeout: 20_000 });
    const test = (t.err + t.out).trim();
    if (t.code !== 0) throw fail(`Die nginx-Konfiguration ist fehlerhaft, nichts wurde geladen:\n${test.slice(0, 800)}`);
    const r = await run('systemctl', ['reload', 'nginx'], { timeout: 30_000 });
    if (r.code !== 0) throw fail(`Reload fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    return { test };
  },

  async 'nginx.test'() {
    const t = await run('nginx', ['-t'], { timeout: 20_000 });
    return { ok: t.code === 0, text: (t.err + t.out).trim() };
  },

  async 'nginx.sites'() {
    const avail = '/etc/nginx/sites-available'; const en = '/etc/nginx/sites-enabled';
    const enabled = new Map();
    for (const f of fs.readdirSync(en)) { try { enabled.set(f, fs.realpathSync(path.join(en, f))); } catch { enabled.set(f, null); } }
    const names = new Set([...fs.readdirSync(avail), ...enabled.keys()]);
    const out = [];
    for (const n of [...names].sort()) {
      const file = fs.existsSync(path.join(avail, n)) ? path.join(avail, n) : path.join(en, n);
      let text = '';
      try { text = fs.readFileSync(file, 'utf8'); } catch {}
      const sn = new Set(); const targets = new Set(); const listens = new Set();
      for (const m of text.matchAll(/^\s*server_name\s+([^;]+);/gm)) m[1].split(/\s+/).filter((x) => x && x !== '_').forEach((x) => sn.add(x));
      for (const m of text.matchAll(/^\s*proxy_pass\s+([^;]+);/gm)) targets.add(m[1].trim());
      for (const m of text.matchAll(/^\s*root\s+([^;]+);/gm)) targets.add(m[1].trim());
      for (const m of text.matchAll(/^\s*listen\s+([^;]+);/gm)) listens.add(m[1].trim().split(/\s+/)[0]);
      out.push({ name: n, file, enabled: enabled.has(n), size: text.length, serverNames: [...sn], targets: [...targets].slice(0, 6), listens: [...listens].slice(0, 8), ssl: /ssl_certificate\b/.test(text) });
    }
    return { sites: out };
  },

  async 'nginx.site-toggle'({ name, enable }) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('Ungültiger Name.');
    const avail = path.join('/etc/nginx/sites-available', name); const link = path.join('/etc/nginx/sites-enabled', name);
    if (!fs.existsSync(avail)) throw fail('Diese Website-Datei existiert nicht in sites-available.');
    let has = true;
    try { fs.lstatSync(link); } catch { has = false; }
    if (enable && !has) fs.symlinkSync(avail, link);
    else if (!enable && has) { if (!fs.lstatSync(link).isSymbolicLink()) throw fail('sites-enabled enthält hier eine echte Datei, keinen Link. Bitte im Dateimanager bearbeiten.'); fs.unlinkSync(link); }
    const t = await run('nginx', ['-t'], { timeout: 20_000 });
    if (t.code !== 0) {
      if (enable && !has) fs.unlinkSync(link); else if (!enable && has) fs.symlinkSync(avail, link);
      throw fail(`Die nginx-Konfiguration wäre fehlerhaft, die Änderung wurde zurückgenommen:\n${(t.err + t.out).trim().slice(0, 600)}`);
    }
    return { name, enabled: !!enable, note: 'Noch nicht geladen: nginx neu laden, damit die Änderung wirkt.' };
  },

  async 'certs.list'() {
    // certbot may not be installed (certificates can also come from Cloudflare origin certs, mailcow, ...)
    if (!['/usr/bin/certbot', '/usr/local/bin/certbot', '/snap/bin/certbot'].some((f) => fs.existsSync(f))) return { certs: [], available: false, error: '', service: {} };
    const r = await run('certbot', ['certificates'], { timeout: 60_000, env: { LC_ALL: 'C' } });
    const certs = [];
    let cur = null;
    for (const l of r.out.split('\n')) {
      const m = /^\s*(Certificate Name|Serial Number|Key Type|Domains|Expiry Date|Certificate Path|Private Key Path):\s*(.*)$/.exec(l);
      if (!m) continue;
      if (m[1] === 'Certificate Name') { cur = { name: m[2].trim() }; certs.push(cur); continue; }
      if (!cur) continue;
      if (m[1] === 'Domains') cur.domains = m[2].trim().split(/\s+/);
      else if (m[1] === 'Key Type') cur.keyType = m[2].trim();
      else if (m[1] === 'Serial Number') cur.serial = m[2].trim();
      else if (m[1] === 'Certificate Path') cur.path = m[2].trim();
      else if (m[1] === 'Expiry Date') { const d = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\+00:00 \((.*)\)/.exec(m[2].trim()); if (d) { cur.expires = Date.parse(`${d[1].replace(' ', 'T')}Z`); cur.status = d[2]; } }
    }
    const tm = await run('systemctl', ['show', '-p', 'ActiveState,Result', '--', 'certbot.service'], { timeout: 8000 });
    return { certs, available: true, error: certs.length ? '' : (r.err || r.out).trim().slice(0, 300), service: kvLines(tm.out) };
  },

  async 'certs.renew'({ name, dry }) {
    const args = ['renew'];
    if (name) { if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('Ungültiger Zertifikatsname.'); args.push('--cert-name', name); }
    if (dry) args.push('--dry-run');
    return jobs.start('certbot', `Zertifikate ${dry ? 'prüfen (Testlauf)' : 'erneuern'}${name ? `: ${name}` : ''}`, 'certbot', args, { env: { LC_ALL: 'C' } });
  },

  // ------------------------------------------------------------ reboot
  async 'system.reboot'({ delay, dry }) {
    int(delay, 10, 600, 'Die Verzögerung (Sekunden)');
    const pending = await run('systemctl', ['is-active', 'sd-reboot.timer'], { timeout: 8000 });
    if (pending.out.trim() === 'active') throw fail('Ein Neustart ist bereits geplant.');
    if (dry) return { dry: true, delay };
    const r = await run('systemd-run', ['--unit=sd-reboot', `--on-active=${delay}s`, '--timer-property=AccuracySec=1s', '--description=Geplanter Neustart (Xeon-1 Console)', '/usr/bin/systemctl', 'reboot'], { timeout: 15_000 });
    if (r.code !== 0) throw fail(`Neustart konnte nicht geplant werden: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { scheduled: true, delay, at: Date.now() + delay * 1000 };
  },

  async 'system.cancel-reboot'() {
    const r = await run('systemctl', ['stop', 'sd-reboot.timer'], { timeout: 15_000 });
    const st = await run('systemctl', ['is-active', 'sd-reboot.timer'], { timeout: 8000 });
    return { cancelled: st.out.trim() !== 'active', note: r.err.trim().slice(0, 200) };
  },

  async 'system.reboot-status'() {
    const st = await run('systemctl', ['show', '-p', 'ActiveState,NextElapseUSecRealtime', 'sd-reboot.timer'], { timeout: 8000 });
    const kv = kvLines(st.out);
    const pending = kv.ActiveState === 'active';
    let at = null;
    if (pending && kv.NextElapseUSecRealtime) { const d = Date.parse(kv.NextElapseUSecRealtime.replace(/^\w+ /, '')); at = Number.isNaN(d) ? null : d; }
    return { pending, at };
  },

  // ------------------------------------------------------------ host identity + hardware
  async 'sys.identity'() {
    const h = await run('hostnamectl', ['status', '--no-pager'], { timeout: 8000 });
    const t = await run('timedatectl', ['show'], { timeout: 8000 });
    const tzs = await run('timedatectl', ['list-timezones', '--no-pager'], { timeout: 8000 });
    const loc = await run('localectl', ['status', '--no-pager'], { timeout: 8000 });
    return { host: kvLines(h.out, ':'), time: kvLines(t.out), timezones: tzs.out.split('\n').filter(Boolean), locale: kvLines(loc.out, ':') };
  },

  async 'sys.set-hostname'({ name }) {
    if (typeof name !== 'string' || !/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(name)) throw fail('Ungültiger Rechnername (Buchstaben, Ziffern, Bindestrich).');
    const r = await run('hostnamectl', ['set-hostname', name], { timeout: 15_000 });
    if (r.code !== 0) throw fail(`Rechnername konnte nicht gesetzt werden: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { name };
  },

  async 'sys.set-timezone'({ tz }) {
    const list = (await run('timedatectl', ['list-timezones', '--no-pager'], { timeout: 8000 })).out.split('\n');
    if (!list.includes(tz)) throw fail('Unbekannte Zeitzone.');
    const r = await run('timedatectl', ['set-timezone', tz], { timeout: 15_000 });
    if (r.code !== 0) throw fail(`Zeitzone konnte nicht gesetzt werden: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { tz };
  },

  async 'sys.hardware'() {
    const cpuJ = await run('lscpu', ['-J'], { timeout: 10_000 });
    let cpu = [];
    try { cpu = JSON.parse(cpuJ.out).lscpu.map((x) => ({ k: x.field.replace(/:$/, ''), v: x.data })); } catch {}
    const blk = await run('lsblk', ['-J', '-b', '-o', 'NAME,SIZE,TYPE,FSTYPE,MOUNTPOINTS,MODEL,ROTA,UUID,FSUSED,LABEL,RO'], { timeout: 10_000 });
    let blocks = [];
    try { blocks = JSON.parse(blk.out).blockdevices; } catch {}
    const pci = (await run('lspci', ['-mm'], { timeout: 10_000 })).out.split('\n').filter(Boolean).map((l) => l.replace(/"/g, '').replace(/\s+/g, ' ').trim());
    const usb = (await run('lsusb', [], { timeout: 10_000 })).out.split('\n').filter(Boolean);
    const dmi = await run('dmidecode', ['-t', 'system', '-t', 'bios', '-t', 'baseboard', '-t', 'memory', '-q'], { timeout: 15_000 });
    const dmiBlocks = dmi.out.split(/\n\s*\n/).map((b) => b.trim().split('\n')).filter((b) => b.length > 1).map((b) => ({ title: b[0].trim(), items: b.slice(1).map((l) => { const i = l.indexOf(':'); return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : [l.trim(), '']; }).filter(([k, v]) => v && !/^(Not Specified|Unknown|To Be Filled By O\.E\.M\.)$/i.test(v)) })).filter((b) => b.items.length);
    return { cpu, blocks, pci, usb, dmi: dmiBlocks, dmiError: dmi.code !== 0 ? (dmi.err || '').trim().slice(0, 200) : '' };
  },

  async 'sys.sysctl'() {
    const r = await run('sysctl', ['-a'], { timeout: 15_000 });
    const list = r.out.split('\n').filter((l) => l.includes(' = ')).map((l) => { const i = l.indexOf(' = '); return [l.slice(0, i), l.slice(i + 3)]; });
    return { list };
  },

  async 'sys.modules'() {
    const r = await run('lsmod', [], { timeout: 8000 });
    const list = r.out.split('\n').slice(1).filter(Boolean).map((l) => { const p = l.trim().split(/\s+/); return { name: p[0], size: +p[1], used: +p[2], by: (p[3] || '').split(',').filter(Boolean) }; });
    return { list };
  },

  // ------------------------------------------------------------ logs (read-only)
  async 'logs.unit'({ unit, lines }) {
    if (typeof unit !== 'string' || !UNIT_RE.test(unit)) throw fail('Ungültiger Einheitenname.');
    const r = await run('journalctl', ['-u', unit, '-n', String(clampLines(lines)), '--no-pager', '-o', 'short-iso'], { timeout: 20_000 });
    return { text: clip(r.out) };
  },
  async 'logs.kernel'({ lines }) {
    const r = await run('journalctl', ['-k', '-n', String(clampLines(lines)), '--no-pager', '-o', 'short-iso'], { timeout: 20_000 });
    return { text: clip(r.out) };
  },
  async 'logs.system'({ lines, level }) {
    const pr = { err: 'err', warning: 'warning', info: 'info' }[level] || 'warning';
    const r = await run('journalctl', ['-p', pr, '-n', String(clampLines(lines)), '--no-pager', '-o', 'short-iso'], { timeout: 20_000 });
    return { text: clip(r.out) };
  },
  async 'logs.nginx'({ which, lines }) {
    const file = which === 'access' ? '/var/log/nginx/access.log' : '/var/log/nginx/error.log';
    const r = await run('tail', ['-n', String(clampLines(lines)), file], { timeout: 15_000 });
    return { text: clip(r.out || r.err) };
  },

  /** flexible journal search */
  async 'logs.query'({ unit, priority, since, grep, lines, boot }) {
    const args = ['--no-pager', '-o', 'short-iso', '-n', String(clampLines(lines))];
    if (unit) { if (typeof unit !== 'string' || !UNIT_RE.test(unit)) throw fail('Ungültiger Einheitenname.'); args.push('-u', unit); }
    if (priority !== undefined && priority !== null && priority !== '') { if (!['emerg', 'alert', 'crit', 'err', 'warning', 'notice', 'info', 'debug'].includes(priority)) throw fail('Ungültige Priorität.'); args.push('-p', priority); }
    if (since) { if (!SINCE[since]) throw fail('Ungültiger Zeitraum.'); args.push('--since', SINCE[since]); }
    if (boot) args.push('-b');
    if (grep) { if (typeof grep !== 'string' || grep.length > 120 || grep.includes('\0')) throw fail('Ungültiges Suchmuster.'); args.push(`--grep=${grep}`, '--case-sensitive=false'); }
    const r = await run('journalctl', args, { timeout: 40_000 });
    if (r.code !== 0 && !r.out) throw fail((r.err || 'Journal-Abfrage fehlgeschlagen.').trim().slice(0, 300));
    return { text: clip(r.out) };
  },


  /** visitor statistics from an nginx access log in combined format */
  async 'logs.access-stats'({ file, lines }) {
    str(file, 'Datei');
    let real;
    try { real = fs.realpathSync(file); } catch { throw fail('Die Datei existiert nicht.'); }
    if (!real.startsWith('/var/log/nginx/') || !/\.log$/.test(real)) throw fail('Nur nginx-Protokolle unter /var/log/nginx sind erlaubt.');
    const n = Math.min(100000, Math.max(1000, Number.isInteger(lines) ? lines : 20000));
    const r = await run('tail', ['-n', String(n), '--', real], { timeout: 20_000, max: 64 << 20 });
    const re = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)"/;
    const ips = new Map(); const paths = new Map(); const agents = new Map(); const status = {}; const methods = {}; const hourly = new Map();
    let total = 0; let bytes = 0; let first = null; let last = null; let bots = 0;
    const MON = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    for (const line of r.out.split('\n')) {
      const m = re.exec(line);
      if (!m) continue;
      total++;
      ips.set(m[1], (ips.get(m[1]) || 0) + 1);
      const p = m[4].split('?')[0].slice(0, 120); paths.set(p, (paths.get(p) || 0) + 1);
      const cls = `${m[5][0]}xx`; status[cls] = (status[cls] || 0) + 1;
      methods[m[3]] = (methods[m[3]] || 0) + 1;
      if (m[6] !== '-') bytes += +m[6];
      const ua = m[8].slice(0, 90) || '(leer)'; agents.set(ua, (agents.get(ua) || 0) + 1);
      if (/bot|spider|crawl|curl|python|go-http|scan/i.test(m[8])) bots++;
      const d = /^(\d+)\/(\w+)\/(\d+):(\d+):\d+:\d+ ([+-]\d{4})/.exec(m[2]);
      if (d) {
        const off = (d[5][0] === '-' ? -1 : 1) * (+d[5].slice(1, 3) * 60 + +d[5].slice(3)) * 60_000;
        const t = Date.UTC(+d[3], MON[d[2]], +d[1], +d[4]) - off;
        hourly.set(t, (hourly.get(t) || 0) + 1);
        if (first == null || t < first) first = t; if (last == null || t > last) last = t;
      }
    }
    const top = (map, k) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
    return { file: real, total, bytes, bots, first, last, status, methods, ips: top(ips, 15), paths: top(paths, 20), agents: top(agents, 10), hourly: [...hourly.entries()].sort((a, b) => a[0] - b[0]).slice(-72) };
  },

  async 'logs.files'() {
    const out = [];
    const walk = (dir, depth) => {
      let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (depth < 2) walk(p, depth + 1); continue; }
        if (!e.isFile()) continue;
        try { const st = fs.statSync(p); out.push({ path: p, size: st.size, mtime: st.mtimeMs }); } catch {}
      }
    };
    walk('/var/log', 0);
    out.sort((a, b) => b.mtime - a.mtime);
    return { files: out.slice(0, 600) };
  },

  async 'logs.tail'({ path: p, lines, filter }) {
    str(p, 'Pfad');
    let real;
    try { real = fs.realpathSync(p); } catch { throw fail('Die Datei existiert nicht.'); }
    if (!real.startsWith('/var/log/') || !fs.statSync(real).isFile()) throw fail('Nur Dateien unter /var/log sind erlaubt.');
    const n = clampLines(lines);
    let text;
    if (/\.gz$/.test(real)) { const r = await run('zcat', ['--', real], { timeout: 30_000, max: 64 << 20 }); text = r.out.split('\n').slice(-n).join('\n'); }
    else { const r = await run('tail', ['-n', String(n), '--', real], { timeout: 15_000 }); text = r.out; }
    if (filter) { const f = String(filter).toLowerCase().slice(0, 100); text = text.split('\n').filter((l) => l.toLowerCase().includes(f)).join('\n'); }
    return { text: clip(text), path: real };
  },
};

module.exports = { ops, guardPid, readProc };
