import { h, icon, clear } from '../dom.js';
import { grid, heading, card, segmented, toggle, dataTable, badge, toast, kv } from '../widgets.js';
import { RANGES, api, store } from '../store.js';
import { num, tShort, ago, tFull } from '../fmt.js';
import { getTheme, setTheme, THEMES } from '../themectl.js';
import { modal, withUnlock, fieldEl } from '../interact.js';
import { qrSvg } from '../qr.js';

const ALERTS = [
  ['cpu', 'CPU-Last hoch', 'Warnt, wenn die CPU länger als die angegebene Zeit über dem Wert liegt.', [['pct', 'Prozent', 1, 100, 1], ['seconds', 'Sekunden', 5, 3600, 5]]],
  ['load', 'Load Average hoch', 'Faktor mal Anzahl der Kerne, gemessen über 1 Minute.', [['factor', '× Kerne', 0.1, 20, 0.1]]],
  ['memAvail', 'Wenig Arbeitsspeicher verfügbar', 'Warnt, wenn weniger als dieser Anteil des RAM verfügbar ist.', [['pct', 'Prozent', 1, 90, 1]]],
  ['swapUse', 'Swap stark belegt', '', [['pct', 'Prozent', 1, 100, 1]]],
  ['psiMem', 'Speicherdruck (PSI)', 'Anteil der Zeit, in dem alle Prozesse auf Speicher warten.', [['pct', 'Prozent', 0.1, 100, 0.1]]],
  ['disk', 'Festplatte fast voll', 'Gilt für jedes dauerhafte Dateisystem.', [['pct', 'Prozent', 1, 100, 1]]],
  ['inode', 'Inodes fast voll', '', [['pct', 'Prozent', 1, 100, 1]]],
  ['certDays', 'Zertifikat läuft bald ab', '', [['days', 'Tage', 1, 365, 1]]],
  ['siteSlow', 'Website antwortet langsam', 'Aus standardmäßig. Meldet, wenn die erste Antwort länger dauert.', [['ms', 'Millisekunden', 50, 60000, 50]]],
  ['netErrors', 'Netzwerkfehler / verworfene Pakete', '', [['perSec', 'pro Sekunde', 0.1, 100000, 0.1]]],
  ['retrans', 'Viele TCP-Neuübertragungen', '', [['pct', 'Prozent', 0.1, 100, 0.1]]],
  ['services', 'Dienste: Statuswechsel melden', 'Start, Stopp, Ausfall und automatische Neustarts von systemd-Diensten.', []],
  ['docker', 'Container: Änderungen melden', 'Neue, verschwundene, neu gestartete oder ungesunde Container.', []],
  ['ports', 'Neue oder geschlossene Ports melden', '', []],
  ['sites', 'Website offline / online melden', '', []],
  ['reboot', 'Neustart erforderlich melden', '', []],
];

const uaLabel = (ua) => {
  const b = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return `${b}${o ? ` auf ${o}` : ''}`;
};

const numInput = (value, min, max, step, onInput) => {
  const i = h('input', { type: 'number', class: 'input num', min, max, step, value, 'aria-label': 'Wert' });
  i.addEventListener('input', () => onInput(+i.value));
  return i;
};

export default {
  id: 'settings', title: 'Einstellungen', group: 'Dashboard', icon: 'settings', range: false, desc: 'Anzeige, Schwellwerte, Passwort und Sitzungen', keywords: 'passwort grenzwerte konto',
  mount(root, ctx) {
    const { store } = ctx;
    const S = JSON.parse(JSON.stringify(store.settings));
    let discovered = store.discovered || [];

    const save = (label, patchFn) => h('button', { type: 'button', class: 'btn primary', onClick: async (e) => {
      const b = e.currentTarget; b.disabled = true;
      try { const r = await store.saveSettings(patchFn()); discovered = r.discovered || discovered; toast(`${label} gespeichert`); } catch (err) { toast(err.message, 'crit'); }
      b.disabled = false;
    } }, 'Speichern');
    const row = (label, desc, control) => h('div', { class: 'set-row' }, h('div', null, h('div', { class: 'lbl' }, label), desc ? h('small', null, desc) : null), control);

    // ---- display (stored in this browser)
    const rangeSeg = segmented(Object.entries(RANGES).map(([k, r]) => [k, r.label]), store.range, (v) => store.setRange(v));
    const themeSeg = segmented(THEMES, getTheme(), (v) => setTheme(v));
    const display = card({ title: 'Darstellung', sub: 'Gilt nur für diesen Browser und wird sofort übernommen.', span: 4 },
      row('Farbschema', 'Hell, Dunkel oder passend zum Gerät. Auch oben rechts per Sonne/Mond-Knopf umschaltbar.', themeSeg.el),
      row('Zeitraum der Diagramme', 'Auch oben rechts umschaltbar.', rangeSeg.el));

    // ---- websites
    const siteAuto = toggle({ checked: S.sites.auto, label: 'Aus der nginx-Konfiguration erkennen', onChange: (v) => { S.sites.auto = v; } });
    const siteInterval = numInput(S.sites.interval, 10, 3600, 5, (v) => { S.sites.interval = v; });
    const hostTable = dataTable({
      columns: [
        { key: 'host', label: 'Adresse', cls: 'tbl-title' }, { key: 'file', label: 'Gefunden in', cls: 'dim' },
        { key: 'enabled', label: 'Überwachen', sort: (r) => (S.sites.disabled.includes(r.host) ? 0 : 1), fmt: (v, r) => toggle({ checked: !S.sites.disabled.includes(r.host), onChange: (on) => { const set = new Set(S.sites.disabled); if (on) set.delete(r.host); else set.add(r.host); S.sites.disabled = [...set]; } }).el },
        { key: 'name', label: 'Eigener Anzeigename', sortable: false, fmt: (v, r) => { const i = h('input', { class: 'input', placeholder: 'optional', value: S.sites.names[r.host] || '', maxlength: 60, 'aria-label': `Anzeigename für ${r.host}` }); i.addEventListener('input', () => { if (i.value.trim()) S.sites.names[r.host] = i.value.trim(); else delete S.sites.names[r.host]; }); return i; } },
      ], search: true, searchPlaceholder: 'Adresse suchen …', sort: { key: 'host', dir: 'asc' }, dense: true, pageSize: 60, empty: 'Es wurden keine Adressen erkannt.',
    });
    const customBox = h('div', { class: 'pill-list' });
    const cUrl = h('input', { class: 'input', placeholder: 'https://beispiel.de/pfad', 'aria-label': 'Adresse', type: 'url' });
    const cName = h('input', { class: 'input', placeholder: 'Anzeigename (optional)', 'aria-label': 'Anzeigename', maxlength: 60 });
    const renderCustom = () => {
      customBox.replaceChildren(...(S.sites.custom.length ? S.sites.custom.map((c, i) => h('span', { class: 'pill' }, c.name ? `${c.name} · ${c.url}` : c.url, h('button', { type: 'button', title: 'Entfernen', 'aria-label': 'Entfernen', onClick: () => { S.sites.custom.splice(i, 1); renderCustom(); } }, icon('x', 13)))) : [h('span', { class: 'muted' }, 'Keine manuell hinzugefügten Adressen.')]));
    };
    const websites = card({ title: 'Websites', sub: 'Welche Adressen der Server regelmäßig abruft.', span: 12 },
      row('Adressen automatisch erkennen', 'Liest alle server_name-Einträge der nginx-Konfiguration.', siteAuto.el),
      row('Prüfintervall (Sekunden)', 'Mindestens 10.', siteInterval),
      h('div', { class: 'field', style: { margin: '12px 0 6px' } }, h('span', { class: 'lbl' }, 'Erkannte Adressen')), hostTable.el,
      h('div', { class: 'field', style: { margin: '16px 0 6px' } }, h('span', { class: 'lbl' }, 'Eigene Adressen hinzufügen'), customBox),
      h('div', { class: 'row' }, cUrl, cName, h('button', { type: 'button', class: 'btn', onClick: () => { const u = cUrl.value.trim(); if (!u) return; try { const url = new URL(u); if (!/^https?:$/.test(url.protocol)) throw new Error('x'); } catch { toast('Bitte eine gültige http(s)-Adresse eingeben.', 'crit'); return; } S.sites.custom.push({ url: u, name: cName.value.trim() }); cUrl.value = ''; cName.value = ''; renderCustom(); } }, icon('plus', 14), 'Hinzufügen')),
      h('div', { class: 'actions' }, save('Websites', () => ({ sites: { auto: S.sites.auto, interval: S.sites.interval, disabled: S.sites.disabled, custom: S.sites.custom, names: S.sites.names } }))));

    // ---- services
    const showInactive = toggle({ checked: S.services.showInactive, label: 'Inaktive Dienste in der Tabelle anzeigen', onChange: (v) => { S.services.showInactive = v; } });
    const hiddenBox = h('div', { class: 'pill-list' });
    const renderHidden = () => hiddenBox.replaceChildren(...(S.services.hidden.length ? S.services.hidden.map((id, i) => h('span', { class: 'pill' }, id, h('button', { type: 'button', 'aria-label': `${id} wieder anzeigen`, title: 'Wieder anzeigen', onClick: () => { S.services.hidden.splice(i, 1); renderHidden(); } }, icon('x', 13)))) : [h('span', { class: 'muted' }, 'Keine Dienste ausgeblendet. In der Tabelle unter „Dienste“ kannst du Einträge ausblenden.')]));
    const services = card({ title: 'Dienste', sub: 'Darstellung der systemd-Dienste.', span: 4 },
      row('Standardansicht', 'Wenn aus, zeigt die Tabelle zuerst nur aktive Dienste.', showInactive.el),
      h('div', { class: 'field', style: { margin: '12px 0 6px' } }, h('span', { class: 'lbl' }, 'Ausgeblendete Dienste'), hiddenBox),
      h('div', { class: 'actions' }, save('Dienste', () => ({ services: { showInactive: S.services.showInactive, hidden: S.services.hidden } }))));

    // ---- internet
    const tg = S.internet.targets.slice();
    while (tg.length < 3) tg.push({ name: '', host: '', port: 443 });
    const tgRows = tg.map((t) => {
      const n = h('input', { class: 'input', value: t.name, placeholder: 'Name', maxlength: 30, 'aria-label': 'Name' });
      const hs = h('input', { class: 'input', value: t.host, placeholder: 'IP oder Hostname', 'aria-label': 'Host' });
      const p = h('input', { class: 'input num', type: 'number', min: 1, max: 65535, value: t.port, 'aria-label': 'Port' });
      return { n, hs, p, el: h('div', { class: 'row' }, n, hs, p) };
    });
    const dnsName = h('input', { class: 'input', value: S.internet.dnsName, 'aria-label': 'DNS-Name' });
    const internet = card({ title: 'Internet-Latenz', sub: 'Bis zu drei Ziele für die TCP-Messung und ein Name für die DNS-Messung.', span: 12 },
      ...tgRows.map((r) => r.el), h('div', { class: 'field', style: { margin: '12px 0 4px' } }, h('span', { class: 'lbl' }, 'DNS-Name für die Auflösungszeit'), dnsName),
      h('div', { class: 'actions' }, save('Internet-Ziele', () => ({ internet: { targets: tgRows.filter((r) => r.hs.value.trim()).map((r) => ({ name: r.n.value.trim() || r.hs.value.trim(), host: r.hs.value.trim(), port: +r.p.value || 443 })), dnsName: dnsName.value.trim() } }))));

    // ---- alerts
    const alertRows = ALERTS.map(([key, label, desc, fields]) => {
      const a = S.alerts[key];
      const sw = toggle({ checked: a.on, onChange: (v) => { a.on = v; } });
      const inputs = fields.map(([fk, fl, min, max, step]) => h('label', { class: 'row', style: { gap: '6px' } }, numInput(a[fk], min, max, step, (v) => { a[fk] = v; }), h('span', { class: 'muted' }, fl)));
      return row(label, desc, h('div', { class: 'row' }, ...inputs, sw.el));
    });
    const alerts = card({ title: 'Warnungen und Ereignisse', sub: 'Wann der Server etwas als auffällig meldet. Jede Meldung landet unter „Ereignisse“.', span: 8 }, ...alertRows,
      h('div', { class: 'actions' }, save('Warnungen', () => ({ alerts: S.alerts }))));

    // ---- processes
    const topN = numInput(S.processes.top, 5, 50, 1, (v) => { S.processes.top = v; });
    const procs = card({ title: 'Prozesse', span: 4 }, row('Einträge in den Top-Listen', '5 bis 50. Die vollständige Liste zeigt immer alle.', topN),
      h('div', { class: 'actions' }, save('Prozesse', () => ({ processes: { top: S.processes.top } }))));

    // ---- account
    const cur = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Aktuelles Passwort' });
    const nw = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Neues Passwort' });
    const nw2 = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', 'aria-label': 'Neues Passwort wiederholen' });
    const pwErr = h('div', { class: 'err', role: 'alert' });
    const changePw = async () => {
      pwErr.textContent = '';
      if (nw.value !== nw2.value) { pwErr.textContent = 'Die neuen Passwörter stimmen nicht überein.'; return; }
      try { await api.post('/auth/password', { current: cur.value, next: nw.value }); cur.value = nw.value = nw2.value = ''; toast('Passwort geändert, andere Sitzungen wurden beendet'); loadSessions(); } catch (e) { pwErr.textContent = e.message; }
    };
    const sessTable = dataTable({
      columns: [
        { key: 'ua', label: 'Gerät', fmt: (v, r) => h('span', null, uaLabel(v || ''), ' ', r.current ? badge('dieses Gerät', 'info') : null) },
        { key: 'ip', label: 'IP-Adresse' }, { key: 'created', label: 'Angemeldet', fmt: (v) => tShort(v) }, { key: 'last', label: 'Zuletzt aktiv', fmt: (v) => ago(v) },
      ], sort: { key: 'last', dir: 'desc' }, dense: true,
    });
    const meta = h('div');
    const account = card({ title: 'Konto', sub: 'Dein Zugang zu diesem Dashboard.', span: 12 },
      h('div', { class: 'grid' },
        h('div', { class: 's-4' }, h('div', { class: 'form' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Passwort ändern'), h('small', null, 'Mindestens 12 Zeichen, nicht zu einfach. Andere Geräte werden danach abgemeldet.')),
          h('div', { class: 'field' }, h('label', null, 'Aktuelles Passwort'), cur), h('div', { class: 'field' }, h('label', null, 'Neues Passwort'), nw), h('div', { class: 'field' }, h('label', null, 'Neues Passwort wiederholen'), nw2), pwErr,
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn primary', onClick: changePw }, 'Passwort ändern')))),
        h('div', { class: 's-8' }, h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Angemeldete Geräte')), meta, sessTable.el,
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: async () => { try { await api.post('/api/sessions/revoke-others'); toast('Andere Geräte abgemeldet'); loadSessions(); } catch (e) { toast(e.message, 'crit'); } } }, 'Alle anderen Geräte abmelden'),
            h('button', { type: 'button', class: 'btn danger', onClick: async () => { try { await api.post('/auth/logout'); } catch {} location.replace('/login'); } }, icon('logout', 15), 'Abmelden')))));

    async function loadSessions() {
      try { const r = await api.get('/api/session'); sessTable.setRows(r.sessions); meta.replaceChildren(kv([['E-Mail', r.email], ['Passwort geändert', r.changedAt ? tFull(r.changedAt) : '–'], ['Sitzungsdauer', '12 Std Inaktivität oder 7 Tage insgesamt']])); } catch {}
    }


    // ---- two-factor login
    const tfBox = h('div');
    async function loadTotp() {
      let st = { enabled: false, recoveryLeft: 0 };
      try { st = await api.get('/api/totp'); } catch {}
      store.totp = st.enabled;
      tfBox.replaceChildren(
        h('div', { class: `banner ${st.enabled ? 'ok' : 'warn'}` }, icon(st.enabled ? 'shieldok' : 'shield', 20), h('div', { class: 'grow' }, h('b', null, st.enabled ? 'Zwei-Faktor-Anmeldung ist eingeschaltet' : 'Zwei-Faktor-Anmeldung ist aus'), h('small', null, st.enabled ? `Zum Anmelden und zum Freischalten von Änderungen brauchst du Passwort und Code. ${st.recoveryLeft} Wiederherstellungscodes sind noch übrig.` : 'Dieses Dashboard kann den ganzen Server verändern. Ein zweiter Faktor schützt auch dann, wenn dein Passwort einmal in falsche Hände gerät. Empfohlen.'))),
        h('div', { class: 'actions' }, st.enabled ? h('button', { type: 'button', class: 'btn danger', onClick: disableTotp }, 'Ausschalten') : h('button', { type: 'button', class: 'btn primary', onClick: enableTotp }, 'Einrichten')));
    }
    async function enableTotp() {
      let b;
      try { b = await withUnlock(() => api.post('/api/totp/begin')); } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); return; }
      const code = h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, placeholder: '123456', 'aria-label': 'Code aus der App', style: { fontFamily: 'var(--mono)', fontSize: '20px', letterSpacing: '.2em', maxWidth: '200px', height: '44px', textAlign: 'center' } });
      const err = h('div', { class: 'err', role: 'alert' });
      const spaced = b.secret.match(/.{1,4}/g).join(' ');
      modal({ title: 'Zwei-Faktor-Anmeldung einrichten', lead: 'Mit einer Authenticator-App', wide: true,
        body: h('div', { class: 'grid', style: { gap: '20px' } },
          h('div', { class: 's-5', style: { textAlign: 'center' } }, h('div', { class: 'qr-box' }, qrSvg(b.uri, 220)), h('small', { class: 'muted', style: { display: 'block', marginTop: '8px' } }, 'Mit der App scannen')),
          h('div', { class: 's-7 form' },
            h('ol', { class: 'steps' }, h('li', null, 'Installiere eine Authenticator-App (z. B. Google Authenticator, Aegis, 2FAS, Microsoft Authenticator oder 1Password).'), h('li', null, 'Scanne den QR-Code. Geht das nicht, tippe diesen Schlüssel ein:'), h('li', { class: 'nolist' }, h('code', { class: 'secret' }, spaced)), h('li', null, 'Gib unten den Code ein, den die App jetzt anzeigt.')),
            h('div', { class: 'field' }, code), err)),
        buttons: [{ label: 'Abbrechen' }, { label: 'Bestätigen und einschalten', kind: 'primary', onClick: async () => {
          try { const r = await api.post('/api/totp/enable', { code: code.value }); store.totp = true; showRecovery(r.recovery); loadTotp(); } catch (e) { err.textContent = e.message; return false; }
        } }] });
      setTimeout(() => code.focus(), 60);
    }
    function showRecovery(codes) {
      modal({ title: 'Wiederherstellungscodes', lead: 'Jetzt sicher aufbewahren', wide: true,
        body: h('div', null, h('p', null, 'Falls du dein Handy verlierst, kommst du mit einem dieser Codes noch hinein. Jeder funktioniert nur einmal. Sie werden nur jetzt angezeigt.'), h('div', { class: 'recovery' }, ...codes.map((c) => h('code', null, c))),
          h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn', onClick: () => navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Codes kopiert')).catch(() => toast('Kopieren nicht möglich', 'crit')) }, icon('copy', 14), 'Alle kopieren'))),
        buttons: [{ label: 'Ich habe sie gespeichert', kind: 'primary' }] });
    }
    async function disableTotp() {
      const f = fieldEl({ name: 'code', label: 'Aktueller Code (oder ein Wiederherstellungscode)', value: '' });
      const err = h('div', { class: 'err', role: 'alert' });
      modal({ title: 'Zwei-Faktor-Anmeldung ausschalten', body: h('div', { class: 'form' }, h('p', null, 'Danach genügt wieder das Passwort. Das senkt die Sicherheit deutlich.'), f.el, err), buttons: [{ label: 'Abbrechen' }, { label: 'Ausschalten', kind: 'danger solid', onClick: async () => {
        try { await withUnlock(() => api.post('/api/totp/disable', { code: f.get() })); store.totp = false; toast('Zwei-Faktor-Anmeldung ausgeschaltet'); loadTotp(); } catch (e) { if (e.cancelled) return false; err.textContent = e.message; return false; }
      } }] });
    }
    const twofa = card({ title: 'Zwei-Faktor-Anmeldung', sub: 'Zusätzlich zum Passwort ein Code aus einer App auf deinem Handy.', span: 12 }, tfBox);
    loadTotp();

    root.append(grid(display, services, procs, internet, alerts, card({ title: 'Hinweis', span: 4 }, h('p', { class: 'muted' }, 'Änderungen an Warnungen, Websites, Diensten und Internet-Zielen gelten für alle Browser und bleiben nach einem Neustart erhalten. Jeder Abschnitt hat einen eigenen Speichern-Knopf.')), websites, twofa, account));
    renderCustom(); renderHidden();
    const setHosts = () => hostTable.setRows(discovered.map((d) => ({ host: d.host, file: d.file, enabled: d.enabled })));
    setHosts();
    api.get('/api/settings').then((r) => { discovered = r.discovered; setHosts(); }).catch(() => {});
    loadSessions();
  },
};
