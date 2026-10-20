import { store, RANGES, api } from './store.js';
import { h, $, $$, clear, setText, icon } from './dom.js';
import { refreshTheme } from './charts.js';
import { tHMS, dur } from './fmt.js';
import { unlockDialog, isUnlocked, unlockedLeft, setUnlocked, nginxReload, containerDetail, unitDetail, modal } from './interact.js';
import { VIEWS } from './views/index.js';
import { getTheme, cycleTheme, THEMES } from './themectl.js';

// ------------------------------------------------------------------ view context (auto cleanup)

function makeCtx() {
  const offs = [];
  const owned = [];
  return {
    store, api,
    on(type, fn, immediate = false) { offs.push(store.on(type, fn)); if (immediate) fn(); },
    own(x) { owned.push(x); return x; },
    every(fn, ms) { const id = setInterval(fn, ms); offs.push(() => clearInterval(id)); return id; },
    destroy() { for (const o of offs) o(); for (const x of owned) { try { x.destroy && x.destroy(); } catch {} } offs.length = 0; owned.length = 0; },
  };
}

// ------------------------------------------------------------------ shell

const app = $('#app');
let current = null;
let ctx = null;
const navLinks = new Map();
let favBox; let starBtn; let favorites = [];
let themeBtn; let titleEl; let crumbEl; let rangeBox; let viewEl; let liveEl; let pauseBtn; let lockEl;

function buildShell() {
  clear(app);
  const nav = h('nav', { class: 'nav', 'aria-label': 'Hauptnavigation' });
  favBox = h('div', { class: 'fav-box', hidden: '' });
  nav.append(favBox);
  let group = null;
  for (const v of VIEWS) {
    if (v.group !== group) { group = v.group; nav.append(h('div', { class: 'nav-h' }, group)); }
    const count = h('span', { class: 'count', hidden: '' });
    const a = h('a', { href: `#/${v.id}`, onClick: () => app.classList.remove('nav-open') }, icon(v.icon || 'overview', 18), h('span', null, v.title), count);
    navLinks.set(v.id, { a, count });
    nav.append(a);
  }
  const side = h('aside', { class: 'side', id: 'side' },
    h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('server', 20)), h('div', null, h('b', null, 'Xeon-1'), h('small', null, 'Server-Konsole'))),
    nav,
    h('div', { class: 'side-foot', id: 'side-foot' }));

  titleEl = h('h1', null, '');
  crumbEl = h('span', { class: 'crumb' });
  rangeBox = h('div', { class: 'seg', role: 'group', 'aria-label': 'Zeitraum' });
  for (const [k, r] of Object.entries(RANGES)) rangeBox.append(h('button', { type: 'button', 'aria-pressed': String(k === store.range), dataset: { r: k }, onClick: () => store.setRange(k) }, r.label));
  pauseBtn = h('button', { type: 'button', class: 'btn sm icon-only', title: 'Live-Anzeige anhalten (Leertaste)', 'aria-label': 'Live-Anzeige anhalten', onClick: () => store.togglePause() }, icon('pause', 15));
  liveEl = h('span', { class: 'live', role: 'status' }, h('i'), h('span', null, 'Verbinde …'));
  lockEl = h('button', { type: 'button', class: 'lock', hidden: '', title: 'Änderungen sind freigeschaltet. Klicken zum Sperren.', onClick: () => { setUnlocked(0); } });
  const unlockBtn = h('button', { type: 'button', class: 'btn sm', id: 'unlock-btn', title: 'Passwort bestätigen, um Änderungen am Server zu erlauben', onClick: () => unlockDialog() }, icon('lock', 14), 'Freischalten');
  const searchBtn = h('button', { type: 'button', class: 'btn sm', title: 'Schnell zu einer Ansicht springen', onClick: () => openPalette() }, icon('search', 14), 'Suchen', h('span', { class: 'kbd' }, 'Strg K'));
  starBtn = h('button', { type: 'button', class: 'btn sm icon-only ghost star-btn', title: 'Zu den Favoriten (oben in der Seitenleiste)', 'aria-label': 'Zu den Favoriten', 'aria-pressed': 'false', onClick: toggleFavorite }, icon('pin', 15));
  themeBtn = h('button', { type: 'button', class: 'btn sm icon-only', onClick: cycleTheme });
  syncTheme();
  const logout = h('button', { type: 'button', class: 'btn sm icon-only', title: 'Abmelden', 'aria-label': 'Abmelden', onClick: async () => { try { await api.post('/auth/logout'); } catch {} location.replace('/login'); } }, icon('logout', 15));
  const top = h('header', { class: 'top' },
    h('button', { type: 'button', class: 'btn sm icon-only menu-btn', 'aria-label': 'Menü', onClick: () => app.classList.toggle('nav-open') }, icon('menu', 18)),
    h('div', null, h('div', { class: 'row', style: { gap: '4px' } }, titleEl, starBtn), crumbEl),
    h('div', { class: 'top-r' }, rangeBox, pauseBtn, liveEl, lockEl, unlockBtn, searchBtn, themeBtn, logout));
  viewEl = h('main', { class: 'view', id: 'view', tabindex: '-1' });
  app.append(side, h('div', { class: 'scrim', onClick: () => app.classList.remove('nav-open') }), h('div', { class: 'main' }, top, viewEl));
}


// ------------------------------------------------------------------ favourites (stored on the server)

function renderFavs() {
  const list = favorites.map((id) => VIEWS.find((v) => v.id === id)).filter(Boolean);
  favBox.hidden = !list.length;
  favBox.replaceChildren(...(list.length ? [h('div', { class: 'nav-h' }, 'Favoriten'), ...list.map((v) => h('a', { href: `#/${v.id}`, dataset: { fav: v.id }, 'aria-current': current && current.id === v.id ? 'page' : null, onClick: () => app.classList.remove('nav-open') }, icon(v.icon || 'overview', 18), h('span', null, v.title)))] : []));
  if (starBtn && current) { const on = favorites.includes(current.id); starBtn.setAttribute('aria-pressed', String(on)); starBtn.title = on ? 'Aus den Favoriten entfernen' : 'Zu den Favoriten (oben in der Seitenleiste)'; }
}
async function toggleFavorite() {
  if (!current) return;
  const next = favorites.includes(current.id) ? favorites.filter((x) => x !== current.id) : [...favorites, current.id];
  const prev = favorites;
  favorites = next; renderFavs();
  try { await api.put('/api/userdata', { favorites: next }); } catch { favorites = prev; renderFavs(); }
}

// ------------------------------------------------------------------ command palette (Strg+K)

let servicesCache = null;
function openPalette() {
  if (document.querySelector('.cmdk')) return;
  const input = h('input', { type: 'text', placeholder: 'Wohin möchtest du? Oder was tun? (Docker, Notiz, nginx neu laden, Container …)', 'aria-label': 'Suchen', autocomplete: 'off', spellcheck: 'false' });
  const list = h('ul', { role: 'listbox' });
  const el = h('div', { class: 'cmdk' }, h('div', { class: 'cmdk-box' }, input, list));
  let sel = 0; let shown = [];
  const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
  const nav = (id) => () => { location.hash = `#/${id}`; };
  const ACTIONS = [
    { title: 'Darstellung wechseln (hell / dunkel / automatisch)', words: 'theme dunkel hell modus', ic: 'moon', run: cycleTheme },
    { title: 'Live-Anzeige anhalten oder fortsetzen', words: 'pause live', ic: 'pause', run: () => store.togglePause() },
    { title: 'Aktionen freischalten (Passwort)', words: 'passwort unlock entsperren', ic: 'unlock', run: () => unlockDialog() },
    { title: 'nginx neu laden', words: 'nginx reload', ic: 'refresh', run: () => nginxReload() },
    { title: 'Befehl auf dem Server ausführen', words: 'konsole terminal shell', ic: 'terminal', run: nav('console') },
    { title: 'Neue Notiz anlegen', words: 'notiz journal', ic: 'filetext', run: nav('notes') },
    { title: 'Jetzt eine Sicherung starten', words: 'backup sicherung', ic: 'archive', run: nav('backups') },
    { title: 'Neue App aus Vorlage starten', words: 'docker app vorlage', ic: 'box', run: nav('apps') },
    { title: 'Neue Website einrichten', words: 'nginx website domain proxy', ic: 'web', run: nav('nginx') },
    { title: 'Serverbericht erstellen', words: 'bericht report pdf', ic: 'filetext', run: nav('report') },
    { title: 'Tastenkürzel anzeigen', words: 'hilfe shortcuts kürzel', ic: 'info', run: () => shortcutsHelp() },
    { title: 'Abmelden', words: 'logout abmelden', ic: 'logout', run: async () => { try { await api.post('/auth/logout'); } catch {} location.replace('/login'); } },
  ];
  function entries(q) {
    const out = [];
    for (const v of VIEWS) if (!q || `${v.title} ${v.group} ${v.keywords || ''} ${v.desc || ''}`.toLowerCase().includes(q)) out.push({ ic: v.icon || 'overview', title: v.title, tag: v.group, run: () => { location.hash = `#/${v.id}`; } });
    for (const a of ACTIONS) if (q && `${a.title} ${a.words}`.toLowerCase().includes(q)) out.push({ ic: a.ic, title: a.title, tag: 'Aktion', cls: 'act', run: a.run });
    if (q.length >= 2) {
      const dk = (store.detail && store.detail.docker && store.detail.docker.containers) || [];
      for (const c of dk) if (c.name.toLowerCase().includes(q)) out.push({ ic: 'docker', title: `Container ${c.name}`, tag: c.state, run: () => containerDetail(c.name) });
      for (const u of (servicesCache || [])) if (u.id.toLowerCase().includes(q)) out.push({ ic: 'service', title: `Dienst ${u.id}`, tag: u.active, run: () => unitDetail(u.id) });
    }
    return out.slice(0, 40);
  }
  function paint() {
    const q = input.value.trim().toLowerCase();
    shown = entries(q);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((v, i) => h('li', { role: 'option', class: v.cls || '', 'aria-selected': String(i === sel), onClick: () => go(v), onPointerenter: () => { sel = i; mark(); } }, icon(v.ic, 18), v.title, h('small', null, v.tag))));
    if (!shown.length) list.replaceChildren(h('li', { class: 'muted' }, 'Nichts gefunden.'));
  }
  const go = (v) => { close(); v.run(); };
  function mark() { [...list.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === sel))); const c = list.children[sel]; if (c && c.scrollIntoView) c.scrollIntoView({ block: 'nearest' }); }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(shown.length - 1, sel + 1); mark(); } else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); } else if (e.key === 'Enter') { e.preventDefault(); if (shown[sel]) go(shown[sel]); }
  }
  input.addEventListener('input', () => { sel = 0; paint(); });
  el.addEventListener('pointerdown', (e) => { if (e.target === el) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(el);
  paint();
  input.focus();
  if (!servicesCache) api.get('/api/services').then((r) => { servicesCache = r.list; if (el.isConnected) paint(); }).catch(() => {});
}

const GO_KEYS = { o: 'overview', e: 'events', d: 'docker', a: 'apps', f: 'files', c: 'console', s: 'services', p: 'processes', n: 'nginx', w: 'web', b: 'backups', u: 'packages', l: 'logs', k: 'security', t: 'tools', y: 'system', m: 'memory', i: 'storage', z: 'notes', r: 'report' };
function shortcutsHelp() {
  modal({ title: 'Tastenkürzel', lead: 'Funktionieren, wenn kein Eingabefeld aktiv ist', body: h('div', { class: 'kbd-help' },
    h('span', null, h('kbd', null, 'Strg'), ' ', h('kbd', null, 'K')), h('span', null, 'Suche: Ansichten, Aktionen, Container, Dienste'),
    h('span', null, h('kbd', null, '/')), h('span', null, 'Suche öffnen'),
    h('span', null, h('kbd', null, 'Leertaste')), h('span', null, 'Live-Anzeige anhalten oder fortsetzen'),
    h('span', null, h('kbd', null, '?')), h('span', null, 'Diese Hilfe'),
    ...Object.entries(GO_KEYS).flatMap(([k, id]) => [h('span', null, h('kbd', null, 'g'), ' ', h('kbd', null, k)), h('span', null, `Gehe zu ${VIEWS.find((v) => v.id === id).title}`)])), buttons: [{ label: 'Schließen' }] });
}
let goPending = 0;

function route() {
  const id = (location.hash.replace(/^#\/?/, '') || (() => { try { return localStorage.getItem('sd.view'); } catch { return null; } })() || 'overview').split('?')[0];
  const v = VIEWS.find((x) => x.id === id) || VIEWS[0];
  if (current === v) return;
  if (ctx) ctx.destroy();
  current = v;
  try { localStorage.setItem('sd.view', v.id); } catch {}
  for (const [k, { a }] of navLinks) { if (k === v.id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  renderFavs();
  setText(titleEl, v.title);
  syncStatus();
  document.title = `${v.title} · Xeon-1`;
  rangeBox.style.display = v.range === false ? 'none' : '';
  clear(viewEl);
  ctx = makeCtx();
  try { v.mount(viewEl, ctx); } catch (e) { console.error(e); viewEl.append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Fehler beim Aufbau dieser Ansicht'), h('p', null, String(e.message)))))); }
  window.scrollTo(0, 0);
}

function syncStatus() {
  const info = store.info;
  const up = store.detail ? store.detail.sys.uptime : null;
  if (current) setText(crumbEl, current.desc || '');
  const foot = $('#side-foot');
  if (foot && info && up != null) { const t = `${info.host}|${dur(up + (performance.now() - store.bootAt) / 1000, 2)}`; if (foot.dataset.t !== t) { foot.dataset.t = t; foot.replaceChildren(h('b', null, info.host), `${info.os}`, h('br'), `läuft seit ${dur(up + (performance.now() - store.bootAt) / 1000, 2)}`); } }
  const kind = store.paused ? 'paused' : store.connected ? '' : 'off';
  liveEl.className = `live ${kind}`;
  setText(liveEl.lastChild, store.paused ? 'Pausiert' : store.connected ? `Live ${tHMS(store.now())}` : 'Getrennt');
}

function syncTheme() {
  if (!themeBtn) return;
  const m = getTheme();
  const label = THEMES.find((t) => t[0] === m)[1];
  themeBtn.replaceChildren(icon(m === 'dark' ? 'moon' : m === 'auto' ? 'monitor' : 'sun', 16));
  themeBtn.title = `Darstellung: ${label} (klicken zum Wechseln)`;
  themeBtn.setAttribute('aria-label', `Darstellung: ${label}`);
}
store.on('theme', syncTheme);

function syncLock() {
  const left = unlockedLeft();
  const unlocked = left > 0;
  lockEl.hidden = !unlocked;
  $('#unlock-btn').hidden = unlocked;
  if (unlocked) { const t = `Freigeschaltet ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`; if (lockEl.textContent !== t) lockEl.replaceChildren(icon('unlock', 14), t); }
}

function syncCounts() {
  const alerts = store.detail ? store.detail.alerts : [];
  const crit = alerts.filter((a) => a.level === 'crit').length;
  const set = (id, n, warn) => { const c = navLinks.get(id); if (!c) return; c.count.hidden = n === 0; setText(c.count, String(n)); c.count.classList.toggle('w', !!warn); };
  set('events', alerts.length, !crit);
  const sl = store.slow;
  if (sl) {
    set('services', sl.services.failed, false);
    set('web', sl.sites.filter((s) => s.ok === false).length, false);
  }
}

window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('.modal, .drawer, .cmdk')) return;
  if (goPending && Date.now() < goPending) { goPending = 0; const id = GO_KEYS[e.key.toLowerCase()]; if (id) { e.preventDefault(); location.hash = `#/${id}`; } return; }
  if (e.key === ' ' && e.target === document.body) { e.preventDefault(); store.togglePause(); }
  else if (e.key === '/') { e.preventDefault(); openPalette(); }
  else if (e.key === '?') { e.preventDefault(); shortcutsHelp(); }
  else if (e.key === 'g') { goPending = Date.now() + 1000; }
});

store.on('range', () => { if (rangeBox) $$('button', rangeBox).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === store.range))); });
store.on('pause', () => { if (pauseBtn) pauseBtn.replaceChildren(icon(store.paused ? 'play' : 'pause', 15)); syncStatus(); });
store.on('conn', syncStatus);
store.on('detail', () => { syncStatus(); syncCounts(); });
store.on('slow', syncCounts);
store.on('sample', syncStatus);
store.on('unlock', syncLock);
setInterval(syncLock, 1000);

// ------------------------------------------------------------------ boot

(async function boot() {
  buildShell();
  try {
    const saved = localStorage.getItem('sd.range');
    if (saved && RANGES[saved]) store.range = saved;
  } catch {}
  try {
    await store.bootstrap();
  } catch (e) {
    clear(viewEl);
    viewEl.append(h('div', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Der Server antwortet nicht'), h('p', null, 'Neuer Versuch in wenigen Sekunden …')))));
    setTimeout(() => location.reload(), 5000);
    return;
  }
  refreshTheme();
  $$('button', rangeBox).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.r === store.range)));
  store.connect();
  store.syncUnlock();
  api.get('/api/userdata').then((d) => { favorites = (d.favorites || []).filter((id) => VIEWS.some((v) => v.id === id)); renderFavs(); }).catch(() => {});
  store.ensureTier(store.range).catch(() => {});
  syncStatus();
  syncCounts();
  syncLock();
  window.addEventListener('hashchange', route);
  route();
})();
