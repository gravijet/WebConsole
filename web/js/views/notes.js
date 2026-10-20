// Notes and maintenance journal: free text with checklists, pinned notes, colour tags. Stored on the server.

import { h, icon } from '../dom.js';
import { card, toast, badge, emptyState } from '../widgets.js';
import { tShort, ago } from '../fmt.js';
import { api } from '../store.js';
import { confirmDialog } from '../interact.js';

const TAGS = [['', 'Keine'], ['blau', 'Blau'], ['grün', 'Grün'], ['gelb', 'Gelb'], ['rot', 'Rot']];
const TAG_CLASS = { blau: 'c1', grün: 'c7', gelb: 'c3', rot: 'c8' };
const stamp = () => new Date().toLocaleString('de-AT', { dateStyle: 'short', timeStyle: 'short' });

export default {
  id: 'notes', title: 'Notizen', group: 'Dashboard', icon: 'filetext', range: false, desc: 'Wartungsprotokoll, Zugangsnotizen und Checklisten, auf dem Server gespeichert', keywords: 'notiz notizen journal wartung todo checkliste merkzettel protokoll',
  mount(root, ctx) {
    let notes = []; let cur = null; let saveT = null; let dirty = false; let q = '';

    const list = h('div', { class: 'note-list' });
    const search = h('input', { type: 'search', class: 'tbl-search', placeholder: 'Notizen durchsuchen …', 'aria-label': 'Notizen durchsuchen', onInput: (e) => { q = e.target.value.toLowerCase(); paintList(); } });
    const editor = h('div', { class: 'note-ed' });
    const state = h('span', { class: 'muted note-state' }, '');

    async function persist() {
      clearTimeout(saveT);
      if (!dirty) return;
      dirty = false;
      state.textContent = 'Speichert …';
      try { await api.put('/api/userdata', { notes }); state.textContent = 'Gespeichert'; paintList(); } catch (e) { dirty = true; state.textContent = ''; toast(e.message, 'crit'); }
    }
    const touch = () => { dirty = true; if (cur) cur.updated = Date.now(); state.textContent = 'Nicht gespeichert …'; clearTimeout(saveT); saveT = setTimeout(persist, 900); };
    ctx.own({ destroy() { clearTimeout(saveT); if (dirty) { dirty = false; api.put('/api/userdata', { notes }).catch(() => {}); } } });

    function paintList() {
      const rows = notes.filter((n) => !q || `${n.title} ${n.body}`.toLowerCase().includes(q)).sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated));
      list.replaceChildren(...(rows.length ? rows.map((n) => h('button', { type: 'button', class: `note-item${cur && cur.id === n.id ? ' on' : ''}`, onClick: () => open(n) },
        n.tag ? h('i', { class: 'note-dot', style: { background: `var(--${TAG_CLASS[n.tag]})` } }) : null,
        h('span', { class: 'note-t' }, n.pinned ? icon('pin', 12) : null, n.title),
        h('small', null, `${ago(n.updated)} · ${(n.body.split('\n').find((l) => l.trim()) || '').slice(0, 60)}`))) : [h('p', { class: 'muted', style: { padding: '14px 4px' } }, q ? 'Nichts gefunden.' : 'Noch keine Notizen.')]));
    }

    /** checklist lines ("- [ ] text") as clickable boxes below the text area */
    function checklist(n) {
      const lines = n.body.split('\n');
      const items = lines.map((l, i) => { const m = /^(\s*[-*]\s+)\[( |x|X)\]\s?(.*)$/.exec(l); return m ? { i, done: m[2] !== ' ', text: m[3] } : null; }).filter(Boolean);
      if (!items.length) return null;
      const done = items.filter((x) => x.done).length;
      return h('div', { class: 'note-check' }, h('b', null, `Checkliste · ${done} von ${items.length} erledigt`), ...items.map((it) => {
        const cb = h('input', { type: 'checkbox' }); cb.checked = it.done;
        cb.addEventListener('change', () => { lines[it.i] = lines[it.i].replace(/\[( |x|X)\]/, cb.checked ? '[x]' : '[ ]'); n.body = lines.join('\n'); area.value = n.body; touch(); renderCheck(); });
        return h('label', { class: `check${it.done ? ' done' : ''}` }, cb, it.text);
      }));
    }
    let area; let checkBox;
    const renderCheck = () => { if (cur) checkBox.replaceChildren(...[checklist(cur)].filter(Boolean)); };

    function open(n) {
      persist();
      cur = n;
      const title = h('input', { class: 'input note-title', value: n.title, 'aria-label': 'Titel', placeholder: 'Titel' });
      title.addEventListener('input', () => { n.title = title.value; touch(); });
      area = h('textarea', { class: 'input mono-area note-body', rows: 16, spellcheck: 'false', 'aria-label': 'Text', placeholder: 'Schreibe los …\n\nCheckliste:\n- [ ] Erste Aufgabe\n- [x] Schon erledigt' });
      area.value = n.body;
      area.addEventListener('input', () => { n.body = area.value; touch(); renderCheck(); });
      checkBox = h('div');
      const tag = h('select', { class: 'input', 'aria-label': 'Farbe', style: { width: 'auto' } }, ...TAGS.map(([v, l]) => h('option', { value: v, selected: v === n.tag ? '' : null }, l)));
      tag.addEventListener('change', () => { n.tag = tag.value; touch(); paintList(); });
      editor.replaceChildren(
        h('div', { class: 'row', style: { gap: '8px', marginBottom: '10px', flexWrap: 'wrap' } }, title, tag,
          h('button', { type: 'button', class: `btn sm${n.pinned ? ' primary' : ''}`, title: 'Oben anheften', onClick: (e) => { n.pinned = !n.pinned; e.currentTarget.classList.toggle('primary', n.pinned); touch(); paintList(); } }, icon('pin', 13), n.pinned ? 'Angeheftet' : 'Anheften'),
          h('button', { type: 'button', class: 'btn sm', title: 'Datum und Uhrzeit an der Cursorposition einfügen', onClick: () => { const pos = area.selectionStart; const t = `[${stamp()}] `; area.value = area.value.slice(0, pos) + t + area.value.slice(pos); area.selectionStart = area.selectionEnd = pos + t.length; area.focus(); n.body = area.value; touch(); } }, icon('clock', 13), 'Zeitstempel'),
          h('button', { type: 'button', class: 'btn sm danger', onClick: async () => { if (await confirmDialog({ title: 'Notiz löschen?', text: n.title, okLabel: 'Löschen', danger: true })) { notes = notes.filter((x) => x.id !== n.id); cur = null; dirty = true; await persist(); showEmpty(); } } }, icon('trash', 13), 'Löschen')),
        area, checkBox, h('div', { class: 'row', style: { marginTop: '8px' } }, state, h('span', { class: 'grow' }), h('small', { class: 'muted' }, `Erstellt ${tShort(n.created)} · geändert ${ago(n.updated)}`)));
      renderCheck(); paintList();
    }
    function showEmpty() { editor.replaceChildren(emptyState('Keine Notiz geöffnet', 'Wähle links eine Notiz oder lege eine neue an.', 'filetext')); paintList(); }

    function add(preset = {}) {
      const n = { id: Array.from(crypto.getRandomValues(new Uint8Array(5)), (b) => b.toString(16).padStart(2, '0')).join(''), title: preset.title || 'Neue Notiz', body: preset.body || '', pinned: false, tag: preset.tag || '', created: Date.now(), updated: Date.now() };
      notes.unshift(n);
      dirty = true;
      open(n);
      persist();
    }

    const addMenu = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap' } },
      h('button', { type: 'button', class: 'btn primary sm', onClick: () => add() }, icon('plus', 13), 'Neue Notiz'),
      h('button', { type: 'button', class: 'btn sm', title: 'Eine Notiz mit heutigem Datum für Änderungen am Server', onClick: () => add({ title: `Wartung ${new Date().toLocaleDateString('de-AT')}`, body: `[${stamp()}] Was wurde gemacht?\n\nSchritte:\n- [ ] \n- [ ] \n\nErgebnis:\n`, tag: 'blau' }) }, icon('clock', 13), 'Wartungsprotokoll'));
    root.append(h('div', { class: 'grid' }, card({ title: 'Notizen', sub: 'Auf dem Server gespeichert, nicht nur im Browser.', span: 4, actions: addMenu }, search, list), card({ span: 8 }, editor)));
    showEmpty();
    (async () => {
      try { const d = await api.get('/api/userdata'); notes = d.notes || []; } catch (e) { toast(e.message, 'crit'); }
      paintList();
      const pinned = notes.slice().sort((a, b) => (b.pinned - a.pinned) || (b.updated - a.updated))[0];
      if (pinned) open(pinned);
    })();
    void badge;
  },
};
