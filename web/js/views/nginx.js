// nginx: site configurations (enable/disable/edit/test/reload) and Let's Encrypt certificates (renew).

import { h, icon } from '../dom.js';
import { kpi, card, dataTable, badge, tabs, toast, banner, meter } from '../widgets.js';
import { tShort, rel } from '../fmt.js';
import { readOp, actionDialog, nginxReload, modal, quickAction, fieldEl, watchJob } from '../interact.js';

export default {
  id: 'nginx', title: 'nginx & Zertifikate', group: 'Verwalten', icon: 'web', range: false, desc: 'Website-Konfigurationen, Test, Neuladen und Let’s-Encrypt-Zertifikate', keywords: 'nginx vhost site konfiguration ssl letsencrypt certbot zertifikat erneuern',
  mount(root, ctx) {
    const { store } = ctx;
    let sites = null; let certs = null; let busy = false;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 3, icon: ic }); return K[id].el; };
    const panes = { sites: h('div'), certs: h('div') };
    const t = tabs([{ id: 'sites', label: 'Konfigurationen' }, { id: 'certs', label: 'Zertifikate' }], 'sites', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; });
    panes.certs.hidden = true;
    const goFile = (path) => { try { localStorage.setItem('sd.files.cwd', path.replace(/\/[^/]+$/, '')); } catch {} location.hash = '#/files'; };

    const stable = dataTable({
      columns: [
        { key: 'name', label: 'Konfiguration', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, h('small', { class: 'sub mono' }, r.file)) },
        { key: 'serverNames', label: 'Domains', cls: 'wrap', sort: (r) => r.serverNames[0] || '', fmt: (v) => (v.length ? h('span', { class: 'pill-list' }, ...v.slice(0, 4).map((n) => h('span', { class: 'tag' }, n)), v.length > 4 ? h('span', { class: 'muted' }, `+${v.length - 4}`) : null) : '–') },
        { key: 'targets', label: 'Ziel', cls: 'wrap mono dim', fmt: (v) => v.join(', ') || '–' },
        { key: 'ssl', label: 'HTTPS', fmt: (v) => (v ? badge('ja', 'ok') : badge('nein', 'warn')) },
        { key: 'enabled', label: 'Aktiv', sort: (r) => (r.enabled ? 0 : 1), fmt: (v, r) => h('label', { class: 'switch' }, (() => { const i = h('input', { type: 'checkbox', class: 'sw-in' }); i.checked = v; i.addEventListener('change', () => toggleSite(r, i)); return i; })(), h('i')) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: () => goFile(r.file) }, icon('edit', 13), 'Bearbeiten'), h('button', { type: 'button', class: 'btn sm danger', title: 'Website löschen', 'aria-label': 'Website löschen', onClick: () => actionDialog({ op: 'nginx.site-delete', args: { name: r.name }, title: 'Website löschen', lead: r.name, text: 'Die Konfiguration wird gelöscht (eine Kopie bleibt unter „Frühere Versionen“ im Dateimanager). nginx muss danach neu geladen werden.', word: r.name, danger: true, okLabel: 'Löschen', success: 'Website gelöscht', after: load }) }, icon('trash', 13))) },
      ],
      search: true, searchPlaceholder: 'Konfiguration oder Domain suchen …', sort: { key: 'name', dir: 'asc' }, dense: true, pageSize: 60,
    });
    async function toggleSite(r, input) {
      const want = input.checked;
      try { const res = await quickAction('nginx.site-toggle', { name: r.name, enable: want }, { success: `${r.name} ${want ? 'aktiviert' : 'deaktiviert'}. Zum Anwenden nginx neu laden.` }); void res; setTimeout(load, 300); } catch (e) { input.checked = !want; if (!e.cancelled) toast(e.message, 'crit'); }
    }
    const testBtn = h('button', { type: 'button', class: 'btn sm', onClick: async () => { try { const r = await readOp('nginx.test'); modal({ title: 'nginx-Konfigurationstest', lead: r.ok ? 'Die Konfiguration ist in Ordnung' : 'Die Konfiguration hat Fehler', body: h('pre', { class: 'out' }, r.text), buttons: [{ label: 'Schließen' }] }); } catch (e) { toast(e.message, 'crit'); } } }, icon('check', 13), 'Konfiguration testen');
    const reloadBtn = h('button', { type: 'button', class: 'btn sm primary', onClick: () => nginxReload() }, icon('refresh', 13), 'nginx neu laden');
    const newBtn = h('button', { type: 'button', class: 'btn sm primary', onClick: () => siteWizard() }, icon('plus', 13), 'Neue Website');
    panes.sites.append(card({ span: 12 }, stable.el, h('div', { class: 'actions' }, newBtn, testBtn, reloadBtn)));

    // ---- wizard: reverse proxy, static site or redirect
    function siteWizard() {
      let kind = 'proxy';
      const domains = fieldEl({ name: 'domains', label: 'Domains', type: 'textarea', rows: 2, mono: true, placeholder: 'app.beispiel.at', hint: 'Eine oder mehrere, durch Zeilenumbruch oder Leerzeichen getrennt. Die DNS-Einträge müssen auf diesen Server zeigen.' });
      const name = fieldEl({ name: 'name', label: 'Dateiname der Konfiguration', mono: true, hint: 'Wird automatisch aus der ersten Domain gebildet.' });
      let nameTouched = false;
      name.input.addEventListener('input', () => { nameTouched = true; });
      domains.input.addEventListener('input', () => { if (!nameTouched) name.input.value = (domains.input.value.trim().split(/[\s,]+/)[0] || '').toLowerCase(); });
      const upstream = fieldEl({ name: 'upstream', label: 'Ziel', mono: true, placeholder: '3000  oder  http://127.0.0.1:3000', hint: 'Port einer lokalen Anwendung oder die volle Adresse.' });
      const ws = fieldEl({ name: 'websocket', label: 'WebSockets erlauben', type: 'checkbox', value: false, hint: 'Nötig für Live-Anwendungen wie Chats, Dashboards und Home Assistant.' });
      const maxBody = fieldEl({ name: 'maxBody', label: 'Größter Upload (MB)', type: 'number', value: 50, min: 1, max: 10240 });
      const root_ = fieldEl({ name: 'root', label: 'Ordner mit der Website', mono: true, placeholder: '/var/www/meine-seite', hint: 'Dort liegt die index.html. Der Ordner muss existieren.' });
      const spa = fieldEl({ name: 'spa', label: 'Single-Page-App (unbekannte Adressen zeigen index.html)', type: 'checkbox', value: false });
      const redirect = fieldEl({ name: 'redirectTo', label: 'Weiterleiten nach', mono: true, placeholder: 'https://neue-adresse.at', hint: 'Der Pfad der Anfrage bleibt erhalten.' });
      const code = fieldEl({ name: 'code', label: 'Art der Weiterleitung', type: 'select', value: 301, options: [[301, 'Dauerhaft (301)'], [302, 'Vorübergehend (302)']] });
      const certSel = h('select', { class: 'input', 'aria-label': 'HTTPS-Zertifikat' }, h('option', { value: '' }, 'Ohne HTTPS (nur Port 80)'), ...((certs && certs.certs) || []).map((c) => h('option', { value: c.name }, `${c.name}  (${(c.domains || []).slice(0, 3).join(', ')})`)));
      const certField = h('div', { class: 'field' }, h('label', null, 'HTTPS'), h('small', null, 'Wähle ein vorhandenes Zertifikat. Fehlt eines, stelle es zuerst im Reiter „Zertifikate“ aus. Port 80 leitet dann automatisch auf HTTPS um.'), certSel);
      const enable = fieldEl({ name: 'enable', label: 'Sofort aktivieren und nginx neu laden', type: 'checkbox', value: true });
      const err = h('div', { class: 'err', role: 'alert' });
      const kinds = [['proxy', 'Anwendung (Reverse-Proxy)'], ['static', 'Statische Website'], ['redirect', 'Weiterleitung']];
      const groups = { proxy: [upstream.el, ws.el, maxBody.el], static: [root_.el, spa.el], redirect: [redirect.el, code.el] };
      const dyn = h('div', { class: 'form' });
      const seg = h('div', { class: 'seg' });
      const paint = () => { for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.k === kind)); dyn.replaceChildren(...groups[kind]); };
      for (const [k, l] of kinds) seg.append(h('button', { type: 'button', dataset: { k }, onClick: () => { kind = k; paint(); } }, l));
      paint();
      modal({ title: 'Neue Website', lead: 'nginx-Konfiguration anlegen', wide: true,
        body: h('div', { class: 'form' }, h('div', { class: 'field' }, h('label', null, 'Was soll ausgeliefert werden?'), seg), domains.el, dyn, certField, name.el, enable.el, err),
        buttons: [{ label: 'Abbrechen' }, { label: 'Anlegen', kind: 'primary', onClick: async () => {
          err.textContent = '';
          const list = domains.get().split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
          if (!list.length) { err.textContent = 'Bitte mindestens eine Domain angeben.'; return false; }
          const a = { name: (name.get().trim() || list[0]).toLowerCase(), kind, domains: list, cert: certSel.value || undefined, enable: enable.get(), reload: enable.get() };
          if (kind === 'proxy') { a.upstream = upstream.get().trim(); a.websocket = ws.get(); a.maxBody = maxBody.get() || undefined; }
          if (kind === 'static') { a.root = root_.get().trim(); a.spa = spa.get(); }
          if (kind === 'redirect') { a.redirectTo = redirect.get().trim(); a.code = +code.get(); }
          try { const r = await quickAction('nginx.site-create', a, { success: (res) => (res.reloaded ? 'Website angelegt und nginx neu geladen' : 'Website angelegt') }); if (r.warnings && r.warnings.length) toast(`Hinweis von nginx: ${r.warnings[0]}`, 'warn'); load(); } catch (e) { if (!e.cancelled) err.textContent = e.message; return false; }
        } }] });
    }

    const ctable = dataTable({
      columns: [
        { key: 'name', label: 'Zertifikat', cls: 'tbl-title' }, { key: 'domains', label: 'Domains', cls: 'wrap', sort: (r) => (r.domains || []).length, fmt: (v) => (v || []).join(', ') },
        { key: 'expires', label: 'Läuft ab', align: 'r', sort: (r) => r.expires || 0, fmt: (v, r) => (v ? h('span', null, tShort(v), h('small', { class: 'sub' }, rel(v))) : '–') },
        { key: 'days', label: 'Restlaufzeit', align: 'r', sort: (r) => r.expires || 0, fmt: (v, r) => { const d = r.expires ? Math.floor((r.expires - Date.now()) / 86400_000) : null; return d == null ? '–' : meter(Math.max(0, d), 90, { text: `${d} Tage`, tone: d <= 7 ? 'crit' : d <= 21 ? 'warn' : 'ok' }); } },
        { key: 'keyType', label: 'Schlüssel', cls: 'dim' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: () => renew(r.name) }, icon('refresh', 13), 'Erneuern'), h('button', { type: 'button', class: 'btn sm danger', title: 'Zertifikat löschen', 'aria-label': 'Zertifikat löschen', onClick: () => actionDialog({ op: 'certs.delete', args: { name: r.name }, title: 'Zertifikat löschen', lead: r.name, text: 'Das Zertifikat wird bei Let’s Encrypt widerrufen und vom Server gelöscht. Websites, die es noch benutzen, verhindern das Löschen.', word: r.name, danger: true, okLabel: 'Löschen', success: 'Wird gelöscht', after: () => setTimeout(load, 800) }) }, icon('trash', 13))) },
      ],
      sort: { key: 'expires', dir: 'asc' }, dense: true, empty: 'Keine Zertifikate gefunden.',
    });
    const renew = (name) => actionDialog({ op: 'certs.renew', args: (v) => ({ name, dry: !!v.dry }), title: name ? `Zertifikat erneuern: ${name}` : 'Alle Zertifikate erneuern', lead: 'certbot renew', text: 'Certbot erneuert nur Zertifikate, die bald ablaufen. Mit dem Testlauf wird die Erneuerung geprüft, ohne etwas zu verändern. Der Verlauf erscheint live.', fields: [{ name: 'dry', label: 'Nur Testlauf (nichts ändern)', type: 'checkbox', value: true }], okLabel: 'Starten', success: 'Gestartet', after: () => setTimeout(load, 1500) });
    const certBanner = h('div');
    const liveBox = h('div');
    const liveTable = dataTable({
      columns: [
        { key: 'hosts', label: 'Domains', cls: 'wrap tbl-title', sort: (r) => r.hosts[0] || '', fmt: (v) => h('span', { class: 'pill-list' }, ...v.slice(0, 4).map((n) => h('span', { class: 'tag' }, n)), v.length > 4 ? h('span', { class: 'muted' }, `+${v.length - 4}`) : null) },
        { key: 'issuer', label: 'Aussteller', cls: 'dim', fmt: (v) => v || '–' },
        { key: 'to', label: 'Läuft ab', align: 'r', fmt: (v) => h('span', null, tShort(v), h('small', { class: 'sub' }, rel(v))) },
        { key: 'days', label: 'Restlaufzeit', align: 'r', fmt: (v) => meter(Math.max(0, v), 90, { text: `${v} Tage`, tone: v <= 7 ? 'crit' : v <= 21 ? 'warn' : 'ok' }) },
      ],
      sort: { key: 'to', dir: 'asc' }, dense: true, empty: 'Es konnten keine Zertifikate abgefragt werden.',
    });
    const certActions = h('div', { class: 'actions' }, h('button', { type: 'button', class: 'btn sm primary', onClick: () => issue() }, icon('plus', 13), 'Neues Zertifikat'), h('button', { type: 'button', class: 'btn sm', onClick: () => renew(null) }, icon('refresh', 13), 'Alle prüfen / erneuern'));
    panes.certs.append(card({ title: 'Was deine Websites gerade ausliefern', sub: 'Live geprüft über die TLS-Verbindung, egal woher das Zertifikat stammt (Let’s Encrypt, Cloudflare, Mailcow …).', span: 12 }, liveBox, liveTable.el));
    panes.certs.append(h('div', { style: { height: '16px' } }));
    panes.certs.append(card({ title: 'Von certbot verwaltet', sub: 'Zertifikate, die certbot ausstellt und automatisch erneuert.', span: 12 }, certBanner, ctable.el, certActions));
    const issue = () => actionDialog({ op: 'certs.issue', args: (v) => ({ domains: v.domains.split(/[\s,]+/).filter(Boolean), name: v.name.trim() || undefined, email: v.email.trim() || undefined }), title: 'Neues Zertifikat ausstellen', lead: 'Let’s Encrypt über das nginx-Plugin',
      text: 'Die Domains müssen auf diesen Server zeigen (DNS) und über Port 80 erreichbar sein. Liegt die Domain hinter Cloudflare, muss der Proxy für die Prüfung erreichbar bleiben oder kurz ausgeschaltet werden. Es muss bereits eine Website für die Domain in nginx existieren.',
      fields: [{ name: 'domains', label: 'Domains', type: 'textarea', rows: 2, mono: true, placeholder: 'app.beispiel.at', hint: 'Mehrere durch Leerzeichen oder Zeilenumbruch trennen.' }, { name: 'name', label: 'Name des Zertifikats (optional)', hint: 'Standard: die erste Domain.' }, { name: 'email', label: 'E-Mail für Ablauf-Hinweise (optional)', hint: 'Nur nötig, wenn noch kein Konto bei Let’s Encrypt besteht.' }],
      okLabel: 'Ausstellen', success: 'Gestartet', wide: true, validate: (v) => (v.domains.trim() ? null : 'Bitte mindestens eine Domain angeben.'), after: () => setTimeout(load, 1500) });

    root.append(h('div', { class: 'grid' }, mk('s', 'Konfigurationen', 'c1', 'files'), mk('a', 'Aktive Websites', 'c7', 'check'), mk('c', 'Zertifikate', 'c4', 'lock'), mk('e', 'Nächster Ablauf', 'c3', 'clock'), h('div', { class: 's-12' }, t.el, panes.sites, panes.certs)));
    for (const p of Object.values(panes)) p.append(h('p', { class: 'muted loading' }, 'Lade …'));

    function render() {
      if (sites) {
        K.s.set({ value: String(sites.length), sub: `${sites.filter((s) => !s.enabled).length} deaktiviert`, color: 'c1' });
        K.a.set({ value: String(sites.filter((s) => s.enabled).length), sub: `${new Set(sites.filter((s) => s.enabled).flatMap((s) => s.serverNames)).size} Domains`, color: 'c7' });
        stable.setRows(sites);
      }
      if (certs) {
        const soon = certs.certs.slice().filter((c) => c.expires).sort((a, b) => a.expires - b.expires)[0];
        const d = soon ? Math.floor((soon.expires - Date.now()) / 86400_000) : null;
        K.c.set({ value: String(certs.certs.length), sub: 'von certbot verwaltet', color: 'c4' });
        K.e.set({ value: d == null ? '–' : String(d), unit: d == null ? '' : 'Tage', sub: soon ? soon.name : '', level: d == null ? '' : d <= 7 ? 'crit' : d <= 21 ? 'warn' : 'ok', color: 'c3' });
        const failed = certs.available !== false && certs.service && certs.service.Result && certs.service.Result !== 'success';
        if (certs.available === false) certBanner.replaceChildren(banner('info', 'Certbot ist auf diesem Server nicht installiert', 'Das ist in Ordnung, wenn die Zertifikate von woanders kommen (z. B. Cloudflare-Origin-Zertifikate oder Mailcow). Oben siehst du trotzdem, was ausgeliefert wird. Um hier Zertifikate auszustellen, installiere certbot unter „Updates & Pakete“ (Pakete certbot und python3-certbot-nginx).'), h('div', { style: { height: '12px' } }));
        else certBanner.replaceChildren(...(failed ? [banner('warn', 'Die automatische Erneuerung ist zuletzt fehlgeschlagen', 'Der Dienst certbot.service meldet einen Fehler. Prüfe mit „Alle prüfen / erneuern“ (Testlauf), welches Zertifikat betroffen ist, und lies das Protokoll unter Protokolle → certbot.'), h('div', { style: { height: '12px' } })] : []));
        ctable.setRows(certs.certs);
        certActions.hidden = certs.available === false;
      }
      const live = (store.slow && store.slow.certs) || [];
      liveTable.setRows(live);
      const first = live.slice().sort((a, b) => a.to - b.to)[0];
      if (live.length) {
        K.c.set({ value: String(live.length), sub: 'ausgelieferte Zertifikate', color: 'c4' });
        K.e.set({ value: String(first.days), unit: 'Tage', sub: (first.hosts || [])[0] || '', level: first.days <= 7 ? 'crit' : first.days <= 21 ? 'warn' : 'ok', color: 'c3' });
      }
      for (const p of Object.values(panes)) for (const l of [...p.querySelectorAll(':scope > .loading')]) l.remove();
    }
    async function load() {
      if (busy) return; busy = true;
      const res = await Promise.allSettled([readOp('nginx.sites'), readOp('certs.list')]);
      if (res[0].status === 'fulfilled') sites = res[0].value.sites; else toast(res[0].reason.message, 'crit');
      if (res[1].status === 'fulfilled') certs = res[1].value;
      render(); busy = false;
    }
    ctx.every(() => { if (!document.hidden) load(); }, 60_000);
    load();
  },
};
