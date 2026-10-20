'use strict';
// nginx site wizard (reverse proxy, static site, redirect) and Let's Encrypt certificates.
// A site is written, linked, tested with `nginx -t` and rolled back when the test fails.

const fs = require('fs');
const path = require('path');
const { run, fail, int, HOST_RE, isIp } = require('./core');
const jobs = require('./jobs');

const AVAIL = '/etc/nginx/sites-available';
const ENABLED = '/etc/nginx/sites-enabled';
const BACKUPS = '/var/backups/server-dash';
const SITE_RE = /^[a-z0-9][a-z0-9._-]{0,80}$/;
const DOMAIN_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const CERT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;
const PROTECTED = /console\.benjaminberger\.at|server-dash/;

function domains(list) {
  if (!Array.isArray(list) || !list.length || list.length > 10) throw fail('Bitte 1 bis 10 Domains angeben.');
  return list.map((d) => {
    const x = typeof d === 'string' ? d.trim().toLowerCase() : '';
    if (!DOMAIN_RE.test(x)) throw fail(`Ungültige Domain: ${String(d).slice(0, 60)}`);
    return x;
  });
}

/** "3000" -> http://127.0.0.1:3000; a full http(s) URL is rebuilt from its checked parts */
function upstream(v) {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '';
  if (/^\d{1,5}$/.test(s)) { int(+s, 1, 65535, 'Der Port'); return `http://127.0.0.1:${s}`; }
  let u;
  try { u = new URL(s); } catch { throw fail('Das Ziel muss ein Port (z. B. 3000) oder eine Adresse wie http://127.0.0.1:3000 sein.'); }
  if (!/^https?:$/.test(u.protocol)) throw fail('Das Ziel muss mit http:// oder https:// beginnen.');
  if (u.username || u.password || u.search || u.hash) throw fail('Zugangsdaten, Suchparameter und Anker sind im Ziel nicht erlaubt.');
  if (!(isIp(u.hostname.replace(/^\[|\]$/g, '')) || HOST_RE.test(u.hostname))) throw fail('Ungültiger Rechnername im Ziel.');
  if (!/^[A-Za-z0-9/._~-]*$/.test(u.pathname)) throw fail('Der Pfad im Ziel enthält ungültige Zeichen.');
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
}

function redirectTarget(v) {
  let u;
  try { u = new URL(typeof v === 'string' ? v.trim() : ''); } catch { throw fail('Bitte eine Adresse wie https://beispiel.de angeben.'); }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || !HOST_RE.test(u.hostname) || !/^\/?$/.test(u.pathname)) throw fail('Das Weiterleitungsziel muss eine Adresse ohne Pfad sein, z. B. https://beispiel.de.');
  return `${u.protocol}//${u.host}`;
}

function buildConf(o) {
  const names = o.domains.join(' ');
  const lines = [];
  const body = [];
  if (o.maxBody) body.push(`    client_max_body_size ${o.maxBody}m;`);
  if (o.kind === 'proxy') {
    body.push('    location / {', `        proxy_pass ${o.upstream};`, '        proxy_http_version 1.1;', '        proxy_set_header Host $host;', '        proxy_set_header X-Real-IP $remote_addr;', '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;', '        proxy_set_header X-Forwarded-Proto $scheme;');
    if (o.websocket) body.push('        proxy_set_header Upgrade $http_upgrade;', '        proxy_set_header Connection "upgrade";', '        proxy_read_timeout 3600s;');
    body.push('    }');
  } else if (o.kind === 'static') {
    body.push(`    root ${o.root};`, '    index index.html index.htm;', '    location / {', `        try_files $uri $uri/ ${o.spa ? '/index.html' : '=404'};`, '    }');
    body.push('    location ~* \\.(?:css|js|woff2?|png|jpe?g|gif|svg|ico|webp)$ {', '        expires 30d;', '        add_header Cache-Control "public";', '    }');
  } else {
    body.push(`    return ${o.code} ${o.redirectTo}$request_uri;`);
  }
  if (o.headers && o.kind !== 'redirect') body.push('    add_header X-Content-Type-Options "nosniff" always;', '    add_header Referrer-Policy "strict-origin-when-cross-origin" always;');
  if (o.cert) {
    const live = `/etc/letsencrypt/live/${o.cert}`;
    lines.push('server {', '    listen 80;', '    listen [::]:80;', `    server_name ${names};`, '    return 301 https://$host$request_uri;', '}', '',
      'server {', '    listen 443 ssl http2;', '    listen [::]:443 ssl http2;', `    server_name ${names};`, `    ssl_certificate ${live}/fullchain.pem;`, `    ssl_certificate_key ${live}/privkey.pem;`);
    if (fs.existsSync('/etc/letsencrypt/options-ssl-nginx.conf')) lines.push('    include /etc/letsencrypt/options-ssl-nginx.conf;');
    if (fs.existsSync('/etc/letsencrypt/ssl-dhparams.pem')) lines.push('    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;');
    if (o.headers) lines.push('    add_header Strict-Transport-Security "max-age=31536000" always;');
  } else {
    lines.push('server {', '    listen 80;', '    listen [::]:80;', `    server_name ${names};`);
  }
  lines.push(...body, '}', '');
  return `# Angelegt vom Dashboard (${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC)\n${lines.join('\n')}`;
}

async function testOrFail(undo) {
  const t = await run('nginx', ['-t'], { timeout: 20_000 });
  if (t.code !== 0) { undo(); throw fail(`Die nginx-Konfiguration wäre fehlerhaft, nichts wurde übernommen:\n${(t.err + t.out).trim().slice(0, 700)}`); }
  return (t.err + t.out).trim();
}

const ops = {
  async 'nginx.site-create'(a) {
    const name = typeof a.name === 'string' ? a.name.trim().toLowerCase() : '';
    if (!SITE_RE.test(name)) throw fail('Der Dateiname darf nur Kleinbuchstaben, Ziffern, Punkt, Minus und Unterstrich enthalten.');
    if (PROTECTED.test(name)) throw fail('Dieser Name ist für das Dashboard reserviert.');
    if (!['proxy', 'static', 'redirect'].includes(a.kind)) throw fail('Unbekannte Website-Art.');
    const o = { kind: a.kind, domains: domains(a.domains), websocket: !!a.websocket, headers: a.headers !== false, spa: !!a.spa, maxBody: a.maxBody ? int(a.maxBody, 1, 10240, 'Die Uploadgrenze') : 0 };
    if (a.kind === 'proxy') o.upstream = upstream(a.upstream);
    if (a.kind === 'static') {
      if (typeof a.root !== 'string' || !/^\/[A-Za-z0-9._/-]{1,200}$/.test(a.root) || a.root.includes('..')) throw fail('Der Ordner muss ein absoluter Pfad ohne Sonderzeichen sein.');
      try { if (!fs.statSync(a.root).isDirectory()) throw new Error(); } catch { throw fail('Dieser Ordner existiert nicht. Lege ihn zuerst im Dateimanager an.'); }
      o.root = a.root.replace(/\/$/, '');
    }
    if (a.kind === 'redirect') { o.redirectTo = redirectTarget(a.redirectTo); o.code = a.code === 302 ? 302 : 301; }
    if (a.cert) {
      if (typeof a.cert !== 'string' || !CERT_RE.test(a.cert) || !fs.existsSync(`/etc/letsencrypt/live/${a.cert}/fullchain.pem`)) throw fail('Dieses Zertifikat gibt es nicht. Stelle es zuerst aus (nginx & Zertifikate).');
      o.cert = a.cert;
    }
    const file = path.join(AVAIL, name); const link = path.join(ENABLED, name);
    if (fs.existsSync(file)) throw fail('Eine Website mit diesem Dateinamen gibt es schon.');
    // other sites already answering to the same name would make this one unreachable
    const clash = [];
    for (const f of fs.existsSync(ENABLED) ? fs.readdirSync(ENABLED) : []) {
      let text = '';
      try { text = fs.readFileSync(path.join(ENABLED, f), 'utf8'); } catch { continue; }
      for (const m of text.matchAll(/^\s*server_name\s+([^;]+);/gm)) for (const n of m[1].trim().split(/\s+/)) if (o.domains.includes(n.toLowerCase()) && (o.cert ? /listen[^;]*443/.test(text) : /listen[^;]*\b80\b/.test(text))) clash.push(`${n} (${f})`);
    }
    if (clash.length && a.enable !== false) throw fail(`Diese Domain wird schon von einer anderen Website bedient: ${[...new Set(clash)].join(', ')}`);
    fs.mkdirSync(AVAIL, { recursive: true });
    fs.writeFileSync(file, buildConf(o), { mode: 0o644 });
    const undo = () => { try { fs.unlinkSync(link); } catch {} try { fs.unlinkSync(file); } catch {} };
    if (a.enable !== false) fs.symlinkSync(file, link);
    const note = await testOrFail(undo);
    if (a.enable !== false && a.reload) {
      const r = await run('systemctl', ['reload', 'nginx'], { timeout: 30_000 });
      if (r.code !== 0) throw fail(`Die Website wurde angelegt, aber nginx ließ sich nicht neu laden: ${r.err.trim().slice(0, 300)}`);
    }
    return { name, enabled: a.enable !== false, reloaded: !!(a.enable !== false && a.reload), warnings: /warn/i.test(note) ? note.split('\n').filter((l) => /warn/i.test(l)).slice(0, 4) : [] };
  },

  async 'nginx.site-delete'({ name }) {
    if (typeof name !== 'string' || !SITE_RE.test(name)) throw fail('Ungültiger Name.');
    if (PROTECTED.test(name)) throw fail('Die Website des Dashboards selbst lässt sich hier nicht löschen.');
    const file = path.join(AVAIL, name); const link = path.join(ENABLED, name);
    if (!fs.existsSync(file)) throw fail('Diese Website gibt es nicht.');
    const text = fs.readFileSync(file, 'utf8');
    if (PROTECTED.test(text) || /127\.0\.0\.1:3120/.test(text)) throw fail('Diese Datei enthält das Dashboard selbst und wird nicht gelöscht.');
    fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
    const keep = path.join(BACKUPS, `${Date.now()}__${`/etc/nginx/sites-available/${name}`.replace(/\//g, '%2F')}`);
    fs.copyFileSync(file, keep);
    let hadLink = false; let linkTarget = null;
    try { const st = fs.lstatSync(link); hadLink = true; if (st.isSymbolicLink()) linkTarget = fs.readlinkSync(link); } catch {}
    if (hadLink) fs.unlinkSync(link);
    fs.unlinkSync(file);
    await testOrFail(() => { fs.copyFileSync(keep, file); if (hadLink && linkTarget) fs.symlinkSync(linkTarget, link); });
    return { name, note: 'Die Datei wurde gelöscht (eine Kopie liegt unter „Frühere Versionen“). Noch nicht geladen: nginx neu laden, damit die Änderung wirkt.' };
  },

  /** request a new Let's Encrypt certificate through the nginx plugin */
  async 'certs.issue'({ domains: list, name, email }) {
    if (!fs.existsSync('/usr/bin/certbot')) throw fail('Certbot ist auf diesem Server nicht installiert.');
    const ds = domains(list);
    if (ds.some((d) => d.startsWith('*.'))) throw fail('Platzhalter-Zertifikate (*.domain) brauchen eine DNS-Bestätigung und gehen hier nicht.');
    const certName = name == null || name === '' ? ds[0] : name;
    if (typeof certName !== 'string' || !CERT_RE.test(certName)) throw fail('Ungültiger Zertifikatsname.');
    const args = ['certonly', '--nginx', '--non-interactive', '--agree-tos', '--cert-name', certName, '--expand'];
    for (const d of ds) args.push('-d', d);
    if (email) { if (typeof email !== 'string' || !/^[^\s@;|&'"`$<>]{1,64}@[A-Za-z0-9.-]{1,200}$/.test(email)) throw fail('Ungültige E-Mail-Adresse.'); args.push('-m', email); } else {
      let hasAccount = false;
      try { hasAccount = fs.readdirSync('/etc/letsencrypt/accounts').some((d) => fs.existsSync(path.join('/etc/letsencrypt/accounts', d))); } catch {}
      if (!hasAccount) args.push('--register-unsafely-without-email');
    }
    return jobs.start('certbot', `Zertifikat ausstellen: ${ds.join(', ')}`, 'certbot', args, { env: { LC_ALL: 'C' }, props: ['RuntimeMaxSec=600'] });
  },

  async 'certs.delete'({ name }) {
    if (typeof name !== 'string' || !CERT_RE.test(name)) throw fail('Ungültiger Zertifikatsname.');
    if (!fs.existsSync(`/etc/letsencrypt/live/${name}`)) throw fail('Dieses Zertifikat gibt es nicht.');
    // a certificate that a site still uses would take that site down on the next reload
    const users = [];
    for (const f of fs.existsSync(ENABLED) ? fs.readdirSync(ENABLED) : []) {
      try { if (fs.readFileSync(path.join(ENABLED, f), 'utf8').includes(`/live/${name}/`)) users.push(f); } catch {}
    }
    if (users.length) throw fail(`Das Zertifikat wird noch von diesen Websites benutzt: ${users.join(', ')}`);
    return jobs.start('certbot', `Zertifikat löschen: ${name}`, 'certbot', ['delete', '--non-interactive', '--cert-name', name], { env: { LC_ALL: 'C' } });
  },
};

module.exports = { ops };
