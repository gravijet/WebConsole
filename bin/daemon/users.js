'use strict';
// Accounts, groups, login sessions and SSH authorized keys.

const fs = require('fs');
const path = require('path');
const { run, fail, USER_RE } = require('./core');

const NEVER = new Set(['root', 'serverdash', 'nobody']);
const KEY_RE = /^((?:[A-Za-z0-9-]+(?:="[^"\n]*")?,?)+\s+)?(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;
const BACKUPS = '/var/backups/server-dash';

const readPasswd = () => fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter((l) => l && !l.startsWith('#')).map((l) => {
  const p = l.split(':');
  return { name: p[0], uid: +p[2], gid: +p[3], gecos: p[4], home: p[5], shell: p[6] };
});
const readGroups = () => fs.readFileSync('/etc/group', 'utf8').split('\n').filter(Boolean).map((l) => { const p = l.split(':'); return { name: p[0], gid: +p[2], members: (p[3] || '').split(',').filter(Boolean) }; });
function readShadow() {
  const m = new Map();
  try { for (const l of fs.readFileSync('/etc/shadow', 'utf8').split('\n')) { const p = l.split(':'); if (p[0]) m.set(p[0], { hash: p[1], lastChange: p[2] === '' ? null : +p[2], min: p[3], max: p[4], warn: p[5], inactive: p[6], expire: p[7] === '' ? null : +p[7] }); } } catch {}
  return m;
}

async function sessions() {
  const r = await run('loginctl', ['list-sessions', '--output=json', '--no-pager'], { timeout: 10_000 });
  let list = [];
  try { list = JSON.parse(r.out); } catch {}
  const out = [];
  for (const s of list) {
    const d = await run('loginctl', ['show-session', String(s.session), '-p', 'Name,Remote,RemoteHost,Service,Type,State,Timestamp,TTY,Leader,Scope,Class', '--no-pager'], { timeout: 8000 });
    const kv = Object.fromEntries(d.out.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
    out.push({ id: String(s.session), user: s.user, uid: s.uid, tty: kv.TTY || s.tty || '', remote: kv.Remote === 'yes', host: kv.RemoteHost || '', service: kv.Service || '', type: kv.Type || '', state: kv.State || '', since: kv.Timestamp || '', leader: +kv.Leader || null, cls: kv.Class || '' });
  }
  return out;
}

async function mustUser(name, { allowSystem = false } = {}) {
  if (typeof name !== 'string' || !USER_RE.test(name)) throw fail('Ungültiger Benutzername.');
  const u = readPasswd().find((x) => x.name === name);
  if (!u) throw fail('Dieser Benutzer existiert nicht.');
  if (!allowSystem && (u.uid === 0 || NEVER.has(name))) throw fail(`Das Konto „${name}“ ist geschützt (Administrator oder Dashboard-Konto).`);
  if (!allowSystem && u.uid < 1000) throw fail('Systemkonten werden hier nicht verändert.');
  return u;
}

async function activeSessions(name) { return (await sessions()).filter((s) => s.user === name); }

function keyFile(u) { return path.join(u.home, '.ssh', 'authorized_keys'); }

const ops = {
  async 'users.list'() {
    const passwd = readPasswd(); const groups = readGroups(); const shadow = readShadow();
    const sess = await sessions();
    const sudoMembers = new Set((groups.find((g) => g.name === 'sudo') || { members: [] }).members);
    const users = passwd.map((u) => {
      const sh = shadow.get(u.name);
      const h = sh ? sh.hash : null;
      let keys = 0;
      try { keys = fs.readFileSync(keyFile(u), 'utf8').split('\n').filter((l) => KEY_RE.test(l.trim())).length; } catch {}
      let hasHome = false;
      try { hasHome = fs.statSync(u.home).isDirectory(); } catch {}
      return {
        ...u, locked: !!h && h.startsWith('!'), passwordSet: !!h && h.replace(/^!+/, '').length > 1, noLogin: /nologin|false$/.test(u.shell || ''),
        lastChange: sh && sh.lastChange != null ? sh.lastChange * 86400_000 : null, expire: sh && sh.expire != null ? sh.expire * 86400_000 : null,
        groups: groups.filter((g) => g.gid === u.gid || g.members.includes(u.name)).map((g) => g.name), sudo: sudoMembers.has(u.name) || u.uid === 0, keys, hasHome,
        online: sess.filter((s) => s.user === u.name).length,
      };
    });
    const shells = fs.readFileSync('/etc/shells', 'utf8').split('\n').filter((l) => l.startsWith('/'));
    return { users, groups, sessions: sess, shells };
  },

  async 'users.add'({ name, shell, comment, sudo }) {
    if (typeof name !== 'string' || !USER_RE.test(name)) throw fail('Ungültiger Benutzername (Kleinbuchstaben, Ziffern, _ und -).');
    if (readPasswd().some((u) => u.name === name)) throw fail('Dieser Benutzer existiert bereits.');
    const shells = fs.readFileSync('/etc/shells', 'utf8').split('\n');
    const sh = shell || '/bin/bash';
    if (!shells.includes(sh) && sh !== '/usr/sbin/nologin') throw fail('Diese Shell ist nicht erlaubt.');
    const args = ['-m', '-s', sh];
    if (comment) { if (typeof comment !== 'string' || comment.length > 60 || /[:\n\\]/.test(comment)) throw fail('Ungültiger Kommentar.'); args.push('-c', comment); }
    const r = await run('useradd', [...args, '--', name], { timeout: 30_000 });
    if (r.code !== 0) throw fail(`useradd: ${(r.err || r.out).trim().slice(0, 300)}`);
    await run('usermod', ['-L', '--', name], { timeout: 10_000 });
    if (sudo) await run('usermod', ['-aG', 'sudo', '--', name], { timeout: 10_000 });
    return { name, note: 'Das Konto ist angelegt und gesperrt, bis ein SSH-Schlüssel hinterlegt oder ein Passwort gesetzt wird.' };
  },

  async 'users.lock'({ name, lock, force }) {
    const u = await mustUser(name);
    if (lock && !force && (await activeSessions(u.name)).length) throw fail('Dieser Benutzer ist gerade angemeldet. Sperren beendet die laufende Sitzung nicht; zum Trennen zuerst die Sitzung beenden.');
    const r = await run('usermod', [lock ? '-L' : '-U', '--', name], { timeout: 15_000 });
    if (r.code !== 0) throw fail(`usermod: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { name, locked: !!lock };
  },

  async 'users.sudo'({ name, on }) {
    await mustUser(name);
    const r = on ? await run('usermod', ['-aG', 'sudo', '--', name], { timeout: 15_000 }) : await run('gpasswd', ['-d', name, 'sudo'], { timeout: 15_000 });
    if (r.code !== 0 && on) throw fail(`usermod: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { name, sudo: !!on };
  },

  async 'users.delete'({ name, removeHome }) {
    const u = await mustUser(name);
    if ((await activeSessions(u.name)).length) throw fail('Dieser Benutzer ist gerade angemeldet.');
    const r = await run('userdel', [...(removeHome ? ['-r'] : []), '--', name], { timeout: 60_000 });
    if (r.code !== 0) throw fail(`userdel: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { name, removedHome: !!removeHome };
  },

  async 'users.session-kill'({ id }) {
    if (typeof id !== 'string' || !/^[A-Za-z0-9]{1,16}$/.test(id)) throw fail('Ungültige Sitzung.');
    if (!(await sessions()).some((s) => s.id === id)) throw fail('Diese Sitzung existiert nicht mehr.');
    const r = await run('loginctl', ['terminate-session', id], { timeout: 15_000 });
    if (r.code !== 0) throw fail(`loginctl: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { id };
  },

  async 'users.keys-get'({ name }) {
    const u = await mustUser(name, { allowSystem: true });
    let text = '';
    try { text = fs.readFileSync(keyFile(u), 'utf8'); } catch {}
    const keys = [];
    for (const [i, l] of text.split('\n').entries()) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      let fp = '';
      if (KEY_RE.test(t)) { const r = await run('ssh-keygen', ['-lf', '/dev/stdin'], { input: `${t}\n`, timeout: 8000 }); fp = r.out.trim(); }
      keys.push({ line: i + 1, text: t.length > 160 ? `${t.slice(0, 60)} … ${t.slice(-50)}` : t, valid: KEY_RE.test(t), fingerprint: fp });
    }
    return { name, path: keyFile(u), text, keys };
  },

  async 'users.keys-set'({ name, text }) {
    const u = await mustUser(name, { allowSystem: true });
    if (typeof text !== 'string' || text.length > 200_000) throw fail('Ungültiger Inhalt.');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    for (const l of lines) if (!l.startsWith('#') && !KEY_RE.test(l)) throw fail(`Diese Zeile ist kein gültiger öffentlicher SSH-Schlüssel:\n${l.slice(0, 80)}`);
    if (u.uid === 0 && !lines.some((l) => !l.startsWith('#'))) throw fail('Für ein Administratorkonto darf die Schlüsselliste nicht komplett leer sein (Aussperr-Schutz).');
    const dir = path.dirname(keyFile(u)); const file = keyFile(u);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 }); fs.copyFileSync(file, path.join(BACKUPS, `${Date.now()}__authorized_keys__${u.name}`)); } catch {}
    const tmp = `${file}.sd-tmp`;
    fs.writeFileSync(tmp, `${lines.join('\n')}\n`, { mode: 0o600 });
    fs.chownSync(tmp, u.uid, u.gid);
    try { fs.chownSync(dir, u.uid, u.gid); } catch {}
    fs.renameSync(tmp, file);
    return { name, count: lines.filter((l) => !l.startsWith('#')).length };
  },
};

module.exports = { ops };
