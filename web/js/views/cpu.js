import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, deltaChip, dataTable, meter, kv } from '../widgets.js';
import { Heatmap } from '../charts.js';
import { num, B, dur, pct, stats } from '../fmt.js';
import { f, CPU_SERIES, cpuDonut, deltas, levelOf } from './common.js';
import { procBtn } from '../interact.js';

const TIME_KEYS = [['user', 'Benutzer', 'c1'], ['nice', 'Nice', 'c9'], ['system', 'System', 'c3'], ['irq', 'IRQ', 'c5'], ['softirq', 'SoftIRQ', 'c8'], ['iowait', 'I/O-Wait', 'c4'], ['steal', 'Steal', 'c6'], ['idle', 'Leerlauf', 'line']];

export default {
  id: 'cpu', title: 'CPU', group: 'Messwerte', icon: 'cpu', desc: 'Auslastung, Load und einzelne Kerne', keywords: 'prozessor kerne load',
  mount(root, ctx) {
    const { store } = ctx;
    const cores = store.info.cores;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2 }); return K[id].el; };

    const stack = chartCard({ title: 'CPU-Auslastung nach Art', sub: 'Gestapelt, Prozent aller Kerne zusammen', span: 8, mode: 'stacked', series: CPU_SERIES, fmt: f.pct, yMax: 100, markers: true, height: 260, statsOpen: true });
    const dNow = donutCard({ title: 'CPU-Zeit jetzt', sub: 'Anteil der letzten Sekunde', span: 4, fmt: (v) => `${num(v, 1)} %`, size: 160 });
    const perCore = chartCard({ title: 'Auslastung pro Kern', sub: 'Jeder Kern einzeln. Bei 10 Min über 5 Sekunden geglättet, Tooltip und Statistik zeigen die echten Werte.', span: 12, mode: 'line', series: Array.from({ length: cores }, (_, i) => ({ key: `c${i}`, label: `Kern ${i}`, color: `c${(i % 10) + 1}`, fmt: f.pct })), fmt: f.pct, yMax: 100, smooth: 5, height: 240 });
    const heat = new Heatmap(h('div'), { rows: cores, label: (i) => `Kern ${i}`, key: (i) => `c${i}`, height: 40 + cores * 26 });
    ctx.own(heat);
    const load = chartCard({ title: 'Load Average', sub: 'Durchschnittliche Zahl wartender und laufender Prozesse über 1, 5 und 15 Minuten', span: 6, series: [{ key: 'l1', label: '1 Minute', color: 'c1', fmt: f.d2 }, { key: 'l5', label: '5 Minuten', color: 'c3', fmt: f.d2 }, { key: 'l15', label: '15 Minuten', color: 'c5', fmt: f.d2 }], fmt: f.d2, lines: [{ y: cores, label: `${cores} Kerne`, color: 'crit' }], floor: cores, height: 220 });
    const psi = chartCard({ title: 'CPU-Druck (PSI)', sub: 'Anteil der Zeit, in dem Prozesse auf CPU warten müssen (10, 60, 300 Sek)', span: 6, series: [{ key: 'pc10', label: 'Ø 10 Sek', color: 'c1', fmt: f.pct2 }, { key: 'pc60', label: 'Ø 60 Sek', color: 'c3', fmt: f.pct2 }, { key: 'pc300', label: 'Ø 300 Sek', color: 'c5', fmt: f.pct2 }], fmt: f.pct, floor: 5, height: 220 });
    const ctxChart = chartCard({ title: 'Kontextwechsel und Interrupts', sub: 'Pro Sekunde', span: 6, series: [{ key: 'ctx', label: 'Kontextwechsel/s', color: 'c1', fmt: f.int }, { key: 'intr', label: 'Interrupts/s', color: 'c3', fmt: f.int }], fmt: f.int, floor: 1000, height: 200 });
    const procChart = chartCard({ title: 'Prozess-Aktivität', sub: 'Laufende, blockierte Prozesse und neue Prozesse pro Sekunde', span: 6, series: [{ key: 'run', label: 'Laufend', color: 'c1', fmt: f.int }, { key: 'blk', label: 'Blockiert (I/O)', color: 'c4', fmt: f.int }, { key: 'fork', label: 'Neue Prozesse/s', color: 'c2', fmt: f.d1 }], fmt: f.d1, floor: 4, height: 200 });
    [stack, perCore, load, psi, ctxChart, procChart].forEach((c) => ctx.own(c.chart));

    const dBoot = donutCard({ title: 'CPU-Zeit seit Systemstart', sub: 'Summe aller Kerne', span: 4, fmt: (v) => dur(v, 2), size: 160 });
    const timesTable = dataTable({
      columns: [
        { key: 'name', label: 'Kern', sort: (r) => r.idx },
        ...TIME_KEYS.map(([k, l]) => ({ key: k, label: l, align: 'r', fmt: (v) => dur(v, 3) })),
        { key: 'busy', label: 'Ausgelastet', align: 'r', fmt: (v) => meter(v, 100, { text: pct(v) }) },
      ],
      sort: { key: 'name', dir: 'asc' }, dense: true,
    });
    const topTable = dataTable({
      columns: [
        { key: 'pid', label: 'PID', align: 'r' }, { key: 'name', label: 'Prozess', cls: 'tbl-title' }, { key: 'group', label: 'Dienst / Container', fmt: (v) => v || '–' },
        { key: 'user', label: 'Benutzer' }, { key: 'cpu', label: 'CPU', align: 'r', fmt: (v) => meter(v, 100, { text: `${num(v, 1)} %`, tone: 'info' }) },
        { key: 'cpuTime', label: 'CPU-Zeit', align: 'r', fmt: (v) => dur(v, 2) }, { key: 'rss', label: 'RAM', align: 'r', fmt: B },
        { key: 'threads', label: 'Threads', align: 'r' }, { key: 'age', label: 'Läuft seit', align: 'r', fmt: (v) => dur(v, 2) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => procBtn(r) },
      ],
      sort: { key: 'cpu', dir: 'desc' }, dense: true, pageSize: 50,
    });
    const info = h('div');

    root.append(grid(
      mk('cpu', 'Auslastung', 'c1'), mk('clock', 'Takt', 'c3'), mk('load', 'Load (1 Min)', 'c5'), mk('run', 'Laufende Prozesse', 'c2'), mk('ctx', 'Kontextwechsel', 'c9'), mk('psi', 'CPU-Druck (10 Sek)', 'c4'),
      stack.el, dNow.el,
      perCore.el,
      card({ title: 'Kerne über die Zeit', sub: 'Heller = weniger, kräftig bis rot = mehr Last. Jede Zeile ein Kern.', span: 12 }, heat.host),
      load.el, psi.el, ctxChart.el, procChart.el,
      heading('Zeiten seit dem Systemstart', 'Aus /proc/stat: so lange war die CPU insgesamt in welchem Zustand.'),
      dBoot.el, card({ title: 'Zeiten pro Kern', sub: 'Summe seit dem Start des Servers', span: 8 }, timesTable.el),
      heading('Prozesse mit der meisten CPU-Last'),
      card({ span: 12 }, topTable.el),
      card({ title: 'Prozessor', span: 12 }, info)));

    function onSample() {
      const s = store.last();
      const d = store.detail;
      if (!s) return;
      const mhz = d && d.cpu.mhz.length ? d.cpu.mhz.reduce((a, b) => a + b, 0) / d.cpu.mhz.length : null;
      K.cpu.set({ value: num(s.cpu, 1), unit: '%', sub: `Benutzer ${num(s.cu, 1)} · System ${num(s.cs, 1)} %`, deltas: deltas(store, 'cpu', (v) => `${num(v, 1)} pp`, deltaChip, 'down', 0.5), spark: store.series('cpu'), level: levelOf(s.cpu, 70, 90), color: 'c1' });
      K.clock.set({ value: mhz ? num(mhz, 0) : '–', unit: 'MHz', sub: d ? `${cores} Kerne · ${d.cpu.cache || ''} Cache` : '' });
      K.load.set({ value: num(s.l1, 2), sub: `5 Min ${num(s.l5, 2)} · 15 Min ${num(s.l15, 2)}`, deltas: deltas(store, 'l1', (v) => num(v, 2), deltaChip, 'down', 0.05), spark: store.series('l1'), color: 'c5', level: levelOf(s.l1 / cores, 0.8, 1.5) });
      K.run.set({ value: String(s.run), sub: `${s.blk} blockiert · ${num(s.proc)} gesamt · ${num(s.thr)} Threads`, spark: store.series('run'), color: 'c2' });
      K.ctx.set({ value: num(s.ctx), unit: '/s', sub: `${num(s.intr)} Interrupts/s · ${num(s.fork, 1)} neue Prozesse/s`, deltas: deltas(store, 'ctx', (v) => num(v, 0), deltaChip, 'none', 100), spark: store.series('ctx'), color: 'c9' });
      K.psi.set({ value: num(s.pc10, 2), unit: '%', sub: `60 Sek ${num(s.pc60, 2)} % · 300 Sek ${num(s.pc300, 2)} %`, spark: store.series('pc10'), color: 'c4', level: levelOf(s.pc10, 20, 50) });
      dNow.donut.update(cpuDonut(s), { value: `${num(s.cpu, 0)} %`, label: 'belegt' });
    }

    function onDetail() {
      const d = store.detail;
      if (!d) return;
      const t = d.cpu.times;
      dBoot.donut.update(TIME_KEYS.map(([k, l, c]) => ({ id: k, label: l, value: t[k], color: c })), { value: dur(Object.values(t).reduce((a, b) => a + b, 0) / cores, 1), label: 'Laufzeit je Kern' });
      const row = (name, idx, c, n) => ({ name, idx, ...c, busy: ((c.user + c.nice + c.system + c.irq + c.softirq + c.steal) / (c.user + c.nice + c.system + c.idle + c.iowait + c.irq + c.softirq + c.steal)) * 100 });
      timesTable.setRows([row('Alle Kerne', -1, t), ...d.cpu.cores.map((c, i) => row(`Kern ${i}`, i, c))]);
      if (d.procs) topTable.setRows(d.procs.topCpu);
      info.replaceChildren(kv([
        ['Modell', d.sys.cpuinfo.model || store.info.cpu], ['Kerne', String(cores)], ['Cache', d.sys.cpuinfo.cache], ['Taktfrequenzen', d.cpu.mhz.map((m) => `${num(m, 0)} MHz`).join(' · ')],
        ['CPU-Flags', `${d.sys.cpuinfo.flags} Merkmale`], ['Kontextwechsel gesamt', num(d.cpu.ctxt)], ['Interrupts gesamt', num(d.cpu.intr)], ['Prozesse erzeugt', num(d.cpu.forks)],
        ['Pressure-Zeit (some)', `${num(d.psi.cpu.some.total / 1e6, 0)} s seit Start`, 'Gesamtzeit, in der mindestens ein Prozess auf CPU wartete'],
        ['Letzter Systemstart', new Date(d.cpu.btime * 1000).toLocaleString('de-AT', { timeZone: 'Europe/Vienna' })],
      ], 'cols2'));
    }

    ctx.on('sample', onSample);
    ctx.on('detail', onDetail);
    ctx.on('range', onSample);
    onSample(); onDetail();
  },
};
