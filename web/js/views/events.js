import { h, setText } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, segmented, badge } from '../widgets.js';
import { num, ago, tFull, dur } from '../fmt.js';
import { f, eventRow, KIND } from './common.js';

const LEVELS = [['all', 'Alle'], ['crit', 'Kritisch'], ['warn', 'Warnung'], ['info', 'Info'], ['ok', 'Behoben']];
const HOUR = 3_600_000;

export default {
  id: 'events', title: 'Ereignisse', group: 'Übersicht', icon: 'events', range: false, desc: 'Warnungen und alles, was sich am Server geändert hat', keywords: 'warnungen alarme verlauf log',
  mount(root, ctx) {
    const { store } = ctx;
    let level = 'all';
    let kind = '';
    let q = '';
    let limit = 120;

    // events per hour, stacked by level
    const source = () => {
      const now = Date.now();
      const first = Math.floor((now - 24 * HOUR) / HOUR) * HOUR;
      const pts = [];
      for (let t = first; t <= now; t += HOUR) pts.push({ t: t + HOUR / 2, crit: 0, warn: 0, info: 0, ok: 0 });
      for (const e of store.events) { const i = Math.floor((e.t - first) / HOUR); if (i >= 0 && i < pts.length) pts[i][e.level] = (pts[i][e.level] || 0) + 1; }
      return { pts, step: HOUR };
    };
    const hist = chartCard({ title: 'Ereignisse pro Stunde', sub: 'Letzte 24 Stunden, nach Schwere', span: 8, mode: 'stacked', series: [{ key: 'crit', label: 'Kritisch', color: 'crit', fmt: f.int }, { key: 'warn', label: 'Warnung', color: 'warn', fmt: f.int }, { key: 'info', label: 'Info', color: 'c1', fmt: f.int }, { key: 'ok', label: 'Behoben', color: 'ok', fmt: f.int }], fmt: f.int, floor: 4, grid: 4, window: 24 * HOUR, source, height: 220, stats: false });
    ctx.own(hist.chart);
    const dKind = donutCard({ title: 'Ereignisse nach Bereich', span: 4, fmt: f.int, size: 150 });
    const alertsBox = h('div');
    const listBox = h('div', { class: 'tl' });
    const moreBtn = h('button', { type: 'button', class: 'btn ghost', onClick: () => { limit += 200; render(); } });
    const counts = h('span', { class: 'tbl-info' });
    const seg = segmented(LEVELS, level, (v) => { level = v; limit = 120; render(); });
    const kindSel = h('select', { class: 'input', 'aria-label': 'Bereich', onChange: (e) => { kind = e.target.value; limit = 120; render(); }, style: { width: 'auto' } }, h('option', { value: '' }, 'Alle Bereiche'));
    const search = h('input', { type: 'search', class: 'tbl-search', placeholder: 'Ereignisse durchsuchen …', 'aria-label': 'Ereignisse durchsuchen', onInput: (e) => { q = e.target.value.toLowerCase(); limit = 120; render(); } });

    root.append(grid(
      card({ title: 'Aktive Warnungen', sub: 'Bedingungen, die gerade erfüllt sind. Grenzwerte änderst du unter „Einstellungen“.', span: 12 }, alertsBox),
      hist.el, dKind.el,
      heading('Alle Ereignisse', 'Neueste zuerst. Neue Ereignisse erscheinen live.'),
      card({ span: 12 }, h('div', { class: 'tbl-bar' }, search, seg.el, kindSel, h('span', { class: 'grow' }), counts), listBox, h('div', { class: 'tbl-foot' }, moreBtn))));

    let keysDone = '';
    function renderAlerts() {
      const al = store.detail ? store.detail.alerts : [];
      alertsBox.replaceChildren(...(al.length
        ? al.map((a) => h('div', { class: `ev lv-${a.level}` }, h('span', { class: 'ev-i' }), h('div', null, h('div', { class: 'ev-t' }, a.title), a.detail ? h('div', { class: 'ev-d' }, a.detail) : null), h('div', { class: 'ev-when' }, h('b', null, `seit ${dur((Date.now() - a.since) / 1000, 2)}`), tFull(a.since))))
        : [h('div', { class: 'banner ok' }, h('div', null, h('b', null, 'Keine aktiven Warnungen'), h('small', null, 'Alle überwachten Werte liegen im grünen Bereich.')))]));
    }

    function render(fresh = false) {
      const kinds = [...new Set(store.events.map((e) => e.kind))].sort();
      const ks = kinds.join(',');
      if (ks !== keysDone) { keysDone = ks; kindSel.replaceChildren(h('option', { value: '' }, 'Alle Bereiche'), ...kinds.map((k) => h('option', { value: k }, KIND[k] || k))); kindSel.value = kind; }
      const rows = store.events.filter((e) => (level === 'all' || e.level === level) && (!kind || e.kind === kind) && (!q || `${e.title} ${e.detail} ${KIND[e.kind] || e.kind}`.toLowerCase().includes(q)));
      const shown = rows.slice(0, limit);
      listBox.replaceChildren(...(shown.length ? shown.map((e, i) => eventRow(e, { fresh: fresh && i === 0 })) : [h('p', { class: 'muted', style: { padding: '18px 4px' } }, 'Keine passenden Ereignisse.')]));
      setText(counts, `${num(rows.length)} von ${num(store.events.length)}`);
      moreBtn.style.display = rows.length > shown.length ? '' : 'none';
      setText(moreBtn, `${num(rows.length - shown.length)} weitere anzeigen`);
      const byKind = {};
      for (const e of store.events) byKind[e.kind] = (byKind[e.kind] || 0) + 1;
      dKind.donut.update(Object.entries(byKind).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ id: k, label: KIND[k] || k, value: v, color: `c${(i % 10) + 1}` })), { value: num(store.events.length), label: 'Ereignisse' });
    }

    ctx.on('event', () => { render(true); });
    ctx.on('detail', renderAlerts);
    ctx.every(() => { render(); }, 20_000);
    renderAlerts(); render();
  },
};
