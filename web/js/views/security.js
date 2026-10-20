// Security: automatic check, firewall (ufw), fail2ban, SSH attacks and open ports.

import { h, icon } from '../dom.js';
import { kpi, card, dataTable, badge, tabs, toast, banner, emptyState, segmented, tiles } from '../widgets.js';
import { BarList, columns } from '../charts.js';
import { num, tShort, tFull, rel, B } from '../fmt.js';
import { readOp, actionDialog, modal, trigger, menu } from '../interact.js';

const DB_PORTS = new Set([3306, 5432, 6379, 27017, 11211, 9200]);
const isLocal = (a) => /^(127\.|::1$|localhost)/.test(a);

export default {
  id: 'security', title: 'Sicherheit', group: 'Zugriff', icon: 'shield', range: false, desc: 'Sicherheits-Check, Firewall, fail2ban, SSH-Angriffe und offene Ports', keywords: 'firewall ufw fail2ban ports ssh angriffe brute force sperren',
  mount(root, ctx) {
    let fw = null; let audit = null; let socks = null; let sshD = null; let pk = null; let certs = null; let hours = 24; let busy = false;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 3, icon: ic }); return K[id].el; };
    const panes = { check: h('div'), fw: h('div'), f2b: h('div'), ssh: h('div'), ports: h('div') };
    const t = tabs([{ id: 'check', label: 'Sicherheits-Check' }, { id: 'fw', label: 'Firewall' }, { id: 'f2b', label: 'fail2ban' }, { id: 'ssh', label: 'SSH-Angriffe' }, { id: 'ports', label: 'Offene Ports' }], 'check', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; if (id === 'ssh' && !sshD) loadSsh(); });
    for (const k of ['fw', 'f2b', 'ssh', 'ports']) panes[k].hidden = true;

    // ------------------------------------------------------------ check
    const checkBox = h('div');
    panes.check.append(card({ title: 'Sicherheits-Check', sub: 'Automatisch aus den echten Einstellungen des Servers abgeleitet. Nichts davon wird verändert.', span: 12 }, checkBox));
    function checks() {
      const out = [];
      const add = (level, title, text) => out.push({ level, title, text });
      if (audit) {
        const s = audit.sshd;
        const rl = s.permitrootlogin;
        if (rl === 'yes') add('warn', 'SSH: Root-Anmeldung erlaubt', 'Root darf sich direkt per SSH anmelden, auch mit Passwort. Besser: „prohibit-password“ oder „no“ in /etc/ssh/sshd_config.');
        else if (rl) add('ok', 'SSH: Root-Anmeldung eingeschränkt', `PermitRootLogin ist „${rl}“.`);
        if (s.passwordauthentication === 'yes') add('warn', 'SSH: Anmeldung mit Passwort möglich', 'Passwörter lassen sich per Brute-Force erraten. Nur Schlüssel (PasswordAuthentication no) ist sicherer. fail2ban mildert das Risiko.');
        else if (s.passwordauthentication) add('ok', 'SSH: nur Schlüssel-Anmeldung', 'Passwörter werden für SSH nicht akzeptiert.');
        if (s.permitemptypasswords === 'yes') add('crit', 'SSH: leere Passwörter erlaubt', 'Konten ohne Passwort könnten sich anmelden.');
        add('info', `SSH lauscht auf Port ${s.port || '22'}`, s.allowusers ? `Erlaubte Benutzer: ${s.allowusers}` : 'Keine Benutzerbeschränkung (AllowUsers) gesetzt.');
        if (audit.emptyPasswords.length) add('crit', 'Konten ohne Passwort', audit.emptyPasswords.join(', '));
        if (audit.uid0.length > 1) add('warn', 'Mehrere Konten mit Administrator-ID 0', `${audit.uid0.join(', ')} haben die Rechte von root. Prüfe, ob das gewollt ist.`);
        add(audit.unattended ? 'ok' : 'warn', audit.unattended ? 'Automatische Sicherheits-Updates sind installiert' : 'Keine automatischen Sicherheits-Updates', audit.unattended ? 'Das Paket unattended-upgrades ist installiert.' : 'Updates werden nur eingespielt, wenn du sie unter „Updates & Pakete“ startest.');
      }
      if (fw) {
        add(fw.ufw.active ? 'ok' : 'crit', fw.ufw.active ? `Firewall aktiv (${fw.ufw.rules.length} Regeln)` : 'Firewall ist ausgeschaltet', fw.ufw.active ? fw.ufw.defaults : 'Ohne Firewall sind alle Ports offen, die ein Dienst öffnet.');
        add(fw.f2b.available ? 'ok' : 'warn', fw.f2b.available ? `fail2ban läuft (${fw.f2b.jails.length} Jails)` : 'fail2ban ist nicht aktiv', fw.f2b.available ? `${fw.f2b.jails.reduce((a, j) => a + j.currentBanned, 0)} Adressen aktuell gesperrt.` : (fw.f2b.error || ''));
      }
      if (socks) {
        const pub = socks.filter((x) => !isLocal(x.local));
        const db = pub.filter((x) => DB_PORTS.has(x.port));
        const allowed = (port) => fw && fw.ufw.active && fw.ufw.rules.some((r) => r.action === 'ALLOW' && new RegExp(`(^|[^0-9])${port}(/|$| )`).test(r.to));
        const open = db.filter((x) => !fw || !fw.ufw.active || allowed(x.port));
        const shielded = db.filter((x) => !open.includes(x));
        const desc = (l) => l.map((x) => `${x.port}/${x.proto} (${(x.procs[0] || {}).name || '?'})`).join(', ');
        if (open.length) add('crit', 'Datenbank-Port öffentlich erreichbar', desc(open));
        if (shielded.length) add('warn', 'Datenbank lauscht auf allen Adressen, die Firewall blockt sie', `${desc(shielded)}: Es gibt keine ufw-Erlaubnis dafür, von außen kommt niemand durch. Sicherer ist, den Dienst nur an 127.0.0.1 zu binden. Das kannst du in den Einstellungen der Datenbank oder der systemd-Socket-Datei ändern.`);
        if (!db.length) add('ok', 'Keine Datenbank-Ports im Internet', 'MariaDB, Redis und PostgreSQL lauschen nur lokal.');
        add('info', `${pub.length} Ports lauschen öffentlich`, 'Siehe Tab „Offene Ports“. Ob sie von außen erreichbar sind, hängt zusätzlich von der Firewall ab.');
      }
      if (pk) {
        const sec = pk.upgradable.filter((p) => p.security).length;
        add(sec ? 'crit' : 'ok', sec ? `${sec} Sicherheits-Updates offen` : 'Keine offenen Sicherheits-Updates', sec ? pk.upgradable.filter((p) => p.security).slice(0, 6).map((p) => p.name).join(', ') : `${pk.upgradable.length} normale Updates verfügbar.`);
        if (pk.reboot) add('warn', 'Neustart nötig', `Für: ${pk.rebootPkgs.join(', ') || 'Kernel-Update'}`);
      }
      if (certs) {
        const soon = certs.certs.filter((c) => c.expires && c.expires - Date.now() < 14 * 86400_000);
        if (soon.length) add('warn', 'Zertifikate laufen bald ab', soon.map((c) => `${c.name} (${c.status})`).join(', '));
        else add('ok', 'Alle Zertifikate sind noch lange gültig', `${certs.certs.length} Zertifikate geprüft.`);
      }
      return out;
    }
    function renderChecks() {
      const list = checks();
      const bad = list.filter((c) => c.level === 'crit').length; const warn = list.filter((c) => c.level === 'warn').length;
      K.c.set({ value: bad ? String(bad) : warn ? String(warn) : 'OK', unit: bad ? 'kritisch' : warn ? 'Hinweise' : '', sub: `${list.filter((c) => c.level === 'ok').length} von ${list.filter((c) => c.level !== 'info').length} Prüfungen bestanden`, level: bad ? 'crit' : warn ? 'warn' : 'ok', color: 'c1' });
      const order = { crit: 0, warn: 1, info: 2, ok: 3 };
      checkBox.replaceChildren(h('div', { class: 'tl' }, ...list.sort((a, b) => order[a.level] - order[b.level]).map((c) => h('div', { class: `ev lv-${c.level === 'info' ? 'info' : c.level}` }, h('span', { class: 'ev-i' }), h('div', null, h('div', { class: 'ev-t' }, c.title), h('div', { class: 'ev-d' }, c.text)), h('div', { class: 'ev-when' }, badge({ ok: 'in Ordnung', warn: 'Hinweis', crit: 'kritisch', info: 'Info' }[c.level], c.level === 'info' ? 'info' : c.level))))));
    }

    // ------------------------------------------------------------ firewall
    const fwBox = h('div', { class: 'grid' });
    panes.fw.append(fwBox);
    function addRule() {
      return actionDialog({
        op: 'fw.ufw-add', args: (v) => ({ action: v.action, port: v.port.trim(), proto: v.proto, from: v.from.trim() || 'any', comment: v.comment.trim() || undefined }), title: 'Firewall-Regel hinzufügen', lead: 'ufw',
        text: 'Regeln wirken sofort. Du kannst SSH (22), HTTP (80) und HTTPS (443) nicht für alle sperren, damit du dich nicht aussperrst.',
        fields: [{ name: 'action', label: 'Aktion', type: 'select', value: 'allow', options: [['allow', 'Erlauben'], ['deny', 'Verwerfen (still)'], ['reject', 'Ablehnen (mit Antwort)'], ['limit', 'Begrenzen (gegen Brute-Force)']] },
          { name: 'port', label: 'Port', type: 'text', placeholder: '8080 oder 6000:6010' }, { name: 'proto', label: 'Protokoll', type: 'select', value: 'tcp', options: [['tcp', 'TCP'], ['udp', 'UDP'], ['any', 'beide']] },
          { name: 'from', label: 'Von Adresse', type: 'text', placeholder: 'leer = von überall, oder IP / Netz wie 203.0.113.0/24' }, { name: 'comment', label: 'Notiz (optional)', type: 'text' }],
        validate: (v) => (/^\d{1,5}(:\d{1,5})?$/.test(v.port.trim()) ? null : 'Bitte einen Port angeben (z. B. 8080).'), okLabel: 'Hinzufügen', success: 'Regel hinzugefügt', after: () => setTimeout(load, 500),
      });
    }
    function renderFw() {
      const u = fw.ufw;
      const rules = dataTable({
        columns: [
          { key: 'n', label: '#', align: 'r' }, { key: 'to', label: 'Ziel (Port/Dienst)', cls: 'tbl-title' },
          { key: 'action', label: 'Aktion', fmt: (v, r) => badge(`${{ ALLOW: 'erlauben', DENY: 'verwerfen', REJECT: 'ablehnen', LIMIT: 'begrenzen' }[v] || v}${r.dir === 'IN' ? '' : ` (${r.dir})`}`, v === 'ALLOW' ? 'ok' : v === 'LIMIT' ? 'info' : 'crit') },
          { key: 'from', label: 'Von' }, { key: 'comment', label: 'Notiz', cls: 'dim wrap' },
          { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'fw.ufw-delete', args: { number: r.n, expect: r.raw }, title: 'Firewall-Regel löschen', lead: `${r.to} · ${r.action} · von ${r.from}`, text: 'Die Regel wird sofort entfernt. Löschst du eine Erlaubnis, ist der Dienst dahinter nicht mehr erreichbar.', danger: true, okLabel: 'Löschen', success: 'Regel gelöscht', after: () => setTimeout(load, 500) }) }, 'Löschen') },
        ],
        dense: true, sort: { key: 'n', dir: 'asc' }, pageSize: 100, empty: u.active ? 'Keine Regeln.' : 'Die Firewall ist ausgeschaltet.',
        tools: h('button', { type: 'button', class: 'btn sm primary', onClick: addRule }, icon('plus', 14), 'Regel hinzufügen'),
      });
      rules.setRows(u.rules);
      fwBox.replaceChildren(
        card({ title: 'Firewall (ufw)', sub: u.defaults || '', span: 12, actions: [badge(u.active ? 'aktiv' : 'aus', u.active ? 'ok' : 'crit'), h('button', { type: 'button', class: `btn sm ${u.active ? 'danger' : 'primary'}`, onClick: () => actionDialog({ op: 'fw.ufw-enable', args: { on: !u.active }, title: u.active ? 'Firewall ausschalten' : 'Firewall einschalten', lead: 'ufw', text: u.active ? 'Ohne Firewall ist jeder Port erreichbar, den ein Dienst öffnet. Das sollte nur kurz und mit gutem Grund passieren.' : 'Die Regeln werden aktiv. Stelle sicher, dass SSH (22) und deine Websites (80/443) erlaubt sind.', danger: u.active, okLabel: u.active ? 'Ausschalten' : 'Einschalten', success: u.active ? 'Firewall ausgeschaltet' : 'Firewall eingeschaltet', after: () => setTimeout(load, 600) }) }, u.active ? 'Ausschalten' : 'Einschalten'), h('button', { type: 'button', class: 'btn sm', onClick: showIpt }, 'iptables anzeigen')] }, rules.el),
        card({ title: 'Hinweise', span: 12 }, h('p', { class: 'muted' }, `Protokollierung: ${u.logging || '–'}. iptables: ${fw.iptables.rules} Regeln, Richtlinien ${fw.iptables.policies.join(' · ') || '–'}. Docker trägt seine Port-Freigaben selbst in iptables ein und umgeht dabei ufw: Container-Ports, die mit „-p“ veröffentlicht sind, sind trotz ufw erreichbar, außer sie sind an 127.0.0.1 gebunden.`)));
    }
    async function showIpt() { try { const r = await readOp('fw.iptables'); modal({ title: 'iptables-Regeln', lead: 'iptables -S', wide: true, body: h('pre', { class: 'out tall' }, r.text), buttons: [{ label: 'Schließen' }] }); } catch (e) { toast(e.message, 'crit'); } }

    // ------------------------------------------------------------ fail2ban
    const f2bBox = h('div', { class: 'grid' });
    panes.f2b.append(f2bBox);
    function renderF2b() {
      const f = fw.f2b;
      if (!f.available) { f2bBox.replaceChildren(h('div', { class: 's-12' }, banner('warn', 'fail2ban ist nicht erreichbar', f.error || 'Der Dienst läuft nicht.'))); return; }
      f2bBox.replaceChildren(
        h('div', { class: 's-12 row' }, h('button', { type: 'button', class: 'btn primary', onClick: () => banDialog() }, icon('ban', 15), 'Adresse sperren')),
        ...f.jails.map((j) => card({ title: j.name, sub: j.file ? `Beobachtet: ${j.file}` : '', span: 6, actions: badge(`${j.currentBanned} gesperrt`, j.currentBanned ? 'warn' : 'ok') },
          tiles([{ label: 'Fehlversuche aktuell', value: num(j.currentFailed) }, { label: 'Fehlversuche gesamt', value: num(j.totalFailed) }, { label: 'Gesperrt gesamt', value: num(j.totalBanned) }]),
          h('div', { style: { height: '12px' } }),
          j.banned.length ? h('div', { class: 'pill-list' }, ...j.banned.map((ip) => h('span', { class: 'pill mono' }, ip, h('button', { type: 'button', title: 'Entsperren', 'aria-label': `${ip} entsperren`, onClick: () => actionDialog({ op: 'f2b.unban', args: { jail: j.name, ip }, title: 'Adresse entsperren', lead: ip, text: `Die Adresse wird im Jail „${j.name}“ freigegeben.`, okLabel: 'Entsperren', success: 'Entsperrt', after: () => setTimeout(load, 500) }) }, icon('x', 13))))) : h('p', { class: 'muted' }, 'Momentan ist keine Adresse gesperrt.'))),
      );
    }
    function banDialog(ip0 = '') {
      const jails = (fw.f2b.jails || []).map((j) => [j.name, j.name]);
      return actionDialog({ op: 'f2b.ban', args: (v) => ({ jail: v.jail, ip: v.ip.trim() }), title: 'Adresse sperren', lead: 'fail2ban', fields: [{ name: 'jail', label: 'Jail', type: 'select', value: (jails.find((x) => x[0] === 'sshd') || jails[0] || [''])[0], options: jails }, { name: 'ip', label: 'IP-Adresse', type: 'text', value: ip0, placeholder: '203.0.113.7' }], okLabel: 'Sperren', danger: true, success: 'Adresse gesperrt', after: () => setTimeout(load, 500) });
    }

    // ------------------------------------------------------------ SSH attacks
    const sshBox = h('div');
    panes.ssh.append(sshBox);
    async function loadSsh() {
      sshBox.replaceChildren(h('p', { class: 'muted loading' }, 'Lade …'));
      try { sshD = await readOp('auth.ssh', { hours }); renderSsh(); } catch (e) { sshBox.replaceChildren(h('p', { class: 'err' }, e.message)); }
    }
    function renderSsh() {
      const d = sshD;
      const hourly = new Map(d.hourly.map((x) => [x.t, x.count]));
      const end = Math.floor(Date.now() / 3_600_000) * 3_600_000; const nb = Math.min(d.hours, 72);
      const data = Array.from({ length: nb }, (_, i) => { const tt = end - (nb - 1 - i) * 3_600_000; const dt = new Date(tt); return { label: nb <= 48 ? `${String(dt.getHours()).padStart(2, '0')}:00` : `${dt.getDate()}.${dt.getMonth() + 1}.`, value: hourly.get(tt) || 0, tip: `${tShort(tt)}: ${hourly.get(tt) || 0} Fehlversuche` }; });
      const ipTable = dataTable({
        columns: [{ key: 'ip', label: 'Adresse', cls: 'tbl-title mono' }, { key: 'count', label: 'Fehlversuche', align: 'r', fmt: (v) => num(v) }, { key: 'users', label: 'Probierte Benutzer', cls: 'wrap dim', fmt: (v) => v.join(', ') }, { key: 'last', label: 'Zuletzt', align: 'r', fmt: (v) => rel(v) },
          { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('button', { type: 'button', class: 'btn sm', onClick: () => banDialog(r.ip) }, icon('ban', 13), 'Sperren') }],
        dense: true, sort: { key: 'count', dir: 'desc' }, pageSize: 20, empty: 'Keine Fehlversuche im Zeitraum.', search: true, searchPlaceholder: 'Adresse suchen …',
      });
      ipTable.setRows(d.ips);
      const ul = h('div'); const bl = new BarList(ul, { fmt: (v) => num(v) });
      bl.update(d.users.slice(0, 10).map((u, i) => ({ id: u.user, label: u.user || '(leer)', value: u.count, color: 'c8' })));
      sshBox.replaceChildren(h('div', { class: 'grid' },
        card({ title: 'Fehlgeschlagene SSH-Anmeldungen', sub: 'Pro Stunde. Aus dem Journal des SSH-Dienstes.', span: 12, actions: segmented([[24, '24 Std'], [168, '7 Tage'], [720, '30 Tage']], hours, (v) => { hours = v; loadSsh(); }).el },
          tiles([{ label: 'Fehlversuche', value: num(d.failed), tone: d.failed > 200 ? 'warn' : '' }, { label: 'Verschiedene Adressen', value: num(d.ips.length) }, { label: 'Erfolgreiche Anmeldungen', value: num(d.accepted.length), tone: 'ok' }]), h('div', { style: { height: '14px' } }), columns(data, { height: 120, color: 'c8', fmt: (v) => num(v) }).el),
        card({ title: 'Häufigste Adressen', span: 8 }, ipTable.el), card({ title: 'Meistprobierte Benutzer', span: 4 }, d.users.length ? ul : h('p', { class: 'muted' }, 'Keine.'))));
    }

    // ------------------------------------------------------------ ports
    const portTable = dataTable({
      columns: [
        { key: 'port', label: 'Port', align: 'r', fmt: (v) => String(v) }, { key: 'proto', label: 'Protokoll', fmt: (v) => v.toUpperCase() }, { key: 'local', label: 'Adresse', cls: 'mono' },
        { key: 'scope', label: 'Erreichbarkeit', sort: (r) => (isLocal(r.local) ? 1 : 0), fmt: (v, r) => (isLocal(r.local) ? badge('nur lokal', 'ok') : DB_PORTS.has(r.port) ? badge('öffentlich · Datenbank!', 'crit') : badge('öffentlich', 'warn')) },
        { key: 'procs', label: 'Programm', cls: 'wrap', sort: (r) => (r.procs[0] ? r.procs[0].name : ''), fmt: (v) => (v.length ? v.map((p) => `${p.name} (${p.pid})`).join(', ') : '–') },
      ],
      search: true, searchPlaceholder: 'Port oder Programm suchen …', dense: true, sort: { key: 'port', dir: 'asc' }, pageSize: 100,
      filters: [{ label: 'Öffentlich', fn: (r) => !isLocal(r.local) }, { label: 'Alle', fn: () => true }, { label: 'Nur lokal', fn: (r) => isLocal(r.local) }],
    });
    panes.ports.append(card({ title: 'Lauschende Ports', sub: '„Öffentlich“ heißt: das Programm nimmt Verbindungen von außen an. Ob sie die Firewall passieren, siehst du unter „Firewall“.', span: 12 }, portTable.el));

    root.append(h('div', { class: 'grid' }, mk('c', 'Sicherheits-Check', 'c1', 'shieldok'), mk('f', 'Firewall', 'c2', 'shield'), mk('b', 'fail2ban', 'c4', 'ban'), mk('p', 'Öffentliche Ports', 'c9', 'network'), h('div', { class: 's-12' }, t.el, panes.check, panes.fw, panes.f2b, panes.ssh, panes.ports)));
    for (const k of ['check', 'fw', 'f2b']) panes[k].append(h('p', { class: 'muted loading' }, 'Lade …'));

    function render() {
      if (fw) {
        const u = fw.ufw;
        K.f.set({ value: u.active ? 'Aktiv' : 'Aus', sub: u.active ? `${u.rules.length} Regeln · ${u.defaults.split(',')[0] || ''}` : 'keine Filterung durch ufw', level: u.active ? 'ok' : 'crit', color: 'c2' });
        const banned = fw.f2b.available ? fw.f2b.jails.reduce((a, j) => a + j.currentBanned, 0) : 0;
        K.b.set({ value: fw.f2b.available ? String(banned) : '–', unit: fw.f2b.available ? 'gesperrt' : '', sub: fw.f2b.available ? `${fw.f2b.jails.length} Jails · ${fw.f2b.jails.reduce((a, j) => a + j.totalBanned, 0)} Sperren insgesamt` : 'nicht aktiv', level: fw.f2b.available ? 'ok' : 'warn', color: 'c4' });
        for (const p of [panes.fw, panes.f2b]) for (const l of [...p.querySelectorAll(':scope > .loading')]) l.remove();
        renderFw(); renderF2b();
      }
      if (socks) { const pub = socks.filter((x) => !isLocal(x.local)); K.p.set({ value: String(new Set(pub.map((x) => `${x.proto}${x.port}`)).size), sub: `${socks.length} lauschende Sockets insgesamt`, color: 'c9' }); portTable.setRows(socks.map((x) => ({ ...x }))); }
      for (const l of [...panes.check.querySelectorAll(':scope > .loading')]) l.remove();
      renderChecks();
    }
    async function load() {
      if (busy) return; busy = true;
      const res = await Promise.allSettled([readOp('fw.overview'), readOp('sec.audit'), readOp('net.sockets'), readOp('pkg.status'), readOp('certs.list')]);
      if (res[0].status === 'fulfilled') fw = res[0].value;
      if (res[1].status === 'fulfilled') audit = res[1].value;
      if (res[2].status === 'fulfilled') socks = res[2].value.list;
      if (res[3].status === 'fulfilled') pk = res[3].value;
      if (res[4].status === 'fulfilled') certs = res[4].value;
      const bad = res.find((r) => r.status === 'rejected');
      if (bad && !fw) toast(bad.reason.message, 'crit');
      render();
      busy = false;
    }
    ctx.every(() => { if (!document.hidden) load(); }, 60_000);
    load();
    void emptyState; void tFull; void B; void trigger; void menu;
  },
};
