// Storage map: where does the disk space go? A treemap of one folder level at a time; click a folder to go in.

import { h, icon } from '../dom.js';
import { card, dataTable, toast, banner, kpi, meter } from '../widgets.js';
import { B, num } from '../fmt.js';
import { readOp, actionDialog } from '../interact.js';

/** squarified treemap (Bruls, Huizing, van Wijk): items sorted by value, returns {x,y,w,h} per item */
export function squarify(values, W, H) {
  const total = values.reduce((s, v) => s + v, 0);
  const out = new Array(values.length);
  if (!total || W <= 0 || H <= 0) return values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const areas = values.map((v) => (v / total) * W * H);
  let x = 0; let y = 0; let w = W; let hgt = H; let i = 0;
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b, 0);
    const mx = Math.max(...row); const mn = Math.min(...row);
    return Math.max((side * side * mx) / (s * s), (s * s) / (side * side * mn));
  };
  while (i < areas.length) {
    const side = Math.min(w, hgt);
    const row = [areas[i]]; let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]], side) <= worst(row, side)) { row.push(areas[j]); j++; }
    const sum = row.reduce((a, b) => a + b, 0);
    if (w >= hgt) { // a column on the left
      const cw = sum / hgt; let cy = y;
      row.forEach((a, k) => { const ch = a / cw; out[i + k] = { x, y: cy, w: cw, h: ch }; cy += ch; });
      x += cw; w -= cw;
    } else { // a row on top
      const rh = sum / w; let cx = x;
      row.forEach((a, k) => { const cw = a / rh; out[i + k] = { x: cx, y, w: cw, h: rh }; cx += cw; });
      y += rh; hgt -= rh;
    }
    i = j;
  }
  return out;
}

const baseName = (p) => p.split('/').filter(Boolean).pop() || '/';

export default {
  id: 'storage', title: 'Speicher-Karte', group: 'Verwalten', icon: 'disk', range: false, desc: 'Sehen, was den Platz auf der Festplatte belegt, und Ordner für Ordner hineinzoomen', keywords: 'speicherplatz platz festplatte du treemap größe aufräumen groß ordner',
  mount(root, ctx) {
    const { store } = ctx;
    const cache = new Map();
    let path = '/'; let busy = false; let token = 0;
    try { const s = sessionStorage.getItem('sd.storage.path'); if (s && s.startsWith('/')) path = s; } catch {}

    const crumbs = h('div', { class: 'crumbs' });
    const mapBox = h('div', { class: 'tmap', role: 'img', 'aria-label': 'Speicherbelegung als Kartendiagramm' });
    const note = h('div');
    const K = { t: kpi({ label: 'Gesamt in diesem Ordner', color: 'c1', span: 4, icon: 'disk' }), d: kpi({ label: 'Davon Ordner', color: 'c4', span: 4, icon: 'files' }), f: kpi({ label: 'Einzelne Dateien', color: 'c3', span: 4, icon: 'file' }) };
    const input = h('input', { class: 'input', value: path, 'aria-label': 'Pfad', spellcheck: 'false', style: { fontFamily: 'var(--mono)', maxWidth: '420px' } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(input.value.trim() || '/'); });
    const mounts = h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '6px' } });

    const table = dataTable({
      columns: [
        { key: 'name', label: 'Name', cls: 'tbl-title', fmt: (v, r) => h('span', { class: 'row', style: { gap: '8px' } }, icon(r.kind === 'dir' ? 'files' : 'file', 15), v) },
        { key: 'size', label: 'Größe', align: 'r', fmt: (v) => B(v) },
        { key: 'pct', label: 'Anteil', fmt: (v, r) => meter(v, 100, { text: `${num(v, 1)} %`, tone: 'ok' }), sort: (r) => r.size },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null,
          r.kind === 'dir' ? h('button', { type: 'button', class: 'btn sm', onClick: () => go(r.path) }, 'Öffnen') : null,
          h('button', { type: 'button', class: 'btn sm', onClick: () => { try { localStorage.setItem('sd.files.cwd', r.kind === 'dir' ? r.path : r.path.replace(/\/[^/]+$/, '') || '/'); } catch {} location.hash = '#/files'; } }, 'Im Dateimanager'),
          r.kind !== 'dir' ? h('button', { type: 'button', class: 'btn sm danger', onClick: () => del(r) }, icon('trash', 13)) : null) },
      ],
      sort: { key: 'size', dir: 'desc' }, dense: true, pageSize: 50, search: true, searchPlaceholder: 'In dieser Ebene suchen …', empty: 'Leer.',
    });

    async function del(r) {
      await actionDialog({ op: 'files.delete', args: { path: r.path }, title: 'Datei löschen', lead: r.path, text: `${B(r.size)} werden frei. Eine Kopie bleibt in den früheren Versionen, wenn die Datei klein genug ist.`, danger: true, okLabel: 'Löschen', success: 'Gelöscht', after: () => { cache.delete(path); load(true); } });
    }

    function go(p) {
      const clean = p.replace(/\/+$/, '') || '/';
      path = clean.startsWith('/') ? clean : `/${clean}`;
      input.value = path;
      try { sessionStorage.setItem('sd.storage.path', path); } catch {}
      load(false);
    }

    function paintCrumbs() {
      const parts = path.split('/').filter(Boolean);
      crumbs.replaceChildren(h('button', { type: 'button', class: 'crumb-b', onClick: () => go('/') }, icon('server', 14), 'Server'), ...parts.flatMap((p, i) => [h('span', { class: 'crumb-s' }, '/'), h('button', { type: 'button', class: 'crumb-b', onClick: () => go(`/${parts.slice(0, i + 1).join('/')}`) }, p)]));
    }

    function paintMap(data) {
      const rows = data.rows;
      mapBox.replaceChildren();
      if (!rows.length) { mapBox.append(h('p', { class: 'muted', style: { padding: '30px', textAlign: 'center' } }, 'Dieser Ordner ist leer.')); return; }
      const W = mapBox.clientWidth || 800; const H = mapBox.clientHeight || 420;
      const shown = rows.slice(0, 60);
      const rest = rows.slice(60).reduce((s, r) => s + r.size, 0);
      const items = rest > 0 ? [...shown, { name: `weitere (${rows.length - 60})`, size: rest, kind: 'rest' }] : shown;
      const rects = squarify(items.map((r) => Math.max(1, r.size)), W, H);
      items.forEach((r, i) => {
        const q = rects[i];
        const small = q.w < 70 || q.h < 34;
        const cell = h('button', { type: 'button', class: `tcell${r.kind === 'dir' ? ' dir' : ''}${r.kind === 'rest' ? ' rest' : ''}`, title: `${r.name} · ${B(r.size)}${data.total ? ` · ${num((r.size / data.total) * 100, 1)} %` : ''}`, disabled: r.kind === 'rest' ? '' : null,
          onClick: () => { if (r.kind === 'dir') go(r.path); } },
        small ? null : h('b', null, r.name), small ? null : h('small', null, B(r.size)));
        cell.style.cssText = '';
        cell.style.left = `${q.x}px`; cell.style.top = `${q.y}px`; cell.style.width = `${Math.max(0, q.w - 2)}px`; cell.style.height = `${Math.max(0, q.h - 2)}px`;
        if (r.kind !== 'rest') cell.style.setProperty('--tc', `var(--c${(i % 10) + 1})`);
        mapBox.append(cell);
      });
    }

    async function load(force) {
      const mine = ++token;
      paintCrumbs();
      let data = !force && cache.get(path);
      if (!data) {
        busy = true;
        mapBox.replaceChildren(h('div', { class: 'tmap-wait' }, h('span', { class: 'spin' }), h('b', null, 'Wird gemessen …'), h('small', null, 'Große Ordner brauchen bis zu einer Minute.')));
        table.setRows([]); note.replaceChildren();
        try {
          const r = await readOp('files.du', { path, files: true });
          const sumTop = r.list.reduce((s, x) => s + x.size, 0);
          const rows = r.list.map((x) => ({ ...x, name: baseName(x.path), pct: r.total ? (x.size / r.total) * 100 : 0 }));
          // top-level entries beyond the first 100 and anything du could not attribute
          data = { path: r.path, total: r.total, rows, timedOut: r.timedOut, other: Math.max(0, r.total - sumTop) };
          cache.set(path, data);
        } catch (e) {
          if (mine !== token) return;
          busy = false;
          mapBox.replaceChildren(h('p', { class: 'err', style: { padding: '30px' } }, e.message));
          return;
        }
        busy = false;
      }
      if (mine !== token) return;
      const dirs = data.rows.filter((r) => r.kind === 'dir').reduce((s, r) => s + r.size, 0);
      K.t.set({ value: B(data.total), sub: data.path });
      K.d.set({ value: B(dirs), sub: `${data.rows.filter((r) => r.kind === 'dir').length} Unterordner`, color: 'c4' });
      K.f.set({ value: B(data.rows.filter((r) => r.kind !== 'dir').reduce((s, r) => s + r.size, 0)), sub: `${data.rows.filter((r) => r.kind !== 'dir').length} Dateien in der Liste`, color: 'c3' });
      note.replaceChildren(...(data.timedOut ? [banner('warn', 'Zeitlimit erreicht', 'Die Messung wurde nach 90 Sekunden abgebrochen, die Zahlen sind unvollständig. Öffne einen kleineren Unterordner.'), h('div', { style: { height: '12px' } })] : []));
      paintMap(data);
      table.setRows(data.rows);
    }

    const mountPoints = () => {
      const disks = (store.detail && store.detail.disks && store.detail.disks.mounts) || [];
      const set = new Set(['/', '/home', '/var', '/var/lib/docker', '/var/log', '/opt', '/srv', '/tmp', ...disks.map((d) => d.mount).filter(Boolean)]);
      mounts.replaceChildren(h('span', { class: 'muted' }, 'Schnell zu:'), ...[...set].slice(0, 14).map((m) => h('button', { type: 'button', class: 'btn sm ghost', onClick: () => go(m) }, m)));
    };
    mountPoints();

    root.append(h('div', { class: 'grid' }, K.t.el, K.d.el, K.f.el,
      card({ span: 12 }, h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px', marginBottom: '12px' } }, input, h('button', { type: 'button', class: 'btn primary', onClick: () => go(input.value.trim() || '/') }, 'Anzeigen'), h('button', { type: 'button', class: 'btn', onClick: () => { cache.delete(path); load(true); } }, icon('refresh', 14), 'Neu messen'), h('span', { class: 'grow' }), mounts), crumbs, note, mapBox,
        h('p', { class: 'muted', style: { marginTop: '10px' } }, 'Die Fläche eines Feldes zeigt, wie viel Platz es belegt. Ein Klick auf einen Ordner geht hinein. Gemessen wird nur auf diesem Laufwerk (andere eingehängte Laufwerke zählen nicht mit).')),
      card({ title: 'Alles in dieser Ebene', span: 12 }, table.el)));

    let resizeT;
    const onResize = () => { clearTimeout(resizeT); resizeT = setTimeout(() => { const d = cache.get(path); if (d && !busy) paintMap(d); }, 150); };
    window.addEventListener('resize', onResize);
    ctx.own({ destroy() { window.removeEventListener('resize', onResize); clearTimeout(resizeT); token++; } });
    load(false);
  },
};
