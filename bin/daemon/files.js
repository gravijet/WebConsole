'use strict';
// File manager. Every path is normalised and checked; secrets are never read back; every overwrite
// or delete of a file keeps a copy in /var/backups/server-dash so nothing is lost by accident.

const fs = require('fs');
const path = require('path');
const { run, clip, fail, int, str } = require('./core');

const BACKUPS = '/var/backups/server-dash';
const STATE = process.env.SD_STATE_DIR || '/var/lib/server-dash';
const UPLOADS = path.join(STATE, 'uploads');
const OUTBOX = path.join(STATE, 'outbox');
const MAX_READ = 2 * 1024 * 1024;
const MAX_STAGE = 256 * 1024 * 1024;
const MAX_BACKUP = 8 * 1024 * 1024;

// never touch: roots of the system, the helper itself, and the dashboard's own secrets
const ROOT_DIRS = new Set(['/', '/bin', '/boot', '/dev', '/etc', '/home', '/lib', '/lib32', '/lib64', '/proc', '/root', '/run', '/sbin', '/sys', '/usr', '/var', '/opt', '/srv', '/mnt', '/media', '/tmp', '/usr/bin', '/usr/lib', '/usr/sbin', '/usr/local', '/var/lib', '/var/log', '/etc/ssh', '/etc/systemd', '/etc/nginx', '/etc/letsencrypt', '/var/lib/docker']);
const NO_WRITE_PREFIX = ['/proc/', '/sys/', '/dev/', '/usr/local/lib/server-dash/', '/etc/systemd/system/server-dash', '/var/lib/server-dash/auth', '/var/lib/server-dash/uploads/', '/var/lib/server-dash/outbox/', '/run/server-dash/'];
const NO_READ_NAMES = [/^\/etc\/shadow-?$/, /^\/etc\/gshadow-?$/, /^\/etc\/ssh\/ssh_host_[a-z0-9_]+_key$/, /\/(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/, /^\/etc\/letsencrypt\/(live|archive)\/.+\/privkey[0-9]*\.pem$/, /^\/var\/lib\/server-dash\/(auth|sessions)[^/]*\.json$/, /^\/etc\/ssl\/private\//];
const PRIVATE_KEY_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;

let passwdCache = { at: 0, users: new Map(), groups: new Map() };
function names() {
  if (Date.now() - passwdCache.at < 15_000) return passwdCache;
  const u = new Map(); const g = new Map();
  try { for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const p = l.split(':'); if (p[2]) u.set(+p[2], p[0]); } } catch {}
  try { for (const l of fs.readFileSync('/etc/group', 'utf8').split('\n')) { const p = l.split(':'); if (p[2]) g.set(+p[2], p[0]); } } catch {}
  passwdCache = { at: Date.now(), users: u, groups: g };
  return passwdCache;
}

function clean(p, label = 'Pfad') {
  str(p, label, 4096);
  if (!p.startsWith('/')) throw fail('Der Pfad muss absolut sein (mit / beginnen).');
  const n = path.posix.normalize(p);
  return n.length > 1 && n.endsWith('/') ? n.slice(0, -1) : n;
}

function realOrSelf(p) { try { return fs.realpathSync(p); } catch { return p; } }

function checkRead(p) {
  for (const re of NO_READ_NAMES) if (re.test(p) || re.test(realOrSelf(p))) throw fail('Diese Datei enthält Geheimnisse und wird nicht angezeigt.');
}
function checkWrite(p, { tree = false } = {}) {
  const real = realOrSelf(p);
  if (ROOT_DIRS.has(p) || ROOT_DIRS.has(real)) throw fail('Dieses Systemverzeichnis ist geschützt.');
  for (const pre of NO_WRITE_PREFIX) if ((p + '/').startsWith(pre) || (real + '/').startsWith(pre) || p.startsWith(pre) || real.startsWith(pre)) throw fail('Dieser Bereich gehört dem Dashboard selbst und ist geschützt.');
  if (tree && /^\/home\/[^/]+$/.test(p)) throw fail('Ganze Home-Verzeichnisse werden hier nicht verändert. Lösche oder ändere Inhalte einzeln.');
  if (/^\/(proc|sys|dev)(\/|$)/.test(real)) throw fail('Dieser Bereich ist geschützt.');
}

function backup(p) {
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile() || st.size > MAX_BACKUP) return null;
    fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
    const id = `${Date.now()}__${p.replace(/\//g, '%2F')}`;
    fs.copyFileSync(p, path.join(BACKUPS, id));
    const meta = { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid };
    fs.writeFileSync(path.join(BACKUPS, `${id}.meta`), JSON.stringify(meta), { mode: 0o600 });
    return id;
  } catch { return null; }
}

function isBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function entry(dir, name) {
  const p = path.posix.join(dir, name);
  let st; let lst;
  try { lst = fs.lstatSync(p); } catch { return null; }
  const isLink = lst.isSymbolicLink();
  st = lst;
  let target = null; let broken = false;
  if (isLink) { try { target = fs.readlinkSync(p); st = fs.statSync(p); } catch { broken = true; } }
  const nm = names();
  return {
    name, type: isLink ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other', isDir: !broken && st.isDirectory(), size: st.size, mtime: st.mtimeMs, mode: (lst.mode & 0o7777).toString(8).padStart(4, '0'),
    uid: lst.uid, gid: lst.gid, owner: nm.users.get(lst.uid) || String(lst.uid), group: nm.groups.get(lst.gid) || String(lst.gid), target, broken,
  };
}

/** apply a fresh copy of owner / mode to `dest`, taken from a backup record */
function restoreMeta(dest, meta) {
  try { fs.chownSync(dest, meta.uid, meta.gid); fs.chmodSync(dest, meta.mode); } catch {}
}

// validators run on the new content before (sudoers) or right after (nginx, sshd) it is put in place
async function validateAfter(p) {
  if (/^\/etc\/nginx\//.test(p)) { const t = await run('nginx', ['-t'], { timeout: 20_000 }); return t.code === 0 ? null : (t.err + t.out).trim().slice(0, 700); }
  if (/^\/etc\/ssh\/sshd_config(\.d\/.*)?$/.test(p)) { const t = await run('sshd', ['-t'], { timeout: 20_000 }); return t.code === 0 ? null : (t.err + t.out).trim().slice(0, 700); }
  if (/^\/etc\/(fail2ban|ufw)\//.test(p)) return null;
  return null;
}

const ops = {
  async 'files.list'({ path: raw }) {
    const dir = clean(raw);
    let real;
    try { real = fs.realpathSync(dir); } catch { throw fail('Dieses Verzeichnis existiert nicht.'); }
    let st; try { st = fs.statSync(real); } catch { throw fail('Kein Zugriff.'); }
    if (!st.isDirectory()) throw fail('Das ist kein Verzeichnis.');
    let list;
    try { list = fs.readdirSync(real); } catch (e) { throw fail(`Kein Zugriff: ${e.code}`); }
    const entries = list.slice(0, 6000).map((n) => entry(real, n)).filter(Boolean);
    let free = null;
    try { const s = fs.statfsSync(real); free = { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
    return { path: dir, real, entries, truncated: list.length > 6000, count: list.length, free, mode: (st.mode & 0o7777).toString(8).padStart(4, '0'), owner: names().users.get(st.uid) || String(st.uid) };
  },

  async 'files.stat'({ path: raw }) {
    const p = clean(raw);
    let lst;
    try { lst = fs.lstatSync(p); } catch { throw fail('Nicht gefunden.'); }
    const e = entry(path.posix.dirname(p), path.posix.basename(p)) || {};
    const ft = await run('file', ['-b', '--', p], { timeout: 8000 });
    let sample = null;
    if (lst.isFile()) { try { const fd = fs.openSync(p, 'r'); const b = Buffer.alloc(Math.min(lst.size, 8192)); fs.readSync(fd, b, 0, b.length, 0); fs.closeSync(fd); sample = { binary: isBinary(b) }; } catch {} }
    return { ...e, path: p, atime: lst.atimeMs, ctime: lst.ctimeMs, birth: lst.birthtimeMs, inode: lst.ino, links: lst.nlink, type_desc: ft.out.trim().slice(0, 200), ...(sample || {}) };
  },

  async 'files.read'({ path: raw, offset }) {
    const p = clean(raw);
    checkRead(p);
    let st;
    try { st = fs.statSync(p); } catch { throw fail('Die Datei existiert nicht.'); }
    if (!st.isFile()) throw fail('Das ist keine normale Datei.');
    const off = Number.isInteger(offset) && offset > 0 ? Math.min(offset, st.size) : 0;
    const len = Math.min(MAX_READ, st.size - off);
    const fd = fs.openSync(p, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, off);
    fs.closeSync(fd);
    if (isBinary(buf)) return { path: p, size: st.size, mtime: st.mtimeMs, binary: true, text: '' };
    const text = buf.toString('utf8');
    if (PRIVATE_KEY_RE.test(text)) throw fail('Diese Datei enthält einen privaten Schlüssel und wird nicht angezeigt.');
    return { path: p, size: st.size, mtime: st.mtimeMs, binary: false, text, truncated: off + len < st.size, mode: (st.mode & 0o7777).toString(8).padStart(4, '0'), editable: off === 0 && off + len >= st.size };
  },

  async 'files.write'({ path: raw, text, expectMtime, create }) {
    const p = clean(raw);
    checkWrite(p);
    if (typeof text !== 'string' || text.length > MAX_READ + 1024) throw fail('Der Inhalt ist zu groß (max. 2 MB im Editor).');
    if (PRIVATE_KEY_RE.test(text)) throw fail('Private Schlüssel werden hier nicht gespeichert.');
    let st = null;
    try { st = fs.lstatSync(p); } catch {}
    if (st && !st.isFile() && !st.isSymbolicLink()) throw fail('Das ist keine normale Datei.');
    if (!st && !create) throw fail('Die Datei existiert nicht.');
    if (st && Number.isFinite(expectMtime) && Math.abs(st.mtimeMs - expectMtime) > 1) throw fail('Die Datei wurde zwischenzeitlich verändert. Bitte neu laden, damit nichts überschrieben wird.');
    const target = st && st.isSymbolicLink() ? fs.realpathSync(p) : p;
    checkWrite(target);
    const dir = path.dirname(target);
    if (!fs.existsSync(dir)) throw fail('Das Zielverzeichnis existiert nicht.');
    const bk = st ? backup(target) : null;
    const tmp = path.join(dir, `.sd-tmp-${process.pid}-${Date.now()}`);
    const meta = st ? { mode: fs.statSync(target).mode & 0o7777, uid: fs.statSync(target).uid, gid: fs.statSync(target).gid } : { mode: 0o644, uid: fs.statSync(dir).uid, gid: fs.statSync(dir).gid };
    fs.writeFileSync(tmp, text, { mode: meta.mode });
    restoreMeta(tmp, meta);
    // sudoers must be valid before it replaces the old file, or sudo breaks for everyone
    if (/^\/etc\/sudoers(\.d\/.*)?$/.test(target)) {
      const v = await run('visudo', ['-c', '-f', tmp], { timeout: 15_000 });
      if (v.code !== 0) { fs.unlinkSync(tmp); throw fail(`sudoers-Syntaxfehler, nichts gespeichert:\n${(v.err + v.out).trim().slice(0, 500)}`); }
    }
    fs.renameSync(tmp, target);
    const bad = await validateAfter(target);
    if (bad) {
      if (bk) fs.copyFileSync(path.join(BACKUPS, bk), target); else fs.unlinkSync(target);
      throw fail(`Die Prüfung hat die neue Datei abgelehnt, die alte Fassung wurde wiederhergestellt:\n${bad}`);
    }
    return { path: target, size: Buffer.byteLength(text), mtime: fs.statSync(target).mtimeMs, backup: bk, created: !st };
  },

  async 'files.mkdir'({ path: raw }) {
    const p = clean(raw);
    checkWrite(p);
    if (fs.existsSync(p)) throw fail('Es existiert bereits etwas mit diesem Namen.');
    const parent = path.dirname(p);
    if (!fs.existsSync(parent)) throw fail('Das übergeordnete Verzeichnis existiert nicht.');
    fs.mkdirSync(p, { mode: 0o755 });
    const ps = fs.statSync(parent);
    fs.chownSync(p, ps.uid, ps.gid);
    return { path: p };
  },

  async 'files.rename'({ from, to }) {
    const a = clean(from, 'Quelle'); const b = clean(to, 'Ziel');
    checkWrite(a, { tree: true }); checkWrite(b);
    if (!fs.existsSync(a) && !fs.lstatSync(a, { throwIfNoEntry: false })) throw fail('Die Quelle existiert nicht.');
    if (fs.lstatSync(b, { throwIfNoEntry: false })) throw fail('Am Ziel existiert bereits etwas.');
    if (b.startsWith(`${a}/`)) throw fail('Ein Ordner lässt sich nicht in sich selbst verschieben.');
    if (!fs.existsSync(path.dirname(b))) throw fail('Das Zielverzeichnis existiert nicht.');
    try { fs.renameSync(a, b); } catch (e) {
      if (e.code !== 'EXDEV') throw fail(`Verschieben fehlgeschlagen: ${e.code}`);
      const r = await run('mv', ['-n', '--', a, b], { timeout: 300_000 });
      if (r.code !== 0) throw fail(`Verschieben fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 200)}`);
    }
    return { from: a, to: b };
  },

  async 'files.copy'({ from, to }) {
    const a = clean(from, 'Quelle'); const b = clean(to, 'Ziel');
    checkRead(a); checkWrite(b);
    if (!fs.lstatSync(a, { throwIfNoEntry: false })) throw fail('Die Quelle existiert nicht.');
    if (fs.lstatSync(b, { throwIfNoEntry: false })) throw fail('Am Ziel existiert bereits etwas.');
    if (b.startsWith(`${a}/`)) throw fail('Ein Ordner lässt sich nicht in sich selbst kopieren.');
    const r = await run('cp', ['-a', '--no-clobber', '--', a, b], { timeout: 300_000 });
    if (r.code !== 0) throw fail(`Kopieren fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { from: a, to: b };
  },

  async 'files.delete'({ path: raw, recursive }) {
    const p = clean(raw);
    checkWrite(p, { tree: true });
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (!st) throw fail('Nicht gefunden.');
    if (st.isDirectory() && !st.isSymbolicLink()) {
      if (recursive) { const r = await run('rm', ['-rf', '--one-file-system', '--', p], { timeout: 300_000 }); if (r.code !== 0) throw fail(`Löschen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 200)}`); return { path: p, recursive: true }; }
      try { fs.rmdirSync(p); } catch (e) { throw fail(e.code === 'ENOTEMPTY' ? 'Der Ordner ist nicht leer.' : `Löschen fehlgeschlagen: ${e.code}`); }
      return { path: p };
    }
    const bk = backup(p);
    fs.unlinkSync(p);
    return { path: p, backup: bk };
  },

  async 'files.chmod'({ path: raw, mode, recursive }) {
    const p = clean(raw);
    checkWrite(p, { tree: true });
    if (typeof mode !== 'string' || !/^[0-7]{3,4}$/.test(mode)) throw fail('Ungültige Rechte (z. B. 644 oder 0755).');
    if (!fs.lstatSync(p, { throwIfNoEntry: false })) throw fail('Nicht gefunden.');
    const r = await run('chmod', [...(recursive ? ['-R'] : []), mode, '--', p], { timeout: 120_000 });
    if (r.code !== 0) throw fail(`chmod fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { path: p, mode };
  },

  async 'files.chown'({ path: raw, owner, group, recursive }) {
    const p = clean(raw);
    checkWrite(p, { tree: true });
    const re = /^[a-z_][a-z0-9_-]{0,31}$|^\d{1,10}$/;
    if (typeof owner !== 'string' || !re.test(owner) || (group && (typeof group !== 'string' || !re.test(group)))) throw fail('Ungültiger Benutzer- oder Gruppenname.');
    if (!fs.lstatSync(p, { throwIfNoEntry: false })) throw fail('Nicht gefunden.');
    const r = await run('chown', [...(recursive ? ['-R'] : []), group ? `${owner}:${group}` : owner, '--', p], { timeout: 120_000 });
    if (r.code !== 0) throw fail(`chown fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { path: p };
  },

  async 'files.du'({ path: raw, files }) {
    const p = clean(raw);
    let real;
    try { real = fs.realpathSync(p); } catch { throw fail('Nicht gefunden.'); }
    const r = await run('du', ['-xb', ...(files ? ['-a'] : []), '--max-depth=1', '--', real], { timeout: 90_000 });
    const list = r.out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('\t'); return { size: +l.slice(0, i), path: l.slice(i + 1) }; }).sort((a, b) => b.size - a.size);
    const total = (list.find((x) => x.path === real) || {}).size || 0;
    const top = list.filter((x) => x.path !== real).slice(0, 100).map((x) => {
      let kind = 'file';
      try { const st = fs.lstatSync(x.path); kind = st.isDirectory() ? 'dir' : st.isSymbolicLink() ? 'link' : 'file'; } catch {}
      return { ...x, kind };
    });
    return { path: real, total, list: top, timedOut: r.killed };
  },

  async 'files.find'({ path: raw, name, minSize, depth }) {
    const p = clean(raw);
    if (typeof name !== 'string' && !minSize) throw fail('Bitte einen Suchbegriff oder eine Mindestgröße angeben.');
    const args = [p, '-xdev', '-maxdepth', String(int(depth || 6, 1, 12, 'Die Tiefe'))];
    if (name) { if (typeof name !== 'string' || name.length > 100 || name.includes('\0')) throw fail('Ungültiger Suchbegriff.'); args.push('-iname', `*${name.replace(/[[\]\\]/g, '\\$&')}*`); }
    if (minSize) args.push('-type', 'f', '-size', `+${int(minSize, 1, 1 << 30, 'Die Größe')}M`);
    args.push('-printf', '%p\t%s\t%T@\t%y\n');
    const r = await run('find', args, { timeout: 60_000, max: 8 << 20 });
    const list = r.out.split('\n').filter(Boolean).slice(0, 500).map((l) => { const q = l.split('\t'); return { path: q[0], size: +q[1], mtime: Math.floor(+q[2] * 1000), kind: q[3] === 'd' ? 'dir' : q[3] === 'l' ? 'link' : 'file' }; });
    return { list, truncated: r.out.split('\n').length > 500, timedOut: r.killed };
  },

  async 'files.versions'({ path: raw }) {
    const p = clean(raw);
    let out = [];
    try {
      const suffix = `__${p.replace(/\//g, '%2F')}`;
      out = fs.readdirSync(BACKUPS).filter((f) => f.endsWith(suffix)).map((f) => { const st = fs.statSync(path.join(BACKUPS, f)); return { id: f, t: +f.split('__')[0], size: st.size }; }).sort((a, b) => b.t - a.t).slice(0, 30);
    } catch {}
    return { path: p, versions: out };
  },

  async 'files.version-read'({ id }) {
    if (typeof id !== 'string' || !/^\d{13}__[^/\\]+$/.test(id) || id.endsWith('.meta')) throw fail('Ungültige Version.');
    const buf = fs.readFileSync(path.join(BACKUPS, id));
    return { text: isBinary(buf) ? '' : buf.toString('utf8').slice(0, MAX_READ), binary: isBinary(buf) };
  },

  async 'files.restore'({ id }) {
    if (typeof id !== 'string' || !/^\d{13}__[^/\\]+$/.test(id) || id.endsWith('.meta')) throw fail('Ungültige Version.');
    const target = decodeURIComponent(id.slice(id.indexOf('__') + 2));
    checkWrite(target);
    const src = path.join(BACKUPS, id);
    if (!fs.existsSync(src)) throw fail('Diese Version gibt es nicht mehr.');
    backup(target);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(`${src}.meta`, 'utf8')); } catch {}
    const tmp = `${target}.sd-tmp`;
    fs.copyFileSync(src, tmp);
    if (meta) restoreMeta(tmp, meta);
    fs.renameSync(tmp, target);
    const bad = await validateAfter(target);
    return { path: target, warning: bad || null };
  },

  /** copy a file to the dashboard's outbox so the unprivileged web process can stream it */
  async 'files.stage-out'({ path: raw }) {
    const p = clean(raw);
    checkRead(p);
    let st;
    try { st = fs.statSync(p); } catch { throw fail('Die Datei existiert nicht.'); }
    if (!st.isFile()) throw fail('Nur normale Dateien lassen sich herunterladen.');
    if (st.size > MAX_STAGE) throw fail('Die Datei ist größer als 256 MB.');
    if (st.size <= 4 * 1024 * 1024) {
      const head = fs.readFileSync(p);
      if (PRIVATE_KEY_RE.test(head.toString('latin1'))) throw fail('Diese Datei enthält einen privaten Schlüssel und lässt sich nicht herunterladen.');
    }
    fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o750 });
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const dest = path.join(OUTBOX, id);
    fs.copyFileSync(p, dest);
    const gid = fs.statSync(STATE).gid; const uid = fs.statSync(STATE).uid;
    fs.chownSync(dest, uid, gid); fs.chmodSync(dest, 0o640);
    return { id, name: path.basename(p), size: st.size };
  },

  /** move an uploaded file (written by the dashboard) to its final place */
  async 'files.install'({ tmp, dest, overwrite }) {
    if (typeof tmp !== 'string' || !/^[0-9]{13}-[a-z0-9]{8}$/.test(tmp)) throw fail('Ungültiger Upload.');
    const src = path.join(UPLOADS, tmp);
    const d = clean(dest, 'Ziel');
    checkWrite(d);
    const st = fs.lstatSync(src, { throwIfNoEntry: false });
    if (!st || !st.isFile()) throw fail('Der Upload existiert nicht mehr.');
    const exists = fs.lstatSync(d, { throwIfNoEntry: false });
    if (exists && !overwrite) throw fail('Am Ziel existiert bereits eine Datei mit diesem Namen.');
    if (exists && !exists.isFile()) throw fail('Am Ziel existiert bereits ein Ordner oder Link.');
    const dir = path.dirname(d);
    if (!fs.existsSync(dir)) throw fail('Das Zielverzeichnis existiert nicht.');
    if (exists) backup(d);
    const ds = fs.statSync(dir);
    const tmpDest = path.join(dir, `.sd-tmp-${process.pid}-${Date.now()}`);
    fs.copyFileSync(src, tmpDest);
    fs.chownSync(tmpDest, exists ? exists.uid : ds.uid, exists ? exists.gid : ds.gid);
    fs.chmodSync(tmpDest, exists ? exists.mode & 0o7777 : 0o644);
    fs.renameSync(tmpDest, d);
    fs.unlinkSync(src);
    return { path: d, size: st.size };
  },
};

module.exports = { ops, UPLOADS, OUTBOX };
