import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, deltaChip, dataTable, meter, kv, badge } from '../widgets.js';
import { num, B, R, dur, pct, slope } from '../fmt.js';
import { f, deltas, levelOf, ratio } from './common.js';

export default {
  id: 'disks', title: 'Datenträger', group: 'Messwerte', icon: 'disk', desc: 'Belegung, Durchsatz und Dateisysteme', keywords: 'festplatte speicherplatz io',
  mount(root, ctx) {
    const { store } = ctx;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2 }); return K[id].el; };

    const thr = chartCard({ title: 'Durchsatz', sub: 'Gelesen und geschrieben (Hauptdatenträger)', span: 6, mode: 'area', series: [{ key: 'dr', label: 'Lesen', color: 'c1' }, { key: 'dw', label: 'Schreiben', color: 'c3' }], fmt: f.rate, base: 1024, floor: 51200, markers: true, height: 220, statsOpen: true });
    const iops = chartCard({ title: 'Operationen pro Sekunde (IOPS)', span: 6, series: [{ key: 'dri', label: 'Lesen', color: 'c1', fmt: f.d1 }, { key: 'dwi', label: 'Schreiben', color: 'c3', fmt: f.d1 }], fmt: f.ps, floor: 20, height: 220 });
    const lat = chartCard({ title: 'Latenz', sub: 'Durchschnittliche Dauer je Lese-/Schreibvorgang', span: 6, series: [{ key: 'drl', label: 'Lesen', color: 'c1', fmt: f.ms2 }, { key: 'dwl', label: 'Schreiben', color: 'c3', fmt: f.ms2 }], fmt: f.ms, floor: 2, height: 210 });
    const util = chartCard({ title: 'Auslastung', sub: 'Anteil der Zeit, in der das Gerät beschäftigt war', span: 6, mode: 'area', series: [{ key: 'du', label: 'Ausgelastet', color: 'c5', fmt: f.pct }], fmt: f.pct, yMax: 100, height: 210 });
    const queue = chartCard({ title: 'Warteschlange', sub: 'Durchschnittlich wartende I/O-Anfragen', span: 6, series: [{ key: 'dq', label: 'Warteschlangen-Tiefe', color: 'c4', fmt: f.d2 }], fmt: f.d1, floor: 1, height: 190 });
    const psi = chartCard({ title: 'I/O-Druck (PSI)', sub: 'Zeitanteil, in dem Prozesse auf I/O warten (some) bzw. alle blockiert sind (full)', span: 6, series: [{ key: 'pi10', label: 'some Ø 10 Sek', color: 'c3', fmt: f.pct2 }, { key: 'pi60', label: 'some Ø 60 Sek', color: 'c1', fmt: f.pct2 }, { key: 'pi300', label: 'some Ø 300 Sek', color: 'c5', fmt: f.pct2 }, { key: 'pif10', label: 'full Ø 10 Sek', color: 'c4', fmt: f.pct2 }], fmt: f.pct, floor: 2, height: 190 });
    const used = chartCard({ title: 'Belegter Platz auf /', sub: 'Verlauf der Belegung', span: 6, mode: 'area', series: [{ key: 'dsu', label: 'Belegt', color: 'c6' }], fmt: f.bytes, base: 1024, yMin: 0, floor: 1 << 30, height: 190 });
    const inode = chartCard({ title: 'Inode-Belegung auf /', sub: 'Dateien und Verzeichnisse im Verhältnis zur Obergrenze', span: 6, series: [{ key: 'dsi', label: 'Inodes belegt', color: 'c8', fmt: f.pct2 }], fmt: f.pct, floor: 5, height: 190 });
    [thr, iops, lat, util, queue, psi, used, inode].forEach((c) => ctx.own(c.chart));

    const devTable = dataTable({
      columns: [
        { key: 'dev', label: 'Gerät', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, ' ', r.primary ? badge('Haupt', 'info') : null) },
        { key: 'model', label: 'Modell', fmt: (v) => v || '–' }, { key: 'size', label: 'Größe', align: 'r', fmt: B },
        { key: 'rotational', label: 'Typ', fmt: (v) => (v ? 'Magnetplatte' : 'SSD / virtuell') }, { key: 'scheduler', label: 'Scheduler' },
        { key: 'rBps', label: 'Lesen', align: 'r', fmt: R }, { key: 'wBps', label: 'Schreiben', align: 'r', fmt: R },
        { key: 'rIops', label: 'Lese-IOPS', align: 'r', fmt: (v) => num(v, 1) }, { key: 'wIops', label: 'Schreib-IOPS', align: 'r', fmt: (v) => num(v, 1) },
        { key: 'rLat', label: 'Lese-Latenz', align: 'r', fmt: (v) => `${num(v, 2)} ms` }, { key: 'wLat', label: 'Schreib-Latenz', align: 'r', fmt: (v) => `${num(v, 2)} ms` },
        { key: 'util', label: 'Auslastung', align: 'r', fmt: (v) => meter(v, 100, { text: pct(v, 0) }) },
        { key: 'rTotal', label: 'Gelesen gesamt', align: 'r', fmt: B }, { key: 'wTotal', label: 'Geschrieben gesamt', align: 'r', fmt: B },
        { key: 'rIO', label: 'Lesevorgänge', align: 'r', fmt: (v) => num(v) }, { key: 'wIO', label: 'Schreibvorgänge', align: 'r', fmt: (v) => num(v) },
      ], sort: { key: 'dev', dir: 'asc' }, dense: true,
    });
    const fsTable = dataTable({
      columns: [
        { key: 'mount', label: 'Eingehängt unter', cls: 'tbl-title' }, { key: 'dev', label: 'Gerät' }, { key: 'type', label: 'Typ' },
        { key: 'total', label: 'Größe', align: 'r', fmt: B },
        { key: 'used', label: 'Belegt', align: 'r', sort: (r) => r.used / (r.used + r.avail), fmt: (v, r) => meter(v, v + r.avail, { text: `${B(v)} · ${num(ratio(v, v + r.avail), 1)} %` }) },
        { key: 'avail', label: 'Frei', align: 'r', fmt: B }, { key: 'reserved', label: 'Reserviert', align: 'r', fmt: B },
        { key: 'inodesUsed', label: 'Inodes belegt', align: 'r', sort: (r) => (r.inodes ? r.inodesUsed / r.inodes : 0), fmt: (v, r) => (r.inodes ? meter(v, r.inodes, { text: `${num(v)} von ${num(r.inodes)}` }) : '–') },
      ], sort: { key: 'mount', dir: 'asc' }, dense: true,
    });
    const fsDonuts = h('div', { class: 'grid s-12' });
    const growth = h('div', { class: 'muted' }, 'Wird berechnet …');

    root.append(grid(
      mk('r', 'Lesen', 'c1'), mk('w', 'Schreiben', 'c3'), mk('iops', 'IOPS', 'c5'), mk('lat', 'Latenz', 'c2'), mk('util', 'Ausgelastet', 'c4'), mk('free', 'Freier Platz /', 'c6'),
      thr.el, iops.el, lat.el, util.el, queue.el, psi.el,
      heading('Geräte', 'Alle physischen Datenträger mit ihren Zählern seit dem Systemstart.'),
      card({ span: 12 }, devTable.el),
      heading('Dateisysteme', 'Belegung, reservierter Platz (nur für root) und Inodes.'),
      fsDonuts,
      card({ span: 12 }, fsTable.el),
      heading('Wachstum'),
      used.el, inode.el,
      card({ title: 'Schätzung: wann ist / voll?', sub: 'Lineare Hochrechnung aus den Messwerten der letzten 24 Stunden. Nur ein Anhaltspunkt.', span: 12 }, growth)));

    const donuts = new Map();
    function onSample() {
      const s = store.last();
      const d = store.detail;
      if (!s) return;
      K.r.set({ value: R(s.dr).split(' ')[0], unit: R(s.dr).split(' ')[1], sub: `${num(s.dri, 1)} Vorgänge/s · Latenz ${num(s.drl, 2)} ms`, deltas: deltas(store, 'dr', R, deltaChip, 'none', 2048), spark: store.series('dr'), color: 'c1' });
      K.w.set({ value: R(s.dw).split(' ')[0], unit: R(s.dw).split(' ')[1], sub: `${num(s.dwi, 1)} Vorgänge/s · Latenz ${num(s.dwl, 2)} ms`, deltas: deltas(store, 'dw', R, deltaChip, 'none', 2048), spark: store.series('dw'), color: 'c3' });
      K.iops.set({ value: num(s.dri + s.dwi, 1), unit: '/s', sub: `${num(s.dri, 1)} lesen · ${num(s.dwi, 1)} schreiben`, spark: store.series('dri'), color: 'c5' });
      K.lat.set({ value: num(Math.max(s.drl, s.dwl), 2), unit: 'ms', sub: `Lesen ${num(s.drl, 2)} · Schreiben ${num(s.dwl, 2)} ms`, spark: store.series('dwl'), color: 'c2', level: levelOf(Math.max(s.drl, s.dwl), 20, 100) });
      K.util.set({ value: num(s.du, 1), unit: '%', sub: `Warteschlange ${num(s.dq, 2)} · I/O-Druck ${num(s.pi10, 2)} %`, deltas: deltas(store, 'du', (v) => `${num(v, 1)} pp`, deltaChip, 'down', 1), spark: store.series('du'), color: 'c4', level: levelOf(s.du, 70, 95) });
      const root = d && (d.fs.find((x) => x.mount === '/') || d.fs[0]);
      if (root) K.free.set({ value: B(root.avail), sub: `${num(ratio(root.used, root.used + root.avail), 1)} % belegt von ${B(root.total)}`, deltas: deltas(store, 'dsu', B, deltaChip, 'down', 1e6), spark: store.series('dsu'), color: 'c6', level: levelOf(ratio(root.used, root.used + root.avail), 80, 92) });
    }

    function onDetail() {
      const d = store.detail;
      if (!d) return;
      devTable.setRows(d.disks);
      fsTable.setRows(d.fs);
      const seen = new Set();
      for (const fsys of d.fs) {
        seen.add(fsys.mount);
        let dc = donuts.get(fsys.mount);
        if (!dc) { dc = donutCard({ title: fsys.mount, sub: `${fsys.dev} · ${fsys.type}`, span: 3, fmt: B, size: 120 }); fsDonuts.append(dc.el); donuts.set(fsys.mount, dc); }
        dc.donut.update([{ id: 'u', label: 'Belegt', value: fsys.used, color: fsys.persistent ? 'c1' : 'c6' }, { id: 'r', label: 'Reserviert', value: fsys.reserved, color: 'c3' }, { id: 'a', label: 'Frei', value: fsys.avail, color: 'line' }], { value: `${num(ratio(fsys.used, fsys.used + fsys.avail), 0)} %`, label: B(fsys.total) });
      }
      for (const [m, dc] of donuts) if (!seen.has(m)) { dc.el.remove(); donuts.delete(m); }
      const root = d.fs.find((x) => x.mount === '/') || d.fs[0];
      const pts = store.t60.filter((p) => p.dsu != null && p.t > Date.now() - 86_400_000).map((p) => [p.t, p.dsu]);
      const sl = slope(pts);
      if (root && sl != null && pts.length > 30) {
        const perDay = sl * 86_400_000;
        const span = (pts[pts.length - 1][0] - pts[0][0]) / 3_600_000;
        growth.replaceChildren(kv([
          ['Veränderung pro Tag (Trend)', `${perDay >= 0 ? '+' : '−'}${B(Math.abs(perDay))}`], ['Gemessen über', `${num(span, 1)} Stunden (${pts.length} Messpunkte)`],
          ['Freier Platz jetzt', B(root.avail)],
          ['Voll in etwa', perDay > 1e6 ? dur((root.avail / perDay) * 86400, 2) : 'wächst nicht (merklich)'],
        ]));
      } else growth.textContent = 'Zu wenig Messdaten für eine Schätzung. Nach etwa 30 Minuten gibt es erste Werte.';
    }

    ctx.on('sample', onSample);
    ctx.on('detail', onDetail);
    ctx.on('range', () => { onSample(); onDetail(); });
    onSample(); onDetail();
  },
};
