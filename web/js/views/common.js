import { h } from '../dom.js';
import { num, B, R, ago, tShort, isNum } from '../fmt.js';

/** value formatters; second arg `axis` = short form for axis labels */
export const f = {
  pct: (v, axis) => `${num(v, axis ? (Number.isInteger(v) || v >= 10 ? 0 : 1) : 1)} %`,
  pct2: (v) => `${num(v, 2)} %`,
  bytes: (v) => B(v),
  rate: (v) => R(v),
  int: (v) => num(Math.round(v)),
  d1: (v) => num(v, 1),
  d2: (v) => num(v, 2),
  ps: (v, axis) => `${num(v, v < 10 && !axis ? 1 : 0)}/s`,
  ps2: (v, axis) => `${num(v, v < 10 ? (axis ? 1 : 2) : 0)}/s`,
  ms: (v, axis) => `${num(v, v < 10 && !axis ? 1 : 0)} ms`,
  ms2: (v) => `${num(v, 2)} ms`,
  pages: (v) => `${num(v, v < 10 ? 1 : 0)} Seiten/s`,
};

export const CPU_SERIES = [
  { key: 'cu', label: 'Benutzer', color: 'c1' },
  { key: 'cs', label: 'System', color: 'c3' },
  { key: 'ci', label: 'Interrupts', color: 'c5' },
  { key: 'cw', label: 'I/O-Wait', color: 'c4' },
  { key: 'ct', label: 'Steal', color: 'c8' },
];

export const MEM_SERIES = [
  { key: 'mu', label: 'Belegt', color: 'c1' },
  { key: 'mb', label: 'Puffer', color: 'c9' },
  { key: 'mc', label: 'Cache', color: 'c2' },
  { key: 'mf', label: 'Frei', color: 'c6' },
];

export const cpuDonut = (s) => s ? [
  { id: 'cu', label: 'Benutzer', value: s.cu, color: 'c1' },
  { id: 'cs', label: 'System', value: s.cs, color: 'c3' },
  { id: 'ci', label: 'Interrupts', value: s.ci, color: 'c5' },
  { id: 'cw', label: 'I/O-Wait', value: s.cw, color: 'c4' },
  { id: 'ct', label: 'Steal', value: s.ct, color: 'c8' },
  { id: 'idle', label: 'Leerlauf', value: Math.max(0, 100 - s.cu - s.cs - s.ci - s.cw - s.ct), color: 'line' },
] : [];

export const memDonut = (s) => s ? [
  { id: 'mu', label: 'Belegt (Programme)', value: s.mu, color: 'c1' },
  { id: 'mb', label: 'Puffer', value: s.mb, color: 'c9' },
  { id: 'mc', label: 'Cache', value: s.mc, color: 'c2' },
  { id: 'mf', label: 'Frei', value: s.mf, color: 'line' },
] : [];

export const KIND = { action: 'Aktion', cpu: 'CPU', memory: 'Speicher', network: 'Netzwerk', disk: 'Festplatte', service: 'Dienst', docker: 'Container', site: 'Website', cert: 'Zertifikat', system: 'System', auth: 'Konto', alert: 'Warnung' };

export function eventRow(e, { fresh = false } = {}) {
  return h('div', { class: `ev lv-${e.level}${fresh ? ' new' : ''}` },
    h('span', { class: 'ev-i' }),
    h('div', null, h('div', { class: 'ev-t' }, e.title, h('span', { class: 'tag' }, KIND[e.kind] || e.kind)), e.detail ? h('div', { class: 'ev-d' }, e.detail) : null),
    h('div', { class: 'ev-when' }, h('b', null, ago(e.t)), tShort(e.t)));
}

/** two delta chips (vs 1 h / 24 h ago) for a field */
export function deltas(store, key, fmt, deltaChip, good = 'down', zero = 0) {
  return [deltaChip('1 Std', store.delta(key, 3_600_000), fmt, { good, zero }), deltaChip('24 Std', store.delta(key, 86_400_000, 300_000), fmt, { good, zero })];
}

export const levelOf = (v, warn, crit) => (v >= crit ? 'crit' : v >= warn ? 'warn' : 'ok');
export const ratio = (a, b) => (b ? (a / b) * 100 : 0);
export { isNum };
