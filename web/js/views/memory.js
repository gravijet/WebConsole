import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, deltaChip, dataTable, meter } from '../widgets.js';
import { num, B, R, dur, pct } from '../fmt.js';
import { f, MEM_SERIES, memDonut, deltas, levelOf, ratio } from './common.js';
import { procBtn } from '../interact.js';

const HUGE = /^HugePages_/;
const NO_SHARE = /^(Vmalloc|DirectMap|CommitLimit|Committed_AS|Swap|HugePages)/;

export default {
  id: 'memory', title: 'Arbeitsspeicher', group: 'Messwerte', icon: 'memory', desc: 'RAM, Swap, Cache und Speicherdruck', keywords: 'ram swap speicher',
  mount(root, ctx) {
    const { store } = ctx;
    const total = () => store.info.ram;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2 }); return K[id].el; };

    const stack = chartCard({ title: 'Arbeitsspeicher über die Zeit', sub: 'Belegt, Puffer, Cache und frei ergeben zusammen den gesamten RAM', span: 8, mode: 'stacked', series: MEM_SERIES, fmt: f.bytes, base: 1024, yMax: total, markers: true, height: 260, statsOpen: true });
    const dRam = donutCard({ title: 'Aufteilung jetzt', sub: 'Wohin der RAM gerade geht', span: 4, fmt: B, size: 160 });
    const avail = chartCard({ title: 'Verfügbarer Speicher', sub: 'Was Programme sofort bekommen könnten, inklusive freigebbarem Cache', span: 6, mode: 'area', series: [{ key: 'ma', label: 'Verfügbar', color: 'c7' }, { key: 'mu', label: 'Belegt', color: 'c1' }], fmt: f.bytes, base: 1024, yMax: total, height: 210 });
    const swap = chartCard({ title: 'Swap', sub: 'Auf die Platte ausgelagerter Speicher', span: 6, mode: 'area', series: [{ key: 'su', label: 'Belegt', color: 'c3' }, { key: 'sc', label: 'Im RAM zwischengespeichert', color: 'c5' }], fmt: f.bytes, base: 1024, floor: 1 << 28, height: 210 });
    const paging = chartCard({ title: 'Swap-Aktivität', sub: 'Seiten pro Sekunde, die ein- bzw. ausgelagert werden', span: 6, series: [{ key: 'swin', label: 'Eingelagert (swap in)', color: 'c1', fmt: f.pages }, { key: 'swout', label: 'Ausgelagert (swap out)', color: 'c4', fmt: f.pages }], fmt: f.ps, floor: 10, height: 200 });
    const faults = chartCard({ title: 'Seitenfehler', sub: 'Normale (minor) und Plattenzugriffe (major) pro Sekunde', span: 6, series: [{ key: 'pgf', label: 'Minor/s', color: 'c1', fmt: f.int }, { key: 'pgmaj', label: 'Major/s', color: 'c4', fmt: f.d1 }], fmt: f.ps, floor: 100, height: 200 });
    const psi = chartCard({ title: 'Speicherdruck (PSI)', sub: 'Zeitanteil, in dem Prozesse auf Speicher warten (some) bzw. alle blockiert sind (full)', span: 6, series: [{ key: 'pm10', label: 'some Ø 10 Sek', color: 'c3', fmt: f.pct2 }, { key: 'pm60', label: 'some Ø 60 Sek', color: 'c1', fmt: f.pct2 }, { key: 'pm300', label: 'some Ø 300 Sek', color: 'c5', fmt: f.pct2 }, { key: 'pmf10', label: 'full Ø 10 Sek', color: 'c4', fmt: f.pct2 }], fmt: f.pct, floor: 2, height: 200 });
    const disk = chartCard({ title: 'Paging und Speicherbereinigung', sub: 'Gelesen/geschrieben über die Platte, gescannte Seiten bei Speichermangel', span: 6, series: [{ key: 'pgin', label: 'Von Platte gelesen', color: 'c1', fmt: f.rate }, { key: 'pgout', label: 'Auf Platte geschrieben', color: 'c3', fmt: f.rate }], fmt: f.rate, base: 1024, floor: 10240, height: 200 });
    const scan = chartCard({ title: 'Reclaim-Scan', sub: 'Seiten, die der Kernel pro Sekunde nach freigebbarem Speicher durchsucht', span: 6, series: [{ key: 'scan', label: 'Seiten/s', color: 'c5', fmt: f.int }], fmt: f.ps, floor: 100, height: 180 });
    const kern = chartCard({ title: 'Speicher-Kategorien', sub: 'Wofür der Kernel den Speicher verwendet', span: 12, series: [
      { key: 'manon', label: 'Anonym (Heap/Stack)', color: 'c1' }, { key: 'mmap', label: 'Gemappt (Dateien)', color: 'c2' }, { key: 'msh', label: 'Shared Memory', color: 'c5' },
      { key: 'msl', label: 'Slab (Kernel)', color: 'c3' }, { key: 'mpt', label: 'Seitentabellen', color: 'c8' }, { key: 'mdirty', label: 'Dirty (noch nicht geschrieben)', color: 'c4' },
      { key: 'mact', label: 'Aktiv', color: 'c9', hidden: true }, { key: 'minact', label: 'Inaktiv', color: 'c6', hidden: true },
    ], fmt: f.bytes, base: 1024, floor: 1 << 24, height: 260 });
    [stack, avail, swap, paging, faults, psi, disk, scan, kern].forEach((c) => ctx.own(c.chart));

    const dSwap = donutCard({ title: 'Swap', span: 4, fmt: B, size: 140 });
    const dCommit = donutCard({ title: 'Zugesagter Speicher', sub: 'Committed_AS im Verhältnis zum Limit', span: 4, fmt: B, size: 140 });
    const dUser = donutCard({ title: 'RAM nach Benutzer', span: 4, fmt: B, size: 140 });
    const dGroup = donutCard({ title: 'RAM nach Dienst / Container', sub: 'Resident Set Size der Prozesse', span: 6, fmt: B, size: 150 });
    const dName = donutCard({ title: 'RAM nach Programm', sub: 'Gleichnamige Prozesse zusammengefasst', span: 6, fmt: B, size: 150 });

    const procTable = dataTable({
      columns: [
        { key: 'pid', label: 'PID', align: 'r' }, { key: 'name', label: 'Prozess', cls: 'tbl-title' }, { key: 'group', label: 'Dienst / Container', fmt: (v) => v || '–' }, { key: 'user', label: 'Benutzer' },
        { key: 'rss', label: 'RAM (RSS)', align: 'r', fmt: (v) => meter(v, store.info.ram, { text: B(v), tone: 'info' }) },
        { key: 'cpu', label: 'CPU', align: 'r', fmt: (v) => `${num(v, 1)} %` }, { key: 'threads', label: 'Threads', align: 'r' }, { key: 'age', label: 'Läuft seit', align: 'r', fmt: (v) => dur(v, 2) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => procBtn(r) },
      ],
      sort: { key: 'rss', dir: 'desc' }, dense: true, pageSize: 50,
    });
    const rawTable = dataTable({
      columns: [
        { key: 'key', label: 'Eintrag in /proc/meminfo', cls: 'tbl-title' },
        { key: 'human', label: 'Wert', align: 'r', sort: (r) => r.value },
        { key: 'value', label: 'Rohwert', align: 'r', fmt: (v, r) => (r.count ? num(v) : `${num(v)} Byte`) },
        { key: 'pct', label: 'Anteil am RAM', align: 'r', fmt: (v) => (v == null ? '–' : `${num(v, 2)} %`) },
      ],
      search: true, searchPlaceholder: 'meminfo durchsuchen …', sort: { key: 'value', dir: 'desc' }, dense: true, pageSize: 100,
    });

    root.append(grid(
      mk('used', 'Belegt', 'c1'), mk('avail', 'Verfügbar', 'c7'), mk('cache', 'Cache + Puffer', 'c2'), mk('swap', 'Swap belegt', 'c3'), mk('psi', 'Speicherdruck (10 Sek)', 'c4'), mk('maj', 'Major Faults', 'c5'),
      stack.el, dRam.el, avail.el, swap.el, paging.el, faults.el, psi.el, disk.el, scan.el,
      card({ title: 'Zugesagter Speicher (Overcommit)', sub: 'Programme dürfen mehr Speicher anfordern, als physisch vorhanden ist', span: 6 }, h('div', { class: 'muted', id: 'commit-note' }, 'Wird berechnet …')),
      kern.el,
      heading('Wer belegt den Speicher?'),
      dSwap.el, dCommit.el, dUser.el, dGroup.el, dName.el,
      card({ title: 'Prozesse nach Speicherverbrauch', span: 12 }, procTable.el),
      heading('Alle Werte', 'Vollständige Liste aus /proc/meminfo, wird alle 5 Sekunden aktualisiert.'),
      card({ span: 12 }, rawTable.el)));

    function onSample() {
      const s = store.last();
      if (!s) return;
      const t = total();
      const cacheAll = s.mc + s.mb;
      K.used.set({ value: B(s.mu), sub: `${num(ratio(s.mu, t), 1)} % von ${B(t)}`, deltas: deltas(store, 'mu', B, deltaChip, 'down', 20e6), spark: store.series('mu'), color: 'c1', level: levelOf(100 - ratio(s.ma, t), 80, 92) });
      K.avail.set({ value: B(s.ma), sub: `${num(ratio(s.ma, t), 1)} % des RAM nutzbar`, deltas: deltas(store, 'ma', B, deltaChip, 'up', 20e6), spark: store.series('ma'), color: 'c7' });
      K.cache.set({ value: B(cacheAll), sub: `Cache ${B(s.mc)} · Puffer ${B(s.mb)}`, deltas: deltas(store, 'mc', B, deltaChip, 'none', 20e6), spark: store.series('mc'), color: 'c2' });
      const d = store.detail;
      const st = d ? d.mem.swapTotal : 0;
      K.swap.set({ value: B(s.su), sub: st ? `${num(ratio(s.su, st), 1)} % von ${B(st)}` : 'kein Swap', deltas: deltas(store, 'su', B, deltaChip, 'down', 20e6), spark: store.series('su'), color: 'c3', level: st ? levelOf(ratio(s.su, st), 60, 85) : '' });
      K.psi.set({ value: num(s.pm10, 2), unit: '%', sub: `full ${num(s.pmf10, 2)} % · 60 Sek ${num(s.pm60, 2)} %`, spark: store.series('pm10'), color: 'c4', level: levelOf(s.pmf10, 1, 5) });
      K.maj.set({ value: num(s.pgmaj, 1), unit: '/s', sub: `${num(s.pgf)} Minor/s · swap in ${num(s.swin, 1)}, out ${num(s.swout, 1)}`, spark: store.series('pgmaj'), color: 'c5' });
      dRam.donut.update(memDonut(s), { value: B(s.mu), label: `von ${B(t)}` });
    }

    function onDetail() {
      const d = store.detail;
      if (!d) return;
      const m = d.mem;
      dSwap.donut.update([{ id: 'u', label: 'Belegt', value: m.swapUsed, color: 'c3' }, { id: 'f', label: 'Frei', value: Math.max(0, m.swapTotal - m.swapUsed), color: 'line' }], { value: m.swapTotal ? `${num(ratio(m.swapUsed, m.swapTotal), 0)} %` : '–', label: m.swapTotal ? `von ${B(m.swapTotal)}` : 'kein Swap' });
      dCommit.donut.update([{ id: 'c', label: 'Zugesagt', value: m.commit, color: 'c5' }, { id: 'r', label: 'Bis zum Limit', value: Math.max(0, m.commitLimit - m.commit), color: 'line' }], { value: `${num(ratio(m.commit, m.commitLimit), 0)} %`, label: `Limit ${B(m.commitLimit)}` });
      const note = document.getElementById('commit-note');
      if (note) note.textContent = `Zugesagt: ${B(m.commit)} bei einem Limit von ${B(m.commitLimit)} (${num(ratio(m.commit, m.commitLimit), 1)} %). Physisch vorhanden: ${B(store.info.ram)}. ${m.commit > store.info.ram ? 'Mehr zugesagt als physisch da ist: bei Bedarf wird auf Swap ausgewichen. Das ist unter Linux normal.' : 'Weniger zugesagt als physisch vorhanden.'}`;
      if (d.procs) {
        dUser.donut.update(d.procs.byUser.slice(0, 7).map((u, i) => ({ id: u.user, label: u.user, value: u.rss, color: `c${(i % 10) + 1}` })), { value: B(d.procs.byUser.reduce((a, b) => a + b.rss, 0)), label: 'Prozesse' });
        const g = d.procs.byGroup;
        const top = g.slice(0, 9);
        const rest = g.slice(9).reduce((a, b) => a + b.rss, 0);
        dGroup.donut.update([...top.map((x, i) => ({ id: x.name, label: x.name, value: x.rss, color: `c${(i % 10) + 1}` })), ...(rest ? [{ id: '_rest', label: 'Übrige', value: rest, color: 'line' }] : [])], { value: B(g.reduce((a, b) => a + b.rss, 0)), label: 'gesamt' });
        const n = d.procs.byName;
        dName.donut.update(n.slice(0, 9).map((x, i) => ({ id: x.name, label: `${x.name}${x.count > 1 ? ` × ${x.count}` : ''}`, value: x.rss, color: `c${(i % 10) + 1}` })), { value: B(n.reduce((a, b) => a + b.rss, 0)), label: 'gesamt' });
        procTable.setRows(d.procs.topMem);
      }
    }

    async function loadRaw() {
      try {
        const r = await ctx.api.get('/api/raw');
        const t = store.info.ram;
        rawTable.setRows(Object.entries(r.meminfo).map(([key, value]) => {
          const count = HUGE.test(key);
          return { key, value, count, human: count ? num(value) : B(value), pct: count || NO_SHARE.test(key) ? null : ratio(value, t) };
        }));
      } catch {}
    }

    ctx.on('sample', onSample);
    ctx.on('detail', onDetail);
    ctx.on('range', onSample);
    ctx.every(loadRaw, 5000);
    onSample(); onDetail(); loadRaw();
  },
};
