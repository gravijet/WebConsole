#!/usr/bin/node
'use strict';
// Creates one backup archive for a plan from /etc/server-dash/backups.json and prunes old ones.
// Started by cron (schedule of the plan) or by the dashboard ("Jetzt sichern"). Runs as root.
//   usage: backup-run.js <plan-id>

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const CONF = process.env.SD_CONF_DIR || '/etc/server-dash';
const ARCHIVES = process.env.SD_ARCHIVE_DIR || '/var/backups/sd-archives';
const id = process.argv[2];

const say = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m, code = 1) => { say(m); process.exit(code); };

let plan;
try { plan = (JSON.parse(fs.readFileSync(path.join(CONF, 'backups.json'), 'utf8')).plans || []).find((p) => p.id === id); } catch { die('Die Sicherungspläne konnten nicht gelesen werden.'); }
if (!plan) die('Diesen Sicherungsplan gibt es nicht.');

const dir = path.join(ARCHIVES, plan.id);
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const pad = (n) => String(n).padStart(2, '0');
const d = new Date();
const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const ext = plan.compress === 'gz' ? 'tar.gz' : 'tar.zst';
const file = path.join(dir, `${plan.id}-${stamp}.${ext}`);
const part = `${file}.part`;
const t0 = Date.now();

const args = ['--create', '--file', part, '--ignore-failed-read', '--warning=no-file-changed', '--warning=no-file-removed', '--sparse'];
if (plan.compress === 'gz') args.push('--gzip'); else args.push('--use-compress-program=zstd -T2 -3');
if (plan.oneFs) args.push('--one-file-system');
args.push(`--exclude=${ARCHIVES.replace(/^\//, '')}`);
for (const e of plan.excludes || []) args.push(`--exclude=${e.replace(/^\//, '')}`);
args.push('-C', '/', ...plan.paths.map((p) => (p === '/' ? '.' : p.replace(/^\//, ''))));

let dump = null;
if (plan.mysql) {
  dump = path.join(dir, `mariadb-${stamp}.sql`);
  say('Sichere die MariaDB-Datenbanken …');
  const out = fs.openSync(dump, 'w', 0o600);
  const r = spawnSync('mysqldump', ['--all-databases', '--single-transaction', '--routines', '--events', '--quick'], { stdio: ['ignore', out, 'pipe'], timeout: 20 * 60_000 });
  fs.closeSync(out);
  if (r.status !== 0) { say(`Warnung: mysqldump fehlgeschlagen (${String(r.stderr || '').trim().slice(0, 200)}). Die Dateien werden trotzdem gesichert.`); try { fs.unlinkSync(dump); } catch {} dump = null; } else say(`Datenbank-Auszug: ${(fs.statSync(dump).size / 1048576).toFixed(1)} MB`);
}
if (dump) args.push('-C', dir, path.basename(dump));

say(`Sichere ${plan.paths.join(', ')} …`);
const r = spawnSync('tar', args, { stdio: ['ignore', 'inherit', 'inherit'], timeout: 6 * 3600_000, env: { ...process.env, LC_ALL: 'C' } });
if (dump) { try { fs.unlinkSync(dump); } catch {} }
if (r.status === 0 || r.status === 1) { // 1 = some files changed while reading, the archive is still good
  fs.renameSync(part, file);
  const size = fs.statSync(file).size;
  fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: Date.now(), ok: true, file: path.basename(file), size, seconds: Math.round((Date.now() - t0) / 1000) }));
  say(`Fertig: ${path.basename(file)} (${(size / 1048576).toFixed(1)} MB, ${Math.round((Date.now() - t0) / 1000)} s)`);
  const all = fs.readdirSync(dir).filter((f) => f.startsWith(`${plan.id}-`) && /\.tar\.(zst|gz)$/.test(f)).sort().reverse();
  for (const old of all.slice(Math.max(1, plan.keep || 7))) { try { fs.unlinkSync(path.join(dir, old)); say(`Altes Archiv gelöscht: ${old}`); } catch {} }
  process.exit(0);
}
try { fs.unlinkSync(part); } catch {}
fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ at: Date.now(), ok: false, error: `tar Exit ${r.status}`, seconds: Math.round((Date.now() - t0) / 1000) }));
die(`Die Sicherung ist fehlgeschlagen (tar Exit ${r.status}${r.error ? `, ${r.error.message}` : ''}).`, 2);
