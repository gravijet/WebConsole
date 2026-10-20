'use strict';
// Xeon-1 Console: authenticated live server dashboard.
// Everything shown is measured or discovered at runtime; nothing about the machine is hard-coded.

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const { makeStore } = require('./lib/history');
const { Events } = require('./lib/events');
const { Settings } = require('./lib/settings');
const authLib = require('./lib/auth');
const collectorLib = require('./lib/collector');
const actions = require('./lib/actions');
const { Notifier } = require('./lib/notify');
const { Healer } = require('./lib/heal');
const { UserData } = require('./lib/userdata');

const PORT = +process.env.PORT || 3120;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'web');
const STATE_DIR = process.env.STATE_DIRECTORY || path.join(__dirname, '.state');
const STATUS_URL = process.env.NGINX_STATUS_URL || 'http://127.0.0.1:8099/nginx_status';
const MAX_CLIENTS = 100;
const actionTimes = new Map(); // session id -> timestamps of recent actions (rate limit)
const readTimes = new Map();   // same for lookups
const UPLOADS = path.join(process.env.STATE_DIRECTORY || path.join(__dirname, '.state'), 'uploads');
const OUTBOX = path.join(process.env.STATE_DIRECTORY || path.join(__dirname, '.state'), 'outbox');
const MAX_UPLOAD = 90 * 1024 * 1024; // Cloudflare's request limit is 100 MB

const store = makeStore(STATE_DIR);
const events = new Events(store);
const settings = new Settings(store);
const auth = authLib.create({ store, events, stateDir: STATE_DIR });

if (process.argv.includes('--reset-auth')) {
  auth.reset();
  console.log(`Passwort zurückgesetzt. Neuer Einrichtungscode:\n  sudo cat ${auth.codeFile}`);
  process.exit(0);
}

const collector = collectorLib.create({ store, settings, events, dockerFile: path.join(STATE_DIR, 'docker.json'), statusUrl: STATUS_URL });
const notifier = new Notifier(store, events);
const healer = new Healer({ store, events, collector });
const userdata = new UserData(store);

// ------------------------------------------------------------------ http helpers

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon',
};

const SEC = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Robots-Tag': 'noindex, nofollow',
};

function clientIp(req) {
  const ra = req.socket.remoteAddress || '';
  const loop = ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1';
  const xf = req.headers['x-forwarded-for'];
  return (loop && xf ? String(xf).split(',')[0].trim() : ra).slice(0, 64) || 'unknown';
}

function send(req, res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && buf.length > 1024;
  const out = gz ? zlib.gzipSync(buf, { level: 5 }) : buf;
  res.writeHead(status, { ...SEC, 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}), 'Content-Length': out.length, ...headers });
  res.end(req.method === 'HEAD' ? undefined : out);
}
const json = (req, res, obj, status = 200, headers = {}) => send(req, res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

function readBody(req, max = 16384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const timer = setTimeout(() => { reject(new Error('timeout')); req.destroy(); }, 8000);
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { clearTimeout(timer); reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { clearTimeout(timer); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}

/** state-changing requests: custom header (forces a CORS preflight), JSON only, same-origin */
function csrfOk(req) {
  if (req.headers['x-sd'] !== '1') return false;
  if (!/^application\/json/i.test(req.headers['content-type'] || '')) return false;
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host !== req.headers.host) return false; } catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return false;
  return true;
}

function serveStatic(req, res, pathname) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return json(req, res, { error: 'bad path' }, 400); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep) || /(^|\/)\./.test(path.relative(PUBLIC, file))) return json(req, res, { error: 'not found' }, 404);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(req, res, { error: 'not found' }, 404);
    const ext = path.extname(file);
    if (!TYPES[ext]) return json(req, res, { error: 'not found' }, 404);
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { ...SEC, 'Content-Type': TYPES[ext], 'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'private, no-cache', ETag: etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && ['.html', '.css', '.js', '.svg'].includes(ext);
    if (gz) headers['Content-Encoding'] = 'gzip'; else headers['Content-Length'] = st.size;
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy());
    (gz ? stream.pipe(zlib.createGzip({ level: 6 })) : stream).pipe(res);
  });
}

// ------------------------------------------------------------------ live stream (SSE)

const clients = new Set(); // { res, sid }
function broadcast(event, data) {
  if (!clients.size) return;
  const msg = (event === 'message' ? '' : `event: ${event}\n`) + `data: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.res.write(msg);
}
collector.on('sample', (s) => broadcast('message', s));
collector.on('detail', (d) => broadcast('detail', d));
collector.on('slow', (s) => broadcast('slow', s));
events.on((e) => broadcast('evt', e));
auth.onRevoke((ids) => {
  const set = new Set(ids.map((i) => i));
  for (const c of [...clients]) if (set.has(c.sid)) { c.res.end(); clients.delete(c); }
  collector.setClients(clients.size);
});

// ------------------------------------------------------------------ routing

/** server actions: lookups need a session, secrets need a fresh password confirmation, changes too (plus a log entry) */
const limited = (map, sid, max) => {
  const now = Date.now();
  const recent = (map.get(sid) || []).filter((t) => now - t < 60_000);
  if (recent.length >= max) { map.set(sid, recent); return true; }
  recent.push(now);
  map.set(sid, recent);
  return false;
};

async function handleAction(req, res, sess, body, ip) {
  const op = typeof body.op === 'string' ? body.op : '';
  const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {};
  const isRead = actions.READ_OPS.has(op);
  const isSecret = actions.SENSITIVE_OPS.has(op);
  if (isRead || isSecret) {
    if (limited(readTimes, sess.id, 400)) return json(req, res, { error: 'Zu viele Abfragen in kurzer Zeit.' }, 429);
    if (isSecret && !auth.elevatedUntil(sess.id)) return json(req, res, { error: 'Bitte bestätige zuerst dein Passwort.', code: 'elevation' }, 403);
    try { return json(req, res, { ok: true, result: await actions.call(op, args, 190_000) }); } catch (e) { return json(req, res, { error: e.message }, e.user ? 422 : 502); }
  }
  if (!actions.WRITE_OPS.has(op)) return json(req, res, { error: 'Unbekannte Aktion.' }, 400);
  if (!auth.elevatedUntil(sess.id)) return json(req, res, { error: 'Bitte bestätige zuerst dein Passwort.', code: 'elevation' }, 403);
  if (limited(actionTimes, sess.id, 60)) return json(req, res, { error: 'Zu viele Aktionen in kurzer Zeit.' }, 429);
  let pl;
  try { pl = actions.plan(op, args, { ip }); } catch (e) { return json(req, res, { error: e.message }, 400); }
  if (pl.confirm && args.confirm !== pl.confirm) return json(req, res, { error: 'Die Bestätigung fehlt oder stimmt nicht.', code: 'confirm', expect: pl.confirm }, 400);
  const { confirm, ...clean } = args;
  try {
    const result = await actions.call(op, clean);
    events.add({ level: pl.level, kind: 'action', title: pl.title, detail: `manuell ausgelöst von ${ip}` });
    // something you stopped on purpose must not be brought back by the self-healing rules
    if (op === 'unit.control') { if (['stop', 'disable', 'mask'].includes(clean.action)) healer.suppress(clean.unit); else if (['start', 'restart', 'reload-or-restart'].includes(clean.action)) healer.release(clean.unit); }
    if (op === 'docker.control') { if (['stop', 'kill', 'pause'].includes(clean.action)) healer.suppress(clean.name); else healer.release(clean.name); }
    if (op === 'docker.remove') healer.suppress(clean.name);
    return json(req, res, { ok: true, result });
  } catch (e) {
    events.add({ level: 'warn', kind: 'action', title: `Fehlgeschlagen: ${pl.title}`, detail: e.message.slice(0, 300) });
    return json(req, res, { error: e.message }, e.user ? 422 : 502);
  }
}

// ---- file transfer: raw streams, so they bypass the JSON body limit. Both need a fresh password confirmation.

const safeName = (n) => typeof n === 'string' && n.length > 0 && n.length <= 200 && !/[\/\0]/.test(n) && n !== '.' && n !== '..';

async function handleUpload(req, res, sess, url, ip) {
  if (req.headers['x-sd'] !== '1') return json(req, res, { error: 'Ungültige Anfrage.' }, 403);
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== req.headers.host) return json(req, res, { error: 'Ungültige Anfrage.' }, 403); } catch { return json(req, res, { error: 'Ungültige Anfrage.' }, 403); } }
  if (!auth.elevatedUntil(sess.id)) return json(req, res, { error: 'Bitte bestätige zuerst dein Passwort.', code: 'elevation' }, 403);
  if (limited(actionTimes, sess.id, 60)) return json(req, res, { error: 'Zu viele Aktionen in kurzer Zeit.' }, 429);
  const dir = url.searchParams.get('dir'); const name = url.searchParams.get('name');
  const overwrite = url.searchParams.get('overwrite') === '1';
  if (!dir || !dir.startsWith('/') || !safeName(name)) return json(req, res, { error: 'Ungültiges Ziel.' }, 400);
  const len = +req.headers['content-length'];
  if (!Number.isFinite(len) || len < 0) return json(req, res, { error: 'Die Dateigröße fehlt.' }, 411);
  if (len > MAX_UPLOAD) return json(req, res, { error: 'Die Datei ist größer als 90 MB.' }, 413);
  const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const tmp = path.join(UPLOADS, id);
  const dest = path.posix.join(dir, name);
  let size = 0; let failed = false;
  const out = fs.createWriteStream(tmp, { mode: 0o600 });
  const abort = (status, msg) => { if (failed) return; failed = true; out.destroy(); fs.unlink(tmp, () => {}); json(req, res, { error: msg }, status); };
  req.on('data', (c) => { size += c.length; if (size > MAX_UPLOAD) { abort(413, 'Die Datei ist größer als 90 MB.'); req.destroy(); } });
  req.on('error', () => abort(400, 'Upload abgebrochen.'));
  req.on('aborted', () => abort(400, 'Upload abgebrochen.'));
  out.on('error', () => abort(500, 'Der Upload konnte nicht gespeichert werden.'));
  out.on('finish', async () => {
    if (failed) return;
    try {
      const result = await actions.call('files.install', { tmp: id, dest, overwrite });
      const t = actions.plan('files.install', { dest });
      events.add({ level: 'info', kind: 'action', title: t.title, detail: `${size} Bytes, manuell ausgelöst von ${ip}` });
      json(req, res, { ok: true, result });
    } catch (e) {
      fs.unlink(tmp, () => {});
      json(req, res, { error: e.message }, e.user ? 422 : 502);
    }
  });
  req.pipe(out);
}

async function handleDownload(req, res, sess, url, ip) {
  if (!auth.elevatedUntil(sess.id)) return json(req, res, { error: 'Bitte bestätige zuerst dein Passwort.', code: 'elevation' }, 403);
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return json(req, res, { error: 'Ungültige Anfrage.' }, 403);
  if (limited(actionTimes, sess.id, 60)) return json(req, res, { error: 'Zu viele Aktionen in kurzer Zeit.' }, 429);
  const p = url.searchParams.get('path');
  if (!p || !p.startsWith('/')) return json(req, res, { error: 'Ungültiger Pfad.' }, 400);
  let staged;
  try { staged = await actions.call('files.stage-out', { path: p }); } catch (e) { return json(req, res, { error: e.message }, e.user ? 422 : 502); }
  const file = path.join(OUTBOX, staged.id);
  const ascii = staged.name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  res.writeHead(200, { ...SEC, 'Content-Type': 'application/octet-stream', 'Content-Length': staged.size, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(staged.name)}` });
  events.add({ level: 'info', kind: 'action', title: `Datei heruntergeladen: ${p.length > 90 ? `${p.slice(0, 90)}…` : p}`, detail: `${staged.size} Bytes, manuell ausgelöst von ${ip}` });
  const stream = fs.createReadStream(file);
  const cleanup = () => fs.unlink(file, () => {});
  stream.on('error', () => { cleanup(); res.destroy(); });
  res.on('close', cleanup);
  stream.pipe(res);
}

function sweepTransfers() {
  const cutoff = Date.now() - 15 * 60_000;
  for (const dir of [UPLOADS, OUTBOX]) {
    fs.readdir(dir, (err, names) => { if (err) return; for (const n of names) { const t = +n.split('-')[0]; if (t && t < cutoff) fs.unlink(path.join(dir, n), () => {}); } });
  }
}
fs.mkdirSync(UPLOADS, { recursive: true, mode: 0o750 });
fs.mkdirSync(OUTBOX, { recursive: true, mode: 0o750 });
sweepTransfers();
setInterval(sweepTransfers, 5 * 60_000).unref();

const PUBLIC_FILES = new Set(['/login.html', '/login.css', '/login.js', '/favicon.svg', '/theme.js']);

async function handle(req, res) {
  const method = req.method;
  let url;
  try { url = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const p = url.pathname;
  const ip = clientIp(req);
  const ua = req.headers['user-agent'] || '';

  if (p === '/healthz') return json(req, res, { ok: true });

  // ---- public: login page + auth endpoints
  if (method === 'GET' && (p === '/login' || p === '/login/')) {
    if (auth.verify(req)) { res.writeHead(302, { Location: '/', ...SEC, 'Cache-Control': 'no-store' }); return res.end(); }
    return serveStatic(req, res, '/login.html');
  }
  if ((method === 'GET' || method === 'HEAD') && (PUBLIC_FILES.has(p) || p.startsWith('/fonts/'))) return serveStatic(req, res, p);

  if (p === '/auth/status' && method === 'GET') return json(req, res, { ...auth.status(), authed: !!auth.verify(req) });

  if (method === 'POST' && (p === '/auth/login' || p === '/auth/setup')) {
    if (!csrfOk(req)) return json(req, res, { error: 'Ungültige Anfrage.' }, 403);
    let body;
    try { body = await readBody(req); } catch { return json(req, res, { error: 'Ungültige Anfrage.' }, 400); }
    const r = p === '/auth/login' ? await auth.login(body, { ip, ua }) : await auth.setup(body, { ip, ua });
    if (r.status === 200) return json(req, res, { ok: true }, 200, { 'Set-Cookie': auth.cookieString(r.token) });
    return json(req, res, { error: r.error, retry: r.retry }, r.status, r.retry ? { 'Retry-After': String(r.retry) } : {});
  }

  // ---- everything below needs a valid session
  const sess = auth.verify(req);
  if (!sess) {
    if (method === 'GET' && !p.startsWith('/api/') && !/\.(js|css|svg|png|ico|json)$/.test(p)) {
      res.writeHead(302, { Location: '/login', ...SEC, 'Cache-Control': 'no-store' });
      return res.end();
    }
    return json(req, res, { error: 'Nicht angemeldet.' }, 401);
  }

  if (method === 'POST' && p === '/api/upload') return handleUpload(req, res, sess, url, ip);

  if (method === 'POST' || method === 'PUT') {
    if (!csrfOk(req)) return json(req, res, { error: 'Ungültige Anfrage.' }, 403);
    let body;
    try { body = await readBody(req, p === '/api/action' ? 3_200_000 : p === '/api/userdata' ? 1_500_000 : 65536); } catch { return json(req, res, { error: 'Ungültige Anfrage.' }, 400); }

    if (p === '/auth/logout') {
      auth.revoke(sess.id);
      return json(req, res, { ok: true }, 200, { 'Set-Cookie': auth.clearCookie() });
    }
    if (p === '/auth/elevate') {
      const r = await auth.elevate(sess.id, body.password, ip, body.code);
      return json(req, res, r.status === 200 ? { ok: true, until: r.until } : { error: r.error, code: r.code, retry: r.retry }, r.status, r.retry ? { 'Retry-After': String(r.retry) } : {});
    }
    if (p === '/api/action') return handleAction(req, res, sess, body, ip);
    if (p === '/auth/password') {
      const r = await auth.changePassword({ current: body.current, next: body.next }, { ip, id: sess.id });
      return json(req, res, r.status === 200 ? { ok: true } : { error: r.error, retry: r.retry }, r.status);
    }
    if (p === '/api/sessions/revoke-others') { auth.revokeOthers(sess.id); return json(req, res, { ok: true }); }

    // ---- owner's own data (notes, saved commands, favourites): a session is enough
    if (p === '/api/userdata' && method === 'PUT') {
      try { return json(req, res, userdata.update(body)); } catch (e) { return json(req, res, { error: e.message }, 422); }
    }

    // ---- everything below changes how the dashboard protects or reaches you: password confirmation first
    if (['/api/notify', '/api/notify/test', '/api/heal', '/api/totp/begin', '/api/totp/enable', '/api/totp/disable'].includes(p)) {
      if (!auth.elevatedUntil(sess.id)) return json(req, res, { error: 'Bitte bestätige zuerst dein Passwort.', code: 'elevation' }, 403);
      if (limited(actionTimes, sess.id, 60)) return json(req, res, { error: 'Zu viele Aktionen in kurzer Zeit.' }, 429);
      try {
        if (p === '/api/notify' && method === 'PUT') { notifier.replaceAll(body.channels); events.add({ level: 'info', kind: 'action', title: 'Benachrichtigungskanäle geändert', detail: `manuell ausgelöst von ${ip}` }); return json(req, res, notifier.view()); }
        if (p === '/api/notify/test') { const r = await notifier.test(String(body.id || '')); return json(req, res, r.ok ? { ok: true } : { error: r.error }, r.ok ? 200 : 502); }
        if (p === '/api/heal' && method === 'PUT') { healer.replace(body); events.add({ level: 'info', kind: 'action', title: 'Selbstheilungs-Regeln geändert', detail: `manuell ausgelöst von ${ip}` }); return json(req, res, healer.view()); }
        if (p === '/api/totp/begin') { const r = auth.totpBegin(); return json(req, res, r.status === 200 ? { secret: r.secret, uri: r.uri } : { error: r.error }, r.status); }
        if (p === '/api/totp/enable') { const r = auth.totpEnable(body.code); return json(req, res, r.status === 200 ? { ok: true, recovery: r.recovery } : { error: r.error }, r.status); }
        if (p === '/api/totp/disable') { const r = auth.totpDisable(body.code); return json(req, res, r.status === 200 ? { ok: true } : { error: r.error }, r.status); }
      } catch (e) { return json(req, res, { error: e.message }, 422); }
    }
    if (p === '/api/settings' && method === 'PUT') {
      const v = settings.update(body);
      return json(req, res, { settings: v, discovered: collector.sites.discovered() });
    }
    return json(req, res, { error: 'not found' }, 404);
  }

  if (method !== 'GET' && method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD, POST, PUT' }); return res.end(); }

  switch (p) {
    case '/api/bootstrap':
      return json(req, res, {
        now: Date.now(), info: collector.info, raw: collector.raw(), detail: collector.detail(), slow: collector.slowPayload(),
        events: events.recentList(200), settings: settings.get(), account: { email: auth.email, changedAt: auth.changedAt() },
      });

    case '/api/history': {
      const tier = ['t10', 't60'].includes(url.searchParams.get('tier')) ? url.searchParams.get('tier') : 'raw';
      const since = Math.max(0, +url.searchParams.get('since') || 0);
      return json(req, res, { now: Date.now(), tier, ...collector.history(tier, since) });
    }

    case '/api/processes': return json(req, res, { now: Date.now(), ...collector.processes() });
    case '/api/services': return json(req, res, { now: Date.now(), list: collector.services.list, at: collector.services.at });
    case '/api/sites': return json(req, res, { now: Date.now(), sites: collector.sites.list, discovered: collector.sites.discovered() });
    case '/api/raw': return json(req, res, collector.rawDump());

    case '/api/events': {
      const lim = Math.min(1000, Math.max(1, +url.searchParams.get('limit') || 200));
      return json(req, res, { events: events.recentList(lim) });
    }

    case '/api/settings':
      return json(req, res, { settings: settings.get(), discovered: collector.sites.discovered() });

    case '/api/session':
      return json(req, res, { email: auth.email, changedAt: auth.changedAt(), sessions: auth.sessionsList(sess.id), elevatedUntil: auth.elevatedUntil(sess.id), totp: auth.totpStatus().enabled });

    case '/api/download': return handleDownload(req, res, sess, url, ip);
    case '/api/notify': return json(req, res, notifier.view());
    case '/api/heal': return json(req, res, { now: Date.now(), ...healer.view() });
    case '/api/userdata': return json(req, res, userdata.get());
    case '/api/totp': return json(req, res, auth.totpStatus());

    case '/api/stream': {
      if (clients.size >= MAX_CLIENTS) return json(req, res, { error: 'busy' }, 503);
      res.writeHead(200, { ...SEC, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      const c = { res, sid: sess.id };
      clients.add(c);
      collector.setClients(clients.size);
      req.on('close', () => { clients.delete(c); collector.setClients(clients.size); });
      return;
    }

    default:
      if (p.startsWith('/api/') || p.startsWith('/auth/')) return json(req, res, { error: 'not found' }, 404);
      if (PUBLIC_FILES.has(p) && p !== '/favicon.svg' && p !== '/theme.js') return json(req, res, { error: 'not found' }, 404);
      return serveStatic(req, res, p);
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('request error:', e && e.message);
    if (!res.headersSent) json(req, res, { error: 'Interner Fehler.' }, 500); else res.end();
  });
});
server.keepAliveTimeout = 65_000;
server.headersTimeout = 15_000;
server.requestTimeout = 0; // SSE is long-lived

setInterval(() => { for (const c of clients) c.res.write(': ping\n\n'); }, 15_000);

collector.start();
server.listen(PORT, HOST, () => console.log(`server-dash on http://${HOST}:${PORT}`));

function shutdown() {
  collector.flush();
  collector.save();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}
// a failed measurement must never take the dashboard down
process.on('uncaughtException', (e) => console.error('uncaught:', e && e.stack));
process.on('unhandledRejection', (e) => console.error('unhandled rejection:', e && e.stack ? e.stack : e));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
