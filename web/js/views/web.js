import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, dataTable, meter, badge, status, kv } from '../widgets.js';
import { num, B, dur, tShort, tHMS, ago } from '../fmt.js';
import { f } from './common.js';

const codeBadge = (c, r) => (r && r.nodns ? badge('–', 'neutral') : !c ? badge('–', 'crit') : c < 300 ? badge(String(c), 'ok') : c < 400 ? badge(String(c), 'info') : c < 500 ? badge(String(c), 'warn') : badge(String(c), 'crit'));

export default {
  id: 'web', title: 'Websites', group: 'Verwalten', icon: 'web', range: false, desc: 'Erreichbarkeit, Antwortzeiten und Zertifikate aller Websites', keywords: 'nginx ssl zertifikat domain https',
  mount(root, ctx) {
    const { store } = ctx;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2 }); return K[id].el; };
    let sites = [];
    let selected = null;

    // merged latency history: probes of all sites share one timestamp per round
    const source = () => {
      const byT = new Map();
      for (const s of sites) for (const p of s.hist) { let o = byT.get(p.t); if (!o) { o = { t: p.t }; byT.set(p.t, o); } o[s.key] = p.ms; }
      return { pts: [...byT.values()].sort((a, b) => a.t - b.t), step: Math.max(10_000, (store.settings.sites.interval || 30) * 1000) };
    };
    const allChart = chartCard({ title: 'Antwortzeit aller Websites', sub: 'Zeit bis zur ersten Antwort. Klicke auf die Namen, um Seiten ein- oder auszublenden.', span: 12, series: [], fmt: f.ms, floor: 100, source, window: 3 * 3_600_000, height: 260, statsOpen: false });
    const one = chartCard({ title: 'Ausgewählte Seite', sub: 'Antwortzeit im Verlauf', span: 8, mode: 'area', series: [{ key: 'ms', label: 'Antwortzeit', color: 'c1', fmt: f.ms }], fmt: f.ms, floor: 100, window: 3 * 3_600_000, height: 210, source: () => ({ pts: selected ? selected.hist.filter((p) => p.ms != null).map((p) => ({ t: p.t, ms: p.ms })) : [], step: 30_000 }) });
    const detail = card({ title: 'Details', span: 4 }, h('p', { class: 'muted' }, 'Zeile in der Tabelle anklicken.'));
    [allChart, one].forEach((c) => ctx.own(c.chart));
    const dCodes = donutCard({ title: 'Antworten nach Status', sub: 'HTTP-Statusklassen der letzten Prüfung', span: 4, fmt: f.int, size: 140 });
    const dTime = donutCard({ title: 'Zeitaufteilung (Ø)', sub: 'Wohin die Zeit eines Aufrufs geht', span: 4, fmt: (v) => `${num(v, 0)} ms`, size: 140 });
    const dCert = donutCard({ title: 'Zertifikate', sub: 'Restlaufzeit', span: 4, fmt: f.int, size: 140 });

    const table = dataTable({
      columns: [
        { key: 'ok', label: 'Status', sort: (r) => (r.ok === false ? 0 : r.ok ? 2 : 1), fmt: (v, r) => (r.nodns ? status('kein DNS', 'neutral') : status(v == null ? 'prüfe …' : v ? 'online' : 'offline', v == null ? 'neutral' : v ? 'ok' : 'crit')) },
        { key: 'host', label: 'Adresse', cls: 'tbl-title', fmt: (v, r) => h('span', null, h('a', { href: r.url, target: '_blank', rel: 'noopener', onClick: (e) => e.stopPropagation() }, v), r.name ? h('small', { class: 'sub' }, r.name) : null) },
        { key: 'title', label: 'Seitentitel', cls: 'wrap', fmt: (v) => v || h('span', { class: 'muted' }, 'kein Titel') },
        { key: 'code', label: 'HTTP', align: 'r', fmt: (v, r) => codeBadge(v, r) },
        { key: 'ms', label: 'Antwortzeit', align: 'r', fmt: (v, r) => (v == null ? (r.nodns ? '–' : (r.error || '–')) : meter(v, 1500, { text: `${num(v, 0)} ms`, tone: v > 1000 ? 'crit' : v > 500 ? 'warn' : 'ok' })) },
        { key: 'timing', label: 'DNS · TCP · TLS · Antwort', sort: (r) => (r.timing ? r.timing.ttfb : null), fmt: (t) => (t && t.ttfb != null ? `${t.dns ?? '–'} · ${t.connect != null && t.dns != null ? t.connect - t.dns : '–'} · ${t.tls != null && t.connect != null ? t.tls - t.connect : '–'} · ${t.tls != null ? t.ttfb - t.tls : t.connect != null ? t.ttfb - t.connect : '–'} ms` : '–') },
        { key: 'server', label: 'Server', fmt: (v) => v || '–' },
        { key: 'final', label: 'Endet bei', cls: 'wrap dim', fmt: (v, r) => (v && v !== r.url ? v.replace(/^https?:\/\//, '') : '–') },
        { key: 'up', label: 'Verfügbar', align: 'r', fmt: (v) => (v == null ? '–' : `${num(v, v === 100 ? 0 : 2)} %`) },
        { key: 'avg', label: 'Ø', align: 'r', fmt: (v) => (v == null ? '–' : `${num(v, 0)} ms`) }, { key: 'min', label: 'Min', align: 'r', fmt: (v) => (v == null ? '–' : `${num(v, 0)} ms`) }, { key: 'max', label: 'Max', align: 'r', fmt: (v) => (v == null ? '–' : `${num(v, 0)} ms`) },
        { key: 'checks', label: 'Prüfungen', align: 'r', fmt: (v) => num(v) },
        { key: 'source', label: 'Quelle', cls: 'dim' },
        { key: 'checkedAt', label: 'Zuletzt', align: 'r', fmt: (v) => (v ? ago(v) : '–') },
      ],
      search: true, searchPlaceholder: 'Website suchen …', sort: { key: 'ok', dir: 'asc' }, dense: true, pageSize: 80,
      filters: [{ label: 'Alle' }, { label: 'Online', fn: (r) => r.ok }, { label: 'Offline', fn: (r) => r.ok === false }, { label: 'Ohne DNS', fn: (r) => r.nodns }, { label: 'Weiterleitungen', fn: (r) => r.code >= 300 && r.code < 400 }, { label: 'Manuell', fn: (r) => r.custom }],
      rowClass: (r) => (r.ok === false ? 'row-bad' : ''),
      onRow: (r) => { selected = r; one.chart.draw(); renderDetail(); },
    });
    const certTable = dataTable({
      columns: [
        { key: 'hosts', label: 'Gültig für', cls: 'wrap tbl-title', sort: (r) => r.hosts[0], fmt: (v) => v.join(', ') },
        { key: 'issuer', label: 'Aussteller', fmt: (v) => v || '–' }, { key: 'subject', label: 'Betreff', cls: 'dim' },
        { key: 'from', label: 'Gültig ab', fmt: (v) => tShort(v) }, { key: 'to', label: 'Gültig bis', fmt: (v) => tShort(v) },
        { key: 'days', label: 'Restlaufzeit', align: 'r', fmt: (v) => meter(Math.max(0, v), 90, { text: `${v} Tage`, tone: v <= 7 ? 'crit' : v <= 21 ? 'warn' : 'ok' }) },
        { key: 'san', label: 'Alternative Namen', cls: 'wrap dim', fmt: (v) => v.join(', ') },
      ], sort: { key: 'days', dir: 'asc' }, dense: true, empty: 'Keine Zertifikate gelesen.',
    });
    const cfgNote = h('p', { class: 'muted' }, 'Welche Seiten geprüft werden, stellst du unter „Einstellungen“ ein. Die Liste wird aus der nginx-Konfiguration erkannt (server_name). Namen ohne DNS-Eintrag zählen nicht als Ausfall.');

    root.append(grid(
      mk('up', 'Online', 'c7'), mk('avg', 'Ø Antwortzeit', 'c1'), mk('slow', 'Langsamste Seite', 'c3'), mk('avail', 'Verfügbarkeit', 'c2'), mk('cert', 'Nächstes Zertifikat läuft ab', 'c5'), mk('red', 'Weiterleitungen', 'c9'),
      allChart.el,
      dCodes.el, dTime.el, dCert.el,
      heading('Alle Websites', 'Der Server ruft jede Adresse regelmäßig selbst ab, so wie ein Besucher. Zeile anklicken für Details und Verlauf.'),
      card({ span: 12 }, cfgNote, table.el),
      one.el, detail,
      heading('Zertifikate', 'Wie sie der lokale Webserver ausliefert. Läuft eines ab, erscheint vorher eine Warnung.'),
      card({ span: 12 }, certTable.el)));

    function renderDetail() {
      if (!selected) return;
      const s = sites.find((x) => x.key === selected.key) || selected;
      selected = s;
      const t = s.timing || {};
      detail.replaceChildren(h('header', { class: 'card-h' }, h('div', null, h('h3', null, s.host), h('p', null, s.title || 'kein Titel'))),
        kv([
          ['Status', s.ok == null ? 'wird geprüft' : s.ok ? 'online' : `offline (${s.error || `HTTP ${s.code}`})`], ['HTTP-Status', s.code ? String(s.code) : '–'], ['Adresse', s.url],
          ['Weiterleitung', s.location || '–'], ['Endet bei', s.final || '–'], ['Inhaltstyp', s.type || '–'], ['Server', s.server || '–'],
          ['DNS', t.dns != null ? `${t.dns} ms` : '–'], ['TCP-Verbindung', t.connect != null && t.dns != null ? `${t.connect - t.dns} ms` : '–'], ['TLS-Handshake', t.tls != null && t.connect != null ? `${t.tls - t.connect} ms` : '–'], ['Erste Antwort', t.ttfb != null ? `${t.ttfb} ms` : '–'],
          ['Prüfungen', num(s.checks)], ['Verfügbarkeit', s.up != null ? `${num(s.up, 2)} %` : '–'], ['Quelle', s.source], ['Beobachtet seit', s.since ? tShort(s.since) : '–'],
        ]));
    }

    function render() {
      const all = sites;
      const mon = all.filter((s) => !s.nodns); // names without a DNS record are neutral, not an outage
      const noDns = all.length - mon.length;
      const chk = mon.filter((s) => s.ok != null);
      const upN = mon.filter((s) => s.ok).length;
      const withMs = mon.filter((s) => s.ms != null);
      K.up.set({ value: chk.length ? String(upN) : '–', unit: `von ${mon.length}`, sub: `${mon.length - upN > 0 && chk.length ? `${mon.length - upN} nicht erreichbar` : 'alle erreichbar'}${noDns ? ` · ${noDns} ohne DNS` : ''}`, level: chk.length ? (upN === chk.length ? 'ok' : 'crit') : '', color: 'c7', spark: [] });
      const avg = withMs.length ? withMs.reduce((a, b) => a + b.ms, 0) / withMs.length : null;
      K.avg.set({ value: avg != null ? num(avg, 0) : '–', unit: avg != null ? 'ms' : '', sub: withMs.length ? `schnellste ${num(Math.min(...withMs.map((s) => s.ms)), 0)} ms` : '', color: 'c1', spark: [] });
      const sl = withMs.slice().sort((a, b) => b.ms - a.ms)[0];
      K.slow.set({ value: sl ? num(sl.ms, 0) : '–', unit: sl ? 'ms' : '', sub: sl ? sl.host : '', color: 'c3', level: sl && sl.ms > 1000 ? 'warn' : '', spark: [] });
      const ups = mon.filter((s) => s.up != null);
      K.avail.set({ value: ups.length ? num(ups.reduce((a, b) => a + b.up, 0) / ups.length, 2) : '–', unit: '%', sub: `${num(mon.reduce((a, b) => a + b.checks, 0))} Prüfungen insgesamt`, color: 'c2', spark: [] });
      const certs = (store.slow && store.slow.certs) || [];
      const c0 = certs[0];
      K.cert.set({ value: c0 ? String(c0.days) : '–', unit: c0 ? 'Tage' : '', sub: c0 ? c0.hosts.slice(0, 2).join(', ') : 'keine Daten', level: c0 ? (c0.days <= 7 ? 'crit' : c0.days <= 21 ? 'warn' : 'ok') : '', color: 'c5', spark: [] });
      K.red.set({ value: String(mon.filter((s) => s.code >= 300 && s.code < 400).length), sub: 'Antworten mit 3xx', color: 'c9', spark: [] });
      table.setRows(all);
      certTable.setRows(certs);
      const cls = { '2xx OK': 0, '3xx Weiterleitung': 0, '4xx Client-Fehler': 0, '5xx Server-Fehler': 0, 'keine Antwort': 0, 'kein DNS-Eintrag': 0 };
      for (const s of all) {
        if (s.nodns) { cls['kein DNS-Eintrag']++; continue; }
        if (s.ok == null) continue;
        if (!s.code) cls['keine Antwort']++; else if (s.code < 300) cls['2xx OK']++; else if (s.code < 400) cls['3xx Weiterleitung']++; else if (s.code < 500) cls['4xx Client-Fehler']++; else cls['5xx Server-Fehler']++;
      }
      const cc = ['c7', 'c1', 'c3', 'c2', 'c4', 'line'];
      dCodes.donut.update(Object.entries(cls).map(([k, v], i) => ({ id: k, label: k, value: v, color: cc[i] })), { value: String(all.length), label: 'Adressen' });
      const tm = mon.filter((s) => s.timing && s.timing.ttfb != null);
      const m = (fn) => (tm.length ? tm.reduce((a, s) => a + Math.max(0, fn(s.timing) || 0), 0) / tm.length : 0);
      dTime.donut.update([
        { id: 'dns', label: 'DNS', value: m((t) => t.dns), color: 'c3' }, { id: 'tcp', label: 'TCP', value: m((t) => (t.connect != null && t.dns != null ? t.connect - t.dns : 0)), color: 'c1' },
        { id: 'tls', label: 'TLS', value: m((t) => (t.tls != null && t.connect != null ? t.tls - t.connect : 0)), color: 'c5' }, { id: 'srv', label: 'Antwort des Servers', value: m((t) => t.ttfb - (t.tls ?? t.connect ?? 0)), color: 'c2' },
      ], { value: `${num(m((t) => t.ttfb), 0)} ms`, label: 'Ø gesamt' });
      const band = { 'Abgelaufen': 0, '< 7 Tage': 0, '7–21 Tage': 0, '> 21 Tage': 0 };
      for (const c of certs) { if (c.days < 0) band.Abgelaufen++; else if (c.days < 7) band['< 7 Tage']++; else if (c.days <= 21) band['7–21 Tage']++; else band['> 21 Tage']++; }
      dCert.donut.update(Object.entries(band).map(([k, v], i) => ({ id: k, label: k, value: v, color: ['c2', 'c3', 'c9', 'c7'][i] })), { value: String(certs.length), label: 'Zertifikate' });
      // chart series follow the monitored sites
      const keyStr = mon.map((s) => s.key).join('|');
      if (keyStr !== render.keys) {
        render.keys = keyStr;
        const top = new Set(mon.filter((s) => s.avg != null).sort((a, b) => b.avg - a.avg).slice(0, 6).map((s) => s.key));
        allChart.chart.setSeries(mon.map((s, i) => ({ key: s.key, label: s.name || s.host, color: `c${(i % 10) + 1}`, fmt: f.ms, hidden: !top.has(s.key) })));
      }
      if (selected) renderDetail();
    }

    async function load() {
      try { const r = await ctx.api.get('/api/sites'); sites = r.sites; render(); } catch {}
    }
    ctx.on('slow', () => { if (!sites.length && store.slow) { sites = store.slow.sites; render(); } else load(); });
    ctx.every(load, 10_000);
    load();
  },
};
