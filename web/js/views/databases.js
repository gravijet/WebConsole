// Database servers on the host: MariaDB, Redis, PostgreSQL.

import { h, icon } from '../dom.js';
import { kpi, card, dataTable, badge, tabs, toast, banner, tiles, kv } from '../widgets.js';
import { BarList } from '../charts.js';
import { num, B, dur } from '../fmt.js';
import { readOp, actionDialog, unitAction } from '../interact.js';

export default {
  id: 'databases', title: 'Datenbanken', group: 'System', icon: 'database', range: false, desc: 'MariaDB, Redis und PostgreSQL: Größe, Verbindungen und laufende Abfragen', keywords: 'mysql mariadb redis postgres sql db',
  mount(root, ctx) {
    let data = null; let busy = false;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 4, icon: ic }); return K[id].el; };
    const panes = { maria: h('div'), redis: h('div'), pg: h('div') };
    const t = tabs([{ id: 'maria', label: 'MariaDB' }, { id: 'redis', label: 'Redis' }, { id: 'pg', label: 'PostgreSQL' }], 'maria', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; });
    panes.redis.hidden = true; panes.pg.hidden = true;
    root.append(h('div', { class: 'grid' }, mk('m', 'MariaDB', 'c5', 'database'), mk('r', 'Redis', 'c8', 'zap'), mk('p', 'PostgreSQL', 'c4', 'database'), h('div', { class: 's-12' }, t.el, panes.maria, panes.redis, panes.pg)));
    for (const p of Object.values(panes)) p.append(h('p', { class: 'muted loading' }, 'Lade …'));

    const notRunning = (d, name) => h('div', { class: 'grid' }, h('div', { class: 's-12' }, banner(d.state === 'active' ? 'warn' : 'info', d.state === 'active' ? `${name} läuft, ist aber nicht abfragbar` : `${name} läuft nicht`, d.error || `Der Dienst ${d.unit} ist „${d.state}“.`, h('div', { class: 'actions' }, d.state !== 'active' ? h('button', { type: 'button', class: 'btn sm primary', onClick: () => unitAction(d.unit.endsWith('.service') ? d.unit : `${d.unit}.service`, 'start', () => setTimeout(load, 1500)) }, 'Dienst starten') : null))));

    function renderMaria(d) {
      if (!d.available) { panes.maria.replaceChildren(notRunning(d, 'MariaDB')); return; }
      const s = d.status; const v = d.vars;
      const hitRate = s.Innodb_buffer_pool_read_requests ? (1 - s.Innodb_buffer_pool_reads / s.Innodb_buffer_pool_read_requests) * 100 : null;
      const dbs = dataTable({
        columns: [{ key: 'name', label: 'Datenbank', cls: 'tbl-title' }, { key: 'tables', label: 'Tabellen', align: 'r' }, { key: 'total', label: 'Größe', align: 'r', sort: (r) => r.data + r.index, fmt: (x, r) => B(r.data + r.index) }, { key: 'data', label: 'Daten', align: 'r', fmt: B }, { key: 'index', label: 'Indizes', align: 'r', fmt: B }, { key: 'free', label: 'Frei (fragmentiert)', align: 'r', fmt: B }],
        dense: true, sort: { key: 'total', dir: 'desc' }, empty: 'Keine Datenbanken.',
      });
      dbs.setRows(d.databases);
      const procs = dataTable({
        columns: [{ key: 'id', label: 'ID', align: 'r' }, { key: 'user', label: 'Benutzer' }, { key: 'host', label: 'Von', cls: 'mono dim' }, { key: 'db', label: 'Datenbank' }, { key: 'command', label: 'Befehl' }, { key: 'time', label: 'Dauer', align: 'r', fmt: (x) => dur(x, 1) }, { key: 'info', label: 'Abfrage', cls: 'wrap mono', fmt: (x) => h('span', { style: { wordBreak: 'break-all' } }, x || '–') },
          { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (x, r) => h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'db.mysql-kill', args: { id: r.id }, title: 'Verbindung beenden', lead: `Verbindung ${r.id} (${r.user})`, text: 'Die Verbindung und ihre laufende Abfrage werden abgebrochen.', danger: true, okLabel: 'Beenden', success: 'Verbindung beendet', after: () => setTimeout(load, 500) }) }, 'Beenden') }],
        dense: true, sort: { key: 'time', dir: 'desc' }, empty: 'Keine Verbindungen.',
      });
      procs.setRows(d.processes);
      const users = dataTable({ columns: [{ key: 'user', label: 'Benutzer', cls: 'tbl-title' }, { key: 'host', label: 'Erlaubt von', cls: 'mono' }, { key: 'noPassword', label: 'Passwort', fmt: (x) => (x ? badge('keins!', 'crit') : badge('gesetzt', 'ok')) }], dense: true, sort: { key: 'user', dir: 'asc' } });
      users.setRows(d.users);
      const bl = new BarList(h('div'), { fmt: B });
      bl.update(d.databases.filter((x) => x.data + x.index > 0).slice(0, 8).map((x, i) => ({ id: x.name, label: x.name, value: x.data + x.index, color: `c${(i % 10) + 1}` })));
      panes.maria.replaceChildren(h('div', { class: 'grid' },
        card({ title: `MariaDB ${v.version}`, sub: `${v.version_comment} · lauscht auf ${v.bind_address || '–'} · ${v.datadir}`, span: 12 }, tiles([
          { label: 'Läuft seit', value: dur(s.Uptime, 2) }, { label: 'Verbindungen', value: `${s.Threads_connected} / ${v.max_connections}`, sub: `${s.Threads_running} aktiv · Spitze ${s.Max_used_connections}` },
          { label: 'Abfragen gesamt', value: num(s.Questions), sub: `Ø ${num(s.Questions / Math.max(1, s.Uptime), 2)} pro Sekunde` }, { label: 'Langsame Abfragen', value: num(s.Slow_queries), tone: s.Slow_queries ? 'warn' : '', sub: `Schwelle ${v.long_query_time} s, Protokoll ${v.slow_query_log}` },
          { label: 'Cache-Trefferquote', value: hitRate == null ? '–' : `${num(hitRate, 2)} %`, sub: `Pufferpool ${B(+v.innodb_buffer_pool_size)}` }, { label: 'Datenverkehr', value: `${B(s.Bytes_received)} ↓ ${B(s.Bytes_sent)} ↑`, sub: `${s.Aborted_connects} abgebrochene Verbindungsversuche` },
        ])),
        card({ title: 'Datenbanken', span: 8 }, dbs.el), card({ title: 'Größte Datenbanken', span: 4 }, bl.host),
        card({ title: 'Verbindungen und laufende Abfragen', span: 12 }, procs.el), card({ title: 'Benutzer', sub: 'Nur Name und erlaubter Herkunftsort. Passwörter werden nie angezeigt.', span: 12 }, users.el)));
    }

    function renderRedis(d) {
      if (!d.available) { panes.redis.replaceChildren(notRunning(d, 'Redis')); return; }
      const i = d.info;
      const hit = +i.keyspace_hits + +i.keyspace_misses > 0 ? (+i.keyspace_hits / (+i.keyspace_hits + +i.keyspace_misses)) * 100 : null;
      const ks = dataTable({ columns: [{ key: 'db', label: 'Datenbank', cls: 'tbl-title' }, { key: 'keys', label: 'Schlüssel', align: 'r', fmt: (v) => num(v) }, { key: 'expires', label: 'Mit Ablaufzeit', align: 'r', fmt: (v) => num(v) }], dense: true, empty: 'Keine Schlüssel gespeichert.' });
      ks.setRows(d.keyspace);
      panes.redis.replaceChildren(h('div', { class: 'grid' },
        card({ title: `Redis ${i.redis_version}`, sub: `${i.redis_mode} · Port ${i.tcp_port} · ${i.os}`, span: 12 }, tiles([
          { label: 'Läuft seit', value: dur(+i.uptime_in_seconds, 2) }, { label: 'Clients', value: i.connected_clients, sub: `${i.blocked_clients} blockiert` }, { label: 'Speicher', value: i.used_memory_human, sub: i.maxmemory === '0' ? 'kein Limit' : `Limit ${i.maxmemory_human}` },
          { label: 'Befehle pro Sekunde', value: i.instantaneous_ops_per_sec }, { label: 'Trefferquote', value: hit == null ? '–' : `${num(hit, 1)} %`, sub: `${num(+i.keyspace_hits)} Treffer · ${num(+i.keyspace_misses)} Fehlgriffe` }, { label: 'Verdrängte Schlüssel', value: num(+i.evicted_keys) },
          { label: 'Letzte Sicherung', value: i.rdb_last_bgsave_status === 'ok' ? 'in Ordnung' : i.rdb_last_bgsave_status, tone: i.rdb_last_bgsave_status === 'ok' ? 'ok' : 'warn', sub: `${num(+i.rdb_changes_since_last_save)} Änderungen seitdem` },
        ])),
        card({ title: 'Schlüsselraum', span: 6 }, ks.el), card({ title: 'Details', span: 6 }, kv([['Rolle', i.role], ['Persistenz (AOF)', i.aof_enabled === '1' ? 'an' : 'aus'], ['Speicher-Spitze', i.used_memory_peak_human], ['Fragmentierung', i.mem_fragmentation_ratio], ['Verbindungen gesamt', num(+i.total_connections_received)], ['Befehle gesamt', num(+i.total_commands_processed)], ['Abgelehnte Verbindungen', num(+i.rejected_connections)]]))));
    }

    function renderPg(d) {
      if (!d.available) { panes.pg.replaceChildren(notRunning(d, 'PostgreSQL')); return; }
      const dbs = dataTable({ columns: [{ key: 'name', label: 'Datenbank', cls: 'tbl-title' }, { key: 'size', label: 'Größe', align: 'r', fmt: B }, { key: 'connections', label: 'Verbindungen', align: 'r' }], dense: true, sort: { key: 'size', dir: 'desc' } });
      dbs.setRows(d.databases);
      const act = dataTable({ columns: [{ key: 'pid', label: 'PID', align: 'r' }, { key: 'user', label: 'Benutzer' }, { key: 'db', label: 'Datenbank' }, { key: 'state', label: 'Zustand' }, { key: 'seconds', label: 'Dauer', align: 'r', fmt: (x) => dur(x || 0, 1) }, { key: 'query', label: 'Abfrage', cls: 'wrap mono' }], dense: true, empty: 'Keine aktiven Verbindungen.' });
      act.setRows(d.activity);
      panes.pg.replaceChildren(h('div', { class: 'grid' }, card({ title: `PostgreSQL ${d.version}`, span: 12 }, tiles([{ label: 'Datenbanken', value: String(d.databases.length) }, { label: 'Gesamtgröße', value: B(d.databases.reduce((a, b) => a + b.size, 0)) }, { label: 'Verbindungen', value: String(d.activity.length) }])), card({ title: 'Datenbanken', span: 6 }, dbs.el), card({ title: 'Aktivität', span: 6 }, act.el)));
    }

    function render() {
      const m = data.mariadb; const r = data.redis; const p = data.postgres;
      K.m.set({ value: m.available ? 'Läuft' : m.state === 'active' ? 'Fehler' : 'Aus', sub: m.available ? `${m.databases.filter((x) => !['mysql', 'information_schema', 'performance_schema', 'sys'].includes(x.name)).length} eigene Datenbanken · ${B(m.databases.reduce((a, b) => a + b.data + b.index, 0))}` : m.error || 'nicht aktiv', level: m.available ? 'ok' : 'warn', color: 'c5' });
      K.r.set({ value: r.available ? 'Läuft' : r.state === 'active' ? 'Gesperrt' : 'Aus', sub: r.available ? `${r.info.used_memory_human} · ${r.info.connected_clients} Clients` : r.error || 'nicht aktiv', level: r.available ? 'ok' : 'warn', color: 'c8' });
      K.p.set({ value: p.available ? 'Läuft' : 'Aus', sub: p.available ? `Version ${p.version}` : 'Der Cluster ist gestoppt', level: p.available ? 'ok' : '', color: 'c4' });
      renderMaria(m); renderRedis(r); renderPg(p);
    }
    async function load() {
      if (busy) return; busy = true;
      try { data = await readOp('db.overview'); render(); } catch (e) { toast(e.message, 'crit'); for (const p of Object.values(panes)) for (const l of [...p.querySelectorAll(':scope > .loading')]) l.textContent = e.message; }
      busy = false;
    }
    ctx.every(() => { if (!document.hidden) load(); }, 20_000);
    load();
    void icon;
  },
};
