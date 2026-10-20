// Scheduled work: systemd timers, cron jobs and the periodic cron directories.

import { h, icon } from '../dom.js';
import { kpi, card, dataTable, badge, tabs, toast, banner, emptyState } from '../widgets.js';
import { num, tShort, tFull, rel, cronText } from '../fmt.js';
import { readOp, actionDialog, unitAction, unitDetail, logModal, trigger, menu, modal, quickAction } from '../interact.js';

const PRESETS = [
  ['*/5 * * * *', 'Alle 5 Minuten'], ['*/15 * * * *', 'Alle 15 Minuten'], ['0 * * * *', 'Jede Stunde'], ['0 */6 * * *', 'Alle 6 Stunden'], ['0 3 * * *', 'Täglich um 03:00'],
  ['30 2 * * 1', 'Montags um 02:30'], ['0 4 1 * *', 'Am 1. des Monats um 04:00'], ['@reboot', 'Beim Start des Servers'], ['custom', 'Eigener Ausdruck …'],
];

export default {
  id: 'cron', title: 'Zeitpläne', group: 'Verwalten', icon: 'cron', range: false, desc: 'systemd-Timer und Cron-Jobs ansehen, ausführen und anlegen', keywords: 'timer cron crontab aufgaben geplant backup',
  mount(root, ctx) {
    let data = null; let busy = false;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 3, icon: ic }); return K[id].el; };
    const panes = { timers: h('div'), cron: h('div'), periodic: h('div') };
    const t = tabs([{ id: 'timers', label: 'systemd-Timer' }, { id: 'cron', label: 'Cron-Jobs' }, { id: 'periodic', label: 'Periodische Skripte' }], 'timers', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; });
    panes.cron.hidden = true; panes.periodic.hidden = true;

    const svc = (r) => r.activates || r.unit.replace(/\.timer$/, '.service');
    const timers = dataTable({
      columns: [
        { key: 'unit', label: 'Timer', cls: 'tbl-title wrap', fmt: (v, r) => h('span', null, v.replace(/\.timer$/, ''), r.description ? h('small', { class: 'sub' }, r.description) : null) },
        { key: 'schedule', label: 'Zeitplan', cls: 'wrap', fmt: (v) => (v ? h('span', null, cronText(v) === v ? v : cronText(v), h('small', { class: 'sub mono' }, v)) : '–') },
        { key: 'next', label: 'Nächster Lauf', align: 'r', sort: (r) => r.next || 9e12, fmt: (v) => (v ? h('span', null, rel(v * 1000), h('small', { class: 'sub' }, tShort(v * 1000))) : '–') },
        { key: 'last', label: 'Letzter Lauf', align: 'r', sort: (r) => r.last || 0, fmt: (v) => (v ? h('span', null, rel(v * 1000), h('small', { class: 'sub' }, tShort(v * 1000))) : 'noch nie') },
        { key: 'enabled', label: 'Autostart', fmt: (v) => (v === 'enabled' ? badge('aktiv', 'ok') : v === 'static' ? badge('fest', 'neutral') : badge(v || '–', 'warn')) },
        { key: 'activates', label: 'Startet', cls: 'dim mono wrap' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => trigger((a) => menu(a, [
          { label: 'Jetzt ausführen', sub: `startet ${svc(r)}`, onClick: () => unitAction(svc(r), 'start', () => setTimeout(load, 1500)) },
          { label: 'Protokoll des Auftrags', onClick: () => logModal({ kind: 'unit', name: svc(r) }) },
          { label: 'Details und Konfiguration', onClick: () => unitDetail(r.unit, load) },
          'hr',
          r.enabled === 'enabled' ? { label: 'Timer deaktivieren', danger: true, onClick: () => unitAction(r.unit, 'disable', () => setTimeout(load, 800)) } : { label: 'Timer aktivieren', onClick: () => unitAction(r.unit, 'enable', () => setTimeout(load, 800)) },
          { label: r.active === 'active' ? 'Timer stoppen' : 'Timer starten', onClick: () => unitAction(r.unit, r.active === 'active' ? 'stop' : 'start', () => setTimeout(load, 800)) },
        ])) },
      ],
      search: true, searchPlaceholder: 'Timer suchen …', sort: { key: 'next', dir: 'asc' }, dense: true, pageSize: 60, empty: 'Keine systemd-Timer.',
      onRow: (r) => unitDetail(r.unit, load),
    });
    panes.timers.append(card({ span: 12 }, timers.el));

    const cronT = dataTable({
      columns: [
        { key: 'schedule', label: 'Wann', cls: 'wrap', sort: (r) => r.schedule, fmt: (v, r) => h('span', null, cronText(v), h('small', { class: 'sub mono' }, v)) },
        { key: 'user', label: 'Benutzer', cls: 'nw' },
        { key: 'command', label: 'Befehl', cls: 'wrap mono', fmt: (v) => h('span', { style: { wordBreak: 'break-all' } }, v) },
        { key: 'source', label: 'Quelle', cls: 'dim wrap' },
        { key: 'disabled', label: 'Status', fmt: (v) => (v ? badge('auskommentiert', 'neutral') : badge('aktiv', 'ok')) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => (r.userTab ? h('button', { type: 'button', class: 'btn sm', onClick: () => editUserTab(r.userTab) }, icon('edit', 13), 'Bearbeiten') : h('a', { class: 'btn sm', href: '#/files', onClick: () => { try { localStorage.setItem('sd.files.cwd', r.file.replace(/\/[^/]+$/, '')); } catch {} } }, icon('files', 13), 'Datei')) },
      ],
      search: true, searchPlaceholder: 'Cron-Job suchen …', sort: { key: 'source', dir: 'asc' }, dense: true, pageSize: 60, empty: 'Es gibt keine Cron-Jobs.',
      tools: h('button', { type: 'button', class: 'btn sm primary', onClick: () => addJob() }, icon('plus', 14), 'Neuer Cron-Job'),
    });
    panes.cron.append(card({ span: 12 }, cronT.el, h('p', { class: 'muted', style: { marginTop: '10px' } }, 'Jobs aus /etc/crontab und /etc/cron.d bearbeitest du im Dateimanager (Knopf „Datei“). Benutzer-Crontabs lassen sich hier direkt bearbeiten.')));
    const perBox = h('div', { class: 'grid' });
    panes.periodic.append(perBox);

    function editUserTab(user, append) {
      readOp('cron.user-get', { user }).then((r) => {
        const area = h('textarea', { class: 'editor', style: { minHeight: '40vh' }, spellcheck: 'false', 'aria-label': `Crontab von ${user}` });
        area.value = r.text + (append ? `${r.text && !r.text.endsWith('\n') ? '\n' : ''}${append}\n` : '');
        modal({ title: 'Crontab bearbeiten', lead: `Benutzer ${user}`, xwide: true, body: h('div', { class: 'form' }, r.empty && !append ? h('p', { class: 'muted' }, 'Dieser Benutzer hat noch keine Crontab.') : null, area, h('p', { class: 'muted' }, 'Fünf Zeitfelder (Minute Stunde Tag Monat Wochentag), dann der Befehl. Fehlerhafte Zeilen lehnt cron beim Speichern ab.')), buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async () => { try { await quickAction('cron.user-set', { user, text: area.value }, { success: 'Crontab gespeichert' }); setTimeout(load, 500); } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); return false; } } }] });
      }).catch((e) => { if (!e.cancelled) toast(e.message, 'crit'); });
    }

    function addJob() {
      const preset = h('select', { class: 'input', 'aria-label': 'Zeitplan' }, ...PRESETS.map(([v, l]) => h('option', { value: v }, l)));
      const expr = h('input', { class: 'input', style: { fontFamily: 'var(--mono)' }, value: PRESETS[4][0], 'aria-label': 'Cron-Ausdruck', spellcheck: 'false' });
      const preview = h('small', { class: 'muted' });
      const user = h('input', { class: 'input', value: 'root', 'aria-label': 'Benutzer' });
      const cmd = h('input', { class: 'input', style: { fontFamily: 'var(--mono)' }, placeholder: '/usr/local/bin/backup.sh', 'aria-label': 'Befehl', spellcheck: 'false' });
      const upd = () => { preview.textContent = `→ ${cronText(expr.value)}`; };
      preset.addEventListener('change', () => { if (preset.value !== 'custom') expr.value = preset.value; upd(); });
      expr.addEventListener('input', () => { preset.value = PRESETS.some((p) => p[0] === expr.value) ? expr.value : 'custom'; upd(); });
      upd();
      modal({
        title: 'Neuer Cron-Job', lead: 'Wird an die Crontab des Benutzers angehängt', body: h('div', { class: 'form' },
          h('div', { class: 'field' }, h('label', null, 'Benutzer'), user),
          h('div', { class: 'field' }, h('label', null, 'Zeitplan'), preset, expr, preview),
          h('div', { class: 'field' }, h('label', null, 'Befehl'), cmd, h('small', null, 'Vollständiger Pfad empfohlen. Umleitungen wie >> /var/log/job.log 2>&1 gehören dazu.'))),
        buttons: [{ label: 'Abbrechen' }, { label: 'Weiter', kind: 'primary', onClick: () => { if (!cmd.value.trim() || !user.value.trim()) { toast('Bitte Benutzer und Befehl angeben.', 'crit'); return false; } setTimeout(() => editUserTab(user.value.trim(), `${expr.value.trim()} ${cmd.value.trim()}`), 50); } }],
      });
    }

    root.append(h('div', { class: 'grid' }, mk('t', 'systemd-Timer', 'c1', 'cron'), mk('c', 'Cron-Jobs', 'c4', 'process'), mk('n', 'Nächster Lauf', 'c2', 'clock'), mk('f', 'Deaktivierte Timer', 'c8', 'ban'), h('div', { class: 's-12' }, t.el, panes.timers, panes.cron, panes.periodic)));
    for (const p of Object.values(panes)) p.append(h('p', { class: 'muted loading' }, 'Lade …'));

    function render() {
      const act = data.timers.filter((x) => x.next);
      const next = act.slice().sort((a, b) => a.next - b.next)[0];
      K.t.set({ value: String(data.timers.length), sub: `${data.timers.filter((x) => x.enabled === 'enabled').length} aktiviert`, color: 'c1' });
      K.c.set({ value: String(data.cron.filter((c) => !c.disabled).length), sub: `${data.cron.filter((c) => c.disabled).length} auskommentiert · ${data.userTabs.length} Benutzer-Crontabs`, color: 'c4' });
      K.n.set({ value: next ? rel(next.next * 1000).replace(/^in /, '') : '–', sub: next ? `${next.unit.replace(/\.timer$/, '')} um ${tShort(next.next * 1000)}` : 'kein Timer geplant', color: 'c2' });
      const off = data.timers.filter((x) => x.enabled && x.enabled !== 'enabled' && x.enabled !== 'static');
      K.f.set({ value: String(off.length), sub: off.length ? off.slice(0, 2).map((x) => x.unit.replace(/\.timer$/, '')).join(', ') : 'alle aktiv', color: 'c8' });
      timers.setRows(data.timers);
      cronT.setRows(data.cron);
      perBox.replaceChildren(...['hourly', 'daily', 'weekly', 'monthly'].map((k) => card({ title: { hourly: 'Stündlich', daily: 'Täglich', weekly: 'Wöchentlich', monthly: 'Monatlich' }[k], sub: `/etc/cron.${k}`, span: 3 },
        data.periodic[k].length ? h('ul', null, ...data.periodic[k].map((s) => h('li', { style: { padding: '5px 0', borderBottom: '1px solid var(--line-2)' } }, h('span', { class: 'mono' }, s.name)))) : h('p', { class: 'muted' }, 'Keine Skripte.'))));
      for (const p of Object.values(panes)) for (const l of [...p.querySelectorAll(':scope > .loading')]) l.remove();
    }
    async function load() {
      if (busy) return; busy = true;
      try { data = await readOp('cron.overview'); render(); } catch (e) { toast(e.message, 'crit'); }
      busy = false;
    }
    ctx.every(() => { if (!document.hidden) load(); }, 30_000);
    load();
    void banner; void emptyState; void num; void tFull;
  },
};
