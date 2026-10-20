'use strict';
// Single-owner authentication.
//  - exactly one allowed e-mail address
//  - first run: owner must present a one-time setup code (written to the state dir, readable
//    only by root/the service user) AND choose a password; nobody can claim the account
//    just by knowing the address
//  - scrypt password hashing, constant-work login (dummy hash for unknown input), generic errors
//  - random 256-bit session tokens, only their SHA-256 is stored; HttpOnly + Secure + SameSite=Strict cookie
//  - sliding idle timeout + absolute lifetime; password change/reset revokes sessions
//  - per-IP failure lockout with escalation, global flood slow-down, bounded concurrent hashing

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const ALLOWED_EMAIL = (process.env.ALLOWED_EMAIL || 'benjaminburger3456@gmail.com').trim().toLowerCase();
const COOKIE = '__Host-sd';
const IDLE_MS = 12 * 3600_000;
const ELEVATE_MS = 5 * 60_000; // how long a password confirmation unlocks server actions
const LIFE_MS = 7 * 24 * 3600_000;
const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, maxmem: 128 * 1024 * 1024 };

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const b64 = (b) => Buffer.from(b).toString('base64');
const safeEq = (a, b) => {
  const x = sha256(String(a));
  const y = sha256(String(b));
  return crypto.timingSafeEqual(x, y);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- two-factor codes (RFC 6238: HMAC-SHA1, 30 s steps, 6 digits)
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf) {
  let bits = ''; let out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
function unbase32(s) {
  let bits = '';
  for (const c of s) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function hotp(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String(((h[o] & 0x7f) << 24 | h[o + 1] << 16 | h[o + 2] << 8 | h[o + 3]) % 1_000_000).padStart(6, '0');
}

// ------------------------------------------------------------------ bounded hashing
let busy = 0;
const waiting = [];
async function hashSlot(fn) {
  if (busy >= 2) await new Promise((r) => waiting.push(r));
  busy++;
  try { return await fn(); } finally { busy--; const n = waiting.shift(); if (n) n(); }
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await hashSlot(() => scrypt(pw.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }));
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${b64(salt)}$${b64(key)}`;
}

async function verifyPassword(pw, stored) {
  const p = String(stored || '').split('$');
  if (p.length !== 6 || p[0] !== 'scrypt') return false;
  const [N, r, pp] = [+p[1], +p[2], +p[3]];
  if (!(N <= 1 << 17 && r <= 16 && pp <= 4)) return false;
  const salt = Buffer.from(p[4], 'base64');
  const want = Buffer.from(p[5], 'base64');
  const key = await hashSlot(() => scrypt(pw.normalize('NFKC'), salt, want.length, { N, r, p: pp, maxmem: SCRYPT.maxmem }));
  return key.length === want.length && crypto.timingSafeEqual(key, want);
}

let dummyHash = null;

// ------------------------------------------------------------------ password policy
const COMMON = new Set(['password', 'passwort', 'passwort123', 'password123', '123456789012', 'qwertzuiopü', 'qwertyuiop12', 'iloveyou1234', 'administrator', 'willkommen123', 'letmein12345', 'changeme1234', 'welcome12345', 'abcdefghijkl', 'abc123abc123', '1q2w3e4r5t6y', 'benjamin1234', 'benjaminberger', 'benjaminburger']);

function policyError(pw, email) {
  if (typeof pw !== 'string') return 'Ungültiges Passwort.';
  if (pw.length < 12) return 'Das Passwort muss mindestens 12 Zeichen lang sein.';
  if (pw.length > 128) return 'Das Passwort darf höchstens 128 Zeichen lang sein.';
  const low = pw.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(pw) || /^(.{1,6})\1+$/.test(pw)) return 'Dieses Passwort ist zu einfach.';
  if (/(password|passwort|qwert|asdfg|123456|654321|letmein|welcome|willkommen|admin|iloveyou|changeme)/.test(low)) return 'Das Passwort enthält ein sehr häufiges Muster.';
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) return 'Das Passwort darf nicht deine E-Mail-Adresse enthalten.';
  if (new Set(pw).size < 6) return 'Das Passwort braucht mehr unterschiedliche Zeichen.';
  const seq = 'abcdefghijklmnopqrstuvwxyz0123456789';
  if (seq.includes(low) || seq.split('').reverse().join('').includes(low)) return 'Das Passwort ist eine einfache Zeichenfolge.';
  const classes = [/[a-zäöüß]/, /[A-ZÄÖÜ]/, /\d/, /[^A-Za-zäöüÄÖÜß\d]/].filter((r) => r.test(pw)).length;
  if (classes < 3 && pw.length < 16) return 'Nutze mindestens drei Zeichenarten (Klein-, Großbuchstaben, Zahlen, Sonderzeichen) oder 16+ Zeichen.';
  return null;
}

// ------------------------------------------------------------------ rate limiting
class Limiter {
  constructor() { this.m = new Map(); this.globalFails = []; }
  _e(ip) {
    let e = this.m.get(ip);
    if (!e) { e = { fails: [], lockedUntil: 0, locks: 0 }; this.m.set(ip, e); }
    return e;
  }
  check(ip) {
    const e = this._e(ip);
    const now = Date.now();
    if (e.lockedUntil > now) return { ok: false, retry: Math.ceil((e.lockedUntil - now) / 1000) };
    return { ok: true };
  }
  fail(ip) {
    const e = this._e(ip);
    const now = Date.now();
    e.fails = e.fails.filter((t) => now - t < 15 * 60_000);
    e.fails.push(now);
    this.globalFails = this.globalFails.filter((t) => now - t < 15 * 60_000);
    this.globalFails.push(now);
    if (e.fails.length >= 6) {
      e.locks++;
      e.lockedUntil = now + Math.min(2 * 3600_000, 5 * 60_000 * 2 ** (e.locks - 1));
      e.fails = [];
      return { locked: true, retry: Math.ceil((e.lockedUntil - now) / 1000) };
    }
    return { locked: false, left: 6 - e.fails.length };
  }
  success(ip) { const e = this.m.get(ip); if (e) { e.fails = []; } }
  flood() { const now = Date.now(); this.globalFails = this.globalFails.filter((t) => now - t < 15 * 60_000); return this.globalFails.length >= 40; }
  sweep() { const now = Date.now(); for (const [k, e] of this.m) if (e.lockedUntil < now && e.fails.every((t) => now - t > 15 * 60_000)) this.m.delete(k); }
}

// ------------------------------------------------------------------ auth service
function create({ store, events, stateDir }) {
  const FILE = 'auth.json';
  const CODE_FILE = path.join(stateDir, 'setup-code.txt');
  const limiter = new Limiter();
  let st = store.load(FILE, null) || { v: 1, hash: null, setup: null, sessions: {}, changedAt: null };
  const listeners = [];
  const elevated = new Map(); // session id -> unlocked until (ms); memory only, gone after a restart

  const save = () => store.save(FILE, st);

  function newSetupCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(16);
    let code = '';
    for (let i = 0; i < 16; i++) code += alphabet[bytes[i] % alphabet.length];
    const pretty = code.match(/.{4}/g).join('-');
    st.setup = { hash: b64(sha256(code)), fails: 0, created: Date.now() };
    save();
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(CODE_FILE, `Xeon-1 Console: Einrichtungscode (einmalig)\n\n${pretty}\n\nErstellt: ${new Date().toISOString()}\nGültig, bis das Passwort gesetzt wurde.\n`, { mode: 0o600 });
    } catch (e) { console.error('could not write setup code file:', e.message); }
    console.log(`[auth] Setup-Code erzeugt: ${CODE_FILE}`);
  }

  function ensureSetup() {
    if (!st.hash && !st.setup) newSetupCode();
    if (st.hash && fs.existsSync(CODE_FILE)) { try { fs.unlinkSync(CODE_FILE); } catch {} }
  }

  function revokeAll() { st.sessions = {}; }

  /** CLI: forget the password, kill all sessions, emit a fresh setup code */
  function reset() { st.hash = null; st.changedAt = null; revokeAll(); newSetupCode(); }

  function cookieString(token, maxAge = LIFE_MS / 1000) {
    return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAge)}`;
  }
  const clearCookie = () => `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;

  function parseCookie(header) {
    const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([A-Za-z0-9_-]{20,80})`).exec(header || '');
    return m ? m[1] : null;
  }

  function createSession(ip, ua) {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = b64(sha256(token));
    const now = Date.now();
    st.sessions[id] = { created: now, last: now, ip: String(ip).slice(0, 64), ua: String(ua || '').slice(0, 200) };
    save();
    return { token, id };
  }

  /** returns { id, session } for a valid cookie, else null */
  function verify(req) {
    const token = parseCookie(req.headers.cookie);
    if (!token) return null;
    const id = b64(sha256(token));
    const s = st.sessions[id];
    if (!s) return null;
    const now = Date.now();
    if (now - s.last > IDLE_MS || now - s.created > LIFE_MS) { delete st.sessions[id]; save(); return null; }
    if (now - s.last > 60_000) { s.last = now; save(); }
    return { id, session: s };
  }

  function revoke(id) { delete st.sessions[id]; elevated.delete(id); save(); for (const fn of listeners) fn([id]); }
  function revokeOthers(keepId) {
    const gone = Object.keys(st.sessions).filter((k) => k !== keepId);
    for (const k of gone) { delete st.sessions[k]; elevated.delete(k); }
    save();
    for (const fn of listeners) fn(gone);
  }
  const onRevoke = (fn) => listeners.push(fn);

  function sessionsList(currentId) {
    return Object.entries(st.sessions).map(([id, s]) => ({ id: id.slice(0, 10), current: id === currentId, created: s.created, last: s.last, ip: s.ip, ua: s.ua }))
      .sort((a, b) => b.last - a.last);
  }

  function sweep() {
    const now = Date.now();
    let changed = false;
    const gone = [];
    for (const [k, s] of Object.entries(st.sessions)) if (now - s.last > IDLE_MS || now - s.created > LIFE_MS) { delete st.sessions[k]; gone.push(k); changed = true; }
    if (changed) { save(); for (const fn of listeners) fn(gone); }
    limiter.sweep();
  }
  setInterval(sweep, 10 * 60_000).unref();

  const status = () => ({ setup: !st.hash });

  async function floodDelay() { if (limiter.flood()) await sleep(2500); }

  function normEmail(e) { return typeof e === 'string' ? e.trim().toLowerCase().slice(0, 254) : ''; }

  async function ensureDummy() { if (!dummyHash) dummyHash = await hashPassword('dummy-password-for-constant-work'); return dummyHash; }

  // ---- two-factor: secret + recovery codes live in auth.json next to the password hash
  const totpOn = () => !!(st.totp && st.totp.enabled);
  const recoveryHash = (c) => b64(sha256(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')));
  function checkCode(raw) {
    const c = String(raw || '').trim();
    if (!totpOn() || !c) return false;
    if (/^\d{6}$/.test(c) || /^\d{3}\s\d{3}$/.test(c)) {
      const code = c.replace(/\s/g, '');
      const now = Math.floor(Date.now() / 30_000);
      for (const d of [0, -1, 1]) {
        const step = now + d;
        if (step <= (st.totp.last || 0)) continue; // a code works once
        if (safeEq(hotp(st.totp.secret, step), code)) { st.totp.last = step; save(); return true; }
      }
      return false;
    }
    const h = recoveryHash(c);
    const i = (st.totp.recovery || []).findIndex((x) => safeEq(x, h));
    if (i < 0) return false;
    st.totp.recovery.splice(i, 1);
    save();
    events.add({ level: 'warn', kind: 'auth', title: 'Wiederherstellungscode benutzt', detail: `${st.totp.recovery.length} übrig` });
    return true;
  }

  async function login({ email, password, code }, { ip, ua }) {
    const lim = limiter.check(ip);
    if (!lim.ok) return { status: 429, error: 'Zu viele Versuche. Bitte später erneut versuchen.', retry: lim.retry };
    await floodDelay();
    if (!st.hash) return { status: 409, error: 'setup_required' };
    const e = normEmail(email);
    const pw = typeof password === 'string' ? password.slice(0, 256) : '';
    const emailOk = safeEq(e, ALLOWED_EMAIL);
    const ok = await verifyPassword(pw, emailOk ? st.hash : await ensureDummy());
    if (emailOk && ok && totpOn()) {
      if (typeof code !== 'string' || !code.trim()) return { status: 401, error: 'totp_required' };
      if (!checkCode(code)) {
        const f = limiter.fail(ip);
        events.add({ level: 'warn', kind: 'auth', title: 'Falscher Zwei-Faktor-Code bei der Anmeldung', detail: ip, key: `totp-${ip}`, cooldown: 300_000 });
        return { status: 401, error: 'Der Code stimmt nicht oder wurde schon benutzt.', retry: f.locked ? f.retry : undefined };
      }
    }
    if (emailOk && ok) {
      limiter.success(ip);
      const s = createSession(ip, ua);
      events.add({ level: 'info', kind: 'auth', title: 'Anmeldung', detail: `von ${ip}` });
      return { status: 200, token: s.token };
    }
    const f = limiter.fail(ip);
    if (f.locked) events.add({ level: 'warn', kind: 'auth', title: 'Anmeldung gesperrt nach Fehlversuchen', detail: `${ip}, gesperrt für ${Math.round(f.retry / 60)} Min`, key: `lock-${ip}`, cooldown: 600_000 });
    return { status: 401, error: 'E-Mail oder Passwort falsch.', retry: f.locked ? f.retry : undefined };
  }

  async function setup({ email, code, password }, { ip, ua }) {
    const lim = limiter.check(ip);
    if (!lim.ok) return { status: 429, error: 'Zu viele Versuche. Bitte später erneut versuchen.', retry: lim.retry };
    await floodDelay();
    if (st.hash || !st.setup) return { status: 409, error: 'Die Einrichtung ist bereits abgeschlossen.' };
    const e = normEmail(email);
    const c = typeof code === 'string' ? code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32) : '';
    const emailOk = safeEq(e, ALLOWED_EMAIL);
    const codeOk = crypto.timingSafeEqual(sha256(c), Buffer.from(st.setup.hash, 'base64'));
    if (!(emailOk && codeOk)) {
      const f = limiter.fail(ip);
      st.setup.fails++;
      if (st.setup.fails >= 8) { events.add({ level: 'warn', kind: 'auth', title: 'Einrichtungscode nach Fehlversuchen erneuert', detail: ip }); newSetupCode(); } else save();
      return { status: 401, error: 'E-Mail oder Einrichtungscode falsch.', retry: f.locked ? f.retry : undefined };
    }
    const pe = policyError(password, e);
    if (pe) return { status: 422, error: pe };
    st.hash = await hashPassword(password);
    st.setup = null;
    st.changedAt = Date.now();
    revokeAll();
    try { fs.unlinkSync(CODE_FILE); } catch {}
    limiter.success(ip);
    const s = createSession(ip, ua);
    save();
    events.add({ level: 'info', kind: 'auth', title: 'Passwort eingerichtet', detail: `Erste Anmeldung von ${ip}` });
    return { status: 200, token: s.token };
  }

  /** password confirmation that unlocks server actions for a few minutes */
  async function elevate(id, password, ip, code) {
    const key = `el:${ip}`;
    const lim = limiter.check(key);
    if (!lim.ok) return { status: 429, error: 'Zu viele Versuche. Bitte später erneut versuchen.', retry: lim.retry };
    const pw = typeof password === 'string' ? password.slice(0, 256) : '';
    if (!st.hash || !(await verifyPassword(pw, st.hash))) {
      const f = limiter.fail(key);
      if (f.locked) events.add({ level: 'warn', kind: 'auth', title: 'Entsperren nach Fehlversuchen gesperrt', detail: ip, key: `elock-${ip}`, cooldown: 600_000 });
      return { status: 403, error: 'Das Passwort ist falsch.', retry: f.locked ? f.retry : undefined };
    }
    if (totpOn() && !checkCode(code)) {
      const f = limiter.fail(key);
      return { status: 403, error: code ? 'Der Code stimmt nicht oder wurde schon benutzt.' : 'Bitte auch den Code aus der Authenticator-App eingeben.', code: 'totp', retry: f.locked ? f.retry : undefined };
    }
    limiter.success(key);
    const until = Date.now() + ELEVATE_MS;
    elevated.set(id, until);
    return { status: 200, until };
  }
  function elevatedUntil(id) {
    const u = elevated.get(id);
    if (!u || u < Date.now()) { elevated.delete(id); return 0; }
    return u;
  }
  const dropElevation = (id) => elevated.delete(id);

  async function changePassword({ current, next }, { ip, id }) {
    const lim = limiter.check(`pw:${ip}`);
    if (!lim.ok) return { status: 429, error: 'Zu viele Versuche.', retry: lim.retry };
    if (!(await verifyPassword(typeof current === 'string' ? current.slice(0, 256) : '', st.hash))) {
      limiter.fail(`pw:${ip}`);
      return { status: 403, error: 'Das aktuelle Passwort ist falsch.' }; // not 401: the session itself is fine
    }
    const pe = policyError(next, ALLOWED_EMAIL);
    if (pe) return { status: 422, error: pe };
    if (current === next) return { status: 422, error: 'Das neue Passwort muss sich vom alten unterscheiden.' };
    st.hash = await hashPassword(next);
    st.changedAt = Date.now();
    save();
    revokeOthers(id);
    events.add({ level: 'info', kind: 'auth', title: 'Passwort geändert', detail: `von ${ip}, andere Sitzungen beendet` });
    return { status: 200 };
  }

  // ---- two-factor management (the caller has checked that the session is unlocked)
  const totpStatus = () => ({ enabled: totpOn(), recoveryLeft: totpOn() ? (st.totp.recovery || []).length : 0, pending: !!(st.totp && st.totp.pending) });
  function totpBegin() {
    if (totpOn()) return { status: 409, error: 'Die Zwei-Faktor-Anmeldung ist schon eingeschaltet.' };
    const secret = base32(crypto.randomBytes(20));
    st.totp = { ...(st.totp || {}), enabled: false, pending: secret };
    save();
    const label = encodeURIComponent(`Xeon-1 Konsole:${ALLOWED_EMAIL}`);
    return { status: 200, secret, uri: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent('Xeon-1 Konsole')}&algorithm=SHA1&digits=6&period=30` };
  }
  function totpEnable(code) {
    if (totpOn()) return { status: 409, error: 'Schon eingeschaltet.' };
    const pending = st.totp && st.totp.pending;
    if (!pending) return { status: 409, error: 'Bitte zuerst die Einrichtung starten.' };
    const c = String(code || '').replace(/\s/g, '');
    const now = Math.floor(Date.now() / 30_000);
    const step = [0, -1, 1].map((d) => now + d).find((t) => /^\d{6}$/.test(c) && safeEq(hotp(pending, t), c));
    if (step == null) return { status: 422, error: 'Der Code stimmt nicht. Prüfe die Uhrzeit deines Handys und versuche es mit dem nächsten Code.' };
    const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    const codes = Array.from({ length: 8 }, () => { const b = crypto.randomBytes(10); const t = Array.from(b, (x) => alphabet[x % alphabet.length]).join(''); return `${t.slice(0, 5)}-${t.slice(5)}`; });
    st.totp = { enabled: true, secret: pending, last: step, recovery: codes.map(recoveryHash) };
    save();
    events.add({ level: 'info', kind: 'auth', title: 'Zwei-Faktor-Anmeldung eingeschaltet', detail: '' });
    return { status: 200, recovery: codes };
  }
  function totpDisable(code) {
    if (!totpOn()) return { status: 409, error: 'Die Zwei-Faktor-Anmeldung ist nicht eingeschaltet.' };
    if (!checkCode(code)) return { status: 403, error: 'Der Code stimmt nicht oder wurde schon benutzt.' };
    st.totp = null;
    save();
    events.add({ level: 'warn', kind: 'auth', title: 'Zwei-Faktor-Anmeldung ausgeschaltet', detail: '' });
    return { status: 200 };
  }

  ensureSetup();

  return {
    totpStatus, totpBegin, totpEnable, totpDisable,
    email: ALLOWED_EMAIL, COOKIE, status, login, setup, changePassword, elevate, elevatedUntil, dropElevation, verify, revoke, revokeOthers, onRevoke,
    sessionsList, cookieString, clearCookie, reset, ensureSetup, policyError, codeFile: CODE_FILE,
    hasPassword: () => !!st.hash, changedAt: () => st.changedAt,
  };
}

module.exports = { create, policyError, ALLOWED_EMAIL, hashPassword, verifyPassword };
