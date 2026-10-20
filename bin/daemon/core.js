'use strict';
// Shared helpers for the privileged action helper: process runner, validators, user errors.

const { execFile } = require('child_process');
const net = require('net');

const MAX_OUT = 400_000;

/** run a command without a shell; never throws */
const run = (cmd, args = [], { timeout = 30_000, input, env, cwd, max = 16 << 20 } = {}) => new Promise((resolve) => {
  const child = execFile(cmd, args, { timeout, maxBuffer: max, env: env ? { ...process.env, ...env } : process.env, cwd }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || ''), killed: !!(err && err.killed) });
  });
  if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
});

const clip = (s, n = MAX_OUT) => (s.length > n ? `… (gekürzt)\n${s.slice(-n)}` : s);

/** an error whose message is safe to show to the user */
const fail = (msg) => { const e = new Error(msg); e.user = true; return e; };

const UNIT_RE = /^[A-Za-z0-9:_.@\\][A-Za-z0-9:_.@\\-]{0,119}\.(service|timer|socket|mount|path|target)$/; // never starts with '-'
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_RE = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const PKG_RE = /^[a-z0-9][a-z0-9+.:-]{0,100}$/;

const isIp = (s) => typeof s === 'string' && net.isIP(s) > 0;
const isHost = (s) => typeof s === 'string' && (isIp(s) || (HOST_RE.test(s) && !s.startsWith('-')));
const isCidr = (s) => {
  if (typeof s !== 'string') return false;
  const [ip, bits, extra] = s.split('/');
  if (extra !== undefined || !isIp(ip)) return false;
  if (bits === undefined) return true;
  return /^\d{1,3}$/.test(bits) && +bits <= (net.isIPv4(ip) ? 32 : 128);
};

const int = (v, min, max, label = 'Wert') => {
  if (!Number.isInteger(v) || v < min || v > max) throw fail(`${label} muss zwischen ${min} und ${max} liegen.`);
  return v;
};
const str = (v, label = 'Wert', max = 4096) => {
  if (typeof v !== 'string' || !v.length || v.length > max || v.includes('\0')) throw fail(`Ungültige Angabe: ${label}.`);
  return v;
};

module.exports = { run, clip, fail, UNIT_RE, NAME_RE, USER_RE, HOST_RE, PKG_RE, isIp, isHost, isCidr, int, str, MAX_OUT };
