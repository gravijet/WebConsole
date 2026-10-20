// Number / time formatting (de-AT, Europe/Vienna). Pure functions, no state.

const nfs = {};
export const num = (v, d = 0) => (nfs[d] ||= new Intl.NumberFormat('de-AT', { minimumFractionDigits: d, maximumFractionDigits: d })).format(v);
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** binary units, auto-scaled: { n:'5,7', u:'GB', text:'5,7 GB' } */
export function bytes(v, minUnit = 0) {
  v = Math.max(0, v || 0);
  let i = 0;
  while ((v >= 1024 || i < minUnit) && i < UNITS.length - 1) { v /= 1024; i++; }
  const d = i === 0 ? 0 : v < 10 ? 2 : v < 100 ? 1 : 0;
  const n = num(v, d);
  return { n, u: UNITS[i], text: `${n} ${UNITS[i]}` };
}
export const B = (v) => bytes(v).text;
export const rate = (v) => { const b = bytes(v); return { n: b.n, u: `${b.u}/s`, text: `${b.n} ${b.u}/s` }; };
export const R = (v) => rate(v).text;
/** network style bits per second */
export const bits = (v) => {
  let x = Math.max(0, (v || 0) * 8);
  const u = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'];
  let i = 0;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return `${num(x, x < 10 ? 2 : x < 100 ? 1 : 0)} ${u[i]}`;
};
export const pct = (v, d = 1) => `${num(v, d)} %`;
export const count = (v) => num(Math.round(v));
export const ms = (v) => (v == null ? '–' : `${num(v, v < 10 ? 1 : 0)} ms`);
export const perSec = (v, d = 1) => `${num(v, v < 10 ? d : 0)}/s`;

/** 90061 -> "1 T 1 Std 1 Min" */
export function dur(sec, parts = 2) {
  if (sec == null) return '–';
  sec = Math.max(0, Math.floor(sec));
  const u = [['T', 86400], ['Std', 3600], ['Min', 60], ['Sek', 1]];
  const out = [];
  for (const [l, s] of u) {
    const n = Math.floor(sec / s);
    if (n > 0 || out.length) { out.push(`${n} ${l}`); sec -= n * s; }
    if (out.length === parts) break;
  }
  return out.length ? out.join(' ') : '0 Sek';
}
/** seconds -> "12d 04:05:06" style clock */
export function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400);
  const p = (n) => String(n).padStart(2, '0');
  return `${d > 0 ? `${d} T ` : ''}${p(Math.floor((sec % 86400) / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(sec % 60)}`;
}

const TZ = 'Europe/Vienna';
const f = (o) => new Intl.DateTimeFormat('de-AT', { timeZone: TZ, hourCycle: 'h23', ...o });
const fHMS = f({ hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fHM = f({ hour: '2-digit', minute: '2-digit' });
const fShort = f({ day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fFull = f({ day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const fDay = f({ day: '2-digit', month: '2-digit', year: 'numeric' });
const fParts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
export const tHMS = (t) => fHMS.format(t);
export const tHM = (t) => fHM.format(t);
export const tShort = (t) => fShort.format(t);
export const tFull = (t) => fFull.format(t);
export const tDay = (t) => fDay.format(t);

let offAt = 0;
let off = 0;
/** ms that Vienna is ahead of UTC (cached) */
export function tzOffset(t) {
  if (Math.abs(t - offAt) > 60_000) {
    offAt = t;
    const p = Object.fromEntries(fParts.formatToParts(t).map((x) => [x.type, +x.value]));
    off = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
  }
  return off;
}

export function ago(t, now = Date.now()) {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return 'gerade eben';
  if (s < 60) return `vor ${s} Sek`;
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std ${Math.floor((s % 3600) / 60)} Min`;
  return `vor ${Math.floor(s / 86400)} T ${Math.floor((s % 86400) / 3600)} Std`;
}

export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** statistics over numeric values */
export function stats(values) {
  const v = values.filter(isNum);
  if (!v.length) return null;
  const s = v.slice().sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
  return { n: v.length, min: s[0], max: s[s.length - 1], avg: sum / v.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), last: v[v.length - 1] };
}

/** linear regression slope (units per ms) of [t, v] pairs */
export function slope(points) {
  const n = points.length;
  if (n < 3) return null;
  let sx = 0; let sy = 0; let sxx = 0; let sxy = 0;
  const t0 = points[0][0];
  for (const [t, v] of points) { const x = t - t0; sx += x; sy += v; sxx += x * x; sxy += x * v; }
  const den = n * sxx - sx * sx;
  return den === 0 ? null : (n * sxy - sx * sy) / den;
}

/** "in 5 Min" / "vor 5 Min" for a timestamp in ms */
export function rel(t, now = Date.now()) {
  if (t == null) return '–';
  const d = Math.round((t - now) / 1000);
  if (Math.abs(d) < 5) return 'jetzt';
  return d > 0 ? `in ${dur(d, 2)}` : ago(t, now);
}

/** "0644" -> "rw-r--r--" */
export function rwx(mode) {
  const m = parseInt(mode, 8);
  if (!Number.isFinite(m)) return '';
  const bit = (n, r, w, x) => `${n & r ? 'r' : '-'}${n & w ? 'w' : '-'}${n & x ? 'x' : '-'}`;
  let s = bit(m >> 6, 4, 2, 1) + bit(m >> 3, 4, 2, 1) + bit(m, 4, 2, 1);
  if (m & 0o4000) s = `${s.slice(0, 2)}${s[2] === 'x' ? 's' : 'S'}${s.slice(3)}`;
  if (m & 0o2000) s = `${s.slice(0, 5)}${s[5] === 'x' ? 's' : 'S'}${s.slice(6)}`;
  if (m & 0o1000) s = `${s.slice(0, 8)}${s[8] === 'x' ? 't' : 'T'}`;
  return s;
}

const DOW = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const MON = ['', 'Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const p2 = (n) => String(n).padStart(2, '0');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** plain-German description of a cron expression ("5 4 * * 1" -> "Montags um 04:05") */
export function cronText(expr) {
  const e = String(expr || '').trim();
  const macros = { '@reboot': 'Beim Start des Servers', '@hourly': 'Jede Stunde', '@daily': 'Täglich um 00:00', '@midnight': 'Täglich um 00:00', '@weekly': 'Sonntags um 00:00', '@monthly': 'Am 1. jedes Monats um 00:00', '@yearly': 'Am 1. Januar um 00:00', '@annually': 'Am 1. Januar um 00:00' };
  if (macros[e]) return macros[e];
  const f = e.split(/\s+/);
  if (f.length !== 5) return e;
  const [mi, ho, dom, mon, dow] = f;
  const num1 = (x) => /^\d+$/.test(x);
  const step = (x) => { const m = /^\*\/(\d+)$/.exec(x); return m ? +m[1] : null; };
  const dayPart = () => {
    const parts = [];
    if (dow !== '*') {
      if (/^[1-5]-[1-5]$/.test(dow) && dow === '1-5') parts.push('Montag bis Freitag');
      else if (dow === '0,6' || dow === '6,0') parts.push('am Wochenende');
      else parts.push(dow.split(',').map((d) => (/^\d$/.test(d) ? `${DOW[+d]}s` : d)).join(', '));
    }
    if (dom !== '*') parts.push(`am ${dom.split(',').map((d) => (num1(d) ? `${d}.` : d)).join(', ')} des Monats`);
    if (mon !== '*') parts.push(`im ${mon.split(',').map((m) => (num1(m) ? MON[+m] || m : m)).join(', ')}`);
    return parts.length ? parts.join(', ') : 'Täglich';
  };
  if (step(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*') return `Alle ${step(mi)} Minuten`;
  if (mi === '*' && ho === '*' && dom === '*' && mon === '*' && dow === '*') return 'Jede Minute';
  if (num1(mi) && ho === '*' && dom === '*' && mon === '*' && dow === '*') return `Jede Stunde um :${p2(mi)}`;
  if (num1(mi) && step(ho) && dom === '*' && mon === '*' && dow === '*') return `Alle ${step(ho)} Stunden um :${p2(mi)}`;
  if (num1(mi) && num1(ho)) return `${cap(dayPart())} um ${p2(ho)}:${p2(mi)}`;
  if (num1(mi) && /^[\d,]+$/.test(ho)) return `${cap(dayPart())} um ${ho.split(',').map((x) => `${p2(x)}:${p2(mi)}`).join(' und ')}`;
  return e;
}
