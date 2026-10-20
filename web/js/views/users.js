// Accounts, groups, login sessions, SSH keys and recent logins.

import { h, icon } from '../dom.js';
import { kpi, card, dataTable, badge, tabs, toast, banner, emptyState, segmented } from '../widgets.js';
import { num, tShort, tFull, rel } from '../fmt.js';
import { readOp, actionDialog, quickAction, modal, trigger, menu } from '../interact.js';

const PROTECTED = new Set(['root', 'serverdash', 'nobody']);
const isPerson = (u) => u.uid >= 1000 && u.uid < 60000 || u.uid === 0 || (!u.noLogin && u.uid >= 1000);

export default {
  id: 'users', title: 'Benutzer & SSH', group: 'Zugriff', icon: 'users', range: false, desc: 'Konten, Gruppen, Anmeldungen und SSH-Schlüssel verwalten', keywords: 'user konto sudo ssh schlüssel key session passwort gruppe login',
  mount(root, ctx) {
    let data = null; let busy = false; let ssh = null; let hours = 24;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 3, icon: ic }); return K[id].el; };
    const panes = { users: h('div'), sessions: h('div'), groups: h('div'), logins: h('div') };
    const t = tabs([{ id: 'users', label: 'Benutzer' }, { id: 'sessions', label: 'Aktive Sitzungen' }, { id: 'logins', label: 'Letzte Anmeldungen' }, { id: 'groups', label: 'Gruppen' }], 'users', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; if (id === 'logins' && !ssh) loadSsh(); });
    for (const k of ['sessions', 'groups', 'logins']) panes[k].hidden = true;

    const filters = [{ label: 'Konten mit Anmeldung', fn: (r) => isPerson(r) }, { label: 'Alle', fn: () => true }, { label: 'Systemkonten', fn: (r) => !isPerson(r) }];
    const utable = dataTable({
      columns: [
        { key: 'name', label: 'Benutzer', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, r.gecos && r.gecos.replace(/,+$/, '') ? h('small', { class: 'sub' }, r.gecos.replace(/,+$/, '')) : null) },
        { key: 'uid', label: 'UID', align: 'r' },
        { key: 'status', label: 'Status', sort: (r) => (r.locked ? 1 : 0) + (r.online ? -1 : 0), fmt: (v, r) => h('span', { class: 'pill-list' }, r.online ? badge(`online (${r.online})`, 'ok') : null, r.locked ? badge('gesperrt', 'warn') : r.noLogin ? badge('keine Anmeldung', 'neutral') : badge('aktiv', 'neutral'), r.sudo ? badge('Administrator', 'accent') : null) },
        { key: 'keys', label: 'SSH-Schlüssel', align: 'r', fmt: (v) => (v ? String(v) : '–') },
        { key: 'shell', label: 'Shell', cls: 'mono dim' }, { key: 'home', label: 'Home', cls: 'mono dim wrap', fmt: (v, r) => (r.hasHome ? v : `${v} (fehlt)`) },
        { key: 'groups', label: 'Gruppen', cls: 'wrap dim', sort: (r) => r.groups.length, fmt: (v) => v.slice(0, 5).join(', ') + (v.length > 5 ? ` +${v.length - 5}` : '') },
        { key: 'lastChange', label: 'Passwort geändert', align: 'r', fmt: (v) => (v ? tShort(v) : '–') },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => trigger((a) => userMenu(a, r)) },
      ],
      search: true, searchPlaceholder: 'Benutzer suchen …', sort: { key: 'uid', dir: 'asc' }, dense: true, pageSize: 100, filters,
      tools: h('button', { type: 'button', class: 'btn sm primary', onClick: () => addUser() }, icon('plus', 14), 'Benutzer anlegen'),
      onRow: (r) => keysDialog(r.name),
    });
    panes.users.append(card({ span: 12 }, utable.el));

    function userMenu(anchor, r) {
      const prot = PROTECTED.has(r.name) || r.uid === 0;
      menu(anchor, [
        { label: 'SSH-Schlüssel ansehen und ändern', sub: `${r.keys} hinterlegt`, onClick: () => keysDialog(r.name) },
        'hr',
        prot ? null : r.locked ? { label: 'Entsperren', onClick: () => lock(r, false) } : { label: 'Sperren', sub: 'Anmeldung verhindern', onClick: () => lock(r, true) },
        prot ? null : r.sudo ? { label: 'Administratorrechte entziehen', sub: 'aus Gruppe sudo entfernen', onClick: () => sudo(r, false) } : { label: 'Zum Administrator machen', sub: 'Gruppe sudo', onClick: () => sudo(r, true) },
        prot ? { label: 'Dieses Konto ist geschützt', onClick: () => toast('Administrator- und Dashboard-Konten lassen sich hier nicht sperren oder löschen.') } : null,
        prot ? null : 'hr',
        prot ? null : { label: 'Löschen', danger: true, onClick: () => del(r) },
      ]);
    }
    const lock = (r, on) => actionDialog({ op: 'users.lock', args: { name: r.name, lock: on }, title: on ? 'Benutzer sperren' : 'Benutzer entsperren', lead: r.name, text: on ? 'Das Passwort des Kontos wird gesperrt. Anmeldung per Schlüssel kann je nach SSH-Einstellung weiter möglich sein; laufende Sitzungen bleiben bestehen.' : 'Das Konto kann sich wieder anmelden.', okLabel: on ? 'Sperren' : 'Entsperren', danger: on, success: on ? 'Benutzer gesperrt' : 'Benutzer entsperrt', after: () => setTimeout(load, 400) });
    const sudo = (r, on) => actionDialog({ op: 'users.sudo', args: { name: r.name, on }, title: on ? 'Administratorrechte erteilen' : 'Administratorrechte entziehen', lead: r.name, text: on ? 'Dieser Benutzer darf danach mit sudo beliebige Befehle als root ausführen. Das ist praktisch der volle Zugriff auf den Server.' : 'Der Benutzer wird aus der Gruppe sudo entfernt.', okLabel: on ? 'Erteilen' : 'Entziehen', danger: on, success: on ? 'Administratorrechte erteilt' : 'Administratorrechte entzogen', after: () => setTimeout(load, 400) });
    const del = (r) => actionDialog({ op: 'users.delete', args: (v) => ({ name: r.name, removeHome: !!v.removeHome }), title: 'Benutzer löschen', lead: r.name, danger: true, okLabel: 'Löschen', text: 'Das Konto wird gelöscht. Nicht angemeldete Benutzer lassen sich entfernen; Dateien außerhalb des Home-Verzeichnisses bleiben liegen.', fields: [{ name: 'removeHome', label: 'Home-Verzeichnis samt Inhalt löschen', type: 'checkbox', value: false }], success: 'Benutzer gelöscht', after: () => setTimeout(load, 400) });
    const addUser = () => actionDialog({
      op: 'users.add', args: (v) => ({ name: v.name.trim(), comment: v.comment.trim() || undefined, shell: v.shell, sudo: !!v.sudo }), title: 'Benutzer anlegen', lead: 'Neues Konto',
      text: 'Das Konto wird gesperrt angelegt. Hinterlege danach einen SSH-Schlüssel, damit sich der Benutzer anmelden kann.',
      fields: [{ name: 'name', label: 'Benutzername', type: 'text', hint: 'Kleinbuchstaben, Ziffern, _ und -' }, { name: 'comment', label: 'Voller Name (optional)', type: 'text' }, { name: 'shell', label: 'Shell', type: 'select', value: '/bin/bash', options: [...((data && data.shells) || ['/bin/bash']).map((s) => [s, s]), ['/usr/sbin/nologin', '/usr/sbin/nologin (keine Anmeldung)']] }, { name: 'sudo', label: 'Administratorrechte (sudo)', type: 'checkbox', value: false }],
      validate: (v) => (/^[a-z_][a-z0-9_-]{0,31}$/.test(v.name.trim()) ? null : 'Ungültiger Benutzername.'), okLabel: 'Anlegen', success: 'Benutzer angelegt', after: () => setTimeout(load, 500),
    });

    async function keysDialog(name) {
      let r;
      try { r = await readOp('users.keys-get', { name }); } catch (e) { if (!e.cancelled) toast(e.code === 'elevation' ? 'Dafür ist die Freischaltung nötig.' : e.message, 'crit'); return; }
      const area = h('textarea', { class: 'editor', style: { minHeight: '28vh' }, spellcheck: 'false', 'aria-label': 'authorized_keys' });
      area.value = r.text;
      const list = h('div');
      const paint = () => list.replaceChildren(r.keys.length ? h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl dense' }, h('thead', null, h('tr', null, h('th', null, 'Zeile'), h('th', null, 'Schlüssel'), h('th', null, 'Fingerabdruck'))), h('tbody', null, ...r.keys.map((k) => h('tr', null, h('td', null, String(k.line)), h('td', { class: 'mono wrap' }, k.text), h('td', { class: 'mono wrap' }, k.valid ? k.fingerprint : badge('ungültig', 'crit'))))))) : h('p', { class: 'muted' }, 'Es sind keine Schlüssel hinterlegt.'));
      paint();
      modal({
        title: 'SSH-Schlüssel', lead: `${name} · ${r.path}`, xwide: true,
        body: h('div', { class: 'form' }, banner('info', 'Öffentliche Schlüssel', 'Eine Zeile pro Schlüssel (ssh-ed25519 AAAA… Kommentar). Vor dem Speichern wird jede Zeile geprüft. Das ist der Inhalt der Datei authorized_keys.'), list, area),
        buttons: [{ label: 'Schließen' }, { label: 'Speichern', kind: 'primary', onClick: async () => { try { await quickAction('users.keys-set', { name, text: area.value }, { success: 'Schlüssel gespeichert', confirmTitle: 'SSH-Schlüssel ändern', confirmText: 'Falsche Schlüssel können dich vom Server aussperren.' }); setTimeout(load, 400); } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); return false; } } }],
      });
    }

    // sessions
    const stable = dataTable({
      columns: [
        { key: 'user', label: 'Benutzer', cls: 'tbl-title' }, { key: 'tty', label: 'Terminal', cls: 'mono' },
        { key: 'host', label: 'Von', cls: 'mono', fmt: (v, r) => v || (r.remote ? 'entfernt' : 'lokal') }, { key: 'service', label: 'Dienst', cls: 'dim' }, { key: 'type', label: 'Art', cls: 'dim' },
        { key: 'state', label: 'Zustand', fmt: (v) => badge(v, v === 'active' ? 'ok' : 'neutral') }, { key: 'since', label: 'Seit', cls: 'dim nw' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'users.session-kill', args: { id: r.id }, title: 'Sitzung beenden', lead: `${r.user} · ${r.tty || r.type}${r.host ? ` · ${r.host}` : ''}`, text: 'Die Sitzung wird sofort getrennt. Nicht gespeicherte Arbeit darin geht verloren.', danger: true, okLabel: 'Beenden', success: 'Sitzung beendet', after: () => setTimeout(load, 700) }) }, 'Beenden') },
      ],
      dense: true, sort: { key: 'user', dir: 'asc' }, empty: 'Niemand ist angemeldet.',
    });
    panes.sessions.append(card({ span: 12 }, stable.el));

    const gtable = dataTable({
      columns: [{ key: 'name', label: 'Gruppe', cls: 'tbl-title' }, { key: 'gid', label: 'GID', align: 'r' }, { key: 'members', label: 'Mitglieder', cls: 'wrap', sort: (r) => r.members.length, fmt: (v) => (v.length ? h('span', { class: 'pill-list' }, ...v.map((m) => h('span', { class: 'tag' }, m))) : '–') }],
      search: true, searchPlaceholder: 'Gruppe suchen …', dense: true, sort: { key: 'gid', dir: 'asc' }, pageSize: 100,
      filters: [{ label: 'Mit Mitgliedern', fn: (r) => r.members.length > 0 }, { label: 'Alle', fn: () => true }],
    });
    panes.groups.append(card({ span: 12 }, gtable.el));

    // logins (journal)
    const loginBox = h('div');
    panes.logins.append(card({ title: 'Erfolgreiche SSH-Anmeldungen', sub: 'Aus dem Journal des SSH-Dienstes. Fehlversuche findest du unter Sicherheit.', span: 12, actions: segmented([[24, '24 Std'], [168, '7 Tage'], [720, '30 Tage']], hours, (v) => { hours = v; ssh = null; loadSsh(); }).el }, loginBox));
    async function loadSsh() {
      loginBox.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
      try {
        ssh = await readOp('auth.ssh', { hours });
        const lt = dataTable({ columns: [{ key: 't', label: 'Zeit', fmt: (v) => `${tFull(v)} (${rel(v)})`, sort: (r) => r.t }, { key: 'user', label: 'Benutzer', cls: 'tbl-title' }, { key: 'ip', label: 'Von', cls: 'mono' }, { key: 'method', label: 'Methode', fmt: (v) => (v === 'publickey' ? badge('Schlüssel', 'ok') : badge(v, 'warn')) }], dense: true, sort: { key: 't', dir: 'desc' }, empty: 'Keine erfolgreichen Anmeldungen im Zeitraum.', pageSize: 100 });
        lt.setRows(ssh.accepted);
        loginBox.replaceChildren(lt.el);
      } catch (e) { loginBox.replaceChildren(h('p', { class: 'err' }, e.message)); }
    }

    root.append(h('div', { class: 'grid' }, mk('u', 'Konten mit Anmeldung', 'c1', 'users'), mk('s', 'Aktive Sitzungen', 'c2', 'terminal'), mk('a', 'Administratoren', 'c4', 'key'), mk('k', 'SSH-Schlüssel', 'c9', 'key'), h('div', { class: 's-12' }, t.el, panes.users, panes.sessions, panes.logins, panes.groups)));

    function render() {
      const people = data.users.filter(isPerson);
      K.u.set({ value: String(people.length), sub: `${data.users.length} Konten insgesamt`, color: 'c1' });
      K.s.set({ value: String(data.sessions.length), sub: data.sessions.length ? [...new Set(data.sessions.map((s) => s.user))].join(', ') : 'niemand angemeldet', color: 'c2' });
      K.a.set({ value: String(data.users.filter((u) => u.sudo && isPerson(u)).length), sub: data.users.filter((u) => u.sudo && isPerson(u)).map((u) => u.name).join(', ') || '–', color: 'c4' });
      K.k.set({ value: String(data.users.reduce((a, u) => a + u.keys, 0)), sub: 'in allen authorized_keys', color: 'c9' });
      t.setBadge('sessions', data.sessions.length || '', 'info');
      utable.setRows(data.users);
      stable.setRows(data.sessions);
      gtable.setRows(data.groups);
    }
    async function load() {
      if (busy) return; busy = true;
      try { data = await readOp('users.list'); render(); } catch (e) { toast(e.message, 'crit'); }
      busy = false;
    }
    ctx.every(() => { if (!document.hidden) load(); }, 20_000);
    load();
    void emptyState; void num;
  },
};
