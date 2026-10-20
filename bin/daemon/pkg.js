'use strict';
// Debian packages: status, upgradable list, installed list, and apt jobs.

const fs = require('fs');
const { run, fail, PKG_RE } = require('./core');
const jobs = require('./jobs');

const APT_ENV = { DEBIAN_FRONTEND: 'noninteractive', LC_ALL: 'C', NEEDRESTART_MODE: 'a' };
const DPKG_OPTS = ['-o', 'Dpkg::Options::=--force-confold', '-o', 'Dpkg::Options::=--force-confdef'];

const mtime = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return null; } };
const pkgNames = (names) => {
  if (!Array.isArray(names) || !names.length || names.length > 20) throw fail('Bitte 1 bis 20 Paketnamen angeben.');
  for (const n of names) if (typeof n !== 'string' || !PKG_RE.test(n)) throw fail(`Ungültiger Paketname: ${String(n).slice(0, 40)}`);
  return names;
};

const ops = {
  async 'pkg.status'() {
    const [up, hold, auto, inst, kern] = await Promise.all([
      run('apt', ['list', '--upgradable'], { timeout: 60_000, env: { LC_ALL: 'C' } }),
      run('apt-mark', ['showhold'], { timeout: 15_000 }),
      run('apt-get', ['-s', 'autoremove'], { timeout: 60_000, env: APT_ENV }),
      run('dpkg-query', ['-W', '-f', '${Package}\n'], { timeout: 30_000 }),
      run('uname', ['-r'], { timeout: 5000 }),
    ]);
    const upgradable = up.out.split('\n').map((l) => /^([^/\s]+)\/(\S+)\s+(\S+)\s+(\S+)\s+\[upgradable from: (.+)\]/.exec(l)).filter(Boolean).map((m) => ({ name: m[1], suite: m[2], version: m[3], arch: m[4], from: m[5], security: /security/i.test(m[2]) }));
    const removable = auto.out.split('\n').filter((l) => l.startsWith('Remv ')).map((l) => l.split(' ')[1]);
    let reboot = false; let rebootPkgs = [];
    try { reboot = fs.existsSync('/var/run/reboot-required'); rebootPkgs = fs.readFileSync('/var/run/reboot-required.pkgs', 'utf8').split('\n').filter(Boolean); } catch {}
    const kernels = (await run('dpkg-query', ['-W', '-f', '${Package} ${Version} ${db:Status-Abbrev}\n', 'linux-image-[0-9]*'], { timeout: 15_000 })).out.split('\n').filter((l) => / ii\s*$/.test(l)).map((l) => l.split(' ').slice(0, 2).join(' '));
    return {
      upgradable, held: hold.out.split('\n').filter(Boolean), removable, installed: inst.out.split('\n').filter(Boolean).length, reboot, rebootPkgs,
      lastUpdate: mtime('/var/lib/apt/periodic/update-success-stamp') || mtime('/var/lib/apt/lists/lock') || null, running: kern.out.trim(), kernels,
    };
  },

  async 'pkg.installed'({ q }) {
    const r = await run('dpkg-query', ['-W', '-f', '${Package}\t${Version}\t${Installed-Size}\t${db:Status-Abbrev}\t${binary:Summary}\n'], { timeout: 30_000, max: 32 << 20 });
    const needle = typeof q === 'string' ? q.toLowerCase().slice(0, 60) : '';
    const all = r.out.split('\n').filter(Boolean).map((l) => l.split('\t')).filter((p) => /^ii/.test(p[3] || ''));
    const list = all.filter((p) => !needle || p[0].includes(needle) || (p[4] || '').toLowerCase().includes(needle));
    return { total: all.length, matches: list.length, list: list.slice(0, 500).map((p) => ({ name: p[0], version: p[1], sizeKb: +p[2] || 0, summary: p[4] || '' })) };
  },

  async 'pkg.search'({ q }) {
    if (typeof q !== 'string' || !/^[A-Za-z0-9+._-]{2,60}$/.test(q)) throw fail('Bitte mindestens 2 Zeichen (Buchstaben, Ziffern, + . _ -).');
    const r = await run('apt-cache', ['search', '--names-only', '--', q], { timeout: 30_000 });
    return { list: r.out.split('\n').filter(Boolean).slice(0, 60).map((l) => { const i = l.indexOf(' - '); return { name: l.slice(0, i), summary: l.slice(i + 3) }; }) };
  },

  async 'pkg.update'() { return jobs.start('apt-update', 'Paketlisten aktualisieren', 'apt-get', ['update'], { env: APT_ENV }); },
  async 'pkg.upgrade'() { return jobs.start('apt-upgrade', 'Alle Updates installieren', 'apt-get', ['-y', ...DPKG_OPTS, 'upgrade'], { env: APT_ENV }); },
  async 'pkg.autoremove'() { return jobs.start('apt-autoremove', 'Nicht mehr benötigte Pakete entfernen', 'apt-get', ['-y', 'autoremove'], { env: APT_ENV }); },
  async 'pkg.clean'() { return jobs.start('apt-clean', 'Paket-Zwischenspeicher leeren', 'apt-get', ['clean'], { env: APT_ENV }); },

  async 'pkg.install'({ names }) {
    const list = pkgNames(names);
    const chk = await run('apt-cache', ['policy', ...list], { timeout: 20_000 });
    for (const n of list) if (!new RegExp(`^${n.replace(/[+.]/g, '\\$&')}:\\n\\s+Installed:`, 'm').test(chk.out)) throw fail(`Das Paket „${n}“ gibt es nicht.`);
    return jobs.start('apt-install', `Installieren: ${list.join(', ')}`, 'apt-get', ['-y', ...DPKG_OPTS, 'install', ...list], { env: APT_ENV });
  },

  async 'pkg.remove'({ names, purge }) {
    const list = pkgNames(names);
    const sim = await run('apt-get', ['-s', purge ? 'purge' : 'remove', ...list], { timeout: 40_000, env: APT_ENV });
    if (sim.code !== 0) throw fail(`Entfernen nicht möglich: ${(sim.err || sim.out).trim().slice(0, 300)}`);
    const extra = sim.out.split('\n').filter((l) => /^(Remv|Purg) /.test(l)).map((l) => l.split(' ')[1]).filter((n) => !list.includes(n));
    if (extra.length) throw fail(`Dadurch würden weitere Pakete entfernt: ${extra.slice(0, 15).join(', ')}${extra.length > 15 ? ' …' : ''}. Das ist hier aus Sicherheitsgründen gesperrt.`);
    return jobs.start('apt-remove', `Entfernen: ${list.join(', ')}`, 'apt-get', ['-y', purge ? 'purge' : 'remove', ...list], { env: APT_ENV });
  },

  async 'pkg.hold'({ name, on }) {
    const [n] = pkgNames([name]);
    const r = await run('apt-mark', [on ? 'hold' : 'unhold', n], { timeout: 20_000 });
    if (r.code !== 0) throw fail(`apt-mark: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { name: n, held: !!on };
  },
};

module.exports = { ops };
