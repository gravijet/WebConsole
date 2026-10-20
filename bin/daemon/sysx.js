'use strict';
// More system information and tools: systemd timers, boot analysis, swap, internet speed test.

const fs = require('fs');
const path = require('path');
const { run, fail, int, clip } = require('./core');

const BACKUPS = '/var/backups/server-dash';
const SWAP_RE = /^\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+){0,5}$/;

async function swapList() {
  const r = await run('swapon', ['--show=NAME,TYPE,SIZE,USED,PRIO', '--bytes', '--noheadings', '--raw'], { timeout: 10_000 });
  return r.out.split('\n').filter(Boolean).map((l) => { const p = l.split(' '); return { name: p[0], type: p[1], size: +p[2], used: +p[3], prio: +p[4] }; });
}

const speedUrl = 'https://speed.cloudflare.com';

const ops = {
  async 'sys.timers'() {
    const r = await run('systemctl', ['list-timers', '--all', '--output=json', '--no-pager'], { timeout: 15_000 });
    let list = [];
    try { list = JSON.parse(r.out || '[]'); } catch { throw fail('Die Zeitgeber ließen sich nicht lesen.'); }
    const names = list.map((t) => t.unit).filter(Boolean);
    const info = names.length ? await run('systemctl', ['show', '--property=Id,Description,UnitFileState,ActiveState', ...names], { timeout: 15_000 }) : { out: '' };
    const meta = new Map();
    for (const block of info.out.split('\n\n')) {
      const o = Object.fromEntries(block.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
      if (o.Id) meta.set(o.Id, o);
    }
    return {
      timers: list.map((t) => {
        const m = meta.get(t.unit) || {};
        return { unit: t.unit, activates: t.activates, next: t.next ? Math.round(t.next / 1000) : null, last: t.last ? Math.round(t.last / 1000) : null, description: m.Description || '', enabled: m.UnitFileState || '', active: m.ActiveState || '' };
      }).sort((a, b) => (a.next || Infinity) - (b.next || Infinity)),
    };
  },

  async 'sys.analyze'() {
    const [total, blame, chain] = await Promise.all([
      run('systemd-analyze', ['time'], { timeout: 20_000, env: { LC_ALL: 'C' } }),
      run('systemd-analyze', ['blame', '--no-pager'], { timeout: 20_000, env: { LC_ALL: 'C' } }),
      run('systemd-analyze', ['critical-chain', '--no-pager'], { timeout: 20_000, env: { LC_ALL: 'C' } }),
    ]);
    const toSec = (s) => { let v = 0; for (const m of s.matchAll(/(\d+(?:\.\d+)?)(min|ms|us|s)/g)) v += +m[1] * ({ min: 60, s: 1, ms: 0.001, us: 0.000001 }[m[2]]); return v; };
    const units = blame.out.split('\n').filter(Boolean).map((l) => { const m = /^\s*(\S.*?)\s+(\S+\.(?:service|mount|device|socket|target|timer))$/.exec(l); return m ? { unit: m[2], seconds: toSec(m[1]) } : null; }).filter(Boolean);
    return { summary: total.out.trim(), units: units.slice(0, 40), chain: clip(chain.out.trim(), 6000) };
  },

  async 'sys.swap'() {
    let swappiness = null;
    try { swappiness = +fs.readFileSync('/proc/sys/vm/swappiness', 'utf8'); } catch {}
    let fstab = [];
    try { fstab = fs.readFileSync('/etc/fstab', 'utf8').split('\n').filter((l) => /^\s*[^#\s]+\s+\S+\s+swap\s/.test(l)).map((l) => l.trim().split(/\s+/)[0]); } catch {}
    const mem = {};
    try { for (const l of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) { const m = /^(SwapTotal|SwapFree|SwapCached):\s+(\d+)/.exec(l); if (m) mem[m[1]] = +m[2] * 1024; } } catch {}
    const df = await run('df', ['-B1', '--output=avail', '/'], { timeout: 10_000 });
    return { devices: (await swapList()).map((d) => ({ ...d, inFstab: fstab.includes(d.name) })), swappiness, mem, rootFree: +(df.out.trim().split('\n')[1] || 0) || null };
  },

  async 'sys.swap-create'({ path: p, sizeMb }) {
    if (typeof p !== 'string' || !SWAP_RE.test(p) || p.includes('..')) throw fail('Der Pfad darf nur Buchstaben, Ziffern, Punkt, Minus und Unterstrich enthalten, z. B. /swapfile2.');
    const mb = int(sizeMb, 64, 262144, 'Die Größe (in MB)');
    if (/^\/(proc|sys|dev|run|boot|etc|usr|bin|sbin|lib)(\/|$)/.test(p)) throw fail('An dieser Stelle darf keine Auslagerungsdatei liegen.');
    if (fs.existsSync(p)) throw fail('Diese Datei gibt es schon.');
    if (!fs.existsSync(path.dirname(p))) throw fail('Der Ordner existiert nicht.');
    const df = await run('df', ['-B1', '--output=avail', path.dirname(p)], { timeout: 10_000 });
    const free = +(df.out.trim().split('\n')[1] || 0);
    if (free && mb * 1048576 > free - 2 * 1024 ** 3) throw fail('Dafür ist nicht genug freier Platz da (2 GB bleiben immer frei).');
    const steps = [['fallocate', ['-l', `${mb}M`, p]], ['chmod', ['600', p]], ['mkswap', [p]], ['swapon', [p]]];
    for (const [cmd, args] of steps) {
      const r = await run(cmd, args, { timeout: 120_000 });
      if (r.code !== 0) { try { fs.unlinkSync(p); } catch {} throw fail(`${cmd} ist fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 300)}`); }
    }
    fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
    try { fs.copyFileSync('/etc/fstab', path.join(BACKUPS, `${Date.now()}__%2Fetc%2Ffstab`)); } catch {}
    fs.appendFileSync('/etc/fstab', `${p} none swap sw 0 0\n`);
    return { path: p, sizeMb: mb };
  },

  async 'sys.swap-remove'({ path: p }) {
    if (typeof p !== 'string' || !SWAP_RE.test(p)) throw fail('Ungültiger Pfad.');
    const dev = (await swapList()).find((d) => d.name === p);
    if (!dev) throw fail('Das ist keine aktive Auslagerung.');
    if (dev.type !== 'file') throw fail('Nur Auslagerungsdateien lassen sich hier entfernen, keine Partitionen.');
    // swapoff has to pull everything back into RAM; refuse when that would push the machine into the OOM killer
    let avail = 0;
    try { avail = +/^MemAvailable:\s+(\d+)/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1] * 1024; } catch {}
    if (dev.used > Math.max(0, avail - 1024 ** 3)) throw fail(`Zu wenig freier Arbeitsspeicher: ${Math.round(dev.used / 1048576)} MB müssten aus dem Swap zurück in den RAM, verfügbar sind nur ${Math.round(avail / 1048576)} MB (1 GB bleibt als Reserve).`);
    const r = await run('swapoff', [p], { timeout: 180_000 });
    if (r.code !== 0) throw fail(`swapoff ist fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 300)}`);
    try {
      const old = fs.readFileSync('/etc/fstab', 'utf8');
      fs.mkdirSync(BACKUPS, { recursive: true, mode: 0o700 });
      fs.copyFileSync('/etc/fstab', path.join(BACKUPS, `${Date.now()}__%2Fetc%2Ffstab`));
      fs.writeFileSync('/etc/fstab', old.split('\n').filter((l) => l.trim().split(/\s+/)[0] !== p).join('\n'));
    } catch {}
    try { fs.unlinkSync(p); } catch {}
    return { removed: p };
  },

  /** download, upload and latency to Cloudflare's speed endpoint */
  async 'net.speedtest'({ part }) {
    if (part === 'latency') {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const r = await run('curl', ['-s', '-o', '/dev/null', '-w', '%{time_connect}', '--max-time', '8', `${speedUrl}/__down?bytes=0`], { timeout: 12_000 });
        if (r.code === 0 && +r.out > 0) times.push(+r.out * 1000);
      }
      if (!times.length) throw fail('Keine Verbindung zum Testserver.');
      times.sort((a, b) => a - b);
      return { latency: times[Math.floor(times.length / 2)], jitter: times[times.length - 1] - times[0] };
    }
    // several parallel streams fill a fast line better than one; Cloudflare refuses single requests above ~25 MB
    if (part === 'down') {
      const t0 = Date.now();
      const rs = await Promise.all([1, 2, 3, 4].map(() => run('curl', ['-s', '-o', '/dev/null', '-w', '%{size_download} %{http_code}', '--max-time', '25', `${speedUrl}/__down?bytes=25000000`], { timeout: 30_000 })));
      const secs = (Date.now() - t0) / 1000;
      const bytes = rs.reduce((s, r) => { const [n, code] = r.out.trim().split(' '); return s + (code === '200' ? +n : 0); }, 0);
      if (!bytes) throw fail('Der Download-Test ist fehlgeschlagen.');
      return { mbit: (bytes * 8) / 1e6 / secs, bytes, seconds: secs };
    }
    if (part === 'up') {
      const t0 = Date.now();
      const rs = await Promise.all([1, 2, 3].map(() => run('/bin/sh', ['-c', `head -c 15000000 /dev/zero | curl -s -o /dev/null -w '%{size_upload} %{http_code}' --max-time 25 -X POST --data-binary @- -H 'Content-Type: application/octet-stream' ${speedUrl}/__up`], { timeout: 32_000 })));
      const secs = (Date.now() - t0) / 1000;
      const bytes = rs.reduce((s, r) => { const [n, code] = r.out.trim().split(' '); return s + (code === '200' ? +n : 0); }, 0);
      if (!bytes) throw fail('Der Upload-Test ist fehlgeschlagen.');
      return { mbit: (bytes * 8) / 1e6 / secs, bytes, seconds: secs };
    }
    throw fail('Unbekannter Testteil.');
  },
};

module.exports = { ops };
