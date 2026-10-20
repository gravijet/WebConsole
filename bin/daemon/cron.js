'use strict';
// Scheduled work: cron (system + user crontabs, periodic directories) and systemd timers.

const fs = require('fs');
const path = require('path');
const { run, fail, USER_RE } = require('./core');

const MACROS = new Set(['@reboot', '@yearly', '@annually', '@monthly', '@weekly', '@daily', '@midnight', '@hourly']);

function parseCron(text, { source, user, withUser }) {
  const out = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      // a commented-out job is still useful to show (disabled)
      const un = line.replace(/^#+\s*/, '');
      const dis = parseLine(un, withUser);
      if (dis && /^[\d*@]/.test(un)) out.push({ source, user: dis.user || user, schedule: dis.schedule, command: dis.command, line: i + 1, disabled: true });
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(line)) return; // environment variable
    const p = parseLine(line, withUser);
    if (p) out.push({ source, user: p.user || user, schedule: p.schedule, command: p.command, line: i + 1, disabled: false });
  });
  return out;
}

function parseLine(line, withUser) {
  const t = line.split(/\s+/);
  let schedule; let rest;
  if (MACROS.has(t[0])) { schedule = t[0]; rest = t.slice(1); } else if (t.length >= 6 && t.slice(0, 5).every((x) => /^[\d*/,\-A-Za-z?LW#]+$/.test(x))) { schedule = t.slice(0, 5).join(' '); rest = t.slice(5); } else return null;
  if (withUser) { const user = rest.shift(); if (!user || !rest.length) return null; return { schedule, user, command: rest.join(' ') }; }
  return rest.length ? { schedule, command: rest.join(' ') } : null;
}

const ops = {
  async 'cron.overview'() {
    const jobsList = [];
    const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
    const sys = read('/etc/crontab');
    if (sys) jobsList.push(...parseCron(sys, { source: '/etc/crontab', withUser: true }).map((j) => ({ ...j, file: '/etc/crontab' })));
    try {
      for (const f of fs.readdirSync('/etc/cron.d').sort()) {
        if (f.startsWith('.') || f.endsWith('.dpkg-old') || f.endsWith('.dpkg-dist')) continue;
        const t = read(path.join('/etc/cron.d', f));
        if (t) jobsList.push(...parseCron(t, { source: `/etc/cron.d/${f}`, withUser: true }).map((j) => ({ ...j, file: `/etc/cron.d/${f}` })));
      }
    } catch {}
    const userTabs = [];
    for (const dir of ['/var/spool/cron/crontabs', '/var/spool/cron']) {
      try {
        for (const f of fs.readdirSync(dir)) {
          const p = path.join(dir, f);
          if (!fs.statSync(p).isFile()) continue;
          const t = read(p);
          if (t == null) continue;
          userTabs.push(f);
          jobsList.push(...parseCron(t, { source: `crontab von ${f}`, user: f, withUser: false }).map((j) => ({ ...j, file: p, userTab: f })));
        }
      } catch {}
    }
    const periodic = {};
    for (const k of ['hourly', 'daily', 'weekly', 'monthly']) {
      try { periodic[k] = fs.readdirSync(`/etc/cron.${k}`).filter((x) => !x.startsWith('.')).sort().map((n) => ({ name: n, path: `/etc/cron.${k}/${n}` })); } catch { periodic[k] = []; }
    }
    const tm = await run('systemctl', ['list-timers', '--all', '--output=json', '--no-pager'], { timeout: 15_000 });
    let timers = [];
    try { timers = JSON.parse(tm.out); } catch {}
    const units = timers.map((t) => t.unit).filter((u) => /^[A-Za-z0-9:_.@\\-]+$/.test(u));
    const info = new Map();
    if (units.length) {
      const sh = await run('systemctl', ['show', '-p', 'Id,Description,UnitFileState,ActiveState,OnCalendar,TimersCalendar,TimersMonotonic,Persistent,Result', '--', ...units], { timeout: 15_000 });
      for (const block of sh.out.split(/\n\n/)) {
        const kv = Object.fromEntries(block.split('\n').filter(Boolean).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
        if (kv.Id) info.set(kv.Id, kv);
      }
    }
    return {
      cron: jobsList, userTabs, periodic,
      timers: timers.map((t) => {
        const i = info.get(t.unit) || {};
        const sched = i.TimersCalendar ? i.TimersCalendar.replace(/\{\s*OnCalendar=([^;]*?)\s*;[^}]*\}/g, '$1').trim() : i.TimersMonotonic ? i.TimersMonotonic.replace(/\{\s*([^;]*?)\s*;[^}]*\}/g, '$1').trim() : '';
        return { unit: t.unit, activates: t.activates, next: t.next ? Math.floor(t.next / 1000) : null, last: t.last ? Math.floor(t.last / 1000) : null, description: i.Description || '', enabled: i.UnitFileState || '', active: i.ActiveState || '', schedule: sched, persistent: i.Persistent === 'yes' };
      }),
    };
  },

  async 'cron.user-get'({ user }) {
    if (typeof user !== 'string' || !USER_RE.test(user)) throw fail('Ungültiger Benutzer.');
    const r = await run('crontab', ['-u', user, '-l'], { timeout: 10_000 });
    return { user, text: r.code === 0 ? r.out : '', empty: r.code !== 0 };
  },

  async 'cron.user-set'({ user, text }) {
    if (typeof user !== 'string' || !USER_RE.test(user)) throw fail('Ungültiger Benutzer.');
    if (typeof text !== 'string' || text.length > 100_000 || text.includes('\0')) throw fail('Ungültiger Inhalt.');
    if (!require('fs').readFileSync('/etc/passwd', 'utf8').split('\n').some((l) => l.startsWith(`${user}:`))) throw fail('Dieser Benutzer existiert nicht.');
    const body = text.endsWith('\n') || !text ? text : `${text}\n`;
    if (!body.trim()) { await run('crontab', ['-u', user, '-r'], { timeout: 10_000 }); return { user, removed: true }; }
    const r = await run('crontab', ['-u', user, '-'], { timeout: 10_000, input: body });
    if (r.code !== 0) throw fail(`crontab hat die Datei abgelehnt:\n${(r.err || r.out).trim().slice(0, 400)}`);
    return { user };
  },
};

module.exports = { ops };
