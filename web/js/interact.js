// Everything that lets the owner act on the server: dialogs, password unlock, menus, drawers, log viewer.
// The browser only asks. The server re-checks every rule and the privileged helper validates again.

import { h, icon, clear, setText } from './dom.js';
import { api, store } from './store.js';
import { toast, tabs, kv, badge, dataTable, meter, tiles } from './widgets.js';
import { dur, num, B, tShort, tFull } from './fmt.js';

// ------------------------------------------------------------------ modal + drawer

export function modal({ title, lead, body, wide = false, xwide = false, buttons = [], onClose, beforeClose } = {}) {
  const foot = h('div', { class: 'modal-foot' });
  const x = h('button', { type: 'button', class: 'btn ghost sm icon-only modal-x', 'aria-label': 'Schließen', onClick: () => api_.close() }, icon('x', 16));
  const box = h('div', { class: `modal-box${wide ? ' wide' : ''}${xwide ? ' xwide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title }, x, h('h3', null, title), lead ? h('div', { class: 'lead' }, lead) : null, body || null, buttons.length ? foot : null);
  const el = h('div', { class: 'modal' }, box);
  const prevFocus = document.activeElement;
  const api_ = {
    el, box,
    close(force) { if (!el.isConnected) return; if (!force && beforeClose && beforeClose() === false) return; el.remove(); document.removeEventListener('keydown', onKey, true); if (prevFocus && prevFocus.focus) prevFocus.focus(); if (onClose) onClose(); },
  };
  function onKey(e) { if (e.key === 'Escape' && el === [...document.querySelectorAll('.modal')].pop()) { e.stopPropagation(); api_.close(); } }
  document.addEventListener('keydown', onKey, true);
  let downOnBackdrop = false;
  el.addEventListener('pointerdown', (e) => { downOnBackdrop = e.target === el; });
  el.addEventListener('pointerup', (e) => { if (downOnBackdrop && e.target === el) api_.close(); });
  for (const b of buttons) {
    const btn = h('button', { type: 'button', class: `btn ${b.kind || ''}`.trim(), onClick: async () => { if (b.onClick) { btn.disabled = true; try { const keep = await b.onClick(api_); if (keep === false) { btn.disabled = false; return; } } catch (e) { btn.disabled = false; throw e; } } if (b.close !== false) api_.close(); } }, b.label);
    foot.append(btn);
    api_[`btn_${b.id || b.label}`] = btn;
  }
  document.body.append(el);
  const focusEl = box.querySelector('input:not([type=checkbox]), textarea, select') || foot.querySelector('.btn.primary, .btn.danger') || box;
  setTimeout(() => focusEl.focus && focusEl.focus(), 30);
  return api_;
}

/** right-hand slide-over for details; `body` is a node, `actions` a list of nodes shown in the header */
export function drawer({ title, sub, body, actions = [], onClose } = {}) {
  const x = h('button', { type: 'button', class: 'btn sm icon-only', 'aria-label': 'Schließen', onClick: () => d.close() }, icon('x', 16));
  const box = h('aside', { class: 'drawer-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'drawer-h' }, h('div', { class: 'grow' }, h('h3', null, title), sub ? h('p', null, sub) : null), h('div', { class: 'card-a' }, ...actions, x)),
    h('div', { class: 'drawer-body' }, body));
  const el = h('div', { class: 'drawer' }, box);
  const prev = document.activeElement;
  const d = {
    el, box,
    close() { if (!el.isConnected) return; el.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.focus) prev.focus(); if (onClose) onClose(); },
    body: box.querySelector('.drawer-body'),
  };
  function onKey(e) { if (e.key === 'Escape' && !document.querySelector('.modal') && el === [...document.querySelectorAll('.drawer')].pop()) { e.stopPropagation(); d.close(); } }
  document.addEventListener('keydown', onKey, true);
  let down = false;
  el.addEventListener('pointerdown', (e) => { down = e.target === el; });
  el.addEventListener('pointerup', (e) => { if (down && e.target === el) d.close(); });
  document.body.append(el);
  x.focus();
  return d;
}

// ------------------------------------------------------------------ unlock (password confirmation, 5 minutes)

let unlockedUntil = 0;
export const isUnlocked = () => unlockedUntil > Date.now();
export const unlockedLeft = () => Math.max(0, unlockedUntil - Date.now());
export function setUnlocked(until) { unlockedUntil = until || 0; store.emit('unlock', unlockedUntil); }
store.syncUnlock = async () => { try { const r = await api.get('/api/session'); store.totp = !!r.totp; setUnlocked(r.elevatedUntil || 0); } catch {} };
setInterval(() => { if (unlockedUntil && unlockedUntil <= Date.now()) setUnlocked(0); }, 1000);

async function postUnlock(password, code) {
  const r = await api.post('/auth/elevate', { password, code: code || undefined });
  setUnlocked(r.until);
}

/** password field, plus the authenticator code when two-factor login is switched on */
function passwordFields() {
  const pw = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', 'aria-label': 'Passwort' });
  const code = store.totp ? h('input', { class: 'input', inputmode: 'numeric', autocomplete: 'one-time-code', spellcheck: 'false', maxlength: 24, placeholder: '6-stelliger Code aus der App', 'aria-label': 'Zwei-Faktor-Code', style: { marginTop: '8px' } }) : null;
  return { pw, code, els: [pw, code], submit: () => postUnlock(pw.value, code ? code.value.trim() : undefined), empty: () => !pw.value || (code && !code.value.trim()) };
}

/** unlock dialog; resolves true once the password was accepted */
export function unlockDialog() {
  return new Promise((resolve) => {
    let ok = false;
    const pf = passwordFields();
    const err = h('div', { class: 'err', role: 'alert' });
    const m = modal({
      title: 'Aktionen freischalten', lead: pf.code ? 'Passwort und Code bestätigen' : 'Passwort bestätigen',
      body: h('div', null, h('p', null, `Damit Änderungen am Server und das Lesen von Dateien möglich sind, brauchst du hier dein Passwort${pf.code ? ' und den Code aus deiner Authenticator-App' : ''}. Die Freigabe gilt 5 Minuten.`), h('div', { class: 'field' }, pf.pw, pf.code), err),
      onClose: () => resolve(ok),
      buttons: [{ label: 'Abbrechen' }, { label: 'Freischalten', kind: 'primary', onClick: async () => { try { await pf.submit(); ok = true; toast('Aktionen sind 5 Minuten freigeschaltet'); } catch (e) { err.textContent = e.message; return false; } } }],
    });
    for (const i of pf.els) if (i) i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.box.querySelector('.btn.primary').click(); } });
  });
}

export const ensureUnlock = () => (isUnlocked() ? Promise.resolve(true) : unlockDialog());

/** call a lookup operation; asks for the password when the operation exposes secrets */
export async function readOp(op, args = {}) {
  try { return (await api.post('/api/action', { op, args })).result; } catch (e) {
    if (e.code !== 'elevation') throw e;
    setUnlocked(0);
    if (!(await ensureUnlock())) throw e;
    return (await api.post('/api/action', { op, args })).result;
  }
}

/** run fn(); when the server wants the password first, ask for it and try once more */
export async function withUnlock(fn) {
  try { return await fn(); } catch (e) {
    if (e.code !== 'elevation') throw e;
    setUnlocked(0);
    if (!(await ensureUnlock())) throw Object.assign(new Error('Abgebrochen'), { cancelled: true });
    return fn();
  }
}

/** start a browser download of a file on the server (needs the unlocked state) */
export async function downloadPath(path) {
  if (!(await ensureUnlock())) return;
  const a = h('a', { href: `/api/download?path=${encodeURIComponent(path)}`, download: path.split('/').pop() });
  document.body.append(a); a.click(); a.remove();
  toast(`Download gestartet: ${path.split('/').pop()}`);
}

// ------------------------------------------------------------------ form fields

/** { name, label, type: text|number|select|textarea|checkbox|password, value, options, hint, placeholder, rows, mono } */
export function fieldEl(f) {
  let input;
  if (f.type === 'select') input = h('select', { class: 'input', name: f.name }, ...f.options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(f.value) ? '' : null }, l)));
  else if (f.type === 'textarea') { input = h('textarea', { class: 'input', name: f.name, rows: f.rows || 5, spellcheck: 'false', placeholder: f.placeholder || null, style: f.mono ? { fontFamily: 'var(--mono)', fontSize: '12.5px' } : null }); input.value = f.value || ''; }
  else if (f.type === 'checkbox') { input = h('input', { type: 'checkbox', name: f.name }); input.checked = !!f.value; }
  else { input = h('input', { class: 'input', name: f.name, type: f.type || 'text', autocomplete: 'off', spellcheck: 'false', placeholder: f.placeholder || null, min: f.min ?? null, max: f.max ?? null }); input.value = f.value ?? ''; }
  const get = () => (f.type === 'checkbox' ? input.checked : f.type === 'number' ? (input.value === '' ? NaN : +input.value) : input.value);
  const el = f.type === 'checkbox'
    ? h('div', { class: 'field' }, h('label', { class: 'check' }, input, f.label), f.hint ? h('small', null, f.hint) : null)
    : h('div', { class: 'field' }, h('label', null, f.label), f.hint ? h('small', null, f.hint) : null, input);
  return { el, input, get, name: f.name };
}

// ------------------------------------------------------------------ run an action

/**
 * Dialog -> (password if locked) -> POST /api/action.
 * opts: { op, args | (values) => args, title, lead, text, fields, okLabel, danger, word, success, after(result), wide, job }
 * Resolves with the result (or null when cancelled).
 */
export function actionDialog(opts) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'err', role: 'alert' });
    const kids = [];
    if (opts.text) kids.push(typeof opts.text === 'string' ? h('p', null, opts.text) : opts.text);
    const fields = (opts.fields || []).map(fieldEl);
    for (const f of fields) kids.push(f.el);
    let word = opts.word || null;
    let wordInput = null;
    const wordBox = h('div', { class: 'field' });
    const showWord = (w) => {
      word = w;
      wordInput = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Bestätigung', placeholder: w });
      wordBox.replaceChildren(h('label', null, 'Zur Sicherheit tippen:'), h('p', null, 'Tippe ', h('span', { class: 'confirm-word' }, w), ' ein, um fortzufahren.'), wordInput);
      wordInput.addEventListener('keydown', enter);
    };
    kids.push(wordBox);
    let pwInput = null;
    const pwBox = h('div', { class: 'field' });
    const showPw = () => {
      pwInput = passwordFields();
      pwBox.replaceChildren(h('label', null, pwInput.code ? 'Passwort und Code' : 'Passwort'), h('small', null, 'Zur Bestätigung. Danach sind Änderungen 5 Minuten freigeschaltet.'), pwInput.pw, pwInput.code);
      for (const i of pwInput.els) if (i) i.addEventListener('keydown', enter);
    };
    kids.push(pwBox);
    kids.push(err);
    let done = false;
    const values = () => Object.fromEntries(fields.map((f) => [f.name, f.get()]));
    const enter = (e) => { if (e.key === 'Enter') { e.preventDefault(); m.box.querySelector('.btn.danger, .btn.primary').click(); } };
    const m = modal({
      title: opts.title || 'Aktion bestätigen', lead: opts.lead, body: h('div', null, ...kids), wide: opts.wide,
      onClose: () => { if (!done) resolve(null); },
      buttons: [
        { label: 'Abbrechen' },
        { label: opts.okLabel || 'Ausführen', kind: opts.danger ? 'danger solid' : 'primary', close: false, onClick: async (mm) => {
          err.textContent = '';
          if (word && (!wordInput || wordInput.value.trim() !== word)) { err.textContent = `Bitte „${word}“ genau so eintippen.`; return false; }
          try {
            if (!isUnlocked()) { if (!pwInput || pwInput.empty()) { err.textContent = pwInput && pwInput.code ? 'Bitte Passwort und Code eingeben.' : 'Bitte das Passwort eingeben.'; return false; } await pwInput.submit(); }
            const vals = values();
            if (opts.validate) { const bad = opts.validate(vals); if (bad) { err.textContent = bad; return false; } }
            const args = typeof opts.args === 'function' ? opts.args(vals) : { ...opts.args };
            if (word) args.confirm = word;
            const r = await api.post('/api/action', { op: opts.op, args });
            done = true; mm.close();
            toast(typeof opts.success === 'function' ? opts.success(r.result, vals) : opts.success || 'Erledigt');
            resolve(r.result || {});
            if (r.result && r.result.job && opts.job !== false) watchJob(r.result.job, r.result.title || opts.title, () => { if (opts.after) opts.after(r.result); });
            else if (opts.after) opts.after(r.result, vals);
          } catch (e) {
            if (e.code === 'elevation') { setUnlocked(0); err.textContent = 'Die Freigabe ist abgelaufen. Bitte das Passwort erneut eingeben.'; showPw(); return false; }
            if (e.code === 'confirm' && e.expect) { showWord(e.expect); err.textContent = `Bitte „${e.expect}“ eintippen, um fortzufahren.`; return false; }
            err.textContent = e.message; return false;
          }
        } },
      ],
    });
    if (word) showWord(word);
    if (!isUnlocked()) showPw();
    const firstInput = m.box.querySelector('input:not([type=checkbox]), select, textarea');
    if (firstInput && firstInput.tagName === 'INPUT') firstInput.addEventListener('keydown', enter);
  });
}

/** alias used by the older call sites */
export const runAction = actionDialog;

/** plain yes/no dialog without server call */
export function confirmDialog({ title, lead, text, okLabel = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let ok = false;
    modal({ title, lead, body: typeof text === 'string' ? h('p', null, text) : text, onClose: () => resolve(ok), buttons: [{ label: 'Abbrechen' }, { label: okLabel, kind: danger ? 'danger solid' : 'primary', onClick: () => { ok = true; } }] });
  });
}

/** ask the user to type `word`; resolves true/false */
export function typedConfirm(word, { title = 'Zur Sicherheit', lead, text } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const input = h('input', { class: 'input', autocomplete: 'off', spellcheck: 'false', placeholder: word, 'aria-label': 'Bestätigung' });
    const err = h('div', { class: 'err', role: 'alert' });
    const m = modal({
      title, lead, body: h('div', null, text ? h('p', null, text) : null, h('div', { class: 'field' }, h('p', null, 'Tippe ', h('span', { class: 'confirm-word' }, word), ' ein, um fortzufahren.'), input), err), onClose: () => resolve(ok),
      buttons: [{ label: 'Abbrechen' }, { label: 'Fortfahren', kind: 'danger solid', onClick: () => { if (input.value.trim() !== word) { err.textContent = `Bitte „${word}“ genau so eintippen.`; return false; } ok = true; } }],
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.box.querySelector('.btn.danger').click(); } });
  });
}

/**
 * Run a change without a prepared dialog: asks for the password or the typed confirmation only when the
 * server says it is needed. Throws on failure (the message is meant for the user); rejects with
 * { cancelled: true } when the user backs out.
 */
export async function quickAction(op, args, { success, confirmTitle, confirmText } = {}) {
  const cancelled = () => Object.assign(new Error('Abgebrochen'), { cancelled: true });
  let extra = {};
  for (let round = 0; round < 3; round++) {
    try {
      const r = (await api.post('/api/action', { op, args: { ...args, ...extra } })).result;
      if (success) toast(typeof success === 'function' ? success(r) : success);
      return r;
    } catch (e) {
      if (e.code === 'elevation') { setUnlocked(0); if (!(await ensureUnlock())) throw cancelled(); continue; }
      if (e.code === 'confirm' && e.expect) { if (!(await typedConfirm(e.expect, { title: confirmTitle, text: confirmText }))) throw cancelled(); extra = { confirm: e.expect }; continue; }
      throw e;
    }
  }
  throw new Error('Aktion fehlgeschlagen.');
}

// ------------------------------------------------------------------ background jobs (apt, docker pull, certbot ...)

export function watchJob(id, title, onDone) {
  const out = h('pre', { class: 'out tall' }, 'Wird gestartet …');
  const state = h('span', { class: 'badge b-info' }, 'läuft');
  let timer = null; let finished = false;
  const m = modal({
    title: 'Hintergrundauftrag', lead: h('span', null, title, ' ', state), wide: true, body: out,
    onClose: () => { clearTimeout(timer); finished = true; },
    buttons: [
      { label: 'Auftrag stoppen', kind: 'danger', id: 'stop', close: false, onClick: async () => { try { await api.post('/api/action', { op: 'job.stop', args: { id } }); toast('Auftrag gestoppt'); } catch (e) { toast(e.message, 'crit'); } return false; } },
      { label: 'Schließen' },
    ],
  });
  async function poll() {
    if (finished) return;
    try {
      const r = (await api.post('/api/action', { op: 'job.get', args: { id } })).result;
      const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
      out.textContent = r.text || (r.done ? '(keine Ausgabe)' : 'Wird gestartet …');
      if (atEnd) out.scrollTop = out.scrollHeight;
      if (r.done) {
        finished = true;
        state.className = `badge ${r.killed ? 'b-warn' : r.exit === 0 ? 'b-ok' : 'b-crit'}`;
        state.textContent = r.killed ? 'abgebrochen' : r.exit === 0 ? 'fertig' : `Fehler (Exit ${r.exit})`;
        m['btn_stop'].hidden = true;
        if (onDone) onDone(r);
        return;
      }
    } catch (e) { out.textContent = e.message; }
    timer = setTimeout(poll, 1200);
  }
  poll();
  return m;
}

// ------------------------------------------------------------------ popover menu

let openMenu = null;
export function menu(anchor, items) {
  if (openMenu) openMenu.close();
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'hr') { el.append(h('hr')); continue; }
    el.append(h('button', { type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '', onClick: () => { close(); it.onClick(); } }, it.label, it.sub ? h('small', null, it.sub) : null));
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth; const hh = el.offsetHeight;
  const left = Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w));
  const top = r.bottom + 4 + hh > window.innerHeight ? Math.max(8, r.top - hh - 4) : r.bottom + 4;
  el.style.left = `${left + window.scrollX}px`; el.style.top = `${top + window.scrollY}px`;
  const onDoc = (e) => { if (!el.contains(e.target) && e.target !== anchor) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() { el.remove(); document.removeEventListener('pointerdown', onDoc, true); document.removeEventListener('keydown', onKey, true); window.removeEventListener('scroll', close, true); openMenu = null; }
  setTimeout(() => { document.addEventListener('pointerdown', onDoc, true); document.addEventListener('keydown', onKey, true); window.addEventListener('scroll', close, true); }, 0);
  openMenu = { close };
  el.querySelector('button')?.focus();
  return openMenu;
}

/** small trigger button for table rows */
export const trigger = (open, label = 'Aktion') => h('button', { type: 'button', class: 'btn sm', 'aria-haspopup': 'menu', onClick: (e) => { e.stopPropagation(); open(e.currentTarget); } }, label, icon('chevdown', 14));

// ------------------------------------------------------------------ processes

const SIGS = {
  TERM: ['beenden', 'SIGTERM', 'Der Prozess bekommt die Bitte, sich selbst sauber zu beenden.'],
  KILL: ['erzwingen', 'SIGKILL', 'Der Prozess wird sofort vom Kernel beendet, ohne aufzuräumen. Ungespeicherte Daten gehen verloren.'],
  HUP: ['neu laden', 'SIGHUP', 'Viele Programme laden dabei ihre Konfiguration neu.'],
  STOP: ['anhalten', 'SIGSTOP', 'Der Prozess wird eingefroren, bis du ihn fortsetzt.'],
  CONT: ['fortsetzen', 'SIGCONT', 'Ein angehaltener Prozess läuft weiter.'],
};

export const killProcess = (p, signal, after) => {
  const [label, sig, hint] = SIGS[signal];
  return actionDialog({
    op: 'proc.signal', args: { pid: p.pid, signal, name: p.name },
    title: `Prozess ${label}`, lead: `${p.name} · PID ${p.pid}`, text: h('div', null, h('p', null, hint), h('p', { class: 'muted' }, `Signal ${sig}${p.group ? ` · gehört zu ${p.group}` : ''}${p.user ? ` · Benutzer ${p.user}` : ''}`)),
    okLabel: signal === 'KILL' ? 'Erzwingen' : 'Ausführen', danger: signal === 'KILL' || signal === 'TERM', success: `${p.name} (${p.pid}): ${sig} gesendet`, after,
  });
};

export const reniceProcess = (p, after) => actionDialog({
  op: 'proc.renice', args: (v) => ({ pid: p.pid, name: p.name, nice: v.nice }), title: 'Priorität ändern', lead: `${p.name} · PID ${p.pid}`,
  fields: [{ name: 'nice', label: 'Nice-Wert', type: 'number', value: p.nice ?? 0, min: -20, max: 19, hint: '−20 = höchste Priorität, 0 = normal, 19 = niedrigste. Negative Werte bevorzugen den Prozess.' }],
  validate: (v) => (Number.isInteger(v.nice) && v.nice >= -20 && v.nice <= 19 ? null : 'Bitte eine ganze Zahl von −20 bis 19 angeben.'),
  okLabel: 'Setzen', success: 'Priorität geändert', after,
});

export function processMenu(anchor, p, after) {
  menu(anchor, [
    { label: 'Details ansehen', sub: 'Speicher, Dateien, Verbindungen', onClick: () => procDetail(p, after) },
    'hr',
    { label: 'Beenden', sub: 'SIGTERM, sanft', onClick: () => killProcess(p, 'TERM', after) },
    { label: 'Neu laden', sub: 'SIGHUP', onClick: () => killProcess(p, 'HUP', after) },
    { label: 'Anhalten', sub: 'SIGSTOP, einfrieren', onClick: () => killProcess(p, 'STOP', after) },
    { label: 'Fortsetzen', sub: 'SIGCONT', onClick: () => killProcess(p, 'CONT', after) },
    { label: 'Priorität ändern', sub: 'renice', onClick: () => reniceProcess(p, after) },
    'hr',
    { label: 'Erzwingen beenden', sub: 'SIGKILL, sofort', danger: true, onClick: () => killProcess(p, 'KILL', after) },
  ]);
}

export async function procDetail(p, after) {
  const body = h('div', { class: 'grid', style: { gridTemplateColumns: '1fr' } }, h('p', { class: 'muted loading' }, 'Lade …'));
  const d = drawer({ title: p.name, sub: `Prozess ${p.pid}`, body, actions: [h('button', { type: 'button', class: 'btn sm', onClick: () => processMenu(menuAnchor, p, () => { d.close(); if (after) after(); }) }, 'Aktion', icon('chevdown', 14))] });
  const menuAnchor = d.box.querySelector('.drawer-h .btn');
  try {
    const i = await readOp('proc.info', { pid: p.pid });
    const lim = i.limits.filter((l) => /open files|processes|address space|locked/i.test(l.name));
    const fdTable = dataTable({ columns: [{ key: 'fd', label: 'FD', align: 'r' }, { key: 'target', label: 'Ziel', cls: 'wrap mono' }], search: true, searchPlaceholder: 'Dateien filtern …', dense: true, pageSize: 40, sort: { key: 'fd', dir: 'asc' }, empty: 'Keine offenen Dateien sichtbar.' });
    fdTable.setRows(i.fds);
    body.replaceChildren(
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Übersicht'))), kv([
        ['Befehl', i.cmdline || i.name], ['Zustand', i.state], ['Benutzer-ID', i.uid], ['Eltern-Prozess', String(i.ppid)], ['Threads', String(i.threads)], ['Priorität (nice)', String(i.nice)],
        ['Arbeitsverzeichnis', i.cwd], ['Programmdatei', i.exe], ['cgroup', i.cgroup],
      ])),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Speicher und Ein-/Ausgabe'))), tiles([
        { label: 'Belegt (RSS)', value: i.vmRss || '–' }, { label: 'Anteilig (PSS)', value: i.pss || '–' }, { label: 'Virtuell', value: i.vmSize || '–' }, { label: 'Swap', value: i.vmSwap || '–' },
        { label: 'Gelesen (Platte)', value: i.io.read_bytes ? B(+i.io.read_bytes) : '–' }, { label: 'Geschrieben (Platte)', value: i.io.write_bytes ? B(+i.io.write_bytes) : '–' },
        { label: 'Offene Dateien', value: num(i.fdCount) }, { label: 'Kontextwechsel', value: num(+i.ctxVol + +i.ctxInv), sub: `${num(+i.ctxInv)} erzwungen` },
      ])),
      i.connections.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Netzwerkverbindungen'), h('p', null, 'Protokoll · Status · Empfangs-/Sendewarteschlange · Lokal · Gegenstelle'))), h('pre', { class: 'out' }, i.connections.join('\n'))) : null,
      i.children.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, `Kindprozesse (${i.children.length})`))), h('div', { class: 'pill-list' }, ...i.children.map((c) => h('span', { class: 'tag' }, `${c.name} · ${c.pid}`)))) : null,
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Limits'))), kv(lim.map((l) => [l.name, `${l.soft} / ${l.hard} ${l.unit}`]))),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, `Geöffnete Dateien (${num(i.fdCount)})`))), fdTable.el),
      i.environNames.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Umgebungsvariablen'), h('p', null, 'Nur die Namen. Werte werden bewusst nicht angezeigt.'))), h('div', { class: 'pill-list' }, ...i.environNames.map((n) => h('span', { class: 'tag mono' }, n)))) : null,
    );
  } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.message)); }
}

// ------------------------------------------------------------------ systemd units

const UNIT_TEXT = {
  restart: ['neu starten', 'Der Dienst wird gestoppt und wieder gestartet. Kurze Unterbrechung.', 'neu gestartet'],
  stop: ['stoppen', 'Der Dienst wird beendet und bleibt aus, bis du ihn startest.', 'gestoppt'],
  start: ['starten', 'Der Dienst wird gestartet.', 'gestartet'],
  reload: ['neu laden', 'Die Konfiguration wird neu eingelesen, ohne den Dienst zu unterbrechen.', 'neu geladen'],
  'reset-failed': ['Fehlerstatus zurücksetzen', 'Setzt nur die „fehlgeschlagen“-Markierung zurück. Der Dienst selbst wird nicht verändert.', 'zurückgesetzt'],
  enable: ['beim Booten aktivieren', 'Der Dienst startet künftig automatisch mit dem Server.', 'aktiviert'],
  disable: ['aus dem Autostart nehmen', 'Der Dienst startet nach einem Neustart nicht mehr von selbst.', 'deaktiviert'],
  mask: ['maskieren (sperren)', 'Der Dienst kann danach gar nicht mehr gestartet werden, auch nicht von anderen Diensten, bis du ihn wieder freigibst.', 'maskiert'],
  unmask: ['freigeben (Maskierung aufheben)', 'Hebt die Sperre auf. Der Dienst lässt sich wieder starten.', 'freigegeben'],
};
export const CRITICAL = new Set(['ssh.service', 'sshd.service', 'nginx.service', 'docker.service', 'containerd.service', 'server-dash.service', 'mariadb.service', 'mysql.service', 'redis-server.service', 'networking.service', 'systemd-networkd.service', 'cron.service', 'fail2ban.service', 'chrony.service', 'dbus.service', 'ufw.service', 'systemd-logind.service', 'systemd-journald.service']);

export const unitAction = (unit, action, after) => {
  const [verb, text, done] = UNIT_TEXT[action];
  const critical = CRITICAL.has(unit) && ['stop', 'restart', 'disable', 'mask'].includes(action);
  const extra = critical ? h('p', { class: 'muted' }, unit === 'ssh.service' ? 'Bestehende SSH-Verbindungen bleiben, neue Anmeldungen sind kurz nicht möglich.' : unit === 'server-dash.service' ? 'Dieses Dashboard ist danach etwa 5 Sekunden nicht erreichbar.' : unit === 'nginx.service' ? 'Alle Websites sind währenddessen kurz nicht erreichbar.' : 'Dieser Dienst ist wichtig für den Server.') : null;
  return actionDialog({ op: 'unit.control', args: { unit, action }, title: `Dienst ${verb}`, lead: unit, text: h('div', null, h('p', null, text), extra), word: critical ? unit : null, okLabel: 'Ausführen', danger: ['stop', 'disable', 'mask'].includes(action), success: `${unit} ${done}`, after });
};

export function unitMenu(anchor, r, after, extra = []) {
  const items = [{ label: 'Details und Konfiguration', sub: 'Einstellungen, Unit-Datei, Protokoll', onClick: () => unitDetail(r.id, after) }, 'hr'];
  if (r.active === 'active') items.push({ label: 'Neu starten', sub: 'restart', onClick: () => unitAction(r.id, 'restart', after) });
  else items.push({ label: 'Starten', sub: 'start', onClick: () => unitAction(r.id, 'start', after) });
  if (r.active === 'active') items.push({ label: 'Neu laden', sub: 'reload (falls unterstützt)', onClick: () => unitAction(r.id, 'reload', after) });
  if (r.active === 'failed') items.push({ label: 'Fehlerstatus zurücksetzen', sub: 'reset-failed', onClick: () => unitAction(r.id, 'reset-failed', after) });
  items.push({ label: 'Protokoll ansehen', sub: 'journalctl', onClick: () => logModal({ kind: 'unit', name: r.id }) }, 'hr');
  items.push(r.enabled === 'enabled' ? { label: 'Autostart entfernen', sub: 'disable', onClick: () => unitAction(r.id, 'disable', after) } : { label: 'Autostart aktivieren', sub: 'enable', onClick: () => unitAction(r.id, 'enable', after) });
  if (r.active === 'active') items.push('hr', { label: 'Stoppen', sub: 'stop', danger: true, onClick: () => unitAction(r.id, 'stop', after) });
  if (extra.length) items.push('hr', ...extra);
  menu(anchor, items);
}

export async function unitDetail(unit, after) {
  const body = h('div', null, h('p', { class: 'muted loading' }, 'Lade …'));
  const d = drawer({ title: unit, sub: 'systemd-Einheit', body });
  try {
    const i = await readOp('unit.info', { unit });
    const p = i.props;
    const active = p.ActiveState === 'active';
    const list = (s) => (s ? s.split(/\s+/).filter(Boolean).map((x) => h('span', { class: 'tag' }, x)) : '–');
    const btn = (label, action, kind = '') => h('button', { type: 'button', class: `btn sm ${kind}`.trim(), onClick: () => unitAction(unit, action, () => { d.close(); if (after) after(); }) }, label);
    const view = h('div');
    const logs = h('div');
    let logsMade = false;
    const t = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'cfg', label: 'Unit-Datei' }, { id: 'log', label: 'Protokoll' }], 'info', (id) => {
      view.hidden = id !== 'info'; cfgBox.hidden = id !== 'cfg'; logs.hidden = id !== 'log';
      if (id === 'log' && !logsMade) { logsMade = true; const lv = logViewer({ kind: 'unit', name: unit }); logs.append(lv.el); }
    });
    const cfgBox = h('div', { hidden: '' }, h('pre', { class: 'out tall' }, i.cat || '(leer)'), h('p', { class: 'muted', style: { marginTop: '8px' } }, p.FragmentPath ? `Datei: ${p.FragmentPath}. Bearbeiten geht im Dateimanager, danach „systemd neu einlesen“ (System → Dienste).` : ''));
    logs.hidden = true;
    view.append(
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, p.Description || unit), h('p', null, `${p.ActiveState}/${p.SubState} · ${p.UnitFileState || '–'}`))), h('div', { class: 'row' },
        active ? btn('Neu starten', 'restart') : btn('Starten', 'start', 'primary'), active ? btn('Neu laden', 'reload') : null, active ? btn('Stoppen', 'stop', 'danger') : null,
        p.UnitFileState === 'enabled' ? btn('Autostart entfernen', 'disable') : p.UnitFileState === 'masked' ? btn('Freigeben', 'unmask') : btn('Autostart aktivieren', 'enable'),
        p.ActiveState === 'failed' ? btn('Fehlerstatus zurücksetzen', 'reset-failed') : null)),
      h('section', { class: 'card' }, kv([
        ['Haupt-PID', p.MainPID && p.MainPID !== '0' ? p.MainPID : '–'], ['Typ', p.Type || '–'], ['Benutzer', p.User || 'root'], ['Gruppe', p.Group || '–'], ['Arbeitsverzeichnis', p.WorkingDirectory || '–'],
        ['Befehl', i.execStart ? i.execStart.replace(/^\{ path=([^;]+) ; argv\[\]=([^;]*);.*$/s, '$2') : '–'],
        ['Neustart-Regel', `${p.Restart || '–'}${p.RestartUSec ? ` (nach ${p.RestartUSec})` : ''}`], ['Automatische Neustarts', p.NRestarts || '0'], ['Letztes Ergebnis', p.Result || '–'],
        ['Speicher aktuell', p.MemoryCurrent && /^\d+$/.test(p.MemoryCurrent) ? B(+p.MemoryCurrent) : '–'], ['Speicher-Limit', p.MemoryMax && /^\d+$/.test(p.MemoryMax) ? B(+p.MemoryMax) : 'keins'], ['Tasks', p.TasksCurrent && /^\d+$/.test(p.TasksCurrent) ? p.TasksCurrent : '–'],
        ['CPU-Zeit gesamt', p.CPUUsageNSec && /^\d+$/.test(p.CPUUsageNSec) ? dur(+p.CPUUsageNSec / 1e9, 3) : '–'], ['Aktiv seit', p.ActiveEnterTimestamp || '–'], ['Zuletzt inaktiv', p.InactiveEnterTimestamp || '–'],
        ['Unit-Datei', p.FragmentPath || '–'], ['Erweiterungen', p.DropInPaths || '–'], ['Dokumentation', p.Documentation || '–'],
      ])),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Abhängigkeiten'))), kv([['Benötigt', h('span', { class: 'pill-list' }, ...[].concat(list(p.Requires)))], ['Möchte', h('span', { class: 'pill-list' }, ...[].concat(list(p.Wants)))], ['Gestartet nach', h('span', { class: 'pill-list' }, ...[].concat(list(p.After)))], ['Gewünscht von', h('span', { class: 'pill-list' }, ...[].concat(list(p.WantedBy)))], ['Löst aus', h('span', { class: 'pill-list' }, ...[].concat(list(p.Triggers)))], ['Ausgelöst von', h('span', { class: 'pill-list' }, ...[].concat(list(p.TriggeredBy)))]])),
    );
    body.replaceChildren(t.el, view, cfgBox, logs);
  } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.message)); }
}

// ------------------------------------------------------------------ docker containers

const dockerLabels = {
  restart: ['neu starten', 'neu gestartet', 'Der Container wird gestoppt und wieder gestartet.'],
  stop: ['stoppen', 'gestoppt', 'Der Container wird beendet (20 Sekunden Zeit zum sauberen Stoppen).'],
  start: ['starten', 'gestartet', 'Der Container wird gestartet.'],
  pause: ['pausieren', 'pausiert', 'Alle Prozesse im Container werden eingefroren, der Speicher bleibt belegt.'],
  unpause: ['fortsetzen', 'fortgesetzt', 'Der pausierte Container läuft weiter.'],
  kill: ['hart beenden', 'hart beendet', 'Der Container bekommt SIGKILL und wird sofort beendet, ohne aufzuräumen.'],
};
export const dockerAction = (name, action, after) => {
  const t = dockerLabels[action];
  return actionDialog({ op: 'docker.control', args: { name, action }, title: `Container ${t[0]}`, lead: name, text: t[2], okLabel: 'Ausführen', danger: ['stop', 'kill', 'pause'].includes(action), success: `${name} ${t[1]}`, after });
};
export const dockerRemove = (name, after) => actionDialog({
  op: 'docker.remove', args: (v) => ({ name, volumes: v.volumes }), title: 'Container entfernen', lead: name, danger: true, word: name, okLabel: 'Entfernen',
  text: 'Der Container wird gestoppt und gelöscht. Seine Daten im Container selbst gehen verloren. Benannte Volumes bleiben, außer du wählst unten das Gegenteil.',
  fields: [{ name: 'volumes', label: 'Auch anonyme Volumes des Containers löschen', type: 'checkbox', value: false }], success: `${name} entfernt`, after,
});
export const dockerPolicy = (name, current, after) => actionDialog({
  op: 'docker.restart-policy', args: (v) => ({ name, policy: v.policy }), title: 'Neustart-Regel', lead: name,
  fields: [{ name: 'policy', label: 'Neustart-Regel', type: 'select', value: current || 'no', options: [['no', 'nie automatisch neu starten'], ['always', 'immer (auch nach Server-Neustart)'], ['unless-stopped', 'immer, außer ich habe ihn gestoppt'], ['on-failure', 'nur bei Fehlern']] }],
  okLabel: 'Setzen', success: 'Neustart-Regel geändert', after,
});
export const dockerRename = (name, after) => actionDialog({
  op: 'docker.rename', args: (v) => ({ name, to: v.to }), title: 'Container umbenennen', lead: name,
  fields: [{ name: 'to', label: 'Neuer Name', type: 'text', value: name }], validate: (v) => (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(v.to) ? null : 'Erlaubt sind Buchstaben, Ziffern, _ . - (nicht am Anfang).'),
  okLabel: 'Umbenennen', success: 'Container umbenannt', after,
});

export const dockerExec = (name) => actionDialog({
  op: 'docker.exec', args: (v) => ({ name, cmd: v.cmd, user: v.user.trim() || undefined }), title: `Befehl im Container ${name}`, lead: 'docker exec', wide: true,
  text: 'Der Befehl läuft mit /bin/sh im laufenden Container. Interaktive Programme (wie ein Editor) gehen hier nicht, dafür sind Ausgabe und Ergebnis live zu sehen.',
  fields: [{ name: 'cmd', label: 'Befehl', type: 'textarea', rows: 3, mono: true, placeholder: 'ls -la /  oder  cat /etc/os-release' }, { name: 'user', label: 'Als Benutzer (optional)', placeholder: 'z. B. root oder www-data' }],
  okLabel: 'Ausführen', success: 'Gestartet', validate: (v) => (v.cmd.trim() ? null : 'Bitte einen Befehl eingeben.'),
});

export function dockerMenu(anchor, c, after) {
  const running = c.state === 'running';
  menu(anchor, [
    { label: 'Details ansehen', sub: 'Einstellungen, Mounts, Netzwerk, Protokoll', onClick: () => containerDetail(c.name, after) },
    'hr',
    running ? { label: 'Neu starten', sub: 'docker restart', onClick: () => dockerAction(c.name, 'restart', after) } : { label: 'Starten', sub: 'docker start', onClick: () => dockerAction(c.name, 'start', after) },
    c.paused ? { label: 'Fortsetzen', sub: 'docker unpause', onClick: () => dockerAction(c.name, 'unpause', after) } : running ? { label: 'Pausieren', sub: 'docker pause', onClick: () => dockerAction(c.name, 'pause', after) } : null,
    { label: 'Protokoll ansehen', sub: 'docker logs', onClick: () => logModal({ kind: 'docker', name: c.name }) },
    running ? { label: 'Befehl im Container ausführen …', sub: 'docker exec', onClick: () => dockerExec(c.name) } : null,
    'hr',
    { label: 'Neustart-Regel ändern', sub: c.restartPolicy || 'no', onClick: () => dockerPolicy(c.name, c.restartPolicy, after) },
    { label: 'Umbenennen', onClick: () => dockerRename(c.name, after) },
    'hr',
    running ? { label: 'Stoppen', sub: 'docker stop', danger: true, onClick: () => dockerAction(c.name, 'stop', after) } : null,
    running ? { label: 'Hart beenden', sub: 'docker kill', danger: true, onClick: () => dockerAction(c.name, 'kill', after) } : null,
    { label: 'Entfernen', sub: 'docker rm', danger: true, onClick: () => dockerRemove(c.name, after) },
  ]);
}

export async function containerDetail(name, after) {
  const body = h('div', null, h('p', { class: 'muted loading' }, 'Lade …'));
  const d = drawer({ title: name, sub: 'Docker-Container', body });
  try {
    const i = await readOp('docker.inspect', { name });
    const s = i.state;
    const act = (label, action, kind = '') => h('button', { type: 'button', class: `btn sm ${kind}`.trim(), onClick: () => dockerAction(name, action, () => { d.close(); if (after) after(); }) }, label);
    const run = s.Running;
    const view = h('div', { class: 'grid', style: { gridTemplateColumns: '1fr' } });
    const logs = h('div', { hidden: '' }); let logsMade = false;
    const t = tabs([{ id: 'info', label: 'Übersicht' }, { id: 'log', label: 'Protokoll' }], 'info', (id) => {
      view.hidden = id !== 'info'; logs.hidden = id !== 'log';
      if (id === 'log' && !logsMade) { logsMade = true; logs.append(logViewer({ kind: 'docker', name }).el); }
    });
    const ports = Object.entries(i.ports || {}).flatMap(([k, v]) => (v ? v.map((b) => `${b.HostIp === '0.0.0.0' || b.HostIp === '::' ? '' : `${b.HostIp}:`}${b.HostPort} → ${k}`) : [`${k} (nicht veröffentlicht)`]));
    view.append(
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, i.image), h('p', null, `${s.Status}${s.Health ? ` · Health: ${s.Health.Status}` : ''} · seit ${s.StartedAt ? tFull(Date.parse(s.StartedAt)) : '–'}`))), h('div', { class: 'row' },
        run ? act('Neu starten', 'restart') : act('Starten', 'start', 'primary'), run ? act('Stoppen', 'stop', 'danger') : null,
        h('button', { type: 'button', class: 'btn sm', onClick: () => dockerPolicy(name, i.restartPolicy && i.restartPolicy.Name, () => { d.close(); if (after) after(); }) }, 'Neustart-Regel'),
        h('button', { type: 'button', class: 'btn sm danger', onClick: () => dockerRemove(name, () => { d.close(); if (after) after(); }) }, 'Entfernen'))),
      h('section', { class: 'card' }, kv([
        ['ID', i.id.slice(0, 12)], ['Erstellt', i.created ? tFull(Date.parse(i.created)) : '–'], ['Zustand', s.Status], ['Exit-Code', String(s.ExitCode)], ['Neustarts', String(i.restartCount)], ['Neustart-Regel', i.restartPolicy ? `${i.restartPolicy.Name || 'no'}${i.restartPolicy.MaximumRetryCount ? ` (max. ${i.restartPolicy.MaximumRetryCount})` : ''}` : '–'],
        ['Befehl', [].concat(i.entrypoint || [], i.cmd || []).join(' ') || '–'], ['Arbeitsverzeichnis', i.workdir || '–'], ['Benutzer', i.user || 'root'], ['Rechnername', i.hostname],
        ['RAM-Limit', i.memory ? B(i.memory) : 'keins'], ['CPU-Limit', i.nanoCpus ? `${num(i.nanoCpus / 1e9, 2)} Kerne` : 'keins'], ['Privilegiert', i.privileged ? 'ja' : 'nein'], ['Log-Treiber', i.logDriver || '–'],
      ])),
      h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Netzwerk und Ports'))), kv([...i.networks.map((n) => [`Netzwerk ${n.name}`, `${n.ip || '–'}${n.gateway ? ` · Gateway ${n.gateway}` : ''}`]), ['Ports', ports.length ? ports.join('\n') : 'keine'], ['Modus', i.networkMode || '–']])),
      i.mounts.length ? h('section', { class: 'card flush' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, `Mounts (${i.mounts.length})`))), h('div', { class: 'tbl-wrap bare' }, h('table', { class: 'tbl dense' }, h('thead', null, h('tr', null, h('th', null, 'Typ'), h('th', null, 'Quelle'), h('th', null, 'Im Container'), h('th', null, 'Zugriff'))), h('tbody', null, ...i.mounts.map((m) => h('tr', null, h('td', null, m.type), h('td', { class: 'wrap mono' }, m.source), h('td', { class: 'wrap mono' }, m.dest), h('td', null, m.rw ? 'lesen/schreiben' : 'nur lesen'))))))) : null,
      i.health ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Gesundheitsprüfung'), h('p', null, `Status ${i.health.status} · ${i.health.failing} Fehlschläge in Folge`))), h('pre', { class: 'out' }, i.health.log.map((l) => `${l.at} · Exit ${l.exit}\n${l.out}`).join('\n') || '(keine Einträge)')) : null,
      i.envKeys.length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Umgebungsvariablen'), h('p', null, 'Nur die Namen. Werte werden bewusst nicht angezeigt.'))), h('div', { class: 'pill-list' }, ...i.envKeys.map((k) => h('span', { class: 'tag mono' }, k)))) : null,
      Object.keys(i.labels).length ? h('section', { class: 'card' }, h('div', { class: 'card-h' }, h('div', null, h('h3', null, 'Labels'))), kv(Object.entries(i.labels).slice(0, 40))) : null,
    );
    body.replaceChildren(t.el, view, logs);
  } catch (e) { body.replaceChildren(h('p', { class: 'err' }, e.message)); }
}

// ------------------------------------------------------------------ log viewer

const LOG_OPS = { unit: 'logs.unit', docker: 'logs.docker', kernel: 'logs.kernel', system: 'logs.system', nginx: 'logs.nginx', file: 'logs.tail' };

export function logViewer({ kind, name, which, lines = 200, level, sources } = {}) {
  const state = { kind, name, which, lines, level, filter: '' };
  const box = h('div', { class: 'logbox', role: 'log', 'aria-live': 'off' }, 'Lade …');
  const filter = h('input', { type: 'search', class: 'tbl-search', placeholder: 'Im Protokoll filtern …', 'aria-label': 'Im Protokoll filtern', onInput: (e) => { state.filter = e.target.value.toLowerCase(); paint(); } });
  const sel = sources ? h('select', { class: 'input', 'aria-label': 'Quelle', style: { width: 'auto', minWidth: '240px' }, onChange: (e) => { const s = sources[+e.target.value]; Object.assign(state, { kind: s.kind, name: s.name, which: s.which, level: s.level }); load(); } }, ...sources.map((s, i) => h('option', { value: i }, s.label))) : null;
  const nSel = h('select', { class: 'input', 'aria-label': 'Zeilen', style: { width: 'auto' }, onChange: (e) => { state.lines = +e.target.value; load(); } }, ...[100, 200, 500, 1000, 2000].map((n) => h('option', { value: n, selected: n === lines ? '' : null }, `${n} Zeilen`)));
  const auto = h('label', { class: 'switch' }, h('input', { type: 'checkbox', class: 'sw-in', onChange: (e) => { if (e.target.checked) timer = setInterval(load, 4000); else clearInterval(timer); } }), h('i'), h('span', null, 'live (4 Sek)'));
  let timer = null; let text = ''; let busy = false;
  function paint() {
    const f = state.filter;
    const rows = text.split('\n').filter((l) => !f || l.toLowerCase().includes(f));
    const frag = document.createDocumentFragment();
    for (const l of rows) {
      const cls = /\b(error|fail(ed|ure)?|fatal|critical|panic|denied|refused)\b/i.test(l) ? 'l-err' : /\b(warn(ing)?|timeout|retry)\b/i.test(l) ? 'l-warn' : '';
      const line = h('span', { class: cls });
      if (f) { const i = l.toLowerCase().indexOf(f); line.append(l.slice(0, i), h('mark', null, l.slice(i, i + f.length)), l.slice(i + f.length)); } else line.append(l);
      frag.append(line, '\n');
    }
    box.replaceChildren(frag);
    if (!rows.length) box.textContent = f ? 'Keine Zeile passt zum Filter.' : 'Keine Einträge.';
  }
  async function load() {
    if (busy) return; busy = true;
    const atEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    try {
      const args = { lines: state.lines };
      if (state.kind === 'unit') args.unit = state.name;
      if (state.kind === 'docker') args.name = state.name;
      if (state.kind === 'file') args.path = state.name;
      if (state.kind === 'nginx') args.which = state.which;
      if (state.kind === 'system') args.level = state.level;
      const r = await api.post('/api/action', { op: LOG_OPS[state.kind], args });
      text = r.result.text || '';
      paint();
      if (atEnd || box.scrollTop === 0) box.scrollTop = box.scrollHeight;
    } catch (e) { box.textContent = e.message; }
    busy = false;
  }
  const bar = h('div', { class: 'tbl-bar' }, sel, filter, nSel, auto, h('span', { class: 'grow' }), h('button', { type: 'button', class: 'btn sm', onClick: load }, icon('refresh', 14), 'Neu laden'));
  const el = h('div', null, bar, box);
  load();
  return { el, load, destroy() { clearInterval(timer); } };
}

export function logModal(opts) {
  const lv = logViewer(opts);
  const title = opts.kind === 'unit' ? 'Protokoll · Dienst' : opts.kind === 'docker' ? 'Protokoll · Container' : 'Protokoll';
  modal({ title, lead: opts.name || '', wide: true, body: lv.el, buttons: [{ label: 'Schließen', onClick: () => lv.destroy() }], onClose: () => lv.destroy() });
}

// ------------------------------------------------------------------ server-level actions

export function rebootDialog(after) {
  return actionDialog({
    op: 'system.reboot', args: (v) => ({ delay: +v.delay }), title: 'Server neu starten', lead: 'Neustart des Servers', word: 'NEUSTART', okLabel: 'Neustart planen', danger: true, success: 'Neustart geplant', after,
    text: 'Der gesamte Server wird neu gestartet: alle Websites, E-Mail, Spiele-Server und diese Seite sind danach einige Minuten nicht erreichbar. Die Daten bleiben erhalten.',
    fields: [{ name: 'delay', label: 'Start in', type: 'select', value: 60, options: [[15, '15 Sekunden'], [60, '1 Minute'], [180, '3 Minuten'], [600, '10 Minuten']] }],
  });
}

export const cancelReboot = () => actionDialog({ op: 'system.cancel-reboot', args: {}, title: 'Neustart abbrechen', lead: 'Geplanten Neustart abbrechen', okLabel: 'Abbrechen', success: 'Neustart abgebrochen' });

export const nginxReload = () => actionDialog({ op: 'nginx.reload', args: {}, title: 'nginx neu laden', lead: 'Konfiguration neu laden', text: 'Die Konfiguration wird zuerst geprüft. Nur wenn sie fehlerfrei ist, wird sie geladen. Es gibt keine Unterbrechung.', okLabel: 'Neu laden', success: 'nginx hat die Konfiguration neu geladen' });

export const daemonReload = () => actionDialog({ op: 'unit.daemon-reload', args: {}, title: 'systemd neu einlesen', lead: 'daemon-reload', text: 'Liest alle Unit-Dateien neu ein. Nötig, nachdem du eine Datei unter /etc/systemd/system geändert hast. Laufende Dienste werden nicht angefasst.', okLabel: 'Neu einlesen', success: 'systemd hat die Unit-Dateien neu eingelesen' });

// small trigger buttons for table rows
export const procBtn = (p, after) => trigger((a) => processMenu(a, p, after));
export const unitBtn = (r, after, extra) => trigger((a) => unitMenu(a, r, after, extra));
export const dockerBtn = (c, after) => trigger((a) => dockerMenu(a, c, after));
