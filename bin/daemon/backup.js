'use strict';
// Backups: plans (what, when, how many to keep), archives, restore. The work itself is done by
// backup-run.js, which cron and the "Jetzt sichern" button both start.

const fs = require('fs');
const path = require('path');
const { run, fail, int, str } = require('./core');
const jobs = require('./jobs');

const CONF = process.env.SD_CONF_DIR || '/etc/server-dash';
const ARCHIVES = process.env.SD_ARCHIVE_DIR || '/var/backups/sd-archives';
const CRON_FILE = process.env.SD_CRON_FILE || '/etc/cron.d/server-dash-backups';
const RUNNER = process.env.SD_BACKUP_RUNNER || '/usr/local/lib/server-dash/backup-run.js';
const PLAN_FILE = path.join(CONF, 'backups.json');
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const ARCHIVE_RE = /^([a-z0-9][a-z0-9_-]{0,40})\/([a-z0-9][a-z0-9_-]{0,40}-\d{8}-\d{6}\.tar\.(zst|gz))$/;
const BAD_PATH = /^\/(proc|sys|dev|run)(\/|$)/;
const MACROS = new Set(['@hourly', '@daily', '@weekly', '@monthly']);

function readPlans() {
  try { return JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')).plans || []; } catch { return []; }
}

function writePlans(plans) {
  fs.mkdirSync(CONF, { recursive: true, mode: 0o755 });
  fs.writeFileSync(PLAN_FILE, JSON.stringify({ plans }, null, 1), { mode: 0o600 });
  const lines = ['# Vom Dashboard verwaltet (Ansicht „Sicherungen“). Änderungen hier werden überschrieben.', 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ''];
  for (const p of plans) if (p.enabled && p.schedule) lines.push(`${p.schedule} root /usr/bin/node ${RUNNER} ${p.id} >> /var/log/server-dash-backup.log 2>&1`);
  if (lines.length > 3) fs.writeFileSync(CRON_FILE, `${lines.join('\n')}\n`, { mode: 0o644 });
  else { try { fs.unlinkSync(CRON_FILE); } catch {} }
}

function cleanSchedule(s) {
  if (s == null || s === '') return '';
  if (typeof s !== 'string') throw fail('Ungültiger Zeitplan.');
  const t = s.trim().replace(/\s+/g, ' ');
  if (MACROS.has(t)) return t;
  const f = t.split(' ');
  if (f.length !== 5 || !f.every((x) => /^[0-9*,/-]+$/.test(x))) throw fail('Der Zeitplan braucht fünf Felder (Minute Stunde Tag Monat Wochentag), z. B. 30 3 * * *.');
  return t;
}

function cleanPath(p) {
  str(p, 'Pfad', 1024);
  if (!p.startsWith('/') || p.includes('\0') || /[\n\r]/.test(p)) throw fail(`Ungültiger Pfad: ${p.slice(0, 80)}`);
  const n = path.posix.normalize(p).replace(/(.)\/$/, '$1');
  if (BAD_PATH.test(n) || n === ARCHIVES || n.startsWith(`${ARCHIVES}/`)) throw fail(`Dieser Pfad lässt sich nicht sichern: ${n}`);
  if (!fs.existsSync(n)) throw fail(`Diesen Pfad gibt es nicht: ${n}`);
  return n;
}

function statusOf(id) { try { return JSON.parse(fs.readFileSync(path.join(ARCHIVES, id, 'status.json'), 'utf8')); } catch { return null; } }

function archiveInfo(rel) {
  const m = ARCHIVE_RE.exec(rel);
  if (!m) throw fail('Ungültiges Archiv.');
  const file = path.join(ARCHIVES, m[1], m[2]);
  let st;
  try { st = fs.statSync(file); } catch { throw fail('Dieses Archiv gibt es nicht (mehr).'); }
  return { plan: m[1], name: m[2], file, size: st.size, mtime: st.mtimeMs, gz: m[3] === 'gz' };
}

const ops = {
  async 'backup.overview'() {
    const plans = readPlans().map((p) => ({ ...p, status: statusOf(p.id) }));
    const archives = [];
    if (fs.existsSync(ARCHIVES)) {
      for (const d of fs.readdirSync(ARCHIVES)) {
        if (!ID_RE.test(d)) continue;
        let names = [];
        try { names = fs.readdirSync(path.join(ARCHIVES, d)); } catch { continue; }
        for (const f of names) {
          if (!ARCHIVE_RE.test(`${d}/${f}`)) continue;
          const st = fs.statSync(path.join(ARCHIVES, d, f));
          archives.push({ id: `${d}/${f}`, plan: d, name: f, size: st.size, mtime: st.mtimeMs });
        }
      }
    }
    archives.sort((a, b) => b.mtime - a.mtime);
    const df = await run('df', ['-B1', '--output=avail,size', fs.existsSync(ARCHIVES) ? ARCHIVES : '/var/backups'], { timeout: 10_000 });
    const [avail, size] = (df.out.trim().split('\n')[1] || '').trim().split(/\s+/).map(Number);
    return { dir: ARCHIVES, plans, archives, free: avail || null, diskSize: size || null, total: archives.reduce((s, a) => s + a.size, 0) };
  },

  async 'backup.plan-save'(a) {
    const id = typeof a.id === 'string' ? a.id : '';
    if (!ID_RE.test(id)) throw fail('Der Kurzname darf nur Kleinbuchstaben, Ziffern, - und _ enthalten.');
    const name = str(a.name || id, 'Name', 80).trim();
    if (!Array.isArray(a.paths) || !a.paths.length || a.paths.length > 30) throw fail('Bitte 1 bis 30 Ordner oder Dateien angeben.');
    const paths = [...new Set(a.paths.map(cleanPath))];
    const excludes = (Array.isArray(a.excludes) ? a.excludes : []).slice(0, 50).map((e) => {
      if (typeof e !== 'string' || !e.trim() || e.length > 200 || /[\n\r\0]/.test(e)) throw fail('Ungültiges Ausschluss-Muster.');
      return e.trim();
    });
    const plan = { id, name, paths, excludes, schedule: cleanSchedule(a.schedule), keep: int(a.keep == null ? 7 : a.keep, 1, 100, 'Die Anzahl aufzubewahrender Archive'), compress: a.compress === 'gz' ? 'gz' : 'zstd', oneFs: !!a.oneFs, mysql: !!a.mysql, enabled: a.enabled !== false };
    const plans = readPlans();
    const i = plans.findIndex((p) => p.id === id);
    if (i >= 0) plans[i] = plan; else { if (plans.length >= 30) throw fail('Mehr als 30 Pläne sind nicht möglich.'); plans.push(plan); }
    writePlans(plans);
    return { id, saved: true };
  },

  async 'backup.plan-delete'({ id, archives }) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('Ungültiger Plan.');
    const plans = readPlans();
    if (!plans.some((p) => p.id === id)) throw fail('Diesen Plan gibt es nicht.');
    writePlans(plans.filter((p) => p.id !== id));
    if (archives) { try { fs.rmSync(path.join(ARCHIVES, id), { recursive: true }); } catch {} }
    return { deleted: true };
  },

  async 'backup.run'({ id }) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw fail('Ungültiger Plan.');
    const plan = readPlans().find((p) => p.id === id);
    if (!plan) throw fail('Diesen Plan gibt es nicht.');
    return jobs.start('backup', `Sicherung: ${plan.name}`, process.execPath, [RUNNER, id], { env: { SD_CONF_DIR: CONF, SD_ARCHIVE_DIR: ARCHIVES }, props: ['RuntimeMaxSec=21600', 'Nice=10', 'IOSchedulingClass=idle'] });
  },

  async 'backup.delete'({ id }) {
    const a = archiveInfo(id);
    fs.unlinkSync(a.file);
    return { deleted: a.name };
  },

  async 'backup.contents'({ id }) {
    const a = archiveInfo(id);
    const r = await run('tar', [a.gz ? '--gzip' : '--use-compress-program=zstd', '-tf', a.file], { timeout: 120_000, max: 64 << 20 });
    if (r.code !== 0 && !r.out) throw fail(`Das Archiv lässt sich nicht lesen: ${r.err.trim().slice(0, 300)}`);
    const all = r.out.split('\n').filter(Boolean);
    return { name: a.name, total: all.length, files: all.slice(0, 1500), truncated: all.length > 1500 };
  },

  /** unpack an archive (or one path from it) into a folder; "/" puts the files back where they came from */
  async 'backup.restore'({ id, dest, only, overwrite }) {
    const a = archiveInfo(id);
    str(dest, 'Zielordner', 1024);
    if (!dest.startsWith('/') || /[\n\r\0]/.test(dest)) throw fail('Der Zielordner muss ein absoluter Pfad sein.');
    const target = path.posix.normalize(dest).replace(/(.)\/$/, '$1');
    if (BAD_PATH.test(target)) throw fail('Dieses Ziel ist nicht erlaubt.');
    fs.mkdirSync(target, { recursive: true });
    const args = [a.gz ? '--gzip' : '--use-compress-program=zstd', '-xpf', a.file, '-C', target, overwrite ? '--overwrite' : '--skip-old-files'];
    if (only != null && only !== '') {
      if (typeof only !== 'string' || only.length > 1024 || /[\0\n\r]/.test(only) || only.split('/').includes('..')) throw fail('Ungültiger Pfad im Archiv.');
      args.push('--', only.replace(/^\/+/, ''));
    }
    return jobs.start('restore', `Wiederherstellen: ${a.name} → ${target}`, 'tar', args, { env: { LC_ALL: 'C' }, props: ['RuntimeMaxSec=21600'] });
  },
};

module.exports = { ops, ARCHIVES };
