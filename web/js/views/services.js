import { h, icon } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, dataTable, meter, badge, status, toast } from '../widgets.js';
import { num, B, R, dur, pct, tShort } from '../fmt.js';
import { f, ratio } from './common.js';
import { unitBtn, daemonReload, unitDetail } from '../interact.js';

const stateBadge = (r) => {
  if (r.active === 'failed') return badge('fehlgeschlagen', 'crit');
  if (r.active === 'active' && r.sub === 'running') return badge('läuft', 'ok');
  if (r.active === 'active') return badge(`aktiv (${r.sub})`, 'info');
  if (r.active === 'activating' || r.active === 'deactivating' || r.active === 'reloading') return badge(r.active, 'warn');
  return badge(`${r.active}`, 'neutral');
};
const shortImage = (s) => (s || '').replace(/@sha256:[0-9a-f]+$/, '').replace(/^sha256:/, '') || '–';

export default {
  id: 'services', title: 'Dienste', group: 'Verwalten', icon: 'service', desc: 'systemd-Dienste starten, stoppen und konfigurieren', keywords: 'systemd units autostart restart',
  mount(root, ctx) {
    const { store } = ctx;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2, icon: { total: 'service', active: 'check', running: 'play', failed: 'warn', restarts: 'refresh', fail: 'warn' }[id] || 'service' }); return K[id].el; };

    const dMem = donutCard({ title: 'RAM nach Dienst', sub: 'Laut systemd/cgroup', span: 3, fmt: B, size: 130 });
    const dCpu = donutCard({ title: 'CPU nach Dienst', sub: 'Prozent eines Kerns', span: 3, fmt: (v) => `${num(v, 1)} %`, size: 130 });
    const dState = donutCard({ title: 'Zustände der Units', span: 3, fmt: f.int, size: 130 });
    const dRestart = donutCard({ title: 'Autostart', sub: 'Wie die Units beim Booten behandelt werden', span: 3, fmt: f.int, size: 130 });
    let list = [];
    const hide = async (id, on) => {
      const cur = new Set(store.settings.services.hidden);
      if (on) cur.add(id); else cur.delete(id);
      try { await store.saveSettings({ services: { hidden: [...cur] } }); toast(on ? `${id} ausgeblendet` : `${id} wieder sichtbar`); render(); } catch (e) { toast(e.message, 'crit'); }
    };
    const filters = [
      { label: 'Aktiv', fn: (r) => !r.hidden && r.active === 'active' },
      { label: 'Laufend', fn: (r) => !r.hidden && r.sub === 'running' },
      { label: 'Fehlgeschlagen', fn: (r) => !r.hidden && r.active === 'failed' },
      { label: 'Inaktiv', fn: (r) => !r.hidden && r.active === 'inactive' },
      { label: 'Alle', fn: (r) => !r.hidden },
      { label: 'Ausgeblendet', fn: (r) => r.hidden },
    ];
    if (store.settings.services.showInactive) filters.unshift(filters.splice(4, 1)[0]);
    const svcTable = dataTable({
      columns: [
        { key: 'id', label: 'Dienst', cls: 'tbl-title' },
        { key: 'active', label: 'Zustand', sort: (r) => `${r.active}/${r.sub}`, fmt: (v, r) => stateBadge(r) },
        { key: 'enabled', label: 'Autostart', fmt: (v) => v || '–' },
        { key: 'pid', label: 'Haupt-PID', align: 'r', fmt: (v) => (v ? String(v) : '–') },
        { key: 'cpu', label: 'CPU', align: 'r', fmt: (v) => (v == null ? '–' : meter(v, 100, { text: `${num(v, 1)} %`, tone: 'info' })) },
        { key: 'mem', label: 'RAM', align: 'r', fmt: (v) => (v == null ? '–' : meter(v, store.info.ram, { text: B(v), tone: 'info' })) },
        { key: 'tasks', label: 'Tasks', align: 'r', fmt: (v) => (v == null ? '–' : num(v)) },
        { key: 'restarts', label: 'Neustarts', align: 'r', fmt: (v) => (v > 0 ? badge(String(v), 'warn') : '0') },
        { key: 'since', label: 'Läuft seit', align: 'r', fmt: (v) => (v == null ? '–' : dur(v, 2)) },
        { key: 'ioR', label: 'Gelesen', align: 'r', fmt: (v) => (v == null ? '–' : B(v)) }, { key: 'ioW', label: 'Geschrieben', align: 'r', fmt: (v) => (v == null ? '–' : B(v)) },
        { key: 'result', label: 'Ergebnis', fmt: (v, r) => (v ? badge(v, 'crit') : r.exit ? `Exit ${r.exit}` : '–') },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => unitBtn(r, () => setTimeout(load, 900), [{ label: r.hidden ? 'In den Listen einblenden' : 'In den Listen ausblenden', sub: 'nur Anzeige', onClick: () => hide(r.id, !r.hidden) }]) },
      ],
      search: true, searchPlaceholder: 'Dienst suchen …', sort: { key: 'mem', dir: 'desc' }, dense: true, pageSize: 60, filters,
      onRow: (r) => unitDetail(r.id, () => setTimeout(load, 900)),
      tools: h('button', { type: 'button', class: 'btn sm', title: 'Nach dem Ändern von Unit-Dateien nötig', onClick: () => daemonReload() }, icon('refresh', 14), 'systemd neu einlesen'),
      rowClass: (r) => (r.active === 'failed' ? 'row-bad' : ''),
    });
    root.append(grid(
      mk('total', 'Units gesamt', 'c1'), mk('active', 'Aktiv', 'c7'), mk('running', 'Laufend', 'c2'), mk('failed', 'Fehlgeschlagen', 'c4'), mk('restarts', 'Automatische Neustarts', 'c3'), mk('fail', 'Zuletzt fehlgeschlagen', 'c8'),
      dMem.el, dCpu.el, dState.el, dRestart.el,
      heading('Systemdienste (systemd)', 'Alle Services des Servers mit Ressourcenverbrauch laut cgroup. Zeile anklicken für Details, Unit-Datei und Protokoll.'),
      card({ span: 12 }, svcTable.el)));

    function render() {
      const hidden = new Set(store.settings.services.hidden);
      const rows = list.map((u) => ({ ...u, hidden: hidden.has(u.id) }));
      svcTable.setRows(rows);
      const vis = rows.filter((r) => !r.hidden);
      const sum = (k) => vis.reduce((a, b) => a + (b[k] || 0), 0);
      const byMem = vis.filter((r) => r.mem > 0).sort((a, b) => b.mem - a.mem);
      const topM = byMem.slice(0, 8);
      const restM = byMem.slice(8).reduce((a, b) => a + b.mem, 0);
      dMem.donut.update([...topM.map((r, i) => ({ id: r.id, label: r.id.replace(/\.service$/, ''), value: r.mem, color: `c${(i % 10) + 1}` })), ...(restM ? [{ id: '_', label: 'Übrige', value: restM, color: 'line' }] : [])], { value: B(byMem.reduce((a, b) => a + b.mem, 0)), label: 'RAM der Dienste' });
      const byCpu = vis.filter((r) => r.cpu > 0.01).sort((a, b) => b.cpu - a.cpu);
      dCpu.donut.update(byCpu.slice(0, 8).map((r, i) => ({ id: r.id, label: r.id.replace(/\.service$/, ''), value: r.cpu, color: `c${(i % 10) + 1}` })), { value: `${num(byCpu.reduce((a, b) => a + b.cpu, 0), 1)} %`, label: 'Summe' });
      const states = {};
      for (const r of vis) { const k = r.active === 'active' && r.sub === 'running' ? 'läuft' : r.active === 'active' ? `aktiv (${r.sub})` : r.active; states[k] = (states[k] || 0) + 1; }
      dState.donut.update(Object.entries(states).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ id: k, label: k, value: v, color: k === 'fehlgeschlagen' || k === 'failed' ? 'c4' : k === 'läuft' ? 'c7' : k === 'inactive' ? 'line' : `c${(i % 10) + 1}` })), { value: num(vis.length), label: 'Units' });
      K.total.set({ value: num(vis.length), sub: hidden.size ? `${hidden.size} ausgeblendet` : 'alle sichtbar', color: 'c1', spark: [] });
      K.active.set({ value: num(vis.filter((r) => r.active === 'active').length), sub: `${vis.filter((r) => r.active === 'inactive').length} inaktiv`, color: 'c7', spark: [] });
      K.running.set({ value: num(vis.filter((r) => r.sub === 'running').length), sub: `${vis.filter((r) => r.active === 'active' && r.sub !== 'running').length} beendet (oneshot)`, color: 'c2', spark: [] });
      const failed = vis.filter((r) => r.active === 'failed');
      K.failed.set({ value: String(failed.length), sub: failed.length ? failed.map((r) => r.id.replace(/\.service$/, '')).join(', ') : 'keine', level: failed.length ? 'crit' : 'ok', color: 'c4', spark: [] });
      const en = {}; for (const r of vis) { const k = r.enabled === 'enabled' ? 'aktiviert' : r.enabled === 'disabled' ? 'deaktiviert' : r.enabled === 'static' ? 'automatisch (static)' : r.enabled === 'masked' ? 'gesperrt (masked)' : r.enabled || 'unbekannt'; en[k] = (en[k] || 0) + 1; }
      dRestart.donut.update(Object.entries(en).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ id: k, label: k, value: v, color: k === 'aktiviert' ? 'c7' : k === 'deaktiviert' ? 'c6' : k.startsWith('gesperrt') ? 'c8' : `c${(i % 10) + 1}` })), { value: num(vis.length), label: 'Units' });
      K.fail.set({ value: num(vis.filter((r) => r.result && r.result !== 'success').length), sub: 'mit Fehlerergebnis seit dem Start', color: 'c8', spark: [] });
      K.restarts.set({ value: num(sum('restarts')), sub: `${vis.filter((r) => r.restarts > 0).length} Dienste betroffen`, color: 'c3', spark: [] });
    }

    const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };

    async function load() {
      try { const r = await ctx.api.get('/api/services'); list = r.list; render(); } catch {}
    }

    ctx.on('settings', render);
    ctx.every(load, 5000);
    load();
  },
};
