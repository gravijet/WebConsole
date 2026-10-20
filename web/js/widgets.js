// UI building blocks shared by all views.

import { h, icon, clear, setText } from './dom.js';
import { TimeChart, Donut, spark } from './charts.js';
import { num, isNum } from './fmt.js';

const SPANS = { 2: 's-2', 3: 's-3', 4: 's-4', 5: 's-5', 6: 's-6', 7: 's-7', 8: 's-8', 9: 's-9', 12: 's-12' };
const spanClass = (n) => SPANS[n] || 's-12';

export const grid = (...kids) => h('div', { class: 'grid' }, ...kids);
export const heading = (text, sub) => h('div', { class: 'sec-h s-12' }, h('h2', null, text), sub ? h('p', null, sub) : null);

export function card({ title, sub, span = 12, actions, cls = '' } = {}, ...body) {
  return h('section', { class: `card ${spanClass(span)} ${cls}` },
    title || actions ? h('header', { class: 'card-h' }, h('div', null, title ? h('h3', null, title) : null, sub ? h('p', null, sub) : null), actions ? h('div', { class: 'card-a' }, actions) : null) : null,
    ...body);
}

export function badge(text, level = 'neutral') {
  return h('span', { class: `badge b-${level}` }, text);
}

/** Dot + text status */
export function status(text, level = 'neutral') {
  return h('span', { class: `st st-${level}` }, h('i'), text);
}

// ------------------------------------------------------------------ KPI

/** change chip: d = store.delta(...) result; fmt formats the absolute difference */
export function deltaChip(label, d, fmt, { good = 'down', zero = 0 } = {}) {
  if (!d || !isNum(d.diff)) return { label, text: '–', tone: 'neutral', dir: '' };
  const dir = Math.abs(d.diff) <= zero ? '' : d.diff > 0 ? 'up' : 'down';
  const tone = !dir ? 'neutral' : (dir === good ? 'good' : good === 'none' ? 'neutral' : 'bad');
  return { label, text: `${d.diff > 0 ? '+' : d.diff < 0 ? '−' : '±'}${fmt(Math.abs(d.diff))}`, tone, dir };
}

export function kpi({ label, color = 'c1', span = 3, icon: ic } = {}) {
  const value = h('span', { class: 'kpi-v' }, '–');
  const unit = h('span', { class: 'kpi-u' });
  const sub = h('div', { class: 'kpi-s' });
  const deltas = h('div', { class: 'kpi-d' });
  const sp = h('div', { class: 'kpi-spark' });
  const dot = h('i', { class: 'kpi-dot' }, ic ? icon(ic, 16) : null);
  const el = h('section', { class: `card kpi ${spanClass(span)}` }, h('div', { class: 'kpi-l' }, dot, label), h('div', { class: 'kpi-val' }, value, unit), sub, deltas, sp);
  const sk = spark(sp, { color });
  el.style.setProperty('--kc', `var(--${color})`);
  return {
    el,
    set({ value: v, unit: u = '', sub: s = '', deltas: ds = [], spark: sv, level = '', color: c } = {}) {
      setText(value, v);
      setText(unit, u);
      if (typeof s === 'string') setText(sub, s); else sub.replaceChildren(s);
      el.dataset.level = level;
      deltas.hidden = !ds.length;
      el.classList.toggle('no-spark', !sv || !sv.length);
      deltas.replaceChildren(...ds.map((d) => h('span', { class: `dchip ${d.tone}${d.dir ? ` ${d.dir}` : ''}` }, h('em', null, d.label), `${d.dir === 'up' ? '▲ ' : d.dir === 'down' ? '▼ ' : ''}${d.text}`)));
      if (c) el.style.setProperty('--kc', `var(--${c})`);
      if (sv) sk.set(sv, c);
    },
  };
}

// ------------------------------------------------------------------ chart cards

export function chartCard({ title, sub, span = 6, stats = true, statsOpen = false, legend = true, extra, ...chartOpts }) {
  const legendBox = legend ? h('div', { class: 'chips' }) : null;
  const host = h('div', { class: 'chart-host' });
  const tableBox = stats ? h('div', { class: 'stats-box' }) : null;
  const el = card({ title, sub, span, actions: extra },
    legendBox, host,
    stats ? h('details', { class: 'stats', open: statsOpen ? '' : null }, h('summary', null, 'Statistik für den gewählten Zeitraum'), tableBox) : null);
  const chart = new TimeChart(host, { ...chartOpts, legend: legendBox, table: tableBox, label: title });
  return { el, chart };
}

export function donutCard({ title, sub, span = 4, ...opts }) {
  const host = h('div', { class: 'donut-host' });
  const el = card({ title, sub, span }, host);
  const donut = new Donut(host, { ...opts, label: title });
  return { el, donut };
}

// ------------------------------------------------------------------ table

/**
 * columns: [{ key, label, align, fmt(value,row) -> string|Node, sort(row) -> comparable, title, cls }]
 * returns { el, setRows(rows) }
 */
export function dataTable({ columns, search = false, searchPlaceholder = 'Suchen …', pageSize = 100, sort: initial, empty = 'Keine Einträge.', rowClass, dense = false, filters, onRow, tools } = {}) {
  const state = { rows: [], key: initial ? initial.key : null, dir: initial ? initial.dir : 'desc', q: '', limit: pageSize, filter: null };
  const thead = h('tr');
  const tbody = h('tbody');
  const more = h('button', { type: 'button', class: 'btn ghost more' });
  const info = h('span', { class: 'tbl-info' });
  const input = search ? h('input', { type: 'search', class: 'tbl-search', placeholder: searchPlaceholder, 'aria-label': searchPlaceholder, onInput: (e) => { state.q = e.target.value.toLowerCase(); state.limit = pageSize; render(); } }) : null;
  const filterBox = filters ? h('div', { class: 'seg' }) : null;
  if (filters) {
    state.filter = filters[0];
    for (const f of filters) {
      const b = h('button', { type: 'button', 'aria-pressed': f === state.filter ? 'true' : 'false', onClick: () => { state.filter = f; for (const x of filterBox.children) x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); state.limit = pageSize; render(); } }, f.label);
      filterBox.append(b);
    }
  }
  const bar = search || filters || tools ? h('div', { class: 'tbl-bar' }, input, filterBox, h('span', { class: 'grow' }), info, tools) : null;
  const cells = columns.map((c) => {
    const th = h('th', { class: `${c.align === 'r' ? 'r' : ''} ${c.sortable === false ? '' : 'sortable'} ${c.cls || ''}`, title: c.title || null, scope: 'col', tabindex: c.sortable === false ? null : 0 }, c.label, h('i', { class: 'si' }));
    if (c.sortable !== false) {
      const act = () => { if (state.key === c.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc'; else { state.key = c.key; state.dir = c.align === 'r' ? 'desc' : 'asc'; } render(); };
      th.addEventListener('click', act);
      th.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); } });
    }
    thead.append(th);
    return th;
  });
  const table = h('table', { class: `tbl${dense ? ' dense' : ''}` }, h('thead', null, thead), tbody);
  more.addEventListener('click', () => { state.limit += pageSize * 2; render(); });
  const wrap = h('div', { class: 'tbl-wrap' }, table);
  const el = h('div', { class: 'tbl-box' }, bar, wrap, h('div', { class: 'tbl-foot' }, more));

  const textOf = (row) => columns.map((c) => { const v = c.fmt ? c.fmt(row[c.key], row) : row[c.key]; return v && v.nodeType ? v.textContent : String(v ?? ''); }).join(' ').toLowerCase();

  function render() {
    let rows = state.rows;
    if (state.filter && state.filter.fn) rows = rows.filter(state.filter.fn);
    if (state.q) rows = rows.filter((r) => (r._txt ??= textOf(r)).includes(state.q));
    const col = columns.find((c) => c.key === state.key);
    if (col) {
      const get = col.sort || ((r) => r[col.key]);
      const m = state.dir === 'asc' ? 1 : -1;
      rows = rows.slice().sort((a, b) => {
        const x = get(a); const y = get(b);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'string' ? x.localeCompare(y, 'de') : x - y) * m;
      });
    }
    cells.forEach((th, i) => { th.dataset.dir = columns[i].key === state.key ? state.dir : ''; th.setAttribute('aria-sort', columns[i].key === state.key ? (state.dir === 'asc' ? 'ascending' : 'descending') : 'none'); });
    const shown = rows.slice(0, state.limit);
    tbody.replaceChildren(...shown.map((r) => {
      const tr = h('tr', { class: rowClass ? rowClass(r) : '' }, ...columns.map((c) => {
        const v = c.fmt ? c.fmt(r[c.key], r) : r[c.key];
        return h('td', { class: `${c.align === 'r' ? 'r' : ''} ${c.cls || ''}` }, v == null || v === '' ? '–' : v);
      }));
      if (onRow) { tr.classList.add('click'); tr.addEventListener('click', () => onRow(r, tr)); }
      return tr;
    }));
    if (!shown.length) tbody.replaceChildren(h('tr', null, h('td', { colspan: columns.length, class: 'empty' }, empty)));
    const left = rows.length - shown.length;
    more.style.display = left > 0 ? '' : 'none';
    setText(more, `${num(left)} weitere anzeigen`);
    if (info) setText(info, `${num(rows.length)} von ${num(state.rows.length)}`);
  }

  return { el, setRows(rows) { state.rows = rows; render(); }, render, get count() { return state.rows.length; } };
}

// ------------------------------------------------------------------ small form widgets

export function toggle({ checked = false, label, onChange, id } = {}) {
  const input = h('input', { type: 'checkbox', id: id || null, class: 'sw-in' });
  input.checked = checked;
  input.addEventListener('change', () => onChange && onChange(input.checked));
  return { el: h('label', { class: 'switch' }, input, h('i'), label ? h('span', null, label) : null), input };
}

export function segmented(options, value, onChange) {
  const box = h('div', { class: 'seg', role: 'group' });
  const btns = options.map(([v, label]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value), onClick: () => { set(v); onChange(v); } }, label);
    box.append(b);
    return [v, b];
  });
  const set = (val) => btns.forEach(([v, b]) => b.setAttribute('aria-pressed', String(v === val)));
  return { el: box, set };
}

export function kv(rows, cls = '') {
  return h('dl', { class: `kv ${cls}` }, ...rows.filter(Boolean).flatMap(([k, v, title]) => [h('dt', { title: title || null }, k), h('dd', null, v == null || v === '' ? '–' : v)]));
}

let toastBox;
export function toast(msg, level = 'ok') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(toastBox); }
  const t = h('div', { class: `toast t-${level}` }, msg);
  toastBox.append(t);
  setTimeout(() => t.classList.add('out'), 3800);
  setTimeout(() => t.remove(), 4300);
}

/** percentage bar inside a table cell etc. */
export function meter(value, max, { tone, text } = {}) {
  const p = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  const t = tone || (p >= 90 ? 'crit' : p >= 75 ? 'warn' : 'ok');
  const fill = h('i', { class: `m-${t}` });
  fill.style.width = `${p}%`;
  return h('span', { class: 'meter' }, h('span', { class: 'meter-bar' }, fill), text != null ? h('span', { class: 'meter-t' }, text) : null);
}

// ------------------------------------------------------------------ tabs, empty state, tiles, banners

/** items: [{ id, label, badge }]; onChange(id) */
export function tabs(items, value, onChange) {
  const box = h('div', { class: 'tabs', role: 'tablist' });
  const btns = new Map();
  for (const it of items) {
    const badgeEl = h('span', { class: 'badge', hidden: '' });
    const b = h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': String(it.id === value), onClick: () => { set(it.id); onChange(it.id); } }, it.icon ? icon(it.icon, 16) : null, it.label, badgeEl);
    btns.set(it.id, { b, badgeEl });
    box.append(b);
  }
  const set = (id) => { for (const [k, { b }] of btns) b.setAttribute('aria-selected', String(k === id)); };
  const setBadge = (id, text, level = 'neutral') => { const x = btns.get(id); if (!x) return; x.badgeEl.hidden = text == null || text === ''; x.badgeEl.textContent = text == null ? '' : String(text); x.badgeEl.className = `badge b-${level}`; };
  return { el: box, set, setBadge };
}

export const emptyState = (title, text, ic = 'info') => h('div', { class: 'empty' }, icon(ic, 28), h('b', null, title), text ? h('div', null, text) : null);

/** [{ label, value, sub, tone }] -> tile grid */
export function tiles(list) {
  return h('dl', { class: 'tiles' }, ...list.filter(Boolean).map((t) => h('div', { class: `tile ${t.tone || ''}` }, h('dt', null, t.label), h('dd', { class: 'tl-v' }, t.value), t.sub ? h('small', null, t.sub) : null)));
}

/** level: ok | warn | crit | info */
export function banner(level, title, text, ...extra) {
  const ic = { ok: 'check', warn: 'warn', crit: 'warn', info: 'info' }[level] || 'info';
  return h('div', { class: `banner ${level}` }, icon(ic, 20), h('div', { class: 'grow' }, h('b', null, title), text ? h('small', null, text) : null, ...extra));
}
