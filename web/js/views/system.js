import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, dataTable, kv, badge, meter, status } from '../widgets.js';
import { num, B, dur, clock, tFull, tShort, tHMS } from '../fmt.js';
import { f, ratio } from './common.js';
import { rebootDialog, cancelReboot, nginxReload, unitAction, unitMenu, trigger, logViewer, daemonReload, readOp, actionDialog, watchJob, modal } from '../interact.js';
import { BarList } from '../charts.js';
import { tabs, tiles, banner } from '../widgets.js';
import { icon } from '../dom.js';
import { rel } from '../fmt.js';
import { api } from '../store.js';

export default {
  id: 'system', title: 'System', group: 'System', icon: 'system', range: false, desc: 'Server steuern, Hardware, Zeit und Kernel', keywords: 'neustart reboot hardware kernel hostname zeitzone',
  mount(root, ctx) {
    const { store } = ctx;
    const info = h('div'); const timeBox = h('div'); const hw = h('div'); const lim = h('div'); const self = h('div'); const reboot = h('div');
    const users = dataTable({ columns: [{ key: 'user', label: 'Benutzer', cls: 'tbl-title' }, { key: 'tty', label: 'Terminal' }, { key: 'since', label: 'Angemeldet seit' }], dense: true, empty: 'Niemand angemeldet.' });
    const swapT = dataTable({ columns: [{ key: 'name', label: 'Swap-Gerät', cls: 'tbl-title' }, { key: 'type', label: 'Typ' }, { key: 'size', label: 'Größe', align: 'r', fmt: B }, { key: 'used', label: 'Belegt', align: 'r', fmt: (v, r) => meter(v, r.size, { text: B(v) }) }, { key: 'prio', label: 'Priorität', align: 'r' }], dense: true, empty: 'Kein Swap eingerichtet.' });
    const ent = chartCard({ title: 'Entropie', sub: 'Zufallsreserve des Kernels', span: 6, series: [{ key: 'ent', label: 'Entropie (Bit)', color: 'c5', fmt: f.int }], fmt: f.int, floor: 256, height: 170, stats: false });
    const usr = chartCard({ title: 'Angemeldete Benutzer', span: 6, series: [{ key: 'usr', label: 'Sitzungen', color: 'c1', fmt: f.int }], fmt: f.int, floor: 3, height: 170, stats: false });
    [ent, usr].forEach((c) => ctx.own(c.chart));

    // ---- control panel
    const pending = h('div');
    const sshHost = () => ((store.slow && store.slow.sites) || []).map((s) => s.host).find((x) => x.startsWith('ssh.'));
    const terminal = h('a', { class: 'btn', href: '#', target: '_blank', rel: 'noopener', hidden: '' }, 'Terminal öffnen');
    const control = card({ title: 'Server steuern', sub: 'Jede Aktion verlangt dein Passwort (danach 5 Minuten freigeschaltet) und wird im Ereignisprotokoll festgehalten.', span: 12 },
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn danger', onClick: () => rebootDialog(() => setTimeout(checkReboot, 800)) }, 'Server neu starten'),
        h('button', { type: 'button', class: 'btn', onClick: () => nginxReload() }, 'nginx neu laden'),
        h('button', { type: 'button', class: 'btn', onClick: () => daemonReload() }, 'systemd neu einlesen'),
        h('button', { type: 'button', class: 'btn', onClick: () => unitAction('server-dash.service', 'restart') }, 'Dashboard neu starten'),
        h('a', { class: 'btn', href: '#/console' }, icon('terminal', 14), 'Befehlskonsole'),
        terminal),
      pending,
      h('p', { class: 'muted', style: { marginTop: '12px' } }, 'Einzelne Dienste, Container und Prozesse steuerst du in den Ansichten „Dienste & Container“ und „Prozesse“ über die Schaltfläche „Aktion“.'));
    const logsHost = h('div', null, h('p', { class: 'muted' }, 'Quellen werden gesammelt …'));
    const logs = card({ title: 'Protokolle', sub: 'Journal, Kernel, nginx und Container. Nur lesend.', span: 12 }, logsHost);
    let viewer = null;

    async function checkReboot() {
      try {
        const r = await api.post('/api/action', { op: 'system.reboot-status', args: {} });
        const st = r.result;
        pending.replaceChildren(...(st.pending ? [h('div', { class: 'banner crit', style: { marginTop: '14px' } }, h('b', null, 'Neustart geplant'), h('small', null, `Der Server startet ${st.at ? `um ${tHMS(st.at)} Uhr` : 'in Kürze'} neu.`), h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => cancelReboot().then(() => setTimeout(checkReboot, 600)) }, 'Neustart abbrechen')))] : []));
      } catch { pending.replaceChildren(); }
    }
    async function buildLogs() {
      let units = [];
      try { units = (await api.get('/api/services')).list.filter((u) => u.active === 'active' || u.active === 'failed').map((u) => u.id).sort(); } catch {}
      const dk = (store.detail && store.detail.docker.containers) || [];
      const sources = [
        { label: 'Kernel-Meldungen', kind: 'kernel' }, { label: 'System: nur Fehler', kind: 'system', level: 'err' }, { label: 'System: Warnungen und Fehler', kind: 'system', level: 'warning' },
        { label: 'nginx: Fehlerprotokoll', kind: 'nginx', which: 'error' }, { label: 'nginx: Zugriffsprotokoll', kind: 'nginx', which: 'access' },
        ...units.map((id) => ({ label: `Dienst: ${id}`, kind: 'unit', name: id })), ...dk.map((c) => ({ label: `Container: ${c.name}`, kind: 'docker', name: c.name })),
      ];
      viewer = logViewer({ ...sources[0], sources });
      ctx.own(viewer);
      logsHost.replaceChildren(viewer.el);
    }

    root.append(grid(
      control, logs,
      card({ title: 'Rechner', span: 6 }, info), card({ title: 'Zeit', sub: 'Uhrzeit und Synchronisation', span: 6 }, timeBox),
      card({ title: 'Prozessor und Speicher', span: 6 }, hw), card({ title: 'Systemgrenzen', sub: 'Wie viel vom Kernel-Limit belegt ist', span: 6 }, lim),
      card({ title: 'Angemeldete Benutzer', sub: 'Aktive Shell-Sitzungen', span: 6 }, users.el), card({ title: 'Swap-Geräte', span: 6 }, swapT.el),
      card({ title: 'Neustart-Hinweis', span: 6 }, reboot), card({ title: 'Dieses Dashboard', sub: 'Der Dienst, der diese Seite ausliefert', span: 6 }, self),
      ent.el, usr.el));

    // ---- more: hardware, kernel, jobs, host settings (loaded on demand)
    const mp = { hw: h('div'), sysctl: h('div'), mods: h('div'), jobs: h('div'), host: h('div'), timers: h('div'), boot: h('div'), swap: h('div') };
    const loaded = {};
    const mt = tabs([{ id: 'host', label: 'Rechnername & Zeit' }, { id: 'hw', label: 'Hardware' }, { id: 'sysctl', label: 'Kernel-Parameter' }, { id: 'mods', label: 'Kernel-Module' }, { id: 'timers', label: 'Zeitgeber' }, { id: 'boot', label: 'Startanalyse' }, { id: 'swap', label: 'Auslagerung' }, { id: 'jobs', label: 'Hintergrundaufträge' }], 'host', (id) => { for (const [k, el] of Object.entries(mp)) el.hidden = k !== id; if (!loaded[id]) { loaded[id] = true; loaders[id](); } });
    for (const k of ['hw', 'sysctl', 'mods', 'jobs', 'timers', 'boot', 'swap']) mp[k].hidden = true;
    const loaders = {
      async host() {
        try {
          const r = await readOp('sys.identity');
          const h0 = r.host; const tm = r.time;
          mp.host.replaceChildren(h('div', { class: 'grid' },
            card({ title: 'Rechner', span: 6, actions: h('button', { type: 'button', class: 'btn sm', onClick: () => actionDialog({ op: 'sys.set-hostname', args: (v) => ({ name: v.name.trim() }), title: 'Rechnernamen ändern', lead: h0['Static hostname'] || '', text: 'Der Name wird sofort gesetzt. Dienste, die den alten Namen kennen (E-Mail, Zertifikate), merken das erst nach einem Neustart.', fields: [{ name: 'name', label: 'Neuer Name', type: 'text', value: h0['Static hostname'] || '' }], danger: true, okLabel: 'Ändern', success: 'Rechnername geändert' }) }, icon('edit', 13), 'Namen ändern') }, kv(Object.entries(h0).map(([k, v]) => [k, v]))),
            card({ title: 'Zeit und Region', span: 6, actions: h('button', { type: 'button', class: 'btn sm', onClick: () => actionDialog({ op: 'sys.set-timezone', args: (v) => ({ tz: v.tz }), title: 'Zeitzone ändern', lead: tm.Timezone, fields: [{ name: 'tz', label: 'Zeitzone', type: 'select', value: tm.Timezone, options: r.timezones.map((z) => [z, z]) }], okLabel: 'Setzen', success: 'Zeitzone geändert' }) }, icon('edit', 13), 'Zeitzone ändern') }, kv([['Zeitzone', tm.Timezone], ['Lokale Zeit', tm.TimeUSec], ['Zeit synchronisiert', tm.NTPSynchronized === 'yes' ? 'ja' : 'nein'], ['NTP aktiv', tm.NTP === 'yes' ? 'ja' : 'nein'], ...Object.entries(r.locale).map(([k, v]) => [k, v])]))));
        } catch (e) { mp.host.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async hw() {
        mp.hw.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('sys.hardware');
          const flat = [];
          const walk = (list, d) => { for (const b of list) { flat.push({ ...b, depth: d }); if (b.children) walk(b.children, d + 1); } };
          walk(r.blocks, 0);
          const bt = dataTable({ columns: [{ key: 'name', label: 'Gerät', cls: 'tbl-title', fmt: (v, b) => h('span', { style: { paddingLeft: `${b.depth * 18}px` } }, v) }, { key: 'type', label: 'Art' }, { key: 'size', label: 'Größe', align: 'r', fmt: (v) => B(+v) }, { key: 'fstype', label: 'Dateisystem', fmt: (v) => v || '–' }, { key: 'mountpoints', label: 'Eingehängt', cls: 'wrap mono', fmt: (v) => (v || []).filter(Boolean).join(', ') || '–' }, { key: 'model', label: 'Modell', fmt: (v) => v || '–' }], dense: true, sortable: false });
          bt.setRows(flat);
          mp.hw.replaceChildren(h('div', { class: 'grid' },
            card({ title: 'Prozessor', span: 6 }, kv(r.cpu.filter((x) => !/^(Vulnerability|Flags)/.test(x.k)).map((x) => [x.k, x.v]))),
            card({ title: 'Mainboard und Speicher (DMI)', span: 6 }, r.dmi.length ? h('div', null, ...r.dmi.map((b) => h('div', { style: { marginBottom: '14px' } }, h('div', { class: 'tbl-title', style: { marginBottom: '4px' } }, b.title), kv(b.items)))) : h('p', { class: 'muted' }, r.dmiError || 'Keine DMI-Daten (virtuelle Maschine?).')),
            card({ title: 'Datenträger und Partitionen', span: 12 }, bt.el),
            card({ title: 'PCI-Geräte', span: 6 }, h('pre', { class: 'out' }, r.pci.join('\n') || '–')), card({ title: 'USB-Geräte', span: 6 }, h('pre', { class: 'out' }, r.usb.join('\n') || '–'))));
        } catch (e) { mp.hw.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async sysctl() {
        mp.sysctl.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('sys.sysctl');
          const t = dataTable({ columns: [{ key: 'k', label: 'Parameter', cls: 'mono tbl-title wrap' }, { key: 'v', label: 'Wert', cls: 'mono wrap', fmt: (v) => h('span', { style: { wordBreak: 'break-all' } }, v) }], search: true, searchPlaceholder: 'Parameter suchen (z. B. net.ipv4, vm.swappiness) …', dense: true, sort: { key: 'k', dir: 'asc' }, pageSize: 100 });
          t.setRows(r.list.map(([k, v]) => ({ k, v })));
          mp.sysctl.replaceChildren(card({ title: 'Kernel-Parameter (sysctl)', sub: `${r.list.length} Werte. Nur Anzeige. Dauerhaft ändern: Datei in /etc/sysctl.d anlegen (Dateimanager), danach neu starten.`, span: 12 }, t.el));
        } catch (e) { mp.sysctl.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async mods() {
        mp.mods.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('sys.modules');
          const t = dataTable({ columns: [{ key: 'name', label: 'Modul', cls: 'tbl-title mono' }, { key: 'size', label: 'Größe', align: 'r', fmt: B }, { key: 'used', label: 'Benutzt von', align: 'r' }, { key: 'by', label: 'Abhängige Module', cls: 'wrap dim mono', fmt: (v) => v.join(', ') || '–' }], search: true, searchPlaceholder: 'Modul suchen …', dense: true, sort: { key: 'size', dir: 'desc' }, pageSize: 100 });
          t.setRows(r.list);
          mp.mods.replaceChildren(card({ title: 'Geladene Kernel-Module', sub: `${r.list.length} Module`, span: 12 }, t.el));
        } catch (e) { mp.mods.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async timers() {
        mp.timers.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('sys.timers');
          const t = dataTable({
            columns: [
              { key: 'unit', label: 'Zeitgeber', cls: 'tbl-title', fmt: (v, x) => h('span', null, v, x.description ? h('small', { class: 'sub' }, x.description) : null) },
              { key: 'activates', label: 'Startet', cls: 'mono dim' },
              { key: 'next', label: 'Nächster Lauf', fmt: (v) => (v ? h('span', null, tShort(v), h('small', { class: 'sub' }, rel(v))) : '–'), sort: (x) => x.next || Infinity },
              { key: 'last', label: 'Letzter Lauf', fmt: (v) => (v ? h('span', null, tShort(v), h('small', { class: 'sub' }, rel(v))) : 'noch nie') },
              { key: 'enabled', label: 'Autostart', fmt: (v) => (v === 'enabled' ? badge('an', 'ok') : badge(v || '–', 'neutral')) },
              { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, x) => trigger((a) => unitMenu(a, { id: x.unit, active: x.active, enabled: x.enabled }, () => setTimeout(loaders.timers, 800))) },
            ], sort: { key: 'next', dir: 'asc' }, dense: true, search: true, searchPlaceholder: 'Zeitgeber suchen …', pageSize: 60,
          });
          t.setRows(r.timers);
          mp.timers.replaceChildren(card({ title: 'systemd-Zeitgeber', sub: `${r.timers.length} Zeitgeber, die Dienste zu festen Zeiten starten (das moderne Gegenstück zu cron). Cron-Aufträge findest du unter „Zeitpläne“.`, span: 12, actions: h('button', { type: 'button', class: 'btn sm', onClick: () => loaders.timers() }, icon('refresh', 13), 'Neu laden') }, t.el));
        } catch (e) { mp.timers.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async boot() {
        mp.boot.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('sys.analyze');
          const list = h('div'); const bl = new BarList(list, { fmt: (v) => `${v.toFixed(v < 10 ? 1 : 0)} s` });
          const max = r.units[0] ? r.units[0].seconds : 1;
          bl.update(r.units.slice(0, 20).map((u, i) => ({ id: u.unit, label: u.unit, value: u.seconds, color: `c${(i % 10) + 1}` })), max);
          mp.boot.replaceChildren(h('div', { class: 'grid' },
            card({ title: 'Startzeit', sub: 'Wie lange der letzte Start gedauert hat', span: 12 }, h('pre', { class: 'out' }, r.summary || '(keine Daten)')),
            card({ title: 'Langsamste Einheiten beim Start', sub: 'Zeit, die jede Einheit zum Hochfahren brauchte. Vieles läuft parallel, die Summe ist deshalb größer als die Startzeit.', span: 7 }, list),
            card({ title: 'Kritischer Pfad', sub: 'Die Kette, die den Start tatsächlich aufgehalten hat', span: 5 }, h('pre', { class: 'out tall' }, r.chain || '–'))));
        } catch (e) { mp.boot.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async swap() {
        mp.swap.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('sys.swap');
          const t = dataTable({
            columns: [
              { key: 'name', label: 'Auslagerung', cls: 'tbl-title mono' }, { key: 'type', label: 'Art', fmt: (v) => (v === 'file' ? 'Datei' : v === 'partition' ? 'Partition' : v) },
              { key: 'size', label: 'Größe', align: 'r', fmt: B }, { key: 'used', label: 'Belegt', align: 'r', fmt: (v, x) => meter(v, x.size, { text: B(v) }) }, { key: 'prio', label: 'Priorität', align: 'r' },
              { key: 'inFstab', label: 'Dauerhaft', fmt: (v) => (v ? badge('ja', 'ok') : badge('nur bis zum Neustart', 'warn')) },
              { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, x) => (x.type === 'file' ? h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'sys.swap-remove', args: { path: x.name }, title: 'Auslagerung entfernen', lead: x.name, text: `Der Inhalt (${B(x.used)}) wird zurück in den Arbeitsspeicher geholt, das kann dauern. Reicht der Speicher nicht, bricht der Vorgang ab. Die Datei wird danach gelöscht.`, word: 'AUSLAGERUNG', danger: true, okLabel: 'Entfernen', success: 'Entfernt', after: () => loaders.swap() }) }, icon('trash', 13), 'Entfernen') : null) },
            ], dense: true, empty: 'Es ist keine Auslagerung eingerichtet.',
          });
          t.setRows(r.devices);
          const total = r.mem.SwapTotal || 0; const free = r.mem.SwapFree || 0;
          mp.swap.replaceChildren(h('div', { class: 'grid' },
            card({ title: 'Auslagerung (Swap)', sub: 'Platz auf der Festplatte, den der Server nutzt, wenn der Arbeitsspeicher knapp wird.', span: 12, actions: h('button', { type: 'button', class: 'btn primary sm', onClick: () => createSwap(r) }, icon('plus', 13), 'Auslagerungsdatei anlegen') }, t.el),
            card({ title: 'Zahlen', span: 6 }, kv([['Gesamt', B(total)], ['Belegt', B(total - free)], ['Im Cache', B(r.mem.SwapCached || 0)], ['Freier Platz auf /', r.rootFree ? B(r.rootFree) : '–']])),
            card({ title: 'Swappiness', sub: 'Wie bereitwillig der Kernel Daten auslagert (0 bis 100)', span: 6 }, h('p', { style: { fontSize: '28px', fontWeight: 700 } }, r.swappiness == null ? '–' : String(r.swappiness)), h('p', { class: 'muted' }, 'Auf Servern sind 10 bis 30 üblich, damit Programme länger im schnellen Speicher bleiben. Ändern: Kernel-Parameter vm.swappiness in einer Datei unter /etc/sysctl.d festlegen.'))));
        } catch (e) { mp.swap.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
      async jobs() {
        mp.jobs.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
        try {
          const r = await readOp('job.list');
          const t = dataTable({ columns: [{ key: 'title', label: 'Auftrag', cls: 'tbl-title wrap' }, { key: 'startedAt', label: 'Gestartet', align: 'r', fmt: (v) => `${tShort(v)} (${rel(v)})`, sort: (x) => x.startedAt }, { key: 'done', label: 'Zustand', fmt: (v, x) => (!v ? badge('läuft', 'info') : x.killed ? badge('abgebrochen', 'warn') : x.exit === 0 ? badge('fertig', 'ok') : badge(`Fehler (${x.exit})`, 'crit')) }, { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, x) => h('button', { type: 'button', class: 'btn sm', onClick: () => watchJob(x.id, x.title) }, 'Ausgabe') }], dense: true, sort: { key: 'startedAt', dir: 'desc' }, empty: 'Es gibt keine Aufträge. Aufträge entstehen bei Updates, Docker-Downloads und Zertifikats-Erneuerungen.' });
          t.setRows(r.jobs);
          mp.jobs.replaceChildren(card({ title: 'Hintergrundaufträge', sub: 'Lang laufende Arbeiten, die du gestartet hast. Die Ausgabe bleibt 3 Tage erhalten.', span: 12, actions: h('button', { type: 'button', class: 'btn sm', onClick: () => loaders.jobs() }, icon('refresh', 13), 'Neu laden') }, t.el));
        } catch (e) { mp.jobs.replaceChildren(h('p', { class: 'err' }, e.message)); }
      },
    };

    function createSwap(r) {
      actionDialog({ op: 'sys.swap-create', args: (v) => ({ path: v.path.trim(), sizeMb: Math.round(v.gb * 1024) }), title: 'Auslagerungsdatei anlegen', lead: 'Zusätzlicher Swap-Platz',
        text: `Legt eine Datei an, aktiviert sie sofort und trägt sie in /etc/fstab ein, damit sie nach dem Neustart wieder da ist. Auf der Festplatte sind ${r.rootFree ? B(r.rootFree) : 'unbekannt viel'} frei.`,
        fields: [{ name: 'path', label: 'Pfad der Datei', value: '/swapfile2' }, { name: 'gb', label: 'Größe in GB', type: 'number', value: 2, min: 0.1, max: 256 }],
        okLabel: 'Anlegen', success: 'Auslagerung angelegt', validate: (v) => (!(v.gb >= 0.0625) ? 'Bitte eine Größe angeben.' : null), after: () => loaders.swap() });
    }
    root.append(h('div', { class: 'grid', style: { marginTop: '16px' } }, h('div', { class: 's-12' }, mt.el, mp.host, mp.hw, mp.sysctl, mp.mods, mp.timers, mp.boot, mp.swap, mp.jobs)));
    loaded.host = true; loaders.host();

    function onDetail() {
      const d = store.detail;
      if (!d) return;
      const i = store.info;
      const s = d.sys;
      const up = s.uptime + (performance.now() - store.bootAt) / 1000;
      info.replaceChildren(kv([
        ['Rechnername', i.host], ['Betriebssystem', i.os], ['Kernel', i.kernel], ['Architektur', i.arch], ['Laufzeit', `${dur(up, 4)} (${clock(up)})`], ['Gestartet', tFull(s.btime * 1000)],
        ['CPU im Leerlauf (Summe)', dur(s.idle, 3), 'Summe über alle Kerne seit dem Start'], ['Letzte Prozess-ID', num(s.lastPid)], ['Hauptschnittstelle', d.net.primary],
      ]));
      const t = s.time || {};
      timeBox.replaceChildren(kv([
        ['Zeitzone', t.timezone || '–'], ['Zeit synchronisiert', t.ntpSynced ? status('ja', 'ok') : status('nein', 'warn')], ['NTP aktiv', t.ntp ? 'ja' : 'nein'],
        ...(t.chrony ? Object.entries(t.chrony).map(([k, v]) => [k, v]) : []),
      ]));
      hw.replaceChildren(kv([
        ['Prozessor', s.cpuinfo.model || i.cpu], ['Kerne', String(i.cores)], ['Cache', s.cpuinfo.cache || '–'], ['Arbeitsspeicher', B(i.ram)], ['Swap', d.mem.swapTotal ? B(d.mem.swapTotal) : 'keiner'],
        ['Seitentabellen', B(d.mem.pageTables)], ['Zugesagter Speicher', `${B(d.mem.commit)} (Limit ${B(d.mem.commitLimit)})`],
      ]));
      const L = s.limits;
      lim.replaceChildren(kv([
        ['Offene Dateien', L.fdMax > 1e15 ? `${num(L.fdAlloc)} (Limit: unbegrenzt)` : meter(L.fdAlloc, L.fdMax, { text: `${num(L.fdAlloc)} von ${num(L.fdMax)}` })],
        ['Prozesse (pid_max)', meter(d.procs ? d.procs.total : 0, L.pidMax, { text: `${num(d.procs ? d.procs.total : 0)} von ${num(L.pidMax)}` })],
        ['Threads (Systemgrenze)', meter(d.procs ? d.procs.threads : 0, L.threadsMax, { text: `${num(d.procs ? d.procs.threads : 0)} von ${num(L.threadsMax)}` })],
        ['Entropie', `${num(L.entropy)} Bit`],
      ]));
      users.setRows(s.users);
      swapT.setRows(d.swaps);
      const rb = s.reboot;
      reboot.replaceChildren(rb.required
        ? h('div', { class: 'banner warn' }, h('div', null, h('b', null, 'Ein Neustart ist erforderlich'), h('small', null, rb.pkgs.length ? `Ausgelöst durch: ${rb.pkgs.join(', ')}` : 'Aktualisierte Systemteile werden erst nach einem Neustart aktiv.')))
        : h('div', { class: 'banner ok' }, h('div', null, h('b', null, 'Kein Neustart nötig'), h('small', null, 'Es liegt kein Hinweis auf einen Neustart vor.'))));
      const me = s.self;
      self.replaceChildren(kv([
        ['Node.js', me.node], ['Prozess-ID', String(me.pid)], ['Arbeitsspeicher (RSS)', B(me.rss)], ['Heap', B(me.heap)], ['Laufzeit des Dienstes', dur(me.up, 3)],
        ['Verbundene Browser', String(me.clients)], ['Verlauf im Speicher', `${num(me.history.raw)} Sekunden · ${num(me.history.t10)} × 10 Sek · ${num(me.history.t60)} × 1 Min`],
      ]));
    }
    ctx.on('detail', onDetail);
    onDetail();
    const th = sshHost();
    if (th) { terminal.href = `https://${th}/`; terminal.hidden = false; }
    ctx.every(checkReboot, 6000);
    checkReboot();
    buildLogs();
  },
};
