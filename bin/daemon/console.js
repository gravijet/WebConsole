'use strict';
// Command console (runs as a background job, so the output can be followed live) and Docker stacks:
// compose projects the dashboard writes to /opt/stacks and brings up, so an "app" is one editable file.

const fs = require('fs');
const path = require('path');
const { run, fail, int, str, USER_RE, NAME_RE } = require('./core');
const jobs = require('./jobs');

const STACKS = process.env.SD_STACKS_DIR || '/opt/stacks';
const STACK_RE = /^[a-z0-9][a-z0-9_-]{0,40}$/;
const ENV = { DOCKER_CONFIG: '/tmp' };
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];
const MAX_YAML = 200_000;

function passwdUser(name) {
  try {
    for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) {
      const p = l.split(':');
      if (p[0] === name) return { name, uid: +p[2], home: p[5] || '/', shell: p[6] || '' };
    }
  } catch {}
  return null;
}

const stackDir = (name) => {
  if (typeof name !== 'string' || !STACK_RE.test(name)) throw fail('Ungültiger Name. Erlaubt: Kleinbuchstaben, Ziffern, - und _ (bis 41 Zeichen).');
  return path.join(STACKS, name);
};
const composeFile = (dir) => COMPOSE_FILES.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f)) || null;

const ops = {
  /** run a shell command as root or as another user, as a job whose output the dashboard polls */
  async 'term.run'({ cmd, user, cwd, timeout }) {
    str(cmd, 'Befehl', 8000);
    const who = user == null || user === '' ? 'root' : user;
    if (typeof who !== 'string' || !USER_RE.test(who)) throw fail('Ungültiger Benutzername.');
    const pw = who === 'root' ? { name: 'root', home: '/root' } : passwdUser(who);
    if (!pw) throw fail('Diesen Benutzer gibt es nicht.');
    if (pw.shell && /(nologin|false)$/.test(pw.shell)) throw fail('Dieser Benutzer hat keine Anmelde-Shell.');
    const dir = cwd == null || cwd === '' ? pw.home : cwd;
    str(dir, 'Arbeitsverzeichnis', 1024);
    if (!dir.startsWith('/')) throw fail('Das Arbeitsverzeichnis muss ein absoluter Pfad sein.');
    try { if (!fs.statSync(dir).isDirectory()) throw new Error(); } catch { throw fail('Das Arbeitsverzeichnis gibt es nicht.'); }
    const secs = timeout == null ? 600 : int(timeout, 5, 3600, 'Die Zeitbegrenzung');
    const script = 'cd -- "$1" || exit 1; eval "$2"';
    const inner = ['/bin/bash', '-lc', script, '_', dir, cmd];
    const [bin, ...args] = who === 'root' ? inner : ['runuser', '-u', who, '--', 'env', `HOME=${pw.home}`, `USER=${who}`, `LOGNAME=${who}`, ...inner];
    const first = cmd.trim().split('\n')[0].slice(0, 70);
    return jobs.start('console', `Befehl: ${first}`, bin, args, { env: { HOME: pw.home, TERM: 'dumb', LANG: 'C.UTF-8' }, cwd: '/', props: [`RuntimeMaxSec=${secs}`] });
  },

  /** run a command inside a running container */
  async 'docker.exec'({ name, cmd, user }) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('Ungültiger Containername.');
    str(cmd, 'Befehl', 4000);
    const ps = await run('docker', ['ps', '--format', '{{.Names}}'], { timeout: 15_000, env: ENV });
    if (!ps.out.split('\n').includes(name)) throw fail('Dieser Container läuft nicht.');
    const args = ['exec'];
    if (user != null && user !== '') { if (typeof user !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(user)) throw fail('Ungültiger Benutzer.'); args.push('-u', user); }
    args.push(name, '/bin/sh', '-c', cmd);
    return jobs.start('exec', `Im Container ${name}: ${cmd.trim().split('\n')[0].slice(0, 60)}`, 'docker', args, { env: ENV, props: ['RuntimeMaxSec=900'] });
  },

  // ---------------------------------------------------------------- stacks

  async 'docker.stack-list'() {
    fs.mkdirSync(STACKS, { recursive: true, mode: 0o755 });
    const ls = await run('docker', ['compose', 'ls', '--all', '--format', 'json'], { timeout: 20_000, env: ENV });
    let projects = [];
    try { projects = JSON.parse(ls.out || '[]'); } catch {}
    const state = new Map(projects.map((p) => [p.Name, p]));
    const stacks = [];
    for (const n of fs.readdirSync(STACKS)) {
      if (!STACK_RE.test(n)) continue;
      const dir = path.join(STACKS, n);
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const file = composeFile(dir);
      if (!file) continue;
      const p = state.get(n);
      stacks.push({ name: n, file, mtime: fs.statSync(file).mtimeMs, status: p ? p.Status : 'nicht gestartet', running: !!(p && /running/.test(p.Status)) });
    }
    return { dir: STACKS, stacks: stacks.sort((a, b) => a.name.localeCompare(b.name)) };
  },

  /** the compose file and the .env of a stack (the .env usually holds passwords, so the dashboard asks for the password first) */
  async 'docker.stack-get'({ name }) {
    const dir = stackDir(name);
    const file = composeFile(dir);
    if (!file) throw fail('Dieses Projekt gibt es nicht.');
    let env = '';
    try { env = fs.readFileSync(path.join(dir, '.env'), 'utf8'); } catch {}
    return { name, file: path.basename(file), yaml: fs.readFileSync(file, 'utf8'), env };
  },

  /** write the compose file (validated with `docker compose config`) and optionally bring it up */
  async 'docker.stack-save'({ name, yaml, env, up }) {
    const dir = stackDir(name);
    str(yaml, 'Compose-Datei', MAX_YAML);
    if (env != null && (typeof env !== 'string' || env.length > 50_000 || env.includes('\0'))) throw fail('Ungültige .env-Datei.');
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    const existing = composeFile(dir);
    const file = existing || path.join(dir, 'compose.yaml');
    const tmp = path.join(dir, '.compose.check.yaml');
    fs.writeFileSync(tmp, yaml, { mode: 0o640 });
    if (typeof env === 'string') fs.writeFileSync(path.join(dir, '.env'), env, { mode: 0o600 });
    const check = await run('docker', ['compose', '-p', name, '-f', tmp, '--project-directory', dir, 'config', '-q'], { timeout: 30_000, env: ENV, cwd: dir });
    fs.unlinkSync(tmp);
    if (check.code !== 0) {
      if (!existing) { try { fs.rmSync(dir, { recursive: true }); } catch {} }
      throw fail(`Die Compose-Datei ist fehlerhaft:\n${(check.err || check.out).trim().slice(0, 900)}`);
    }
    if (existing) { try { fs.copyFileSync(existing, `${existing}.bak`); } catch {} }
    fs.writeFileSync(file, yaml, { mode: 0o640 });
    if (!up) return { name, saved: true };
    return jobs.start('stack', `Projekt starten: ${name}`, 'docker', ['compose', '-p', name, '-f', file, '--project-directory', dir, 'up', '-d', '--remove-orphans', '--pull', 'missing'], { env: ENV, cwd: dir });
  },

  /** stop a stack and remove its folder; named volumes only when asked */
  async 'docker.stack-delete'({ name, volumes }) {
    const dir = stackDir(name);
    const file = composeFile(dir);
    if (!file) throw fail('Dieses Projekt gibt es nicht.');
    return jobs.start('stack', `Projekt entfernen: ${name}`, '/bin/sh', ['-c', 'cd "$1" && docker compose -p "$2" -f "$3" down --remove-orphans $4 && cd / && rm -rf -- "$1"', '_', dir, name, file, volumes ? '--volumes' : ''], { env: ENV, cwd: dir });
  },
};

module.exports = { ops };
