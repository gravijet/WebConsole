#!/usr/bin/node
'use strict';
// Xeon-1 Console: privileged action helper.
//
// Runs as root, started on demand by systemd socket activation, exits when idle.
// The dashboard (unprivileged user "serverdash") talks to it over a unix socket that only
// root and group "serverdash" may open. It accepts a FIXED set of operations with strictly
// validated arguments. There is no way to run an arbitrary command through it.
//
// Request : one JSON line  { op, args }
// Response: one JSON line  { ok: true, result } | { ok: false, error }

const net = require('net');
const fs = require('fs');

const SOCKET = process.env.SD_ACTIONS_SOCKET || null; // tests only; production uses LISTEN_FDS
const IDLE_MS = 5 * 60_000;
const MAX_LINE = 4 * 1024 * 1024; // the file editor sends up to 2 MB of text

const log = (o) => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));

// every operation lives in a module under ./daemon; this file only wires them to the socket
const OPS = Object.create(null);
for (const mod of ['system', 'docker', 'net', 'security', 'users', 'pkg', 'cron', 'files', 'db', 'jobs', 'console', 'sites', 'backup', 'sysx']) {
  for (const [name, fn] of Object.entries(require(`./daemon/${mod}`).ops)) {
    if (OPS[name]) throw new Error(`duplicate operation ${name}`);
    OPS[name] = fn;
  }
}
// quiet operations are not written to the journal (polling, read-only lookups)
const QUIET = /^(ping|logs\.|job\.get|job\.list|system\.reboot-status|files\.(list|stat|read|du|find|versions|version-read)|net\.|docker\.(inventory|inspect)|users\.(list|keys-get)|pkg\.(status|installed|search)|cron\.(overview|user-get)|fw\.(overview|iptables)|sec\.|auth\.|sys\.(identity|hardware|sysctl|modules|timers|analyze|swap$)|db\.overview|backup\.(overview|contents)|docker\.stack-(list|get)|certs\.list|nginx\.(sites|test)|unit\.info|proc\.info)/;
const brief = (args) => JSON.stringify(args, (k, v) => (typeof v === 'string' && v.length > 160 ? `${v.slice(0, 160)}…(${v.length})` : v));

// ------------------------------------------------------------------ server

let idleTimer;
const touch = () => { if (SOCKET) return; /* test mode never exits */ clearTimeout(idleTimer); idleTimer = setTimeout(() => { log({ msg: 'idle, exiting' }); process.exit(0); }, IDLE_MS); idleTimer.unref?.(); };

const server = net.createServer((sock) => {
  touch();
  let buf = '';
  sock.setTimeout(190_000, () => sock.destroy());
  sock.setEncoding('utf8'); // multi-byte characters may be split across chunks
  sock.on('error', () => {});
  sock.on('data', async (c) => {
    buf += c;
    if (buf.length > MAX_LINE) { sock.destroy(); return; }
    const i = buf.indexOf('\n');
    if (i < 0) return;
    const line = buf.slice(0, i);
    buf = '';
    let req;
    try { req = JSON.parse(line); } catch { sock.end(`${JSON.stringify({ ok: false, error: 'Ungültige Anfrage.' })}\n`); return; }
    const fn = typeof req.op === 'string' && OPS[req.op] ? OPS[req.op] : null;
    if (!fn) { sock.end(`${JSON.stringify({ ok: false, error: 'Unbekannte Operation.' })}\n`); return; }
    const args = req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {};
    const started = Date.now();
    try {
      const result = await fn(args);
      if (!QUIET.test(req.op)) log({ op: req.op, args: JSON.parse(brief(args)), ok: true, ms: Date.now() - started });
      sock.end(`${JSON.stringify({ ok: true, result })}\n`);
    } catch (e) {
      log({ op: req.op, args: JSON.parse(brief(args)), ok: false, error: String(e.message).slice(0, 200) });
      sock.end(`${JSON.stringify({ ok: false, error: e.user ? e.message : 'Interner Fehler im Aktions-Helfer.' })}\n`);
    }
  });
});

const fromSystemd = process.env.LISTEN_FDS && Number(process.env.LISTEN_PID) === process.pid;
if (fromSystemd) {
  server.listen({ fd: 3 }, () => log({ msg: 'listening (socket activation)' }));
} else if (SOCKET) {
  try { fs.unlinkSync(SOCKET); } catch {}
  server.listen(SOCKET, () => {
    const gid = process.env.SD_ACTIONS_GID ? Number(process.env.SD_ACTIONS_GID) : null;
    if (gid != null) { try { fs.chownSync(SOCKET, 0, gid); } catch {} }
    fs.chmodSync(SOCKET, 0o660);
    log({ msg: `listening on ${SOCKET} (test mode)` });
  });
} else {
  console.error('Started without socket activation and without SD_ACTIONS_SOCKET.');
  process.exit(2);
}
touch();
process.on('SIGTERM', () => process.exit(0));
