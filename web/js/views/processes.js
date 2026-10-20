import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, dataTable, meter, badge } from '../widgets.js';
import { num, B, dur, pct } from '../fmt.js';
import { f, ratio } from './common.js';
import { procBtn } from '../interact.js';

const STATE = { R: ['Läuft', 'c1'], S: ['Schläft', 'c6'], D: ['Wartet auf I/O', 'c3'], Z: ['Zombie', 'c4'], T: ['Gestoppt', 'c8'], t: ['Debug-Stopp', 'c5'], I: ['Leerlauf (Kernel)', 'c9'], X: ['Beendet', 'c10'], P: ['Geparkt', 'c2'] };

export default {
  id: 'processes', title: 'Prozesse', group: 'Verwalten', icon: 'process', desc: 'Alle laufenden Prozesse: ansehen, beenden, anhalten', keywords: 'kill task manager',
  mount(root, ctx) {
    const { store } = ctx;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2 }); return K[id].el; };

    const cnt = chartCard({ title: 'Prozesse und Threads', span: 6, series: [{ key: 'proc', label: 'Prozesse', color: 'c1', fmt: f.int }, { key: 'thr', label: 'Threads', color: 'c3', fmt: f.int }], fmt: f.int, floor: 100, height: 200 });
    const fd = chartCard({ title: 'Offene Dateien (Dateideskriptoren)', span: 6, mode: 'area', series: [{ key: 'fd', label: 'Belegt', color: 'c5', fmt: f.int }], fmt: f.int, floor: 500, height: 200 });
    [cnt, fd].forEach((c) => ctx.own(c.chart));

    const dState = donutCard({ title: 'Prozess-Zustände', span: 3, fmt: f.int, size: 130 });
    const dUser = donutCard({ title: 'RAM nach Benutzer', span: 3, fmt: B, size: 130 });
    const dCpu = donutCard({ title: 'CPU nach Dienst', sub: 'Prozent eines Kerns', span: 3, fmt: (v) => `${num(v, 1)} %`, size: 130 });
    const dMem = donutCard({ title: 'RAM nach Dienst', span: 3, fmt: B, size: 130 });

    const procTable = dataTable({
      columns: [
        { key: 'pid', label: 'PID', align: 'r' }, { key: 'name', label: 'Prozess', cls: 'tbl-title' },
        { key: 'group', label: 'Dienst / Container', fmt: (v) => v || '–' }, { key: 'user', label: 'Benutzer' },
        { key: 'state', label: 'Zustand', fmt: (v) => (STATE[v] ? STATE[v][0] : v) },
        { key: 'cpu', label: 'CPU', align: 'r', fmt: (v) => meter(v, 100, { text: `${num(v, 1)} %`, tone: 'info' }) },
        { key: 'rss', label: 'RAM (RSS)', align: 'r', fmt: (v) => meter(v, store.info.ram, { text: B(v), tone: 'info' }) },
        { key: 'threads', label: 'Threads', align: 'r' }, { key: 'cpuTime', label: 'CPU-Zeit', align: 'r', fmt: (v) => dur(v, 2) }, { key: 'age', label: 'Läuft seit', align: 'r', fmt: (v) => dur(v, 2) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => procBtn(r, () => setTimeout(loadList, 700)) },
      ],
      search: true, searchPlaceholder: 'Name, PID, Benutzer, Dienst …', sort: { key: 'cpu', dir: 'desc' }, dense: true, pageSize: 80,
      filters: [{ label: 'Alle' }, { label: 'Aktiv', fn: (r) => r.cpu > 0.05 }, { label: 'Nicht root', fn: (r) => r.user !== 'root' }, { label: 'Dienste', fn: (r) => r.groupKind === 'service' }, { label: 'Container', fn: (r) => r.groupKind === 'docker' }],
    });
    const nameTable = dataTable({
      columns: [{ key: 'name', label: 'Programm', cls: 'tbl-title' }, { key: 'count', label: 'Anzahl', align: 'r' }, { key: 'rss', label: 'RAM gesamt', align: 'r', fmt: B }, { key: 'cpu', label: 'CPU gesamt', align: 'r', fmt: (v) => `${num(v, 1)} %` }],
      sort: { key: 'rss', dir: 'desc' }, dense: true, pageSize: 15,
    });
    const userTable = dataTable({
      columns: [{ key: 'user', label: 'Benutzer', cls: 'tbl-title' }, { key: 'count', label: 'Prozesse', align: 'r' }, { key: 'rss', label: 'RAM gesamt', align: 'r', fmt: B }, { key: 'cpu', label: 'CPU gesamt', align: 'r', fmt: (v) => `${num(v, 1)} %` }],
      sort: { key: 'rss', dir: 'desc' }, dense: true, pageSize: 15,
    });
    const groupTable = dataTable({
      columns: [{ key: 'name', label: 'Dienst / Container', cls: 'tbl-title' }, { key: 'kind', label: 'Art', fmt: (v) => ({ service: 'Dienst', docker: 'Container', session: 'Sitzung' }[v] || v || '–') }, { key: 'count', label: 'Prozesse', align: 'r' }, { key: 'rss', label: 'RAM gesamt', align: 'r', fmt: B }, { key: 'cpu', label: 'CPU gesamt', align: 'r', fmt: (v) => `${num(v, 1)} %` }],
      sort: { key: 'rss', dir: 'desc' }, dense: true, pageSize: 15,
    });

    root.append(grid(
      mk('total', 'Prozesse gesamt', 'c1'), mk('run', 'Laufend', 'c2'), mk('thr', 'Threads', 'c3'), mk('zomb', 'Zombies', 'c4'), mk('kern', 'Kernel-Threads', 'c6'), mk('fd', 'Offene Dateien', 'c5'),
      cnt.el, fd.el,
      dState.el, dUser.el, dCpu.el, dMem.el,
      heading('Alle Prozesse', 'Aktualisiert alle 3 Sekunden. Spalten anklicken zum Sortieren. Die Zuordnung zu Dienst oder Container stammt aus den cgroups.'),
      card({ span: 12 }, procTable.el),
      heading('Zusammengefasst'),
      card({ title: 'Nach Programm', span: 4 }, nameTable.el), card({ title: 'Nach Benutzer', span: 4 }, userTable.el), card({ title: 'Nach Dienst / Container', span: 4 }, groupTable.el)));

    function onSample() {
      const s = store.last();
      const d = store.detail;
      if (!s) return;
      const st = d && d.procs ? d.procs.states : {};
      K.total.set({ value: num(s.proc), sub: `${d && d.procs ? num(d.procs.userProcs) : '–'} Programme · ${d && d.procs ? num(d.procs.kernel) : '–'} Kernel`, spark: store.series('proc'), color: 'c1' });
      K.run.set({ value: String(s.run), sub: `${s.blk} blockiert · ${num(s.fork, 1)} neue/s`, spark: store.series('run'), color: 'c2' });
      K.thr.set({ value: num(s.thr), sub: s.proc ? `Ø ${num(s.thr / s.proc, 1)} je Prozess` : '', spark: store.series('thr'), color: 'c3' });
      K.zomb.set({ value: String(st.Z || 0), sub: (st.Z || 0) > 0 ? 'beendete Prozesse warten auf ihr Elternteil' : 'keine', level: (st.Z || 0) > 5 ? 'warn' : 'ok', color: 'c4', spark: [] });
      K.kern.set({ value: d && d.procs ? num(d.procs.kernel) : '–', sub: 'Threads des Betriebssystems', color: 'c6', spark: [] });
      const lim = d ? d.sys.limits : null;
      K.fd.set({ value: num(s.fd), sub: lim ? (lim.fdMax > 1e15 ? 'Limit: unbegrenzt' : `${num(ratio(s.fd, lim.fdMax), 3)} % von ${num(lim.fdMax)}`) : '', spark: store.series('fd'), color: 'c5' });
    }

    function onDetail() {
      const d = store.detail;
      if (!d || !d.procs) return;
      const p = d.procs;
      dState.donut.update(Object.entries(p.states).map(([k, v]) => ({ id: k, label: (STATE[k] || [k])[0], value: v, color: (STATE[k] || [null, 'c6'])[1] })), { value: num(p.total), label: 'Prozesse' });
      dUser.donut.update(p.byUser.slice(0, 7).map((u, i) => ({ id: u.user, label: u.user, value: u.rss, color: `c${(i % 10) + 1}` })), { value: B(p.byUser.reduce((a, b) => a + b.rss, 0)), label: 'RAM' });
      const byCpu = p.byGroup.slice().sort((a, b) => b.cpu - a.cpu);
      dCpu.donut.update(byCpu.slice(0, 7).filter((x) => x.cpu > 0).map((x, i) => ({ id: x.name, label: x.name, value: x.cpu, color: `c${(i % 10) + 1}` })), { value: `${num(byCpu.reduce((a, b) => a + b.cpu, 0), 0)} %`, label: 'Summe' });
      dMem.donut.update(p.byGroup.slice(0, 7).map((x, i) => ({ id: x.name, label: x.name, value: x.rss, color: `c${(i % 10) + 1}` })), { value: B(p.byGroup.reduce((a, b) => a + b.rss, 0)), label: 'RAM' });
      nameTable.setRows(p.byName); userTable.setRows(p.byUser); groupTable.setRows(p.byGroup);
    }

    async function loadList() {
      try { const r = await ctx.api.get('/api/processes'); procTable.setRows(r.list); } catch {}
    }

    ctx.on('sample', onSample);
    ctx.on('detail', onDetail);
    ctx.on('range', onSample);
    ctx.every(loadList, 3000);
    onSample(); onDetail(); loadList();
  },
};
