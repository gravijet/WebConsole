'use strict';
// Long-running work (apt, docker pull, certbot ...) runs as a transient systemd unit so it survives
// the helper's idle exit. Output goes to a log file; the dashboard polls job.get.

const fs = require('fs');
const path = require('path');
const { run, fail, clip } = require('./core');

const DIR = '/run/server-dash/jobs';
const ID_RE = /^\d{13}-[a-z0-9-]{1,30}$/;
const EXIT_RE = /\n::exit (\d+)\s*$/;

function ensureDir() { fs.mkdirSync(DIR, { recursive: true, mode: 0o700 }); }

async function start(label, title, cmd, args = [], { env = {}, cwd, props = [] } = {}) {
  ensureDir();
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'job';
  const id = `${Date.now()}-${slug}`;
  const log = path.join(DIR, `${id}.log`);
  fs.writeFileSync(log, '', { mode: 0o600 });
  fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify({ id, title, cmd: [cmd, ...args].join(' ').slice(0, 300), startedAt: Date.now() }), { mode: 0o600 });
  const sd = ['--unit', `sd-job-${id}`, '--collect', '--quiet', '-p', `StandardOutput=append:${log}`, '-p', `StandardError=append:${log}`, '-p', 'KillMode=control-group', '-p', 'TimeoutStopSec=30'];
  for (const p of props) sd.push('-p', p);
  if (cwd) sd.push('--working-directory', cwd);
  for (const [k, v] of Object.entries(env)) sd.push(`--setenv=${k}=${v}`);
  sd.push('--', '/bin/sh', '-c', '"$@"; rc=$?; echo; echo "::exit $rc"', 'sh', cmd, ...args);
  const r = await run('systemd-run', sd, { timeout: 20_000 });
  if (r.code !== 0) { try { fs.unlinkSync(log); fs.unlinkSync(path.join(DIR, `${id}.json`)); } catch {} throw fail(`Der Auftrag konnte nicht gestartet werden: ${(r.err || r.out).trim().slice(0, 300)}`); }
  return { job: id, title };
}

/** ids of jobs whose systemd unit is still running (finished units are collected away) */
async function activeJobs() {
  const r = await run('systemctl', ['list-units', '--type=service', '--no-legend', '--plain', '--no-pager', 'sd-job-*'], { timeout: 10_000 });
  const set = new Set();
  for (const l of r.out.split('\n')) { const m = /^sd-job-(\S+)\.service\s+\S+\s+(active|activating|deactivating)/.exec(l.trim()); if (m) set.add(m[1]); }
  return set;
}

function readJob(id, active) {
  if (!ID_RE.test(id)) throw fail('Ungültige Auftrags-ID.');
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8')); } catch { throw fail('Dieser Auftrag existiert nicht (mehr).'); }
  let text = '';
  try {
    const fd = fs.openSync(path.join(DIR, `${id}.log`), 'r');
    const st = fs.fstatSync(fd);
    const len = Math.min(st.size, 250_000);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {}
  const m = EXIT_RE.exec(`\n${text}`);
  // no exit marker and no running unit: the job was stopped before it could write one
  const killed = !m && active && !active.has(id) && Date.now() - meta.startedAt > 3000;
  return { ...meta, text: clip(text.replace(/\n::exit \d+\s*$/, '\n'), 250_000), done: !!m || killed, exit: m ? +m[1] : killed ? 143 : null, killed };
}

const ops = {
  async 'job.get'({ id }) { return readJob(String(id), await activeJobs()); },

  async 'job.list'() {
    ensureDir();
    const out = [];
    const active = await activeJobs();
    for (const f of fs.readdirSync(DIR)) {
      if (!f.endsWith('.json')) continue;
      try { const j = readJob(f.slice(0, -5), active); out.push({ id: j.id, title: j.title, startedAt: j.startedAt, done: j.done, exit: j.exit, killed: j.killed }); } catch {}
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    // housekeeping: forget jobs older than 3 days or beyond the newest 40
    out.slice(40).concat(out.filter((j) => Date.now() - j.startedAt > 3 * 86400_000)).forEach((j) => { try { fs.unlinkSync(path.join(DIR, `${j.id}.json`)); fs.unlinkSync(path.join(DIR, `${j.id}.log`)); } catch {} });
    return { jobs: out.slice(0, 40) };
  },

  async 'job.stop'({ id }) {
    readJob(String(id));
    await run('systemctl', ['stop', `sd-job-${id}.service`], { timeout: 40_000 });
    return { stopped: true };
  },
};

module.exports = { ops, start };
