'use strict';
// Self-healing: restart a service or container that went down, with a delay, a per-hour limit and
// respect for things you stopped on purpose. Rules and the log live in the state directory.

const actions = require('./actions');

const FILE = 'heal.json';
const UNIT_RE = /^[A-Za-z0-9:_.@\\-]{1,120}\.service$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const clamp = (v, min, max, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };

class Healer {
  constructor({ store, events, collector }) {
    this.store = store;
    this.events = events;
    this.collector = collector;
    const d = store.load(FILE, { enabled: false, rules: [], log: [] });
    this.enabled = !!d.enabled;
    this.rules = Array.isArray(d.rules) ? d.rules : [];
    this.log = Array.isArray(d.log) ? d.log.slice(0, 100) : [];
    this.badSince = new Map();   // rule id -> time the target was first seen down
    this.tries = new Map();      // rule id -> timestamps of restarts in the last hour
    this.suppressed = new Map(); // target name -> until (you stopped it yourself)
    this.gaveUp = new Set();
    this.wasUp = new Set();      // units seen active since the dashboard started (a unit that never ran is not "down")
    this.busy = false;
    setInterval(() => this.tick().catch((e) => console.error('heal:', e.message)), 10_000).unref();
  }

  save() { this.store.save(FILE, { enabled: this.enabled, rules: this.rules, log: this.log }); }
  view() { return { enabled: this.enabled, rules: this.rules.map((r) => ({ ...r, ...this.status(r) })), log: this.log }; }

  status(r) {
    const s = this.state(r);
    return { state: s ? s.label : 'unbekannt', down: s ? s.down : false, restartsLastHour: (this.tries.get(r.id) || []).filter((t) => Date.now() - t < 3_600_000).length, gaveUp: this.gaveUp.has(r.id), paused: (this.suppressed.get(r.name) || 0) > Date.now() };
  }

  replace({ enabled, rules }) {
    if (!Array.isArray(rules) || rules.length > 60) throw new Error('Höchstens 60 Regeln.');
    const seen = new Set();
    const next = rules.map((r) => {
      if (!r || !['unit', 'container'].includes(r.kind)) throw new Error('Unbekannte Regelart.');
      const name = typeof r.name === 'string' ? r.name.trim() : '';
      if (!(r.kind === 'unit' ? UNIT_RE.test(name) : NAME_RE.test(name))) throw new Error(`Ungültiger Name: ${name.slice(0, 60)}`);
      if (r.kind === 'unit' && actions.CRITICAL_UNITS.has(name) && ['ssh.service', 'sshd.service', 'server-dash.service', 'docker.service'].includes(name)) throw new Error(`${name} kann nicht automatisch neu gestartet werden, weil ein Fehler dabei den Zugang zum Server kosten könnte.`);
      const key = `${r.kind}:${name}`;
      if (seen.has(key)) throw new Error(`Doppelte Regel für ${name}.`);
      seen.add(key);
      const old = this.rules.find((x) => x.kind === r.kind && x.name === name);
      return { id: old ? old.id : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind: r.kind, name, enabled: r.enabled !== false, delay: clamp(r.delay, 5, 900, 30), perHour: clamp(r.perHour, 1, 30, 3), unhealthy: r.kind === 'container' ? r.unhealthy !== false : false };
    });
    this.enabled = !!enabled;
    this.rules = next;
    for (const id of [...this.badSince.keys()]) if (!next.some((r) => r.id === id)) this.badSince.delete(id);
    this.gaveUp.clear();
    this.save();
  }

  /** the dashboard calls this after you stopped something on purpose */
  suppress(name, ms = 30 * 60_000) { this.suppressed.set(name, Date.now() + ms); }
  release(name) { this.suppressed.delete(name); }

  state(r) {
    if (r.kind === 'unit') {
      const u = (this.collector.services.list || []).find((x) => x.id === r.name);
      // systemd unloads a stopped service from its list, so "gone after it was running" means it stopped
      if (!u) return this.wasUp.has(r.name) ? { label: 'gestoppt', down: true } : { label: 'nicht gefunden', down: false };
      if (u.active === 'failed') return { label: 'fehlgeschlagen', down: true };
      if (u.active === 'inactive' && this.wasUp.has(r.name)) return { label: 'gestoppt', down: true };
      if (u.active === 'active') this.wasUp.add(r.name);
      return { label: `${u.active}/${u.sub}`, down: false };
    }
    const d = this.collector.state.docker;
    if (!d || !d.ok || d.stale) return null;
    const c = d.containers.find((x) => x.name === r.name);
    if (!c) return { label: 'nicht gefunden', down: false };
    if (['exited', 'dead'].includes(c.state)) return { label: c.state === 'dead' ? 'tot' : `beendet (${c.exitCode ?? '?'})`, down: true };
    if (r.unhealthy && c.health === 'unhealthy') return { label: 'unhealthy', down: true, restart: true };
    return { label: c.status || c.state, down: false };
  }

  async tick() {
    if (!this.enabled || this.busy) return;
    this.busy = true;
    try {
      const now = Date.now();
      for (const r of this.rules) {
        if (!r.enabled) continue;
        const s = this.state(r);
        if (!s) continue;
        if (!s.down) {
          if (this.badSince.has(r.id)) { this.badSince.delete(r.id); this.gaveUp.delete(r.id); }
          continue;
        }
        if ((this.suppressed.get(r.name) || 0) > now) continue;
        if (!this.badSince.has(r.id)) { this.badSince.set(r.id, now); continue; }
        if (now - this.badSince.get(r.id) < r.delay * 1000) continue;
        const tries = (this.tries.get(r.id) || []).filter((t) => now - t < 3_600_000);
        if (tries.length >= r.perHour) {
          if (!this.gaveUp.has(r.id)) {
            this.gaveUp.add(r.id);
            this.record(r, false, `Aufgegeben: schon ${tries.length} Neustarts in der letzten Stunde`);
            this.events.add({ level: 'crit', kind: 'heal', title: `Selbstheilung gibt bei ${r.name} auf`, detail: `${tries.length} Neustarts in der letzten Stunde haben nicht geholfen. Bitte selbst nachsehen.` });
          }
          continue;
        }
        tries.push(now);
        this.tries.set(r.id, tries);
        this.badSince.set(r.id, now); // wait the delay again before the next attempt
        try {
          if (r.kind === 'unit') await actions.call('unit.control', { unit: r.name, action: 'restart' }, 60_000);
          else await actions.call('docker.control', { name: r.name, action: s.restart ? 'restart' : 'start' }, 60_000);
          this.record(r, true, `${s.label} → Neustart (${tries.length}/${r.perHour} in dieser Stunde)`);
          this.events.add({ level: 'warn', kind: 'heal', title: `Selbstheilung: ${r.name} wurde neu gestartet`, detail: `Zustand war „${s.label}“. Versuch ${tries.length} von ${r.perHour} pro Stunde.` });
        } catch (e) {
          this.record(r, false, e.message.slice(0, 160));
          this.events.add({ level: 'warn', kind: 'heal', title: `Selbstheilung: Neustart von ${r.name} fehlgeschlagen`, detail: e.message.slice(0, 200) });
        }
      }
    } finally { this.busy = false; }
  }

  record(r, ok, text) {
    this.log.unshift({ t: Date.now(), name: r.name, kind: r.kind, ok, text });
    if (this.log.length > 100) this.log.length = 100;
    this.save();
  }
}

module.exports = { Healer };
