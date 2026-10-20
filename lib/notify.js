'use strict';
// Push notifications: every notable event can be forwarded to ntfy, Telegram, Discord, Slack or a
// generic webhook. Channels, tokens and delivery results live in the state directory; tokens are
// never sent back to the browser.

const crypto = require('crypto');
const os = require('os');

const TYPES = ['ntfy', 'telegram', 'discord', 'slack', 'webhook'];
const FILE = 'notify.json';
const MAX_CHANNELS = 12;
const PER_HOUR = 30;

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

function cleanUrl(v, label, { requireHttps = true } = {}) {
  let u;
  try { u = new URL(str(v, 500)); } catch { throw new Error(`${label}: Das ist keine gültige Adresse.`); }
  if (!(u.protocol === 'https:' || (!requireHttps && u.protocol === 'http:'))) throw new Error(`${label}: Die Adresse muss mit https:// beginnen.`);
  if (/^(169\.254\.|fe80:)/i.test(u.hostname)) throw new Error(`${label}: Diese Adresse ist nicht erlaubt.`);
  if (u.username || u.password) throw new Error(`${label}: Zugangsdaten gehören nicht in die Adresse.`);
  return u.href;
}

function sanitizeChannel(c, old) {
  if (!c || typeof c !== 'object' || !TYPES.includes(c.type)) throw new Error('Unbekannte Kanalart.');
  const out = {
    id: old ? old.id : crypto.randomBytes(5).toString('hex'),
    type: c.type, name: str(c.name, 40) || c.type, enabled: c.enabled !== false,
    minLevel: ['info', 'warn', 'crit'].includes(c.minLevel) ? c.minLevel : 'warn',
    recovery: c.recovery !== false,
    quiet: { on: !!(c.quiet && c.quiet.on), from: /^\d{2}:\d{2}$/.test(c.quiet && c.quiet.from) ? c.quiet.from : '22:00', to: /^\d{2}:\d{2}$/.test(c.quiet && c.quiet.to) ? c.quiet.to : '07:00' },
    url: '', topic: '', chat: '', secret: '',
  };
  const keep = (v, prev) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 300) : prev || '');
  if (c.type === 'ntfy') {
    out.url = cleanUrl(c.url || 'https://ntfy.sh', 'Server', { requireHttps: false });
    out.topic = str(c.topic, 100);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(out.topic)) throw new Error('Thema: Nur Buchstaben, Ziffern, - und _ sind erlaubt.');
    out.secret = keep(c.secret, old && old.secret);
  } else if (c.type === 'telegram') {
    out.secret = keep(c.secret, old && old.secret);
    out.chat = str(c.chat, 40);
    if (!/^[A-Za-z0-9:_-]{20,80}$/.test(out.secret)) throw new Error('Bot-Token: Das Format stimmt nicht (123456:ABC…).');
    if (!/^-?\d{1,20}$|^@[A-Za-z0-9_]{3,40}$/.test(out.chat)) throw new Error('Chat-ID: Bitte die Zahl angeben, die dein Bot kennt.');
  } else {
    out.url = cleanUrl(c.url, 'Adresse', { requireHttps: c.type !== 'webhook' });
  }
  return out;
}

class Notifier {
  constructor(store, events) {
    this.store = store;
    this.events = events;
    const d = store.load(FILE, { channels: [], log: [] });
    this.channels = Array.isArray(d.channels) ? d.channels : [];
    this.log = Array.isArray(d.log) ? d.log.slice(0, 60) : [];
    this.sent = new Map(); // channel id -> timestamps
    this.lastTitle = new Map(); // channel id + title -> time
    events.on((e) => { this.dispatch(e).catch(() => {}); });
  }

  save() { this.store.save(FILE, { channels: this.channels, log: this.log }); }

  /** what the browser may see */
  view() {
    return {
      channels: this.channels.map((c) => ({ ...c, secret: undefined, secretSet: !!c.secret })),
      log: this.log,
      types: TYPES,
    };
  }

  replaceAll(list) {
    if (!Array.isArray(list) || list.length > MAX_CHANNELS) throw new Error(`Höchstens ${MAX_CHANNELS} Kanäle.`);
    const byId = new Map(this.channels.map((c) => [c.id, c]));
    const next = list.map((c) => { const old = c && c.id ? byId.get(c.id) : null; return sanitizeChannel(c, old); });
    this.channels = next;
    this.save();
  }

  passes(c, e) {
    if (!c.enabled) return false;
    if (e.kind === 'action' && !/^Fehlgeschlagen/.test(e.title)) return false; // your own clicks are not news
    if (e.level === 'ok') return c.recovery && e.kind !== 'action';
    if (e.level === 'crit') return true;
    if (e.level === 'warn') return c.minLevel !== 'crit';
    return c.minLevel === 'info';
  }

  quietNow(c) {
    if (!c.quiet.on) return false;
    const d = new Date();
    const m = d.getHours() * 60 + d.getMinutes();
    const [fh, fm] = c.quiet.from.split(':').map(Number); const [th, tm] = c.quiet.to.split(':').map(Number);
    const a = fh * 60 + fm; const b = th * 60 + tm;
    return a <= b ? m >= a && m < b : m >= a || m < b;
  }

  async dispatch(e) {
    for (const c of this.channels) {
      if (!this.passes(c, e)) continue;
      if (e.level !== 'crit' && this.quietNow(c)) continue;
      const now = Date.now();
      const key = `${c.id}|${e.title}`;
      if (now - (this.lastTitle.get(key) || 0) < 300_000) continue;
      const recent = (this.sent.get(c.id) || []).filter((t) => now - t < 3_600_000);
      if (recent.length >= PER_HOUR) continue;
      recent.push(now); this.sent.set(c.id, recent); this.lastTitle.set(key, now);
      await this.send(c, e);
    }
    if (this.lastTitle.size > 500) for (const [k, t] of this.lastTitle) if (Date.now() - t > 600_000) this.lastTitle.delete(k);
  }

  async send(c, e, { test = false } = {}) {
    const host = os.hostname();
    const icon = { crit: '🔴', warn: '🟠', ok: '🟢', info: 'ℹ️' }[e.level] || '';
    const title = `${icon} ${host}: ${e.title}`;
    const text = e.detail ? `${title}\n${e.detail}` : title;
    let res;
    try {
      const sig = AbortSignal.timeout(10_000);
      const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: sig, redirect: 'error' });
      if (c.type === 'ntfy') {
        res = await post(c.url.replace(/\/$/, '/'), { topic: c.topic, title: `${host}: ${e.title}`, message: e.detail || e.title, priority: e.level === 'crit' ? 5 : e.level === 'warn' ? 4 : 3, tags: [e.level === 'ok' ? 'white_check_mark' : e.level === 'crit' ? 'rotating_light' : e.level === 'warn' ? 'warning' : 'information_source'] }, c.secret ? { Authorization: `Bearer ${c.secret}` } : {});
      } else if (c.type === 'telegram') {
        res = await post(`https://api.telegram.org/bot${c.secret}/sendMessage`, { chat_id: c.chat, text: text.slice(0, 3900) });
      } else if (c.type === 'discord') {
        res = await post(c.url, { content: text.slice(0, 1900), username: 'Xeon-1 Konsole' });
      } else if (c.type === 'slack') {
        res = await post(c.url, { text: text.slice(0, 3000) });
      } else {
        res = await post(c.url, { title: e.title, detail: e.detail || '', level: e.level, kind: e.kind, host, time: new Date(e.t || Date.now()).toISOString(), test });
      }
      const ok = res.ok;
      this.record(c, e, ok, ok ? '' : `HTTP ${res.status}`, test);
      return { ok, error: ok ? '' : `Der Dienst antwortete mit HTTP ${res.status}.` };
    } catch (err) {
      const msg = err && err.name === 'TimeoutError' ? 'Zeitüberschreitung' : String((err && err.cause && err.cause.code) || (err && err.message) || err).slice(0, 120);
      this.record(c, e, false, msg, test);
      return { ok: false, error: `Senden fehlgeschlagen: ${msg}` };
    }
  }

  record(c, e, ok, error, test) {
    this.log.unshift({ t: Date.now(), channel: c.name, type: c.type, title: e.title, ok, error, test: !!test });
    if (this.log.length > 60) this.log.length = 60;
    this.save();
  }

  async test(id) {
    const c = this.channels.find((x) => x.id === id);
    if (!c) throw new Error('Diesen Kanal gibt es nicht.');
    return this.send(c, { level: 'info', kind: 'system', title: 'Testnachricht', detail: 'Wenn du das liest, funktioniert dieser Kanal.', t: Date.now() }, { test: true });
  }
}

module.exports = { Notifier, TYPES };
