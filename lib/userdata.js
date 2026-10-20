'use strict';
// The owner's own data inside the dashboard: notes (a maintenance journal), saved console commands
// and favourite views. Limits keep the file small; everything is validated on the way in.

const crypto = require('crypto');

const FILE = 'userdata.json';
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const id = () => crypto.randomBytes(5).toString('hex');

function notes(list) {
  if (!Array.isArray(list) || list.length > 150) throw new Error('Höchstens 150 Notizen.');
  return list.map((n) => {
    const nid = typeof n.id === 'string' && /^[a-f0-9]{10}$/.test(n.id) ? n.id : id();
    return {
      id: nid, title: str(n.title, 120).trim() || 'Ohne Titel', body: str(n.body, 20_000),
      pinned: !!n.pinned, tag: ['', 'blau', 'grün', 'gelb', 'rot'].includes(n.tag) ? n.tag : '',
      created: Number.isFinite(n.created) ? n.created : Date.now(), updated: Number.isFinite(n.updated) ? n.updated : Date.now(),
    };
  });
}

function snippets(list) {
  if (!Array.isArray(list) || list.length > 100) throw new Error('Höchstens 100 gespeicherte Befehle.');
  return list.map((s) => {
    const cmd = str(s.cmd, 8000);
    if (!cmd.trim()) throw new Error('Ein gespeicherter Befehl ist leer.');
    return { id: typeof s.id === 'string' && /^[a-f0-9]{10}$/.test(s.id) ? s.id : id(), name: str(s.name, 60).trim() || cmd.split('\n')[0].slice(0, 40), cmd, user: /^[a-z_][a-z0-9_-]{0,31}$/.test(s.user) ? s.user : 'root', cwd: typeof s.cwd === 'string' && s.cwd.startsWith('/') ? s.cwd.slice(0, 300) : '' };
  });
}

class UserData {
  constructor(store, viewIds = () => null) {
    this.store = store;
    this.viewIds = viewIds;
    this.d = store.load(FILE, { notes: [], snippets: [], favorites: [] });
    for (const k of ['notes', 'snippets', 'favorites']) if (!Array.isArray(this.d[k])) this.d[k] = [];
  }

  get() { return this.d; }

  update(patch) {
    const next = { ...this.d };
    if ('notes' in patch) next.notes = notes(patch.notes);
    if ('snippets' in patch) next.snippets = snippets(patch.snippets);
    if ('favorites' in patch) {
      if (!Array.isArray(patch.favorites) || patch.favorites.length > 30) throw new Error('Höchstens 30 Favoriten.');
      next.favorites = [...new Set(patch.favorites.filter((f) => typeof f === 'string' && /^[a-z0-9-]{1,30}$/.test(f)))];
    }
    this.d = next;
    this.store.save(FILE, next);
    return next;
  }
}

module.exports = { UserData };
