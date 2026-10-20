'use strict';
// Firewall (ufw), fail2ban, SSH login activity.

const fs = require('fs');
const { run, clip, fail, isIp, isCidr, int } = require('./core');

const PROTECTED_PORTS = new Set([22, 80, 443]);

async function ufwStatus() {
  const r = await run('ufw', ['status', 'numbered'], { timeout: 15_000 });
  const v = await run('ufw', ['status', 'verbose'], { timeout: 15_000 });
  const text = r.out;
  const active = /Status:\s+active/i.test(text);
  const rules = [];
  for (const l of text.split('\n')) {
    const m = /^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)(?: (IN|OUT|FWD))?\s+(.+?)\s*$/.exec(l);
    if (m) rules.push({ n: +m[1], to: m[2].trim(), action: m[3], dir: m[4] || 'IN', from: m[5].replace(/\s+#.*$/, '').trim(), comment: (/#\s*(.*)$/.exec(l) || [])[1] || '', raw: l.trim() });
  }
  const defaults = (/Default:\s*(.*)/.exec(v.out) || [])[1] || '';
  const logging = (/Logging:\s*(.*)/.exec(v.out) || [])[1] || '';
  return { active, rules, defaults, logging, error: r.code !== 0 ? (r.err || r.out).trim().slice(0, 200) : '' };
}

async function f2b() {
  const st = await run('fail2ban-client', ['status'], { timeout: 15_000 });
  if (st.code !== 0) return { available: false, error: (st.err || st.out).trim().slice(0, 200), jails: [] };
  const names = ((/Jail list:\s*(.*)/.exec(st.out) || [])[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
  const jails = [];
  for (const n of names) {
    const r = await run('fail2ban-client', ['status', n], { timeout: 15_000 });
    const g = (re) => (re.exec(r.out) || [])[1];
    jails.push({
      name: n, currentFailed: +g(/Currently failed:\s*(\d+)/) || 0, totalFailed: +g(/Total failed:\s*(\d+)/) || 0, currentBanned: +g(/Currently banned:\s*(\d+)/) || 0, totalBanned: +g(/Total banned:\s*(\d+)/) || 0,
      banned: (g(/Banned IP list:\s*(.*)/) || '').split(/\s+/).filter(Boolean), file: (g(/File list:\s*(.*)/) || '').trim(),
    });
  }
  return { available: true, jails };
}

const ops = {
  async 'fw.overview'() {
    const ufw = await ufwStatus();
    const [ipt, nft] = await Promise.all([run('iptables', ['-S'], { timeout: 10_000 }), run('nft', ['list', 'tables'], { timeout: 10_000 })]);
    const policies = ipt.out.split('\n').filter((l) => l.startsWith('-P ')).map((l) => l.slice(3));
    return { ufw, iptables: { rules: ipt.out.split('\n').filter((l) => l.startsWith('-A ')).length, policies }, nft: nft.out.split('\n').filter(Boolean), f2b: await f2b() };
  },

  async 'fw.iptables'() {
    const r = await run('iptables', ['-S'], { timeout: 10_000 });
    return { text: clip(r.out + r.err, 200_000) };
  },

  async 'fw.ufw-add'({ action, port, proto, from, comment }) {
    if (!['allow', 'deny', 'reject', 'limit'].includes(action)) throw fail('Ungültige Aktion.');
    const prt = String(port || '');
    if (!/^\d{1,5}(:\d{1,5})?$/.test(prt)) throw fail('Ungültiger Port (z. B. 8080 oder 6000:6010).');
    const [a, b] = prt.split(':').map(Number);
    int(a, 1, 65535, 'Der Port'); if (b !== undefined) int(b, a, 65535, 'Der Port');
    if (b !== undefined && b - a > 5000) throw fail('Der Portbereich ist zu groß.');
    if (!['tcp', 'udp', 'any'].includes(proto || 'any')) throw fail('Ungültiges Protokoll.');
    if (from && from !== 'any' && !isCidr(from)) throw fail('Ungültige Quelladresse (IP oder CIDR).');
    const closing = action !== 'allow';
    if (closing && (!from || from === 'any') && [...PROTECTED_PORTS].some((p) => p >= a && p <= (b ?? a))) throw fail('Zugriffe auf SSH (22), HTTP (80) und HTTPS (443) lassen sich hier nicht für alle sperren. Das würde dich aussperren.');
    const args = [action];
    args.push('from', from && from !== 'any' ? from : 'any', 'to', 'any', 'port', prt);
    if (proto && proto !== 'any') args.push('proto', proto);
    if (comment) { if (typeof comment !== 'string' || comment.length > 60 || /[^\w .,:@äöüÄÖÜß-]/.test(comment)) throw fail('Ungültiger Kommentar.'); args.push('comment', comment); }
    const r = await run('ufw', args, { timeout: 30_000 });
    if (r.code !== 0) throw fail(`ufw: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { text: r.out.trim() };
  },

  async 'fw.ufw-delete'({ number, expect }) {
    int(number, 1, 2000, 'Die Regelnummer');
    const cur = (await ufwStatus()).rules.find((r) => r.n === number);
    if (!cur) throw fail('Diese Regel existiert nicht mehr. Liste neu laden.');
    if (typeof expect === 'string' && expect && expect !== cur.raw) throw fail('Die Regelnummern haben sich geändert. Liste neu laden.');
    const r = await run('ufw', ['--force', 'delete', String(number)], { timeout: 30_000 });
    if (r.code !== 0) throw fail(`ufw: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { text: r.out.trim() };
  },

  async 'fw.ufw-enable'({ on }) {
    const r = await run('ufw', ['--force', on ? 'enable' : 'disable'], { timeout: 30_000 });
    if (r.code !== 0) throw fail(`ufw: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { on: !!on };
  },

  async 'f2b.ban'({ jail, ip }) {
    if (typeof jail !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(jail)) throw fail('Ungültiger Jail-Name.');
    if (!isIp(ip)) throw fail('Ungültige IP-Adresse.');
    const r = await run('fail2ban-client', ['set', jail, 'banip', ip], { timeout: 20_000 });
    if (r.code !== 0) throw fail(`fail2ban: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { jail, ip };
  },
  async 'f2b.unban'({ jail, ip }) {
    if (typeof jail !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(jail)) throw fail('Ungültiger Jail-Name.');
    if (!isIp(ip)) throw fail('Ungültige IP-Adresse.');
    const r = await run('fail2ban-client', ['set', jail, 'unbanip', ip], { timeout: 20_000 });
    if (r.code !== 0) throw fail(`fail2ban: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { jail, ip };
  },

  /** SSH activity from the journal: failed attempts per IP / user, hourly histogram, recent successes */
  async 'auth.ssh'({ hours }) {
    const h = int(hours || 24, 1, 720, 'Der Zeitraum');
    const r = await run('journalctl', ['-u', 'ssh', '-u', 'sshd', '--since', `-${h}h`, '--no-pager', '-o', 'short-unix', '-g', 'Failed|Invalid user|Accepted'], { timeout: 40_000, max: 64 << 20 });
    const byIp = new Map(); const byUser = new Map(); const hourly = new Map(); const ok = [];
    let failed = 0;
    for (const line of r.out.split('\n')) {
      const t = /^(\d+)\.\d+\s/.exec(line);
      if (!t) continue;
      const ts = +t[1] * 1000;
      // "Failed ... for invalid user" duplicates the "Invalid user" line sshd logs just before it: count only one of them
      let m = /Failed (?:password|publickey|keyboard-interactive\/pam) for (?!invalid user )(\S+) from (\S+)/.exec(line) || /Invalid user (\S*) from (\S+)/.exec(line);
      if (m) {
        failed++;
        const [, user, ip] = m;
        const e = byIp.get(ip) || { ip, count: 0, users: new Set(), last: 0 };
        e.count++; e.users.add(user); e.last = Math.max(e.last, ts); byIp.set(ip, e);
        byUser.set(user, (byUser.get(user) || 0) + 1);
        const hk = Math.floor(ts / 3_600_000) * 3_600_000; hourly.set(hk, (hourly.get(hk) || 0) + 1);
        continue;
      }
      m = /Accepted (\S+) for (\S+) from (\S+)/.exec(line);
      if (m) ok.push({ t: ts, method: m[1], user: m[2], ip: m[3] });
    }
    return {
      hours: h, failed,
      ips: [...byIp.values()].sort((a, b) => b.count - a.count).slice(0, 60).map((e) => ({ ip: e.ip, count: e.count, last: e.last, users: [...e.users].slice(0, 6) })),
      users: [...byUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([user, count]) => ({ user, count })),
      hourly: [...hourly.entries()].sort((a, b) => a[0] - b[0]).map(([t, count]) => ({ t, count })),
      accepted: ok.sort((a, b) => b.t - a.t).slice(0, 60),
    };
  },


  /** facts for the security check: effective sshd settings, risky accounts, automatic updates */
  async 'sec.audit'() {
    const sshd = await run('sshd', ['-T'], { timeout: 15_000 });
    const cfg = {};
    for (const l of sshd.out.split('\n')) { const i = l.indexOf(' '); if (i > 0) cfg[l.slice(0, i)] = l.slice(i + 1); }
    const pick = ['port', 'permitrootlogin', 'passwordauthentication', 'pubkeyauthentication', 'permitemptypasswords', 'x11forwarding', 'maxauthtries', 'logingracetime', 'allowusers', 'allowgroups', 'kbdinteractiveauthentication', 'usepam', 'clientaliveinterval'];
    const emptyPw = []; const uid0 = [];
    try { for (const l of fs.readFileSync('/etc/shadow', 'utf8').split('\n')) { const p = l.split(':'); if (p[0] && p[1] === '') emptyPw.push(p[0]); } } catch {}
    try { for (const l of fs.readFileSync('/etc/passwd', 'utf8').split('\n')) { const p = l.split(':'); if (p[2] === '0') uid0.push(p[0]); } } catch {}
    const uu = await run('dpkg-query', ['-W', '-f', '${Status}', 'unattended-upgrades'], { timeout: 8000 });
    const timer = await run('systemctl', ['is-enabled', 'apt-daily-upgrade.timer'], { timeout: 8000 });
    return {
      sshd: Object.fromEntries(pick.filter((k) => cfg[k] !== undefined).map((k) => [k, cfg[k]])), sshdError: sshd.code !== 0 ? (sshd.err || '').trim().slice(0, 200) : '',
      emptyPasswords: emptyPw, uid0, unattended: /install ok installed/.test(uu.out), upgradeTimer: timer.out.trim(),
    };
  },

  async 'auth.last'() {
    const r = await run('last', ['-n', '80', '-F', '-w'], { timeout: 15_000, env: { TZ: 'UTC' } });
    const list = [];
    for (const l of r.out.split('\n')) {
      const m = /^(\S+)\s+(\S+)\s+(\S+)\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(?:-\s+(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})|still logged in|-\s+crash|-\s+down)?/.exec(l);
      if (!m || /^(reboot|wtmp|btmp)/.test(m[1]) && m[1] !== 'reboot') continue;
      const parse = (s) => (s ? Date.parse(`${s} UTC`) : null);
      list.push({ user: m[1], tty: m[2], from: m[3], start: parse(m[4]), end: parse(m[5]), active: /still logged in/.test(l), raw: l.trim() });
    }
    let btmp = null;
    try { btmp = fs.statSync('/var/log/btmp').size; } catch {}
    return { list, btmp };
  },
};

module.exports = { ops };
