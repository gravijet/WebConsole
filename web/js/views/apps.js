// Apps: one-click Docker projects from ready-made templates, plus the projects the dashboard manages
// (/opt/stacks). A project is a compose file you can read, edit and bring up again at any time.

import { h, icon } from '../dom.js';
import { card, dataTable, badge, toast, banner, heading, kpi } from '../widgets.js';
import { tShort, ago } from '../fmt.js';
import { api } from '../store.js';
import { modal, quickAction, watchJob, readOp, actionDialog, menu, trigger, fieldEl } from '../interact.js';

const pass = (n = 20) => { const a = new Uint32Array(n); crypto.getRandomValues(a); return Array.from(a, (x) => 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[x % 56]).join(''); };
const ports = (v, inner) => `    ports:\n      - "${v.bind}:${v.port}:${inner}"\n`;

/** secrets go to the .env file next to the compose file; the compose file only refers to them */
const TEMPLATES = [
  { id: 'uptime-kuma', name: 'Uptime Kuma', cat: 'Überwachung', desc: 'Prüft Websites und Dienste und meldet Ausfälle, mit hübscher Statusseite.', port: 3001, color: 'c7',
    yaml: (v) => `services:\n  app:\n    image: louislam/uptime-kuma:1\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 3001)}    volumes:\n      - data:/app/data\nvolumes:\n  data:\n` },
  { id: 'vaultwarden', name: 'Vaultwarden', cat: 'Sicherheit', desc: 'Eigener Passwort-Tresor, kompatibel mit den Bitwarden-Apps. Braucht HTTPS davor.', port: 8081, color: 'c4',
    yaml: (v) => `services:\n  app:\n    image: vaultwarden/server:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n    environment:\n      SIGNUPS_ALLOWED: "false"\n${ports(v, 80)}    volumes:\n      - data:/data\nvolumes:\n  data:\n`, note: 'Neue Registrierungen sind abgeschaltet. Lege zuerst dein Konto an, indem du SIGNUPS_ALLOWED vorübergehend auf "true" stellst.' },
  { id: 'gitea', name: 'Gitea', cat: 'Entwicklung', desc: 'Leichter Git-Server mit Weboberfläche, Issues und Pull-Requests (SQLite).', port: 3002, color: 'c2',
    yaml: (v) => `services:\n  app:\n    image: gitea/gitea:1\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 3000)}    volumes:\n      - data:/data\nvolumes:\n  data:\n` },
  { id: 'grafana', name: 'Grafana', cat: 'Überwachung', desc: 'Dashboards und Diagramme für Messwerte aus vielen Quellen.', port: 3003, color: 'c3',
    yaml: (v) => `services:\n  app:\n    image: grafana/grafana-oss:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 3000)}    volumes:\n      - data:/var/lib/grafana\nvolumes:\n  data:\n` },
  { id: 'n8n', name: 'n8n', cat: 'Automatisierung', desc: 'Workflows bauen, die Dienste und Webhooks miteinander verbinden.', port: 5678, color: 'c9',
    yaml: (v) => `services:\n  app:\n    image: n8nio/n8n:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 5678)}    volumes:\n      - data:/home/node/.n8n\nvolumes:\n  data:\n` },
  { id: 'filebrowser', name: 'File Browser', cat: 'Dateien', desc: 'Dateien eines Ordners im Browser verwalten, mit Benutzern und Freigaben.', port: 8082, color: 'c5',
    fields: [{ name: 'folder', label: 'Ordner auf dem Server', value: '/srv/files', hint: 'Wird bei Bedarf angelegt.' }],
    yaml: (v) => `services:\n  app:\n    image: filebrowser/filebrowser:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 80)}    volumes:\n      - ${v.folder}:/srv\n      - config:/config\n    command: --database /config/filebrowser.db\nvolumes:\n  config:\n`, note: 'Erste Anmeldung: Benutzer „admin“, Passwort „admin“. Bitte sofort ändern.' },
  { id: 'it-tools', name: 'IT-Tools', cat: 'Entwicklung', desc: 'Hunderte kleine Werkzeuge für Entwickler und Admins, alles im Browser.', port: 8083, color: 'c1',
    yaml: (v) => `services:\n  app:\n    image: corentinth/it-tools:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 80)}` },
  { id: 'excalidraw', name: 'Excalidraw', cat: 'Entwicklung', desc: 'Whiteboard für schnelle Skizzen und Diagramme.', port: 8084, color: 'c10',
    yaml: (v) => `services:\n  app:\n    image: excalidraw/excalidraw:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 80)}` },
  { id: 'whoami', name: 'whoami (Test)', cat: 'Entwicklung', desc: 'Winziger Testdienst, der zeigt, wie Anfragen ankommen. Gut zum Ausprobieren.', port: 8085, color: 'c6',
    yaml: (v) => `services:\n  app:\n    image: traefik/whoami:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 80)}` },
  { id: 'nginx-static', name: 'Statische Website', cat: 'Websites', desc: 'Ein nginx, der einen Ordner mit HTML-Dateien ausliefert.', port: 8086, color: 'c2',
    fields: [{ name: 'folder', label: 'Ordner mit der Website', value: '/srv/www', hint: 'Dort liegt deine index.html.' }],
    yaml: (v) => `services:\n  app:\n    image: nginx:alpine\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 80)}    volumes:\n      - ${v.folder}:/usr/share/nginx/html:ro\n` },
  { id: 'postgres', name: 'PostgreSQL', cat: 'Datenbanken', desc: 'Die zuverlässige Datenbank für fast alles. Nur lokal erreichbar, wenn du nichts änderst.', port: 5433, color: 'c5', fields: [{ name: 'db', label: 'Datenbankname', value: 'app' }, { name: 'user', label: 'Benutzer', value: 'app' }],
    env: () => ({ POSTGRES_PASSWORD: pass() }),
    yaml: (v) => `services:\n  db:\n    image: postgres:16\n    container_name: ${v.name}\n    restart: unless-stopped\n    environment:\n      POSTGRES_DB: ${v.db}\n      POSTGRES_USER: ${v.user}\n      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}\n${ports(v, 5432)}    volumes:\n      - data:/var/lib/postgresql/data\nvolumes:\n  data:\n`, note: 'Das Passwort steht in der .env-Datei des Projekts (Bearbeiten → .env).' },
  { id: 'mariadb', name: 'MariaDB', cat: 'Datenbanken', desc: 'MySQL-kompatible Datenbank. Läuft getrennt von der MariaDB des Servers.', port: 3307, color: 'c9', fields: [{ name: 'db', label: 'Datenbankname', value: 'app' }, { name: 'user', label: 'Benutzer', value: 'app' }],
    env: () => ({ MARIADB_ROOT_PASSWORD: pass(), MARIADB_PASSWORD: pass() }),
    yaml: (v) => `services:\n  db:\n    image: mariadb:11\n    container_name: ${v.name}\n    restart: unless-stopped\n    environment:\n      MARIADB_DATABASE: ${v.db}\n      MARIADB_USER: ${v.user}\n      MARIADB_PASSWORD: \${MARIADB_PASSWORD}\n      MARIADB_ROOT_PASSWORD: \${MARIADB_ROOT_PASSWORD}\n${ports(v, 3306)}    volumes:\n      - data:/var/lib/mysql\nvolumes:\n  data:\n`, note: 'Die Passwörter stehen in der .env-Datei des Projekts.' },
  { id: 'redis', name: 'Redis', cat: 'Datenbanken', desc: 'Schneller Zwischenspeicher und Schlüssel-Wert-Speicher mit Passwort.', port: 6380, color: 'c8',
    env: () => ({ REDIS_PASSWORD: pass() }),
    yaml: (v) => `services:\n  db:\n    image: redis:7-alpine\n    container_name: ${v.name}\n    restart: unless-stopped\n    command: ["redis-server", "--requirepass", "\${REDIS_PASSWORD}", "--appendonly", "yes"]\n${ports(v, 6379)}    volumes:\n      - data:/data\nvolumes:\n  data:\n` },
  { id: 'mongo', name: 'MongoDB', cat: 'Datenbanken', desc: 'Dokumenten-Datenbank mit Administrator-Passwort.', port: 27018, color: 'c7',
    env: () => ({ MONGO_INITDB_ROOT_PASSWORD: pass() }),
    yaml: (v) => `services:\n  db:\n    image: mongo:7\n    container_name: ${v.name}\n    restart: unless-stopped\n    environment:\n      MONGO_INITDB_ROOT_USERNAME: admin\n      MONGO_INITDB_ROOT_PASSWORD: \${MONGO_INITDB_ROOT_PASSWORD}\n${ports(v, 27017)}    volumes:\n      - data:/data/db\nvolumes:\n  data:\n` },
  { id: 'adminer', name: 'Adminer', cat: 'Datenbanken', desc: 'Datenbanken im Browser verwalten (MySQL, PostgreSQL, SQLite …).', port: 8087, color: 'c4',
    yaml: (v) => `services:\n  app:\n    image: adminer:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 8080)}` },
  { id: 'minio', name: 'MinIO', cat: 'Dateien', desc: 'S3-kompatibler Objektspeicher für Backups und Medien.', port: 9010, color: 'c3',
    env: () => ({ MINIO_ROOT_PASSWORD: pass() }),
    yaml: (v) => `services:\n  app:\n    image: minio/minio:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n    command: server /data --console-address ":9001"\n    environment:\n      MINIO_ROOT_USER: admin\n      MINIO_ROOT_PASSWORD: \${MINIO_ROOT_PASSWORD}\n    ports:\n      - "${v.bind}:${v.port}:9001"\n    volumes:\n      - data:/data\nvolumes:\n  data:\n`, note: 'Der Port zeigt auf die Weboberfläche (9001). Benutzer „admin“, Passwort in der .env-Datei.' },
  { id: 'syncthing', name: 'Syncthing', cat: 'Dateien', desc: 'Dateien zwischen Geräten abgleichen, ohne Cloud.', port: 8384, color: 'c2',
    fields: [{ name: 'folder', label: 'Ordner zum Abgleichen', value: '/srv/sync' }],
    yaml: (v) => `services:\n  app:\n    image: syncthing/syncthing:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n    hostname: ${v.name}\n${ports(v, 8384)}    volumes:\n      - ${v.folder}:/var/syncthing\n` },
  { id: 'ntfy', name: 'ntfy', cat: 'Überwachung', desc: 'Eigener Push-Server: Meldungen aufs Handy, ohne Fremddienst.', port: 8088, color: 'c9',
    yaml: (v) => `services:\n  app:\n    image: binwiederhall/ntfy:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n    command: serve\n${ports(v, 80)}    volumes:\n      - cache:/var/cache/ntfy\nvolumes:\n  cache:\n`, note: 'Danach unter „Alarme & Automatik“ einen ntfy-Kanal mit dieser Adresse anlegen.' },
  { id: 'dozzle', name: 'Dozzle', cat: 'Überwachung', desc: 'Live-Protokolle aller Container im Browser.', port: 8089, color: 'c1',
    yaml: (v) => `services:\n  app:\n    image: amir20/dozzle:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 8080)}    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock:ro\n`, note: 'Bekommt lesenden Zugriff auf den Docker-Socket. Nur lokal betreiben.' },
  { id: 'watchtower', name: 'Watchtower', cat: 'Automatisierung', desc: 'Aktualisiert laufende Container automatisch, wenn es neue Images gibt.', port: 0, color: 'c8',
    yaml: (v) => `services:\n  app:\n    image: containrrr/watchtower:latest\n    container_name: ${v.name}\n    restart: unless-stopped\n    environment:\n      WATCHTOWER_SCHEDULE: "0 0 4 * * *"\n      WATCHTOWER_CLEANUP: "true"\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`, note: 'Prüft täglich um 4 Uhr alle Container. Greift auf den Docker-Socket zu und startet Container neu.' },
  { id: 'empty', name: 'Eigenes Projekt', cat: 'Eigene', desc: 'Leere Compose-Datei zum Selbstschreiben oder Einfügen.', port: 8090, color: 'c6',
    yaml: (v) => `services:\n  app:\n    image: nginx:alpine\n    container_name: ${v.name}\n    restart: unless-stopped\n${ports(v, 80)}` },
];

const initials = (s) => s.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();

export default {
  id: 'apps', title: 'Apps', group: 'Verwalten', icon: 'box', range: false, desc: 'Docker-Projekte aus Vorlagen starten und als Compose-Dateien verwalten', keywords: 'docker compose vorlage app installieren stack portainer uptime kuma vaultwarden gitea grafana postgres redis',
  mount(root, ctx) {
    const { store } = ctx;
    let stacks = []; let dir = '/opt/stacks';
    const K = { n: kpi({ label: 'Projekte', color: 'c1', span: 3, icon: 'box' }), r: kpi({ label: 'Laufen', color: 'c7', span: 3, icon: 'check' }), t: kpi({ label: 'Vorlagen', color: 'c4', span: 3, icon: 'zap' }), d: kpi({ label: 'Ordner', color: 'c6', span: 3, icon: 'files' }) };

    const table = dataTable({
      columns: [
        { key: 'name', label: 'Projekt', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, h('small', { class: 'sub mono' }, r.file)) },
        { key: 'status', label: 'Status', sort: (r) => (r.running ? 0 : 1), fmt: (v, r) => badge(r.running ? v : (v || 'nicht gestartet'), r.running ? 'ok' : 'neutral') },
        { key: 'mtime', label: 'Geändert', fmt: (v) => h('span', null, tShort(v), h('small', { class: 'sub' }, ago(v))) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: () => editStack(r.name) }, icon('edit', 13), 'Bearbeiten'), trigger((a) => stackMenu(a, r))) },
      ],
      sort: { key: 'name', dir: 'asc' }, dense: true, empty: 'Noch keine Projekte. Wähle unten eine Vorlage.',
    });

    function stackMenu(anchor, r) {
      const compose = (action, label, text) => actionDialog({ op: 'docker.compose', args: { project: r.name, action }, title: `${label}: ${r.name}`, lead: `docker compose ${action}`, text, okLabel: label, success: 'Gestartet', after: load, word: ['down', 'stop'].includes(action) ? r.name : undefined });
      menu(anchor, [
        { label: 'Starten', icon: 'play', onClick: () => compose('start', 'Starten') },
        { label: 'Neu starten', icon: 'refresh', onClick: () => compose('restart', 'Neu starten') },
        { label: 'Stoppen', icon: 'stop', onClick: () => compose('stop', 'Stoppen', 'Die Container bleiben bestehen und lassen sich wieder starten.') },
        { label: 'Neue Images laden', icon: 'download', onClick: () => compose('pull', 'Images laden', 'Lädt neuere Versionen der Images. Danach „Neu erstellen“, damit sie benutzt werden.') },
        { label: 'Neu erstellen', icon: 'zap', onClick: () => compose('up', 'Neu erstellen', 'Erstellt die Container mit der aktuellen Compose-Datei neu. Volumes bleiben erhalten.') },
        'hr',
        { label: 'Projekt entfernen …', icon: 'trash', danger: true, onClick: () => removeStack(r) },
      ]);
    }
    function removeStack(r) {
      actionDialog({ op: 'docker.stack-delete', args: (v) => ({ name: r.name, volumes: !!v.volumes }), title: `Projekt entfernen: ${r.name}`, lead: 'Container stoppen und Projektordner löschen', danger: true, word: r.name, okLabel: 'Entfernen',
        text: 'Die Container des Projekts werden gestoppt und gelöscht, danach wird der Ordner mit der Compose-Datei entfernt.',
        fields: [{ name: 'volumes', label: 'Auch die Daten (Volumes) löschen', type: 'checkbox', value: false, hint: 'Nicht rückgängig zu machen.' }], success: 'Wird entfernt', after: load });
    }

    // ---- editor for an existing project
    async function editStack(name) {
      let d;
      try { d = await readOp('docker.stack-get', { name }); } catch (e) { if (e.message !== 'Abgebrochen') toast(e.message, 'crit'); return; }
      openEditor({ name, yaml: d.yaml, env: d.env, existing: true });
    }

    function openEditor({ name, yaml, env, existing, note }) {
      const y = h('textarea', { class: 'input mono-area', rows: 18, spellcheck: 'false', 'aria-label': 'Compose-Datei' }); y.value = yaml;
      const e = h('textarea', { class: 'input mono-area', rows: 5, spellcheck: 'false', 'aria-label': '.env-Datei', placeholder: 'SCHLÜSSEL=Wert' }); e.value = env || '';
      const err = h('div', { class: 'err', role: 'alert' });
      const save = async (up) => {
        err.textContent = '';
        try {
          const r = await quickAction('docker.stack-save', { name, yaml: y.value, env: e.value, up }, { success: up ? 'Wird gestartet' : 'Gespeichert' });
          if (r.job) watchJob(r.job, r.title, load); else load();
          return true;
        } catch (x) { if (!x.cancelled) err.textContent = x.message; return false; }
      };
      modal({ title: existing ? `Projekt bearbeiten: ${name}` : `Projekt anlegen: ${name}`, lead: existing ? `${dir}/${name}` : 'Prüfe die Datei. Du kannst alles ändern, bevor es startet.', xwide: true,
        body: h('div', { class: 'form' }, note ? banner('info', 'Hinweis', note) : null, h('div', { class: 'field' }, h('label', null, 'compose.yaml'), y), h('div', { class: 'field' }, h('label', null, '.env (Passwörter und Einstellungen)'), h('small', null, 'Wird mit Rechten nur für root gespeichert. Die Compose-Datei verweist mit ${NAME} darauf.'), e), err),
        buttons: [{ label: 'Abbrechen' }, { label: 'Nur speichern', onClick: async () => (await save(false)) }, { label: existing ? 'Speichern und neu starten' : 'Speichern und starten', kind: 'primary', onClick: async () => (await save(true)) }] });
    }

    // ---- template dialog
    function freePort(def) {
      const used = new Set(((store.detail && store.detail.net && store.detail.net.listen) || []).map((l) => l.port));
      let p = def; while (used.has(p) && p < 65000) p += 1; return p;
    }
    function useTemplate(t) {
      const taken = new Set(stacks.map((s) => s.name));
      let base = t.id === 'empty' ? 'projekt' : t.id; let name = base; let i = 2;
      while (taken.has(name)) name = `${base}-${i++}`;
      const f = [fieldEl({ name: 'name', label: 'Projektname', value: name, hint: 'Kleinbuchstaben, Ziffern, - und _. Wird auch der Container-Name.' })];
      if (t.port) f.push(fieldEl({ name: 'port', label: 'Port auf dem Server', type: 'number', value: freePort(t.port), min: 1, max: 65535, hint: 'Der Wert ist ein freier Port, den noch nichts benutzt.' }));
      const pub = fieldEl({ name: 'public', label: 'Von außen erreichbar machen', type: 'checkbox', value: false, hint: 'Standard: nur auf diesem Server (127.0.0.1). Docker umgeht die Firewall, offene Ports sind sofort im Internet. Besser: danach eine Website mit nginx davorschalten.' });
      if (t.port) f.push(pub);
      for (const x of t.fields || []) f.push(fieldEl(x));
      const err = h('div', { class: 'err', role: 'alert' });
      modal({ title: t.name, lead: t.desc, body: h('div', { class: 'form' }, ...f.map((x) => x.el), err),
        buttons: [{ label: 'Abbrechen' }, { label: 'Weiter: Vorschau', kind: 'primary', close: false, onClick: (m) => {
          const v = Object.fromEntries(f.map((x) => [x.name, x.get()]));
          v.name = String(v.name || '').trim().toLowerCase();
          if (!/^[a-z0-9][a-z0-9_-]{0,40}$/.test(v.name)) { err.textContent = 'Projektname: Kleinbuchstaben, Ziffern, - und _ (bis 41 Zeichen).'; return false; }
          if (taken.has(v.name)) { err.textContent = 'Ein Projekt mit diesem Namen gibt es schon.'; return false; }
          v.bind = v.public ? '0.0.0.0' : '127.0.0.1';
          if (t.port && !(v.port >= 1 && v.port <= 65535)) { err.textContent = 'Bitte einen Port zwischen 1 und 65535 angeben.'; return false; }
          const env = t.env ? t.env(v) : {};
          m.close();
          openEditor({ name: v.name, yaml: t.yaml(v), env: Object.entries(env).map(([k, val]) => `${k}=${val}`).join('\n'), note: t.note });
          return false;
        } }] });
    }

    // ---- gallery
    const cats = [...new Set(TEMPLATES.map((t) => t.cat))];
    let cat = 'Alle';
    const catBar = h('div', { class: 'seg wrap-seg' });
    const gallery = h('div', { class: 'tpl-grid' });
    function paintGallery() {
      for (const b of catBar.children) b.setAttribute('aria-pressed', String(b.dataset.c === cat));
      gallery.replaceChildren(...TEMPLATES.filter((t) => cat === 'Alle' || t.cat === cat).map((t) => h('button', { type: 'button', class: 'tpl', onClick: () => useTemplate(t) },
        h('span', { class: 'tpl-i', style: { background: `var(--${t.color})` } }, initials(t.name)),
        h('span', { class: 'tpl-t' }, h('b', null, t.name), h('small', null, t.cat)),
        h('span', { class: 'tpl-d' }, t.desc))));
    }
    for (const c of ['Alle', ...cats]) catBar.append(h('button', { type: 'button', dataset: { c }, 'aria-pressed': String(c === cat), onClick: () => { cat = c; paintGallery(); } }, c));

    const cardTop = card({ title: 'Deine Projekte', sub: 'Jedes Projekt ist ein Ordner mit einer Compose-Datei. Du kannst sie jederzeit ansehen und ändern.', span: 12, actions: h('button', { type: 'button', class: 'btn sm', onClick: () => load() }, icon('refresh', 13), 'Aktualisieren') }, table.el);
    root.append(h('div', { class: 'grid' }, K.n.el, K.r.el, K.t.el, K.d.el, cardTop, heading('Vorlagen', 'Ein Klick, ein paar Angaben, fertig. Du siehst die komplette Datei, bevor etwas startet.'), h('div', { class: 's-12' }, catBar, gallery)));
    paintGallery();

    async function load() {
      try {
        const r = await readOp('docker.stack-list');
        stacks = r.stacks; dir = r.dir;
        table.setRows(stacks);
        K.n.set({ value: String(stacks.length), sub: 'von diesem Dashboard angelegt' });
        K.r.set({ value: String(stacks.filter((s) => s.running).length), sub: `${stacks.filter((s) => !s.running).length} gestoppt`, level: '' });
        K.t.set({ value: String(TEMPLATES.length - 1), sub: 'zum Ausprobieren' });
        K.d.set({ value: dir.split('/').filter(Boolean).pop() || '/', sub: dir, unit: '' });
      } catch (e) { toast(e.message, 'crit'); }
    }
    load();
    ctx.every(() => { if (!document.hidden) load(); }, 20_000);
    void api;
  },
};
