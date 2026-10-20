// Backups: plans (what, how often, how many to keep), archives, download and restore.
// The work is done by a script on the server; cron starts it on schedule, "Jetzt sichern" starts it by hand.

import { h, icon } from '../dom.js';
import { card, dataTable, badge, toast, banner, kpi, meter } from '../widgets.js';
import { B, tShort, ago, cronText, num } from '../fmt.js';
import { modal, quickAction, readOp, watchJob, actionDialog, menu, trigger, fieldEl, downloadPath, confirmDialog } from '../interact.js';

const SCHEDULES = [
  ['', 'Nur von Hand'], ['30 3 * * *', 'Täglich um 03:30'], ['0 */6 * * *', 'Alle 6 Stunden'], ['0 * * * *', 'Stündlich'], ['15 4 * * 0', 'Sonntags um 04:15'], ['0 5 1 * *', 'Am 1. des Monats um 05:00'], ['custom', 'Eigener Cron-Ausdruck …'],
];
const PRESETS = [
  { name: 'Server-Einstellungen', id: 'einstellungen', paths: ['/etc', '/usr/local/lib/server-dash', '/var/lib/server-dash'], excludes: ['/var/lib/server-dash/uploads', '/var/lib/server-dash/outbox'], keep: 14, hint: 'Alles, was du konfiguriert hast: /etc, das Dashboard und dessen Daten.' },
  { name: 'Home-Verzeichnisse', id: 'home', paths: ['/home'], excludes: ['*/node_modules', '*/.cache', '*/.npm'], keep: 7, hint: 'Alle Benutzerdaten ohne Zwischenspeicher und node_modules.' },
  { name: 'Docker-Projekte', id: 'docker-projekte', paths: ['/opt'], excludes: ['*/node_modules'], keep: 7, hint: 'Compose-Dateien und Daten unter /opt.' },
  { name: 'Websites', id: 'websites', paths: ['/var/www', '/etc/nginx', '/etc/letsencrypt'], excludes: [], keep: 14, hint: 'Webseiten-Dateien, nginx-Konfiguration und Zertifikate.' },
];

const nameToId = (s) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export default {
  id: 'backups', title: 'Sicherungen', group: 'Verwalten', icon: 'archive', range: false, desc: 'Ordner und Datenbanken regelmäßig sichern, herunterladen und wiederherstellen', keywords: 'backup sicherung archiv tar wiederherstellen restore cron datenbank mysqldump',
  mount(root, ctx) {
    let ov = null; let otherTimers = [];
    const K = { p: kpi({ label: 'Sicherungspläne', color: 'c1', span: 3, icon: 'archive' }), a: kpi({ label: 'Archive', color: 'c4', span: 3, icon: 'files' }), s: kpi({ label: 'Belegter Platz', color: 'c3', span: 3, icon: 'disk' }), f: kpi({ label: 'Freier Platz', color: 'c7', span: 3, icon: 'check' }) };
    const bannerBox = h('div');

    // ---- plans
    const plans = dataTable({
      columns: [
        { key: 'name', label: 'Plan', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, h('small', { class: 'sub mono' }, r.paths.join(', ').slice(0, 90))) },
        { key: 'schedule', label: 'Zeitplan', fmt: (v, r) => (!r.enabled ? badge('pausiert', 'neutral') : v ? h('span', null, cronText(v), h('small', { class: 'sub mono' }, v)) : 'von Hand') },
        { key: 'keep', label: 'Behalten', align: 'r', fmt: (v) => `${v} Archive` },
        { key: 'status', label: 'Letzte Sicherung', sort: (r) => (r.status ? r.status.at : 0), fmt: (v) => (v ? h('span', null, v.ok ? badge('ok', 'ok') : badge('Fehler', 'crit'), ' ', ago(v.at), v.ok ? h('small', { class: 'sub' }, `${B(v.size)} in ${v.seconds} s`) : null) : h('span', { class: 'muted' }, 'noch nie')) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm primary', onClick: () => runPlan(r) }, icon('play', 12), 'Jetzt sichern'), trigger((a) => planMenu(a, r))) },
      ],
      sort: { key: 'name', dir: 'asc' }, dense: true, empty: 'Noch kein Plan. Lege einen an oder starte mit einer Vorlage.',
    });
    function planMenu(anchor, r) {
      menu(anchor, [
        { label: 'Bearbeiten', onClick: () => planDialog(r) },
        { label: r.enabled ? 'Zeitplan pausieren' : 'Zeitplan fortsetzen', onClick: () => quickAction('backup.plan-save', { ...r, status: undefined, enabled: !r.enabled }, { success: 'Gespeichert' }).then(load).catch((e) => { if (!e.cancelled) toast(e.message, 'crit'); }) },
        'hr',
        { label: 'Plan löschen …', danger: true, onClick: () => actionDialog({ op: 'backup.plan-delete', args: (v) => ({ id: r.id, archives: !!v.archives }), title: `Plan löschen: ${r.name}`, lead: 'Der Zeitplan wird entfernt', word: r.id, danger: true, okLabel: 'Löschen', fields: [{ name: 'archives', label: 'Auch alle Archive dieses Plans löschen', type: 'checkbox', value: false }], success: 'Plan gelöscht', after: load }) },
      ]);
    }
    async function runPlan(r) {
      try { const res = await quickAction('backup.run', { id: r.id }); watchJob(res.job, res.title, load); } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); }
    }

    function planDialog(plan) {
      const editing = !!plan;
      const p = plan || { name: '', id: '', paths: [], excludes: [], schedule: '30 3 * * *', keep: 7, compress: 'zstd', oneFs: true, mysql: false, enabled: true };
      const name = fieldEl({ name: 'name', label: 'Name', value: p.name, placeholder: 'z. B. Websites' });
      const paths = fieldEl({ name: 'paths', label: 'Was soll gesichert werden?', type: 'textarea', rows: 4, mono: true, value: p.paths.join('\n'), hint: 'Ein Ordner oder eine Datei pro Zeile, mit vollem Pfad.' });
      const excludes = fieldEl({ name: 'excludes', label: 'Ausnehmen (optional)', type: 'textarea', rows: 3, mono: true, value: p.excludes.join('\n'), hint: 'Muster pro Zeile, z. B. */node_modules oder /home/benj/Downloads.' });
      const known = SCHEDULES.some(([v]) => v === p.schedule);
      const sched = fieldEl({ name: 'sched', label: 'Wann?', type: 'select', value: known ? p.schedule : 'custom', options: SCHEDULES });
      const cron = fieldEl({ name: 'cron', label: 'Cron-Ausdruck', value: p.schedule, placeholder: 'Minute Stunde Tag Monat Wochentag', mono: true });
      const cronNote = h('small', { class: 'muted' });
      const keep = fieldEl({ name: 'keep', label: 'Wie viele Archive behalten?', type: 'number', value: p.keep, min: 1, max: 100, hint: 'Ältere werden nach jeder Sicherung gelöscht.' });
      const comp = fieldEl({ name: 'compress', label: 'Kompression', type: 'select', value: p.compress, options: [['zstd', 'zstd (schnell, klein)'], ['gz', 'gzip (überall lesbar)']] });
      const onefs = fieldEl({ name: 'oneFs', label: 'Nicht in andere Laufwerke hineinwechseln', type: 'checkbox', value: p.oneFs, hint: 'Empfohlen. Verhindert, dass eingehängte Netzlaufwerke mitgesichert werden.' });
      const mysql = fieldEl({ name: 'mysql', label: 'Auch alle MariaDB-Datenbanken sichern', type: 'checkbox', value: p.mysql, hint: 'Legt einen SQL-Auszug (mysqldump) ins Archiv.' });
      const err = h('div', { class: 'err', role: 'alert' });
      const syncCron = () => { cron.el.hidden = sched.input.value !== 'custom'; if (sched.input.value !== 'custom') cron.input.value = sched.input.value; cronNote.textContent = cron.input.value ? cronText(cron.input.value) : ''; };
      sched.input.addEventListener('change', syncCron); cron.input.addEventListener('input', syncCron); syncCron();
      const presetRow = editing ? null : h('div', { class: 'field' }, h('label', null, 'Vorlage'), h('div', { class: 'row', style: { flexWrap: 'wrap' } }, ...PRESETS.map((x) => h('button', { type: 'button', class: 'btn sm', title: x.hint, onClick: () => { name.input.value = x.name; paths.input.value = x.paths.join('\n'); excludes.input.value = x.excludes.join('\n'); keep.input.value = x.keep; } }, x.name))));
      modal({ title: editing ? `Plan bearbeiten: ${p.name}` : 'Neuer Sicherungsplan', wide: true,
        body: h('div', { class: 'form' }, presetRow, name.el, paths.el, excludes.el, h('div', { class: 'grid2' }, h('div', null, sched.el, cron.el, cronNote), keep.el), h('div', { class: 'grid2' }, comp.el, h('div', { class: 'form' }, onefs.el, mysql.el)), err),
        buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async () => {
          err.textContent = '';
          const id = editing ? p.id : nameToId(name.get());
          if (!id) { err.textContent = 'Bitte einen Namen angeben.'; return false; }
          if (!editing && ov && ov.plans.some((x) => x.id === id)) { err.textContent = 'Einen Plan mit diesem Namen gibt es schon.'; return false; }
          const list = (t) => t.split('\n').map((x) => x.trim()).filter(Boolean);
          try {
            await quickAction('backup.plan-save', { id, name: name.get().trim(), paths: list(paths.get()), excludes: list(excludes.get()), schedule: sched.get() === 'custom' ? cron.get().trim() : sched.get(), keep: keep.get(), compress: comp.get(), oneFs: onefs.get(), mysql: mysql.get(), enabled: p.enabled }, { success: 'Plan gespeichert' });
            load();
          } catch (e) { if (!e.cancelled) err.textContent = e.message; return false; }
        } }] });
    }

    // ---- archives
    const archives = dataTable({
      columns: [
        { key: 'name', label: 'Archiv', cls: 'tbl-title mono', fmt: (v) => v },
        { key: 'plan', label: 'Plan', fmt: (v) => { const p = ov && ov.plans.find((x) => x.id === v); return p ? p.name : v; } },
        { key: 'mtime', label: 'Erstellt', fmt: (v) => h('span', null, tShort(v), h('small', { class: 'sub' }, ago(v))) },
        { key: 'size', label: 'Größe', align: 'r', fmt: (v) => B(v) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: () => downloadPath(`${ov.dir}/${r.id}`).catch((e) => toast(e.message, 'crit')) }, icon('download', 13), 'Laden'), trigger((a) => archiveMenu(a, r))) },
      ],
      sort: { key: 'mtime', dir: 'desc' }, dense: true, search: true, searchPlaceholder: 'Archive durchsuchen …', pageSize: 20, empty: 'Noch keine Archive.',
    });
    function archiveMenu(anchor, r) {
      menu(anchor, [
        { label: 'Inhalt ansehen', onClick: () => contents(r) },
        { label: 'Wiederherstellen …', onClick: () => restore(r) },
        'hr',
        { label: 'Archiv löschen …', danger: true, onClick: async () => { if (await confirmDialog({ title: 'Archiv löschen?', text: r.name, okLabel: 'Löschen', danger: true })) quickAction('backup.delete', { id: r.id }, { success: 'Archiv gelöscht' }).then(load).catch((e) => { if (!e.cancelled) toast(e.message, 'crit'); }); } },
      ]);
    }
    async function contents(r) {
      try {
        const c = await readOp('backup.contents', { id: r.id });
        modal({ title: 'Inhalt des Archivs', lead: `${c.name} · ${num(c.total)} Einträge${c.truncated ? ' (die ersten 1500)' : ''}`, wide: true, body: h('pre', { class: 'out tall' }, c.files.join('\n')), buttons: [{ label: 'Schließen' }] });
      } catch (e) { toast(e.message, 'crit'); }
    }
    function restore(r) {
      actionDialog({ op: 'backup.restore', args: (v) => ({ id: r.id, dest: v.dest.trim(), only: v.only.trim() || undefined, overwrite: !!v.overwrite }), title: 'Archiv wiederherstellen', lead: r.name,
        text: 'Entpackt das Archiv in einen Ordner. Zum Ausprobieren ist der Standardordner sicher. Mit „/“ landen die Dateien wieder an ihrem ursprünglichen Platz.',
        fields: [
          { name: 'dest', label: 'Zielordner', value: `/var/restore/${r.plan}`, hint: '„/“ stellt an den Originalorten wieder her (dann musst du WIEDERHERSTELLEN eintippen).' },
          { name: 'only', label: 'Nur diesen Pfad (optional)', placeholder: 'z. B. etc/nginx', hint: 'Pfad innerhalb des Archivs, ohne führenden Schrägstrich.' },
          { name: 'overwrite', label: 'Vorhandene Dateien überschreiben', type: 'checkbox', value: false, hint: 'Ohne Haken bleiben vorhandene Dateien unangetastet.' },
        ], okLabel: 'Wiederherstellen', success: 'Gestartet', wide: true, validate: (v) => (v.dest.trim().startsWith('/') ? null : 'Der Zielordner muss ein voller Pfad sein.') });
    }

    root.append(h('div', { class: 'grid' }, K.p.el, K.a.el, K.s.el, K.f.el, h('div', { class: 's-12' }, bannerBox),
      card({ title: 'Sicherungspläne', sub: 'Was gesichert wird, wie oft und wie viele Archive bleiben. Der Zeitplan läuft über cron und ist unter „Zeitpläne“ zu sehen.', span: 12, actions: h('button', { type: 'button', class: 'btn primary sm', onClick: () => planDialog(null) }, icon('plus', 13), 'Neuer Plan') }, plans.el),
      card({ title: 'Archive', sub: 'Alle vorhandenen Sicherungen. Das Herunterladen verlangt dein Passwort.', span: 12 }, archives.el)));

    async function load() {
      try {
        const [o, t] = await Promise.allSettled([readOp('backup.overview'), readOp('sys.timers')]);
        if (o.status === 'rejected') throw o.reason;
        ov = o.value;
        otherTimers = t.status === 'fulfilled' ? t.value.timers.filter((x) => /backup|sicher/i.test(x.unit)) : [];
        plans.setRows(ov.plans); archives.setRows(ov.archives);
        const last = ov.plans.map((p) => p.status).filter(Boolean).sort((a, b) => b.at - a.at)[0];
        K.p.set({ value: String(ov.plans.length), sub: `${ov.plans.filter((p) => p.enabled && p.schedule).length} mit Zeitplan` });
        K.a.set({ value: String(ov.archives.length), sub: last ? `letzte ${ago(last.at)}` : 'noch keine Sicherung' });
        K.s.set({ value: B(ov.total), sub: ov.dir });
        const pct = ov.diskSize ? (ov.free / ov.diskSize) * 100 : null;
        K.f.set({ value: ov.free != null ? B(ov.free) : '–', sub: pct != null ? `${num(pct, 0)} % des Laufwerks` : '', level: pct != null && pct < 10 ? 'crit' : pct != null && pct < 20 ? 'warn' : '' });
        const msgs = [];
        const failed = ov.plans.filter((p) => p.status && !p.status.ok);
        if (failed.length) msgs.push(banner('crit', 'Eine Sicherung ist fehlgeschlagen', failed.map((p) => p.name).join(', ')));
        const stale = ov.plans.filter((p) => p.enabled && p.schedule && p.status && Date.now() - p.status.at > 3 * 86400_000 && /\* \* \*$/.test(p.schedule));
        if (stale.length) msgs.push(banner('warn', 'Eine tägliche Sicherung ist überfällig', stale.map((p) => `${p.name} (zuletzt ${ago(p.status.at)})`).join(', ')));
        if (!ov.plans.length) msgs.push(banner('info', 'Noch keine Sicherung eingerichtet', 'Lege einen Plan an. Mit einer Vorlage dauert das eine halbe Minute.'));
        if (otherTimers.length) msgs.push(banner('info', 'Weitere Sicherungen auf diesem Server', otherTimers.map((x) => `${x.unit}${x.last ? ` (zuletzt ${ago(x.last)})` : ''}`).join(', ')));
        bannerBox.replaceChildren(...msgs.flatMap((m) => [m, h('div', { style: { height: '12px' } })]));
        void meter;
      } catch (e) { toast(e.message, 'crit'); }
    }
    ctx.every(() => { if (!document.hidden) load(); }, 30_000);
    load();
  },
};
