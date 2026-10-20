// Alarms and automation: push notifications to your phone (ntfy, Telegram, Discord, Slack, webhook)
// and self-healing rules that restart a service or container that went down.

import { h, icon } from '../dom.js';
import { card, dataTable, badge, toast, banner, tabs, toggle, kpi, status } from '../widgets.js';
import { tShort, ago } from '../fmt.js';
import { api } from '../store.js';
import { modal, withUnlock, fieldEl, confirmDialog } from '../interact.js';

const TYPES = {
  ntfy: { label: 'ntfy', help: 'Einfach und kostenlos: App „ntfy“ installieren, ein geheimes Thema abonnieren, dasselbe Thema hier eintragen. Auch mit eigenem Server (siehe Apps).' },
  telegram: { label: 'Telegram', help: 'Mit @BotFather einen Bot anlegen und den Token kopieren. Dem Bot einmal schreiben, dann steht deine Chat-ID unter api.telegram.org/bot<TOKEN>/getUpdates.' },
  discord: { label: 'Discord', help: 'Kanal-Einstellungen → Integrationen → Webhooks → Neuer Webhook, dann die Webhook-URL kopieren.' },
  slack: { label: 'Slack', help: 'Eine „Incoming Webhook“-App für den Kanal anlegen und die URL kopieren.' },
  webhook: { label: 'Eigener Webhook', help: 'Schickt bei jedem Ereignis eine JSON-Nachricht per POST an deine Adresse: { title, detail, level, kind, host, time }.' },
};
const LEVELS = [['crit', 'Nur kritisch'], ['warn', 'Warnungen und kritisch'], ['info', 'Alles']];
const LEVEL_NAME = Object.fromEntries(LEVELS);

export default {
  id: 'automation', title: 'Alarme & Automatik', group: 'Dashboard', icon: 'zap', range: false, desc: 'Nachrichten aufs Handy und automatische Reparatur ausgefallener Dienste', keywords: 'benachrichtigung push ntfy telegram discord slack webhook selbstheilung auto restart neustart alarm',
  mount(root, ctx) {
    const { store } = ctx;
    let nf = { channels: [], log: [] }; let hl = { enabled: false, rules: [], log: [] };

    const panes = { notify: h('div'), heal: h('div') };
    const t = tabs([{ id: 'notify', label: 'Benachrichtigungen', icon: 'mail' }, { id: 'heal', label: 'Selbstheilung', icon: 'refresh' }], 'notify', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; });
    panes.heal.hidden = true;

    // ================================================================ notifications
    const chTable = dataTable({
      columns: [
        { key: 'name', label: 'Kanal', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, h('small', { class: 'sub' }, TYPES[r.type].label)) },
        { key: 'target', label: 'Ziel', cls: 'mono dim', sortable: false, fmt: (v, r) => (r.type === 'ntfy' ? `${new URL(r.url).host}/${r.topic}` : r.type === 'telegram' ? `Chat ${r.chat}` : (() => { try { return new URL(r.url).host; } catch { return r.url; } })()) },
        { key: 'minLevel', label: 'Meldet', fmt: (v, r) => h('span', null, LEVEL_NAME[v], r.recovery ? h('small', { class: 'sub' }, 'inkl. „wieder normal“') : null) },
        { key: 'quiet', label: 'Ruhezeit', sortable: false, fmt: (v) => (v && v.on ? `${v.from}–${v.to} (nur kritisch)` : 'keine') },
        { key: 'enabled', label: 'Aktiv', sort: (r) => (r.enabled ? 0 : 1), fmt: (v, r) => { const sw = toggle({ checked: v, onChange: (on) => { r.enabled = on; saveChannels().catch(() => { r.enabled = !on; sw.input.checked = !on; }); } }); return sw.el; } },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: (e) => testChannel(r, e.currentTarget) }, icon('zap', 13), 'Testen'), h('button', { type: 'button', class: 'btn sm', onClick: () => channelDialog(r) }, icon('edit', 13)), h('button', { type: 'button', class: 'btn sm danger', onClick: () => removeChannel(r) }, icon('trash', 13))) },
      ],
      dense: true, empty: 'Noch kein Kanal. Lege einen an, damit dich der Server von selbst erreicht.',
    });
    const logTable = dataTable({
      columns: [
        { key: 't', label: 'Zeit', fmt: (v) => h('span', null, tShort(v), h('small', { class: 'sub' }, ago(v))) },
        { key: 'channel', label: 'Kanal' }, { key: 'title', label: 'Nachricht', cls: 'wrap', fmt: (v, r) => h('span', null, v, r.test ? h('small', { class: 'sub' }, 'Testnachricht') : null) },
        { key: 'ok', label: 'Ergebnis', sort: (r) => (r.ok ? 1 : 0), fmt: (v, r) => (v ? badge('zugestellt', 'ok') : badge(r.error || 'fehlgeschlagen', 'crit')) },
      ],
      sort: { key: 't', dir: 'desc' }, dense: true, pageSize: 10, empty: 'Noch nichts gesendet.',
    });
    const addBtn = h('button', { type: 'button', class: 'btn primary sm', onClick: () => channelDialog(null) }, icon('plus', 13), 'Kanal hinzufügen');
    panes.notify.append(h('div', { class: 'grid' },
      h('div', { class: 's-12' }, banner('info', 'So erreichen dich Warnungen', 'Sobald etwas Kritisches passiert (Dienst fällt aus, Platte voll, Website nicht erreichbar), bekommst du eine Nachricht. Die Stufe stellst du pro Kanal ein. Eigene Klicks im Dashboard lösen nichts aus. Höchstens 30 Nachrichten pro Stunde und Kanal.')),
      card({ title: 'Kanäle', span: 12, actions: addBtn }, chTable.el),
      card({ title: 'Zustellprotokoll', sub: 'Die letzten Sendeversuche.', span: 12 }, logTable.el)));

    async function saveChannels() {
      try {
        nf = await withUnlock(() => api.put('/api/notify', { channels: nf.channels }));
        paintNotify();
      } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); throw e; }
    }
    async function testChannel(r, btn) {
      btn.disabled = true;
      try { await withUnlock(() => api.post('/api/notify/test', { id: r.id })); toast('Testnachricht gesendet. Schau auf dein Gerät.'); } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); }
      btn.disabled = false;
      setTimeout(loadNotify, 600);
    }
    async function removeChannel(r) {
      if (!(await confirmDialog({ title: 'Kanal löschen?', text: `„${r.name}“ erhält danach keine Nachrichten mehr.`, okLabel: 'Löschen', danger: true }))) return;
      nf.channels = nf.channels.filter((c) => c.id !== r.id);
      saveChannels().catch(() => loadNotify());
    }
    function channelDialog(existing) {
      const c = existing || { type: 'ntfy', name: '', enabled: true, minLevel: 'warn', recovery: true, quiet: { on: false, from: '22:00', to: '07:00' }, url: 'https://ntfy.sh', topic: '', chat: '' };
      const type = fieldEl({ name: 'type', label: 'Art', type: 'select', value: c.type, options: Object.entries(TYPES).map(([k, v]) => [k, v.label]) });
      if (existing) type.input.disabled = true;
      const name = fieldEl({ name: 'name', label: 'Name', value: c.name, placeholder: 'z. B. Mein Handy' });
      const url = fieldEl({ name: 'url', label: 'Adresse', value: c.url, mono: true });
      const topic = fieldEl({ name: 'topic', label: 'Thema', value: c.topic, hint: 'Wähle etwas Langes, Zufälliges. Wer das Thema kennt, kann mitlesen.', mono: true });
      const secret = fieldEl({ name: 'secret', label: 'Token', type: 'password', value: '', placeholder: existing && existing.secretSet ? '(gespeichert, leer lassen zum Behalten)' : '' });
      const chat = fieldEl({ name: 'chat', label: 'Chat-ID', value: c.chat, mono: true });
      const minLevel = fieldEl({ name: 'minLevel', label: 'Was soll gemeldet werden?', type: 'select', value: c.minLevel, options: LEVELS });
      const recovery = fieldEl({ name: 'recovery', label: 'Auch melden, wenn wieder alles normal ist', type: 'checkbox', value: c.recovery });
      const quiet = fieldEl({ name: 'quiet', label: 'Ruhezeit: nachts nur Kritisches senden', type: 'checkbox', value: c.quiet.on });
      const qFrom = h('input', { class: 'input', type: 'time', value: c.quiet.from, 'aria-label': 'Ruhezeit von', style: { width: 'auto' } });
      const qTo = h('input', { class: 'input', type: 'time', value: c.quiet.to, 'aria-label': 'Ruhezeit bis', style: { width: 'auto' } });
      const help = h('p', { class: 'muted' });
      const err = h('div', { class: 'err', role: 'alert' });
      const fieldsBox = h('div', { class: 'form' });
      const sync = () => {
        const k = type.input.value;
        help.textContent = TYPES[k].help;
        const els = { ntfy: [url.el, topic.el, secret.el], telegram: [secret.el, chat.el], discord: [url.el], slack: [url.el], webhook: [url.el] }[k];
        secret.el.querySelector('label').textContent = k === 'telegram' ? 'Bot-Token' : 'Zugangstoken (optional)';
        url.el.querySelector('label').textContent = k === 'ntfy' ? 'Server' : 'Webhook-Adresse';
        if (!existing || existing.type !== k) { if (k === 'ntfy' && !url.input.value.startsWith('https://ntfy')) url.input.value = 'https://ntfy.sh'; if (k !== 'ntfy' && url.input.value === 'https://ntfy.sh') url.input.value = ''; }
        fieldsBox.replaceChildren(...els);
      };
      type.input.addEventListener('change', sync); sync();
      modal({ title: existing ? `Kanal bearbeiten: ${c.name}` : 'Kanal hinzufügen', wide: true,
        body: h('div', { class: 'form' }, type.el, help, name.el, fieldsBox, minLevel.el, recovery.el, h('div', { class: 'field' }, quiet.el, h('div', { class: 'row', style: { gap: '8px', marginTop: '6px' } }, qFrom, 'bis', qTo)), err),
        buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async () => {
          err.textContent = '';
          const next = { id: existing ? existing.id : undefined, type: type.get(), name: name.get().trim() || TYPES[type.get()].label, enabled: existing ? existing.enabled : true, minLevel: minLevel.get(), recovery: recovery.get(), quiet: { on: quiet.get(), from: qFrom.value, to: qTo.value }, url: url.get().trim(), topic: topic.get().trim(), chat: chat.get().trim(), secret: secret.get() };
          const prev = nf.channels;
          nf.channels = existing ? prev.map((x) => (x.id === existing.id ? next : x)) : [...prev, next];
          try { await withUnlock(async () => { nf = await api.put('/api/notify', { channels: nf.channels }); }); paintNotify(); toast('Gespeichert'); } catch (e) { nf.channels = prev; if (!e.cancelled) err.textContent = e.message; return false; }
        } }] });
    }
    function paintNotify() {
      chTable.setRows(nf.channels);
      logTable.setRows(nf.log);
      K.c.set({ value: String(nf.channels.filter((c) => c.enabled).length), sub: `${nf.channels.length} angelegt` });
      K.s.set({ value: String(nf.log.filter((l) => l.ok && !l.test).length), sub: `${nf.log.filter((l) => !l.ok).length} fehlgeschlagen` });
    }
    async function loadNotify() { try { nf = await api.get('/api/notify'); paintNotify(); } catch (e) { toast(e.message, 'crit'); } }

    // ================================================================ self-healing
    const masterSw = toggle({ checked: false, label: 'Selbstheilung eingeschaltet', onChange: (on) => { hl.enabled = on; saveHeal().catch(() => { hl.enabled = !on; masterSw.input.checked = !on; }); } });
    const ruleTable = dataTable({
      columns: [
        { key: 'name', label: 'Ziel', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, h('small', { class: 'sub' }, r.kind === 'unit' ? 'Dienst' : 'Container')) },
        { key: 'state', label: 'Zustand jetzt', fmt: (v, r) => (r.gaveUp ? status('aufgegeben', 'crit') : r.paused ? status('von dir gestoppt', 'neutral') : r.down ? status(v, 'warn') : status(v, 'ok')) },
        { key: 'delay', label: 'Wartezeit', align: 'r', fmt: (v) => `${v} s` },
        { key: 'perHour', label: 'Höchstens pro Std', align: 'r', fmt: (v, r) => `${r.restartsLastHour} von ${v} genutzt` },
        { key: 'enabled', label: 'Aktiv', sort: (r) => (r.enabled ? 0 : 1), fmt: (v, r) => { const sw = toggle({ checked: v, onChange: (on) => { r.enabled = on; saveHeal().catch(() => { r.enabled = !on; sw.input.checked = !on; }); } }); return sw.el; } },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: () => ruleDialog(r) }, icon('edit', 13)), h('button', { type: 'button', class: 'btn sm danger', onClick: () => { hl.rules = hl.rules.filter((x) => x.id !== r.id); saveHeal().catch(() => loadHeal()); } }, icon('trash', 13))) },
      ],
      dense: true, empty: 'Noch keine Regel. Füge Dienste oder Container hinzu, die sich selbst reparieren sollen.',
    });
    const healLog = dataTable({
      columns: [{ key: 't', label: 'Zeit', fmt: (v) => h('span', null, tShort(v), h('small', { class: 'sub' }, ago(v))) }, { key: 'name', label: 'Ziel', cls: 'tbl-title' }, { key: 'text', label: 'Was passierte', cls: 'wrap' }, { key: 'ok', label: 'Ergebnis', fmt: (v) => (v ? badge('ok', 'ok') : badge('Problem', 'crit')) }],
      sort: { key: 't', dir: 'desc' }, dense: true, pageSize: 10, empty: 'Bisher musste nichts repariert werden.',
    });
    panes.heal.append(h('div', { class: 'grid' },
      h('div', { class: 's-12' }, banner('info', 'Wie die Selbstheilung arbeitet', 'Fällt ein Dienst oder Container aus, wartet das Dashboard die eingestellte Zeit und startet ihn dann neu. Pro Stunde gibt es nur so viele Versuche, wie du erlaubst; hilft das nicht, gibt es auf und schlägt Alarm. Was du selbst im Dashboard stoppst, bleibt gestoppt.')),
      card({ title: 'Regeln', span: 12, actions: h('span', { class: 'row', style: { gap: '12px' } }, masterSw.el, h('button', { type: 'button', class: 'btn primary sm', onClick: () => ruleDialog(null) }, icon('plus', 13), 'Regel hinzufügen')) }, ruleTable.el),
      card({ title: 'Protokoll der Selbstheilung', span: 12 }, healLog.el)));

    async function saveHeal() {
      try { hl = { ...hl, ...(await withUnlock(() => api.put('/api/heal', { enabled: hl.enabled, rules: hl.rules }))) }; paintHeal(); } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); throw e; }
    }
    async function ruleDialog(existing) {
      let units = [];
      try { units = (await api.get('/api/services')).list.filter((u) => u.load === 'loaded').map((u) => u.id).sort(); } catch {}
      const dk = ((store.detail && store.detail.docker && store.detail.docker.containers) || []).map((c) => c.name).sort();
      const r = existing || { kind: 'unit', name: '', delay: 30, perHour: 3, unhealthy: true, enabled: true };
      const kind = fieldEl({ name: 'kind', label: 'Was soll überwacht werden?', type: 'select', value: r.kind, options: [['unit', 'Ein Dienst (systemd)'], ['container', 'Ein Docker-Container']] });
      if (existing) kind.input.disabled = true;
      const pick = h('select', { class: 'input', 'aria-label': 'Ziel' });
      const fill = () => { const list = kind.input.value === 'unit' ? units : dk; pick.replaceChildren(...(list.length ? list : ['(keine gefunden)']).map((n) => h('option', { value: n, selected: n === r.name ? '' : null }, n))); };
      kind.input.addEventListener('change', fill); fill();
      const delay = fieldEl({ name: 'delay', label: 'Wartezeit vor dem Neustart (Sekunden)', type: 'number', value: r.delay, min: 5, max: 900, hint: 'So lange muss das Ziel ausgefallen sein, bevor es neu gestartet wird.' });
      const per = fieldEl({ name: 'perHour', label: 'Höchstens so viele Neustarts pro Stunde', type: 'number', value: r.perHour, min: 1, max: 30 });
      const unh = fieldEl({ name: 'unhealthy', label: 'Container auch neu starten, wenn er „unhealthy“ ist', type: 'checkbox', value: r.unhealthy });
      const err = h('div', { class: 'err', role: 'alert' });
      modal({ title: existing ? `Regel bearbeiten: ${r.name}` : 'Regel hinzufügen', body: h('div', { class: 'form' }, kind.el, h('div', { class: 'field' }, h('label', null, 'Ziel'), pick), delay.el, per.el, unh.el, err),
        buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async () => {
          const name = existing ? existing.name : pick.value;
          if (!name || name.startsWith('(')) { err.textContent = 'Bitte ein Ziel wählen.'; return false; }
          const next = { id: existing ? existing.id : undefined, kind: kind.get(), name, enabled: existing ? existing.enabled : true, delay: delay.get(), perHour: per.get(), unhealthy: unh.get() };
          const prev = hl.rules;
          hl.rules = existing ? prev.map((x) => (x.id === existing.id ? next : x)) : [...prev, next];
          try { await saveHeal(); } catch (e) { hl.rules = prev; err.textContent = e.cancelled ? '' : e.message; return false; }
        } }] });
    }
    function paintHeal() {
      masterSw.input.checked = hl.enabled;
      ruleTable.setRows(hl.rules);
      healLog.setRows(hl.log);
      K.h.set({ value: hl.enabled ? 'An' : 'Aus', sub: `${hl.rules.filter((x) => x.enabled).length} Regeln aktiv`, level: hl.enabled ? 'ok' : '' });
    }
    async function loadHeal() { try { hl = await api.get('/api/heal'); paintHeal(); } catch (e) { toast(e.message, 'crit'); } }

    // ================================================================ page
    const K = { c: kpi({ label: 'Aktive Kanäle', color: 'c1', span: 4, icon: 'mail' }), h: kpi({ label: 'Selbstheilung', color: 'c7', span: 4, icon: 'refresh' }), s: kpi({ label: 'Gesendet (Protokoll)', color: 'c4', span: 4, icon: 'zap' }) };
    root.append(h('div', { class: 'grid' }, K.c.el, K.h.el, K.s.el, h('div', { class: 's-12' }, t.el, panes.notify, panes.heal)));
    loadNotify();
    loadHeal();
    ctx.every(() => { if (!document.hidden) { loadHeal(); loadNotify(); } }, 15_000);
  },
};
