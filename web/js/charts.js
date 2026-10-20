// Chart toolkit (no dependencies): TimeChart (line / area / stacked, legend, stats table,
// shared crosshair, event markers), Donut (SVG), Heatmap, Spark, BarList.

import { store, RANGES } from './store.js';
import { h, s as svg, clear, setText } from './dom.js';
import { tHM, tHMS, tzOffset, isNum, stats, num, clamp, ago } from './fmt.js';

// ------------------------------------------------------------------ theme

let T = {};
export function refreshTheme() {
  const cs = getComputedStyle(document.documentElement);
  const g = (n) => cs.getPropertyValue(n).trim();
  T = {
    text: g('--text'), text2: g('--text-2'), muted: g('--muted'), line: g('--line'), line2: g('--line-2'), panel: g('--panel'),
    ok: g('--ok'), warn: g('--warn'), crit: g('--crit'), info: g('--info'), accent: g('--accent'),
    pal: Array.from({ length: 10 }, (_, i) => g(`--c${i + 1}`)),
  };
}
refreshTheme();

/** 'c1'..'c10' palette slots, theme tokens ('ok', 'warn', ...) or any CSS color */
export const color = (c) => (/^c\d+$/.test(c) ? T.pal[(+c.slice(1) - 1) % 10] : T[c] || c);

function rgba(c, a) {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (!m) return c;
  let x = m[1];
  if (x.length === 3) x = x.split('').map((ch) => ch + ch).join('');
  const n = parseInt(x, 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// ------------------------------------------------------------------ helpers

function niceMax(m, base = 10, grid = 4) {
  if (!(m > 0)) return 1;
  if (base === 1024) {
    const p = Math.max(0, Math.floor(Math.log(m) / Math.log(1024)));
    const unit = 1024 ** p;
    const n = m / unit;
    const pick = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024].find((x) => n <= x) || 1024;
    return pick * unit;
  }
  const raw = m / grid;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return ([1, 2, 2.5, 5, 10].find((x) => n <= x * 1.0001) || 10) * pow * grid;
}

function lowerBound(a, t) {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

const STEPS = [30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3, 10800e3, 21600e3];
export function timeTicks(t0, t1, target) {
  const span = t1 - t0;
  const step = STEPS.find((x) => span / x <= target + 1) || STEPS[STEPS.length - 1];
  const off = tzOffset(t1);
  const out = [];
  for (let t = Math.ceil((t0 + off) / step) * step - off; t <= t1; t += step) out.push(t);
  return out;
}

function sizeCanvas(cv, host) {
  const r = host.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width));
  const hh = Math.max(1, Math.round(r.height));
  cv.style.width = `${w}px`;
  cv.style.height = `${hh}px`;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(hh * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h: hh };
}

const FONT = '11.5px "Inter", system-ui, -apple-system, "Segoe UI", sans-serif';

// ------------------------------------------------------------------ TimeChart

const instances = new Set();
let hoverT = null;
let hoverSrc = null;

export function drawAll() { for (const c of instances) if (c.vis) c.draw(); }
store.on('sample', drawAll);
store.on('range', drawAll);
store.on('pause', drawAll);
store.on('detail', drawAll);
store.on('theme', () => { refreshTheme(); drawAll(); });
// canvas text needs the web fonts: redraw once they are in
if (document.fonts) { document.fonts.load('11.5px "Inter"').then(() => drawAll()).catch(() => {}); document.fonts.ready.then(() => drawAll()); }

export class TimeChart {
  /**
   * o.series: [{ key | val(p), label, color, fmt, hidden, width }]
   * o.mode: 'line' | 'area' | 'stacked'; o.fmt: value formatter; o.base: 10 | 1024 (axis steps)
   * o.yMax: number | fn | 'auto'; o.floor: minimum auto scale; o.lines: [{ y | fn, label, color }]
   * o.legend / o.table: containers for chips / stats table; o.markers: draw events on the axis
   */
  constructor(host, o) {
    this.host = host;
    this.o = { mode: 'line', grid: 4, yMin: 0, yMax: 'auto', floor: 1, fmt: String, height: 230, base: 10, lines: [], markers: false, ...o };
    this.series = (o.series || []).map((x) => ({ ...x, hidden: !!x.hidden }));
    host.classList.add('tchart');
    host.style.setProperty('--h', `${this.o.height}px`);
    this.cv = h('canvas', { role: 'img', 'aria-label': this.o.label || 'Diagramm' });
    this.tip = h('div', { class: 'tip', role: 'presentation' });
    host.append(this.cv, this.tip);
    this.vis = false;
    this.w = 0;
    this.h = 0;
    this.padL = 8;
    this.padR = 10;
    this.padT = 10;
    this.padB = 24;
    this.chips = [];
    this.statsAt = 0;
    this.buildLegend();
    this.buildTable();

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => { this.vis = e.isIntersecting; if (this.vis) this.draw(); }, { rootMargin: '120px' });
    this.io.observe(host);
    const move = (e) => { const r = host.getBoundingClientRect(); this.setHover(e.clientX - r.left); };
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerdown', move);
    host.addEventListener('pointerleave', () => this.setHover(null));
    instances.add(this);
    this.resize();
  }

  destroy() { instances.delete(this); this.ro.disconnect(); this.io.disconnect(); }

  setSeries(series) { this.series = series.map((x) => ({ ...x, hidden: !!x.hidden })); this.buildLegend(); this.buildTable(); this.draw(); }

  setHover(x) {
    if (x == null) { hoverT = null; hoverSrc = null; } else {
      const { t0, t1 } = this.win || {};
      if (t0 == null) return;
      hoverT = t0 + ((x - this.padL) / (this.w - this.padL - this.padR)) * (t1 - t0);
      hoverSrc = this;
    }
    drawAll();
  }

  resize() {
    const { ctx, w, h: hh } = sizeCanvas(this.cv, this.host);
    this.ctx = ctx; this.w = w; this.h = hh;
    this.draw();
  }

  val(s, p) {
    const v = s.val ? s.val(p) : p[s.key];
    return isNum(v) ? v : null;
  }

  buildLegend() {
    const box = this.o.legend;
    if (!box) return;
    clear(box);
    this.chips = this.series.map((s, i) => {
      const val = h('b', { class: 'chip-v' }, '–');
      const el = h('button', { type: 'button', class: `chip${s.hidden ? ' off' : ''}`, title: 'Ein-/ausblenden', onClick: () => { s.hidden = !s.hidden; el.classList.toggle('off', s.hidden); this.draw(); } },
        h('i', { class: 'sw', style: { background: color(s.color) } }), h('span', { class: 'chip-l' }, s.label), val);
      box.append(el);
      return { el, val, i };
    });
  }

  buildTable() {
    const box = this.o.table;
    if (!box) return;
    clear(box);
    const head = h('tr', null, ...['', 'Aktuell', 'Ø', 'Min', 'Max', 'P95'].map((t) => h('th', null, t)));
    this.rows = this.series.map((s) => {
      const cells = Array.from({ length: 5 }, () => h('td', null, '–'));
      const label = h('td', null, h('i', { class: 'sw', style: { background: color(s.color) } }), s.label);
      return { tr: h('tr', null, label, ...cells), cells };
    });
    box.append(h('table', { class: 'stat-table' }, h('thead', null, head), h('tbody', null, ...this.rows.map((r) => r.tr))));
  }

  draw() {
    if (!this.ctx || this.w < 60) return;
    const { ctx, w, h: hh, o } = this;
    // optional own data source + fixed window (e.g. website latency history, event histogram)
    const R = o.window ? { ms: o.window, tier: 't10', step: 0 } : RANGES[store.range];
    const now = store.now();
    const t1 = now - (R.tier === 'raw' ? 1000 : 0);
    const t0 = t1 - R.ms;
    const { pts, step } = o.source ? o.source() : store.pts();
    this.R = R;
    const lo = Math.max(0, lowerBound(pts, t0 - step * 3) - 1);
    const visible = this.series.filter((s) => !s.hidden);

    // y scale
    const lineVals = o.lines.map((l) => (typeof l.fn === 'function' ? l.fn() : l.y)).filter(isNum);
    let target;
    if (o.yMax === 'auto') {
      let m = o.floor;
      for (let i = lo; i < pts.length; i++) {
        if (o.mode === 'stacked') {
          let sum = 0;
          for (const s of visible) { const v = this.val(s, pts[i]); if (v != null) sum += v; }
          if (sum > m) m = sum;
        } else for (const s of visible) { const v = this.val(s, pts[i]); if (v != null && v > m) m = v; }
      }
      for (const v of lineVals) if (v > m && v < m * 3) m = v;
      target = niceMax(m * 1.04, o.base, o.grid);
    } else target = typeof o.yMax === 'function' ? o.yMax() : o.yMax;
    const yMin = o.yMin;
    this.ymax = target;

    // left padding depends on the widest y label
    ctx.font = FONT;
    let maxLabel = 0;
    for (let k = 0; k < o.grid; k++) maxLabel = Math.max(maxLabel, ctx.measureText(o.fmt(yMin + ((target - yMin) * (o.grid - k)) / o.grid, true)).width);
    this.padL = Math.ceil(maxLabel) + 12;
    const pl = this.padL; const pr = this.padR; const pt = this.padT; const pb = this.padB;
    const pw = w - pl - pr; const ph = hh - pt - pb;
    const X = (t) => pl + ((t - t0) / (t1 - t0)) * pw;
    const Y = (v) => pt + (1 - clamp((v - yMin) / (target - yMin || 1), 0, 1)) * ph;
    const base = pt + ph;
    this.win = { t0, t1 };
    this.geo = { X, Y, base };

    ctx.clearRect(0, 0, w, hh);

    // grid + y labels
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (let k = 0; k <= o.grid; k++) {
      const y = Math.round(pt + (ph * k) / o.grid) + 0.5;
      ctx.strokeStyle = k === o.grid ? T.line : T.line2;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(w - pr, y); ctx.stroke();
      if (k < o.grid) { ctx.fillStyle = T.muted; ctx.fillText(o.fmt(yMin + ((target - yMin) * (o.grid - k)) / o.grid, true), pl - 8, y); }
    }
    // x ticks
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const t of timeTicks(t0, t1, pw < 460 ? 3 : 6)) {
      const x = Math.round(X(t)) + 0.5;
      if (x < pl + 16 || x > w - pr - 16) continue;
      ctx.strokeStyle = T.line2;
      ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, base); ctx.stroke();
      ctx.fillStyle = T.muted;
      ctx.fillText(tHM(t), x, base + 7);
    }

    // threshold lines
    for (const l of o.lines) {
      const v = typeof l.fn === 'function' ? l.fn() : l.y;
      if (!isNum(v) || v > target) continue;
      const y = Math.round(Y(v)) + 0.5;
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = color(l.color || 'warn');
      ctx.beginPath(); ctx.moveTo(pl, y); ctx.lineTo(w - pr, y); ctx.stroke();
      ctx.restore();
      if (l.label) { ctx.textAlign = 'right'; ctx.textBaseline = 'bottom'; ctx.fillStyle = color(l.color || 'warn'); ctx.fillText(l.label, w - pr - 4, y - 2); }
    }

    // series
    ctx.save();
    ctx.beginPath(); ctx.rect(pl, pt - 2, pw, ph + 4); ctx.clip();
    const gap = step * 2.6;
    if (o.mode === 'stacked') this.drawStacked(visible, pts, lo, gap, X, Y, base);
    else for (const s of visible) this.drawSeries(s, pts, lo, gap, X, Y, base);
    ctx.restore();

    // live head
    const head = pts[pts.length - 1];
    if (head && R.tier === 'raw' && !o.source && !store.paused && o.mode !== 'stacked' && visible[0]) {
      const v = this.val(visible[0], head);
      if (v != null) {
        const ph0 = (performance.now() % 1800) / 1800;
        const x = Math.min(w - pr, X(head.t)); const y = Y(v);
        ctx.fillStyle = rgba(color(visible[0].color), 0.3 * (1 - ph0));
        ctx.beginPath(); ctx.arc(x, y, 3 + ph0 * 8, 0, 6.3); ctx.fill();
        ctx.fillStyle = color(visible[0].color);
        ctx.beginPath(); ctx.arc(x, y, 3, 0, 6.3); ctx.fill();
      }
    }

    // event markers on the x axis
    this.markers = [];
    if (o.markers) {
      const lvl = { info: T.info, ok: T.ok, warn: T.warn, crit: T.crit };
      for (const e of store.events) {
        if (e.t < t0 || e.t > t1) continue;
        const x = X(e.t);
        this.markers.push({ x, e });
        ctx.fillStyle = lvl[e.level] || T.muted;
        ctx.beginPath(); ctx.moveTo(x, base); ctx.lineTo(x - 4, base + 7); ctx.lineTo(x + 4, base + 7); ctx.closePath(); ctx.fill();
      }
    }

    // hover
    let hp = null;
    if (hoverT != null && hoverT >= t0 && hoverT <= t1 && pts.length) {
      let i = lowerBound(pts, hoverT);
      if (i > 0 && (i >= pts.length || hoverT - pts[i - 1].t < pts[i].t - hoverT)) i--;
      const p = pts[i];
      if (p && Math.abs(p.t - hoverT) <= Math.max(step * 3, R.ms / 50)) hp = p;
    }
    if (hp) {
      const x = Math.round(X(hp.t)) + 0.5;
      ctx.strokeStyle = T.text;
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(x, pt); ctx.lineTo(x, base); ctx.stroke();
      ctx.setLineDash([]);
      if (o.mode !== 'stacked') {
        for (const s of visible) {
          const v = this.val(s, hp);
          if (v == null) continue;
          ctx.fillStyle = T.panel;
          ctx.strokeStyle = color(s.color);
          ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(x, Y(v), 4, 0, 6.3); ctx.fill(); ctx.stroke();
        }
      }
    }
    this.updateTip(hp, hoverSrc === this);
    this.updateLegend(hp || head);
    const nowMs = performance.now();
    if (nowMs - this.statsAt > 900) { this.statsAt = nowMs; this.updateTable(pts, lo, t0, t1); }
  }

  drawSeries(s, pts, lo, gap, X, Y, base) {
    const { ctx, o } = this;
    const col = color(s.color);
    let seg = [];
    const k = o.smooth > 1 && this.R && this.R.tier === 'raw' ? o.smooth : 1;
    let win = [];
    const flush = () => {
      win = [];
      if (seg.length > 1) {
        const path = new Path2D();
        seg.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
        if (o.mode === 'area') {
          const area = new Path2D(path);
          area.lineTo(seg[seg.length - 1][0], base); area.lineTo(seg[0][0], base); area.closePath();
          ctx.fillStyle = rgba(col, 0.13); ctx.fill(area);
        }
        ctx.lineWidth = s.width || 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
        ctx.strokeStyle = col;
        if (s.dash) ctx.setLineDash(s.dash);
        ctx.stroke(path);
        ctx.setLineDash([]);
      } else if (seg.length === 1) { ctx.fillStyle = col; ctx.beginPath(); ctx.arc(seg[0][0], seg[0][1], 1.6, 0, 6.3); ctx.fill(); }
      seg = [];
    };
    for (let i = lo; i < pts.length; i++) {
      const p = pts[i];
      let v = this.val(s, p);
      if (v == null) { flush(); continue; }
      if (seg.length && p.t - pts[i - 1].t > gap) flush();
      if (k > 1) { win.push(v); if (win.length > k) win.shift(); v = win.reduce((a, b) => a + b, 0) / win.length; }
      seg.push([X(p.t), Y(v)]);
    }
    flush();
  }

  drawStacked(visible, pts, lo, gap, X, Y, base) {
    const { ctx } = this;
    const segs = [];
    let cur = [];
    for (let i = lo; i < pts.length; i++) {
      const p = pts[i];
      if (cur.length && p.t - cur[cur.length - 1].t > gap) { segs.push(cur); cur = []; }
      cur.push(p);
    }
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      if (seg.length < 2) continue;
      const cum = seg.map(() => 0);
      visible.forEach((s) => {
        const lower = cum.slice();
        seg.forEach((p, i) => { const v = this.val(s, p); cum[i] += v == null ? 0 : v; });
        const col = color(s.color);
        const path = new Path2D();
        seg.forEach((p, i) => (i ? path.lineTo(X(p.t), Y(cum[i])) : path.moveTo(X(p.t), Y(cum[i]))));
        for (let i = seg.length - 1; i >= 0; i--) path.lineTo(X(seg[i].t), Y(lower[i]));
        path.closePath();
        ctx.fillStyle = rgba(col, 0.92);
        ctx.fill(path);
        ctx.strokeStyle = T.panel; ctx.lineWidth = 1; ctx.lineJoin = 'round';
        const edge = new Path2D();
        seg.forEach((p, i) => (i ? edge.lineTo(X(p.t), Y(cum[i])) : edge.moveTo(X(p.t), Y(cum[i]))));
        ctx.stroke(edge);
      });
    }
  }

  updateLegend(p) {
    if (!this.chips.length) return;
    for (const c of this.chips) {
      const s = this.series[c.i];
      const v = p ? this.val(s, p) : null;
      setText(c.val, v == null ? '–' : (s.fmt || this.o.fmt)(v));
    }
  }

  updateTable(pts, lo, t0, t1) {
    if (!this.rows) return;
    this.series.forEach((s, i) => {
      const vals = [];
      for (let k = lo; k < pts.length; k++) { if (pts[k].t < t0 || pts[k].t > t1) continue; const v = this.val(s, pts[k]); if (v != null) vals.push(v); }
      const st = stats(vals);
      const f = s.fmt || this.o.fmt;
      const r = this.rows[i];
      const out = st ? [st.last, st.avg, st.min, st.max, st.p95] : [];
      r.cells.forEach((c, k) => setText(c, out[k] == null ? '–' : f(out[k])));
      r.tr.classList.toggle('off', !!s.hidden);
    });
  }

  updateTip(hp, isSource) {
    const tip = this.tip;
    if (!hp || !isSource) { tip.classList.remove('on'); return; }
    const key = `${hp.t}|${this.series.map((s) => (s.hidden ? 0 : 1)).join('')}`;
    if (key !== this.tipKey || (this.R && this.R.tier === 'raw')) {
      this.tipKey = key;
      const kids = [h('div', { class: 'tip-t' }, (this.R && this.R.ms > 3_600_000) ? tHM(hp.t) : tHMS(hp.t))];
      const total = this.o.mode === 'stacked' ? this.series.filter((s) => !s.hidden).reduce((a, s) => a + (this.val(s, hp) || 0), 0) : null;
      for (const s of this.series) {
        if (s.hidden) continue;
        const v = this.val(s, hp);
        if (v == null) continue;
        kids.push(h('div', { class: 'tip-r' }, h('i', { class: 'sw', style: { background: color(s.color) } }), h('span', null, s.label), h('b', null, (s.fmt || this.o.fmt)(v))));
      }
      if (total != null) kids.push(h('div', { class: 'tip-r tip-sum' }, h('span', null, 'Summe'), h('b', null, this.o.fmt(total))));
      const near = this.markers && this.markers.find((m) => Math.abs(m.x - this.geo.X(hp.t)) < 9);
      if (near) kids.push(h('div', { class: 'tip-ev' }, `${near.e.title}`, h('small', null, ` ${ago(near.e.t)}`)));
      tip.replaceChildren(...kids);
    }
    const x = this.geo.X(hp.t);
    const tw = tip.offsetWidth;
    tip.style.transform = `translate(${Math.max(4, x + 14 + tw > this.w ? x - tw - 14 : x + 14)}px, 10px)`;
    tip.classList.add('on');
  }
}

// ------------------------------------------------------------------ Donut

const TAU_R = 2 * Math.PI * 40;

export class Donut {
  /**
   * items: [{ id, label, value, color }]; o.fmt formats values; o.center: { label, value }
   */
  constructor(host, o = {}) {
    this.o = { fmt: String, size: 150, legend: true, percent: true, ...o };
    this.host = host;
    host.classList.add('donut');
    this.circles = new Map();
    this.svg = svg('svg', { viewBox: '0 0 100 100', class: 'donut-svg', role: 'img', 'aria-label': o.label || 'Kreisdiagramm' });
    this.track = svg('circle', { cx: 50, cy: 50, r: 40, class: 'donut-track' });
    this.svg.append(this.track);
    this.cLabel = h('div', { class: 'donut-cl' });
    this.cValue = h('div', { class: 'donut-cv' });
    this.wrap = h('div', { class: 'donut-ring' }, this.svg, h('div', { class: 'donut-center' }, this.cValue, this.cLabel));
    this.wrap.style.setProperty('--size', `${this.o.size}px`);
    this.list = h('ul', { class: 'donut-legend' });
    host.append(this.wrap);
    if (this.o.legend) host.append(this.list);
    this.items = [];
    this.hover = null;
    this.rows = new Map();
  }

  update(items, center) {
    this.items = items.map((x) => ({ ...x, value: Math.max(0, x.value || 0) }));
    this.center = center || this.center;
    const total = this.items.reduce((a, b) => a + b.value, 0);
    this.total = total;
    let acc = 0;
    const seen = new Set();
    this.items.forEach((it) => {
      seen.add(it.id);
      let c = this.circles.get(it.id);
      if (!c) {
        c = svg('circle', { cx: 50, cy: 50, r: 40, class: 'donut-seg' });
        c.addEventListener('pointerenter', () => this.setHover(it.id));
        c.addEventListener('pointerleave', () => this.setHover(null));
        this.svg.append(c);
        this.circles.set(it.id, c);
      }
      const frac = total ? it.value / total : 0;
      const len = Math.max(0, frac * TAU_R - (this.items.length > 1 && frac > 0 ? 0.8 : 0));
      c.style.stroke = color(it.color);
      c.style.strokeDasharray = `${len} ${TAU_R - len}`;
      c.style.strokeDashoffset = `${-acc * TAU_R}`;
      acc += frac;
    });
    for (const [id, c] of this.circles) if (!seen.has(id)) { c.remove(); this.circles.delete(id); }
    if (this.o.legend) this.renderLegend(total);
    this.renderCenter();
  }

  renderLegend(total) {
    const seen = new Set();
    this.items.forEach((it, idx) => {
      seen.add(it.id);
      let r = this.rows.get(it.id);
      if (!r) {
        r = { sw: h('i', { class: 'sw' }), name: h('span', { class: 'dl-n' }), val: h('b', { class: 'dl-v' }), pct: h('span', { class: 'dl-p' }) };
        r.li = h('li', { onPointerenter: () => this.setHover(it.id), onPointerleave: () => this.setHover(null) }, r.sw, r.name, r.val, r.pct);
        this.rows.set(it.id, r);
      }
      r.sw.style.background = color(it.color);
      setText(r.name, it.label);
      setText(r.val, this.o.fmt(it.value));
      setText(r.pct, total ? `${num((it.value / total) * 100, (it.value / total) * 100 < 10 ? 1 : 0)} %` : '–');
      if (this.list.children[idx] !== r.li) this.list.insertBefore(r.li, this.list.children[idx] || null);
    });
    for (const [id, r] of this.rows) if (!seen.has(id)) { r.li.remove(); this.rows.delete(id); }
  }

  setHover(id) {
    this.hover = id;
    for (const [k, c] of this.circles) c.classList.toggle('dim', id != null && k !== id);
    for (const [k, r] of this.rows) r.li.classList.toggle('dim', id != null && k !== id);
    this.renderCenter();
  }

  renderCenter() {
    const it = this.hover != null ? this.items.find((x) => x.id === this.hover) : null;
    if (it) {
      setText(this.cValue, this.total ? `${num((it.value / this.total) * 100, 1)} %` : '–');
      setText(this.cLabel, it.label);
    } else if (this.center) {
      setText(this.cValue, this.center.value);
      setText(this.cLabel, this.center.label || '');
    } else {
      setText(this.cValue, this.o.fmt(this.total));
      setText(this.cLabel, 'gesamt');
    }
  }
}

// ------------------------------------------------------------------ Heatmap (cores x time)

const HEAT = [[0, [241, 239, 233]], [25, [196, 207, 240]], [55, [36, 71, 196]], [80, [229, 64, 26]], [100, [110, 18, 8]]];
function heatColor(v) {
  const x = clamp(v, 0, 100);
  for (let i = 1; i < HEAT.length; i++) {
    if (x <= HEAT[i][0]) {
      const [a, ca] = HEAT[i - 1]; const [b, cb] = HEAT[i];
      const k = (x - a) / (b - a || 1);
      const mix = ca.map((c, j) => Math.round(c + (cb[j] - c) * k));
      return `rgb(${mix[0]},${mix[1]},${mix[2]})`;
    }
  }
  return 'rgb(220,38,38)';
}

export class Heatmap {
  constructor(host, o) {
    this.host = host;
    this.o = { rows: 6, label: (i) => `Kern ${i}`, key: (i) => `c${i}`, height: 190, ...o };
    host.classList.add('heat');
    host.style.setProperty('--h', `${this.o.height}px`);
    this.cv = h('canvas', { role: 'img', 'aria-label': 'Heatmap der Kernauslastung' });
    this.tip = h('div', { class: 'tip' });
    host.append(this.cv, this.tip);
    this.vis = false;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.io = new IntersectionObserver(([e]) => { this.vis = e.isIntersecting; if (this.vis) this.draw(); });
    this.io.observe(host);
    host.addEventListener('pointermove', (e) => { const r = host.getBoundingClientRect(); this.hx = e.clientX - r.left; this.hy = e.clientY - r.top; this.draw(); });
    host.addEventListener('pointerleave', () => { this.hx = null; this.draw(); });
    instances.add(this);
    this.resize();
  }
  destroy() { instances.delete(this); this.ro.disconnect(); this.io.disconnect(); }
  resize() { const { ctx, w, h: hh } = sizeCanvas(this.cv, this.host); this.ctx = ctx; this.w = w; this.h = hh; this.draw(); }
  draw() {
    if (!this.ctx || this.w < 60) return;
    const { ctx, w, h: hh, o } = this;
    const R = RANGES[store.range];
    const t1 = store.now() - 1000; const t0 = t1 - R.ms;
    const { pts, step } = store.pts();
    const padL = 54; const padB = 20; const padT = 4; const padR = 4;
    const pw = w - padL - padR; const ph = hh - padT - padB;
    const rowH = ph / o.rows;
    ctx.clearRect(0, 0, w, hh);
    ctx.font = FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'middle'; ctx.fillStyle = T.muted;
    for (let r = 0; r < o.rows; r++) ctx.fillText(o.label(r), padL - 8, padT + rowH * r + rowH / 2);
    const cols = Math.max(10, Math.floor(pw / 4));
    const cw = pw / cols;
    this.cells = { cols, cw, padL, padT, rowH };
    let j = Math.max(0, lowerBound(pts, t0) - 1);
    for (let c = 0; c < cols; c++) {
      const tc = t0 + ((c + 0.5) / cols) * (t1 - t0);
      while (j + 1 < pts.length && pts[j + 1].t <= tc) j++;
      const p = pts[j];
      if (!p || Math.abs(p.t - tc) > Math.max(step * 1.6, ((t1 - t0) / cols) * 1.3)) continue;
      for (let r = 0; r < o.rows; r++) {
        const v = p[o.key(r)];
        if (!isNum(v)) continue;
        ctx.fillStyle = heatColor(v);
        ctx.fillRect(padL + c * cw, padT + r * rowH, Math.ceil(cw) + 0.5, rowH - 1.5);
      }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = T.muted;
    for (const t of timeTicks(t0, t1, pw < 460 ? 3 : 6)) {
      const x = padL + ((t - t0) / (t1 - t0)) * pw;
      if (x < padL + 16 || x > w - padR - 16) continue;
      ctx.fillText(tHM(t), x, hh - padB + 5);
    }
    if (this.hx != null && this.hx >= padL && this.hx <= w - padR && this.hy >= padT && this.hy <= padT + ph) {
      const c = Math.floor((this.hx - padL) / cw);
      const r = Math.floor((this.hy - padT) / rowH);
      const tc = t0 + ((c + 0.5) / cols) * (t1 - t0);
      let i = lowerBound(pts, tc);
      if (i > 0 && (i >= pts.length || tc - pts[i - 1].t < pts[i].t - tc)) i--;
      const p = pts[i];
      const v = p ? p[o.key(r)] : null;
      ctx.strokeStyle = T.text; ctx.lineWidth = 1.5;
      ctx.strokeRect(padL + c * cw - 0.5, padT + r * rowH - 0.5, Math.max(cw, 4) + 1, rowH);
      this.tip.replaceChildren(h('div', { class: 'tip-t' }, tHMS(tc)), h('div', { class: 'tip-r' }, h('span', null, o.label(r)), h('b', null, isNum(v) ? `${num(v, 1)} %` : '–')));
      const tw = this.tip.offsetWidth;
      this.tip.style.transform = `translate(${Math.max(4, this.hx + 14 + tw > w ? this.hx - tw - 14 : this.hx + 14)}px, ${Math.max(4, this.hy - 30)}px)`;
      this.tip.classList.add('on');
    } else this.tip.classList.remove('on');
  }
}

// ------------------------------------------------------------------ Spark

export function spark(host, o = {}) {
  const cv = h('canvas', { 'aria-hidden': 'true' });
  host.classList.add('spark');
  host.append(cv);
  let values = [];
  let col = o.color || 'c1';
  const draw = () => {
    const { ctx, w, h: hh } = sizeCanvas(cv, host);
    ctx.clearRect(0, 0, w, hh);
    const v = values.filter(isNum);
    if (v.length < 2) return;
    let min = o.min != null ? o.min : Math.min(...v);
    let max = o.max != null ? o.max : Math.max(...v);
    if (max - min < 1e-9) { max = min + 1; }
    const pad = 2;
    const pts = values.map((x, i) => (isNum(x) ? [(i / (values.length - 1)) * (w - 1), pad + (1 - (x - min) / (max - min)) * (hh - pad * 2)] : null));
    const c = color(col);
    const path = new Path2D();
    let pen = false;
    for (const p of pts) { if (!p) { pen = false; continue; } if (pen) path.lineTo(p[0], p[1]); else path.moveTo(p[0], p[1]); pen = true; }
    const area = new Path2D(path);
    const first = pts.find(Boolean); const last = [...pts].reverse().find(Boolean);
    area.lineTo(last[0], hh); area.lineTo(first[0], hh); area.closePath();
    const g = ctx.createLinearGradient(0, 0, 0, hh);
    g.addColorStop(0, rgba(c, 0.22)); g.addColorStop(1, rgba(c, 0));
    ctx.fillStyle = g; ctx.fill(area);
    ctx.strokeStyle = c; ctx.lineWidth = 1.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke(path);
    ctx.fillStyle = c; ctx.beginPath(); ctx.arc(last[0] - 1.5, last[1], 2.4, 0, 6.3); ctx.fill();
  };
  new ResizeObserver(draw).observe(host);
  store.on('theme', draw);
  return { set(vals, c) { values = vals; if (c) col = c; draw(); } };
}

// ------------------------------------------------------------------ BarList

export class BarList {
  constructor(host, o = {}) {
    this.o = { fmt: String, ...o };
    this.host = host;
    host.classList.add('barlist');
    this.rows = new Map();
  }
  update(items, max) {
    const m = max != null ? max : Math.max(1e-9, ...items.map((i) => i.value));
    const seen = new Set();
    items.forEach((it, idx) => {
      seen.add(it.id);
      let r = this.rows.get(it.id);
      if (!r) {
        r = { name: h('span', { class: 'bl-n' }), sub: h('small', { class: 'bl-s' }), val: h('b', { class: 'bl-v' }), fill: h('i') };
        r.el = h('div', { class: 'bl-row' }, h('div', { class: 'bl-top' }, h('span', { class: 'bl-l' }, r.name, r.sub), r.val), h('div', { class: 'bl-track' }, r.fill));
        this.rows.set(it.id, r);
      }
      setText(r.name, it.label);
      setText(r.sub, it.sub || '');
      setText(r.val, this.o.fmt(it.value, it));
      r.fill.style.width = `${clamp((it.value / m) * 100, 0, 100)}%`;
      r.fill.style.background = color(it.color || 'c1');
      if (this.host.children[idx] !== r.el) this.host.insertBefore(r.el, this.host.children[idx] || null);
    });
    for (const [id, r] of this.rows) if (!seen.has(id)) { r.el.remove(); this.rows.delete(id); }
  }
}

// ------------------------------------------------------------------ Columns (small bar chart, SVG)

/** data: [{ label, value, tip }]; renders evenly spaced columns with a tooltip (<title>) per column */
export function columns(data, { height = 110, color: col = 'c1', fmt = String, labelEvery = 0 } = {}) {
  const n = Math.max(1, data.length);
  const W = 1000; const gap = 4; const bw = Math.max(2, (W - gap * (n - 1)) / n);
  const max = Math.max(1, ...data.map((d) => d.value));
  const H = height; const top = 6; const bottom = 22; const ph = H - top - bottom;
  const el = svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'cols', role: 'img', 'aria-label': 'Balkendiagramm', style: { width: '100%', height: `${H}px`, display: 'block' } });
  el.append(svg('line', { x1: 0, x2: W, y1: top + ph + 0.5, y2: top + ph + 0.5, stroke: 'var(--line)', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke' }));
  data.forEach((d, i) => {
    const bh = d.value > 0 ? Math.max(2, (d.value / max) * ph) : 0;
    const r = svg('rect', { x: i * (bw + gap), y: top + ph - bh, width: bw, height: bh, rx: 2, fill: `var(--${col})`, opacity: 0.9 });
    r.append(svg('title', null, d.tip || `${d.label}: ${fmt(d.value)}`));
    el.append(r);
  });
  const host = h('div', { class: 'cols-host' }, el);
  const lab = h('div', { class: 'cols-axis' });
  const step = labelEvery || Math.ceil(n / 8);
  data.forEach((d, i) => { if (i % step === 0) { const s = h('span', null, d.label); s.style.left = `${((i + 0.5) / n) * 100}%`; lab.append(s); } });
  host.append(lab);
  return { el: host, max };
}
