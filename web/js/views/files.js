// File manager: browse, edit, upload, download, rename, copy, permissions, delete, disk usage, search, versions.

import { h, icon } from '../dom.js';
import { card, dataTable, toast, tiles, banner, toggle, emptyState } from '../widgets.js';
import { BarList } from '../charts.js';
import { B, num, tShort, tFull, rwx, rel } from '../fmt.js';
import { api } from '../store.js';
import { modal, menu, trigger, actionDialog, readOp, ensureUnlock, quickAction, confirmDialog, drawer } from '../interact.js';

const PLACES = [['/', 'Wurzel'], ['/home', 'home'], ['/etc', 'etc'], ['/etc/nginx', 'nginx'], ['/etc/systemd/system', 'systemd'], ['/var/log', 'Logs'], ['/var/lib', 'var/lib'], ['/opt', 'opt'], ['/srv', 'srv'], ['/root', 'root'], ['/tmp', 'tmp']];
const TEXT_EXT = /\.(txt|md|log|conf|cfg|ini|json|ya?ml|toml|env|service|timer|socket|sh|bash|zsh|js|mjs|ts|py|rb|php|html?|css|xml|csv|sql|list|rules|cnf|pem|crt|sample|properties|gradle|java|c|h|cpp|go|rs|lua|pl)$|(^|\/)(\.[a-z_]+rc|\.bashrc|\.profile|Dockerfile|Makefile|crontab|hosts|fstab|passwd|group|resolv\.conf|nginx\.conf)$/i;
const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const ARC_EXT = /\.(zip|gz|tgz|tar|bz2|xz|zst|7z|rar|zpaq|deb|iso)$/i;
const CRITICAL_FILES = /^\/etc\/(ssh\/sshd_config(\.d\/.*)?|sudoers(\.d\/.*)?|fstab|passwd|group|shadow|hosts|resolv\.conf|crontab|pam\.d\/.*|ufw\/.*|fail2ban\/.*|network\/.*|nginx\/.*|systemd\/.*)$/;

const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);
const parent = (p) => (p === '/' ? '/' : p.replace(/\/[^/]+$/, '') || '/');
const fileIcon = (r) => (r.type === 'dir' || r.isDir ? 'files' : r.type === 'link' ? 'link' : IMG_EXT.test(r.name) ? 'image' : ARC_EXT.test(r.name) ? 'archive' : TEXT_EXT.test(r.name) ? 'filetext' : 'file');

export default {
  id: 'files', title: 'Dateien', group: 'Verwalten', icon: 'files', range: false, desc: 'Dateien ansehen, bearbeiten, hochladen und herunterladen', keywords: 'dateimanager ordner editor upload download config chmod',
  mount(root, ctx) {
    let cwd = '/';
    try { cwd = localStorage.getItem('sd.files.cwd') || '/home'; } catch { cwd = '/home'; }
    let data = null; let showHidden = true; let loading = false;

    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Pfad' });
    const pathInput = h('input', { class: 'input', style: { fontFamily: 'var(--mono)', fontSize: '12.5px' }, 'aria-label': 'Pfad', spellcheck: 'false', autocomplete: 'off', hidden: '', onKeydown: (e) => { if (e.key === 'Enter') { go(pathInput.value.trim()); pathInput.hidden = true; crumbs.hidden = false; } else if (e.key === 'Escape') { pathInput.hidden = true; crumbs.hidden = false; } } });
    const info = h('div');
    const msg = h('div');
    const fileInput = h('input', { type: 'file', multiple: '', hidden: '', onChange: () => { if (fileInput.files.length) uploadFiles([...fileInput.files]); fileInput.value = ''; } });

    const table = dataTable({
      columns: [
        { key: 'name', label: 'Name', cls: 'wrap', sort: (r) => `${r.isDir ? '0' : '1'}${r.name.toLowerCase()}`, fmt: (v, r) => h('span', { class: `fi ${r.isDir ? 'dir' : r.type}` }, icon(fileIcon(r), 18), h('button', { type: 'button', class: 'name', onClick: (e) => { e.stopPropagation(); open(r); } }, v), r.target ? h('span', { class: 'muted', style: { fontWeight: 400 } }, ` → ${r.target}`) : null) },
        { key: 'size', label: 'Größe', align: 'r', fmt: (v, r) => (r.isDir ? '–' : B(v)) },
        { key: 'mtime', label: 'Geändert', align: 'r', fmt: (v) => tShort(v), sort: (r) => r.mtime },
        { key: 'mode', label: 'Rechte', cls: 'nw mono', fmt: (v) => h('span', { title: rwx(v) }, `${v} ${rwx(v)}`) },
        { key: 'owner', label: 'Besitzer', cls: 'nw', fmt: (v, r) => `${v}:${r.group}` },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => trigger((a) => rowMenu(a, r)) },
      ],
      search: true, searchPlaceholder: 'In diesem Ordner filtern …', sort: { key: 'name', dir: 'asc' }, dense: true, pageSize: 300, empty: 'Dieser Ordner ist leer.',
      onRow: (r) => open(r),
    });

    // ------------------------------------------------------------ navigation
    async function go(path, quiet) {
      if (loading) return;
      loading = true;
      try {
        const r = await api.post('/api/action', { op: 'files.list', args: { path } });
        data = r.result;
        cwd = data.path;
        try { localStorage.setItem('sd.files.cwd', cwd); } catch {}
        msg.replaceChildren();
        render();
      } catch (e) {
        if (!quiet) toast(e.message, 'crit');
        if (!data) { cwd = '/'; msg.replaceChildren(banner('warn', 'Ordner nicht lesbar', e.message)); if (path !== '/') { loading = false; return go('/', true); } }
      }
      loading = false;
    }
    const reload = () => go(cwd, true);

    function render() {
      const parts = cwd.split('/').filter(Boolean);
      const acc = [h('button', { type: 'button', onClick: () => go('/') }, icon('server', 14))];
      let p = '';
      for (const part of parts) { p += `/${part}`; const target = p; acc.push(h('span', null, '/'), h('button', { type: 'button', onClick: () => go(target) }, part)); }
      crumbs.replaceChildren(...acc);
      const rows = data.entries.filter((e) => showHidden || !e.name.startsWith('.')).map((e) => ({ ...e, path: join(cwd, e.name) }));
      table.setRows(rows);
      const dirs = rows.filter((r) => r.isDir).length;
      info.replaceChildren(tiles([
        { label: 'Einträge', value: num(data.count), sub: `${dirs} Ordner, ${rows.length - dirs} Dateien${data.truncated ? ' (Liste gekürzt)' : ''}` },
        data.free ? { label: 'Frei auf diesem Datenträger', value: B(data.free.free), sub: `von ${B(data.free.total)}`, tone: data.free.free / data.free.total < 0.1 ? 'crit' : '' } : null,
        { label: 'Ordner-Rechte', value: data.mode, sub: `${rwx(data.mode)} · ${data.owner}` },
      ]));
    }

    // ------------------------------------------------------------ opening things
    function open(r) {
      if (r.isDir) return go(r.path);
      return openFile(r.path);
    }

    function rowMenu(anchor, r) {
      const dir = r.isDir;
      menu(anchor, [
        dir ? { label: 'Öffnen', onClick: () => go(r.path) } : { label: 'Ansehen und bearbeiten', sub: 'Texteditor', onClick: () => openFile(r.path) },
        !dir ? { label: 'Herunterladen', onClick: () => download(r.path) } : null,
        'hr',
        { label: 'Umbenennen oder verschieben', onClick: () => renameDialog(r) },
        { label: 'Kopieren', onClick: () => copyDialog(r) },
        { label: 'Rechte ändern', sub: `${r.mode} ${rwx(r.mode)}`, onClick: () => chmodDialog(r) },
        { label: 'Besitzer ändern', sub: `${r.owner}:${r.group}`, onClick: () => chownDialog(r) },
        { label: 'Eigenschaften', onClick: () => propsDialog(r) },
        !dir ? { label: 'Frühere Versionen', sub: 'automatische Sicherungen', onClick: () => versionsDialog(r.path) } : { label: 'Platzbedarf analysieren', sub: 'größte Einträge', onClick: () => usageDialog(r.path) },
        'hr',
        { label: 'Löschen', danger: true, onClick: () => deleteDialog(r) },
      ]);
    }

    // ------------------------------------------------------------ editor
    async function openFile(path) {
      let r;
      try { r = await readOp('files.read', { path }); } catch (e) { if (!e.cancelled && e.status !== 403) toast(e.message, 'crit'); else if (e.code === 'elevation') toast('Zum Lesen von Dateien ist die Freischaltung nötig.', 'crit'); return; }
      const name = path.split('/').pop();
      if (r.binary) {
        modal({ title: 'Datei', lead: name, body: h('div', null, h('p', null, 'Das ist keine Textdatei und lässt sich hier nicht bearbeiten.'), tiles([{ label: 'Größe', value: B(r.size) }, { label: 'Geändert', value: tShort(r.mtime) }])), buttons: [{ label: 'Schließen' }, { label: 'Herunterladen', kind: 'primary', onClick: () => download(path) }] });
        return;
      }
      const readOnly = !r.editable;
      const area = h('textarea', { class: 'editor', spellcheck: 'false', 'aria-label': `Inhalt von ${name}`, readonly: readOnly ? '' : null, wrap: 'off' });
      area.value = r.text;
      let saved = r.text; let mtime = r.mtime; let dirty = false;
      const status = h('span', { class: 'muted' }, '');
      const upd = () => {
        dirty = area.value !== saved;
        const pos = area.value.slice(0, area.selectionStart).split('\n');
        status.textContent = `Zeile ${pos.length}, Spalte ${pos[pos.length - 1].length + 1} · ${num(area.value.split('\n').length)} Zeilen${dirty ? ' · nicht gespeichert' : ''}`;
        saveBtn.disabled = !dirty || readOnly;
        saveBtn.classList.toggle('primary', dirty);
      };
      area.addEventListener('input', upd);
      area.addEventListener('keyup', upd);
      area.addEventListener('click', upd);
      area.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey && !readOnly) { e.preventDefault(); const s = area.selectionStart; area.setRangeText('  ', s, area.selectionEnd, 'end'); upd(); }
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      });
      const saveBtn = h('button', { type: 'button', class: 'btn', disabled: '', onClick: () => save() }, icon('check', 15), 'Speichern');
      async function save() {
        if (!dirty || readOnly) return;
        saveBtn.disabled = true;
        try {
          const res = await quickAction('files.write', { path, text: area.value, expectMtime: mtime }, { success: 'Gespeichert', confirmTitle: 'Systemdatei speichern', confirmText: 'Fehler in dieser Datei können den Server oder den Zugang beeinträchtigen. Vor dem Speichern wird eine Sicherung angelegt, und wo möglich die Konfiguration geprüft.' });
          saved = area.value; mtime = res.mtime; upd();
          if (CRITICAL_FILES.test(path) && /^\/etc\/nginx\//.test(path)) toast('nginx-Datei gespeichert. Zum Anwenden „nginx neu laden“ (System oder Websites).');
        } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); upd(); }
      }
      const warn = CRITICAL_FILES.test(path) ? banner('warn', 'Systemdatei', 'Änderungen wirken direkt auf den Server. Eine Sicherung wird automatisch angelegt; nginx- und SSH-Konfigurationen werden vor dem Übernehmen geprüft.') : null;
      const m = modal({
        title: readOnly ? 'Datei ansehen' : 'Datei bearbeiten', lead: h('span', { style: { fontFamily: 'var(--mono)', fontSize: '15px' } }, path), xwide: true,
        body: h('div', { class: 'form', style: { gap: '10px' } },
          h('div', { class: 'row muted', style: { fontSize: '12.5px' } }, `${B(r.size)} · Rechte ${r.mode} ${rwx(r.mode)} · geändert ${tFull(r.mtime)}`),
          warn, r.truncated ? banner('info', 'Datei größer als 2 MB', 'Nur der Anfang wird angezeigt. Bearbeiten ist deshalb gesperrt. Lade die Datei herunter, wenn du alles brauchst.') : null,
          area, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, status)),
        beforeClose: () => (dirty ? window.confirm('Es gibt nicht gespeicherte Änderungen. Wirklich schließen?') : true),
        buttons: [{ label: 'Schließen', onClick: (mm) => { if (dirty && !window.confirm('Es gibt nicht gespeicherte Änderungen. Wirklich schließen?')) return false; mm.close(true); return false; } }, { label: 'Frühere Versionen', onClick: () => { versionsDialog(path, (text) => { area.value = text; upd(); }); return false; } }, { label: 'Herunterladen', onClick: () => { download(path); return false; } }],
      });
      m.box.querySelector('.modal-foot').append(saveBtn);
      upd();
    }

    // ------------------------------------------------------------ download / upload
    async function download(path) {
      try {
        const st = await readOp('files.stat', { path });
        if (st.type !== 'file' && st.type !== 'link') { toast('Nur Dateien lassen sich herunterladen.', 'crit'); return; }
        if (st.size > 256 * 1024 * 1024) { toast('Die Datei ist größer als 256 MB.', 'crit'); return; }
        if (!(await ensureUnlock())) return;
        const a = h('a', { href: `/api/download?path=${encodeURIComponent(path)}`, download: path.split('/').pop() });
        document.body.append(a); a.click(); a.remove();
        toast(`Download gestartet: ${path.split('/').pop()}`);
      } catch (e) { toast(e.message, 'crit'); }
    }

    function sendFile(file, dir, overwrite, onProgress) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', `/api/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}&overwrite=${overwrite ? 1 : 0}`);
        xhr.setRequestHeader('X-SD', '1');
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
        xhr.onload = () => { let j = null; try { j = JSON.parse(xhr.responseText); } catch {} if (xhr.status === 200) resolve(j); else reject(Object.assign(new Error((j && j.error) || `HTTP ${xhr.status}`), { status: xhr.status, code: j && j.code })); };
        xhr.onerror = () => reject(new Error('Verbindung unterbrochen.'));
        xhr.send(file);
      });
    }

    async function uploadFiles(files) {
      if (!(await ensureUnlock())) return;
      const dir = cwd;
      const rows = files.map((f) => {
        const bar = h('i'); const state = h('span', { class: 'muted' }, 'wartet');
        return { f, bar, state, el: h('div', { class: 'field' }, h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'tbl-title' }, f.name), h('span', { class: 'muted' }, B(f.size)), state), h('div', { class: 'progress' }, bar)) };
      });
      const m = modal({ title: 'Hochladen', lead: `Nach ${dir}`, body: h('div', null, ...rows.map((r) => r.el)), buttons: [{ label: 'Schließen' }] });
      for (const r of rows) {
        if (r.f.size > 90 * 1024 * 1024) { r.state.textContent = 'zu groß (max. 90 MB)'; continue; }
        r.state.textContent = 'lädt …';
        const set = (p) => { r.bar.style.width = `${Math.round(p * 100)}%`; };
        try {
          try { await sendFile(r.f, dir, false, set); } catch (e) {
            if (e.status === 422 && /existiert bereits/.test(e.message)) {
              if (await confirmDialog({ title: 'Datei existiert bereits', lead: r.f.name, text: 'Soll die vorhandene Datei überschrieben werden? Die alte Fassung wird als Sicherung aufgehoben.', okLabel: 'Überschreiben' })) await sendFile(r.f, dir, true, set); else { r.state.textContent = 'übersprungen'; continue; }
            } else throw e;
          }
          set(1); r.state.textContent = 'fertig'; r.state.style.color = 'var(--ok)';
        } catch (e) { r.state.textContent = e.message; r.state.style.color = 'var(--crit)'; }
      }
      reload();
      void m;
    }

    // ------------------------------------------------------------ dialogs
    const newFolder = () => actionDialog({ op: 'files.mkdir', args: (v) => ({ path: join(cwd, v.name.trim()) }), title: 'Neuer Ordner', lead: cwd, fields: [{ name: 'name', label: 'Name', type: 'text' }], validate: (v) => (v.name.trim() && !v.name.includes('/') ? null : 'Bitte einen Namen ohne / angeben.'), okLabel: 'Anlegen', success: 'Ordner angelegt', after: reload });
    const newFile = () => actionDialog({ op: 'files.write', args: (v) => ({ path: join(cwd, v.name.trim()), text: '', create: true }), title: 'Neue Datei', lead: cwd, fields: [{ name: 'name', label: 'Name', type: 'text' }], validate: (v) => (v.name.trim() && !v.name.includes('/') ? null : 'Bitte einen Namen ohne / angeben.'), okLabel: 'Anlegen', success: 'Datei angelegt', after: (res, v) => { reload(); if (res && res.path) openFile(res.path); } });
    const renameDialog = (r) => actionDialog({ op: 'files.rename', args: (v) => ({ from: r.path, to: v.to.trim() }), title: 'Umbenennen oder verschieben', lead: r.path, fields: [{ name: 'to', label: 'Neuer Pfad', type: 'text', value: r.path, hint: 'Ändere den Namen oder gib einen anderen Ordner an.' }], okLabel: 'Verschieben', success: 'Verschoben', after: reload });
    const copyDialog = (r) => actionDialog({ op: 'files.copy', args: (v) => ({ from: r.path, to: v.to.trim() }), title: 'Kopieren', lead: r.path, fields: [{ name: 'to', label: 'Ziel', type: 'text', value: `${r.path}.kopie` }], okLabel: 'Kopieren', success: 'Kopiert', after: reload });
    const deleteDialog = (r) => actionDialog({
      op: 'files.delete', args: (v) => ({ path: r.path, recursive: !!v.recursive }), title: r.isDir ? 'Ordner löschen' : 'Datei löschen', lead: r.path, danger: true, okLabel: 'Löschen',
      text: r.isDir ? 'Ein leerer Ordner wird gelöscht. Soll auch der Inhalt entfernt werden, hake das unten an. Das lässt sich nicht rückgängig machen.' : 'Die Datei wird gelöscht. Eine Sicherungskopie bleibt als frühere Version erhalten (bis 8 MB).',
      fields: r.isDir ? [{ name: 'recursive', label: 'Samt Inhalt löschen (rekursiv)', type: 'checkbox', value: false }] : [], success: 'Gelöscht', after: reload,
    });

    function chmodDialog(r) {
      const cur = parseInt(r.mode, 8) & 0o777;
      const boxes = [];
      const octal = h('input', { class: 'input num', value: r.mode.slice(-3), maxlength: 4, 'aria-label': 'Oktalwert' });
      const grid = h('div', { class: 'tiles', style: { gridTemplateColumns: 'repeat(3, 1fr)' } });
      [['Besitzer', 6], ['Gruppe', 3], ['Andere', 0]].forEach(([label, shift]) => {
        const col = h('div', { class: 'tile' }, h('div', { class: 'tl-l' }, label));
        [['Lesen', 4], ['Schreiben', 2], ['Ausführen', 1]].forEach(([l, bit]) => {
          const cb = h('input', { type: 'checkbox' }); cb.checked = !!((cur >> shift) & bit);
          cb.addEventListener('change', () => { let v = 0; boxes.forEach((b) => { if (b.cb.checked) v |= b.bit << b.shift; }); octal.value = v.toString(8).padStart(3, '0'); });
          boxes.push({ cb, bit, shift });
          col.append(h('label', { class: 'check', style: { display: 'flex', marginTop: '6px' } }, cb, l));
        });
        grid.append(col);
      });
      octal.addEventListener('input', () => { const v = parseInt(octal.value, 8); if (Number.isFinite(v)) boxes.forEach((b) => { b.cb.checked = !!(((v & 0o777) >> b.shift) & b.bit); }); });
      const rec = h('input', { type: 'checkbox' });
      actionDialog({
        op: 'files.chmod', args: () => ({ path: r.path, mode: octal.value.trim(), recursive: rec.checked }), title: 'Rechte ändern', lead: r.path,
        text: h('div', { class: 'form' }, grid, h('div', { class: 'field' }, h('label', null, 'Oktalwert'), octal), r.isDir ? h('label', { class: 'check' }, rec, 'Auch für alles darin (rekursiv)') : null),
        okLabel: 'Setzen', success: 'Rechte geändert', after: reload,
      });
    }

    const chownDialog = (r) => actionDialog({
      op: 'files.chown', args: (v) => ({ path: r.path, owner: v.owner.trim(), group: v.group.trim() || undefined, recursive: !!v.recursive }), title: 'Besitzer ändern', lead: r.path,
      fields: [{ name: 'owner', label: 'Benutzer', type: 'text', value: r.owner }, { name: 'group', label: 'Gruppe', type: 'text', value: r.group }, ...(r.isDir ? [{ name: 'recursive', label: 'Auch für alles darin (rekursiv)', type: 'checkbox', value: false }] : [])],
      okLabel: 'Setzen', success: 'Besitzer geändert', after: reload,
    });

    async function propsDialog(r) {
      try {
        const s = await readOp('files.stat', { path: r.path });
        modal({ title: 'Eigenschaften', lead: r.path, body: h('dl', { class: 'kv' }, ...[
          ['Art', s.type_desc || s.type], ['Größe', s.isDir ? '–' : `${B(s.size)} (${num(s.size)} Bytes)`], ['Rechte', `${s.mode} ${rwx(s.mode)}`], ['Besitzer', `${s.owner} (${s.uid})`], ['Gruppe', `${s.group} (${s.gid})`],
          ['Geändert', tFull(s.mtime)], ['Zugegriffen', tFull(s.atime)], ['Status geändert', tFull(s.ctime)], s.birth ? ['Erstellt', tFull(s.birth)] : null, ['Inode', String(s.inode)], ['Links', String(s.links)], s.target ? ['Zeigt auf', s.target] : null,
        ].filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])), buttons: [{ label: 'Schließen' }] });
      } catch (e) { toast(e.message, 'crit'); }
    }

    async function usageDialog(path) {
      const box = h('div', null, h('p', { class: 'muted loading' }, 'Wird berechnet … das kann bei großen Ordnern eine Minute dauern.'));
      modal({ title: 'Platzbedarf', lead: path, wide: true, body: box, buttons: [{ label: 'Schließen' }] });
      try {
        const r = await readOp('files.du', { path });
        const list = h('div');
        const bl = new BarList(list, { fmt: B });
        const max = r.list[0] ? r.list[0].size : 1;
        bl.update(r.list.slice(0, 25).map((x, i) => ({ id: x.path, label: x.path.split('/').pop() || x.path, sub: r.total ? `${((x.size / r.total) * 100).toFixed(1)} %` : '', value: x.size, color: `c${(i % 10) + 1}` })), max);
        box.replaceChildren(tiles([{ label: 'Gesamt', value: B(r.total) }, { label: 'Einträge in dieser Ebene', value: String(r.list.length) }]), r.timedOut ? banner('warn', 'Zeitlimit erreicht', 'Die Berechnung wurde nach 90 Sekunden abgebrochen. Die Zahlen sind unvollständig.') : null, h('div', { style: { marginTop: '14px' } }, list));
      } catch (e) { box.replaceChildren(h('p', { class: 'err' }, e.message)); }
    }

    async function versionsDialog(path, onPick) {
      let r;
      try { r = await readOp('files.versions', { path }); } catch (e) { toast(e.message, 'crit'); return; }
      const t = dataTable({
        columns: [
          { key: 't', label: 'Gesichert am', fmt: (v) => `${tFull(v)} (${rel(v)})` }, { key: 'size', label: 'Größe', align: 'r', fmt: B },
          { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, row) => h('span', null,
            h('button', { type: 'button', class: 'btn sm', onClick: async () => { try { const x = await readOp('files.version-read', { id: row.id }); if (onPick) { onPick(x.text); toast('Fassung in den Editor geladen. Zum Übernehmen speichern.'); } else modal({ title: 'Frühere Fassung', lead: tFull(row.t), wide: true, body: h('pre', { class: 'out tall' }, x.binary ? '(Binärdatei)' : x.text), buttons: [{ label: 'Schließen' }] }); } catch (e) { toast(e.message, 'crit'); } } }, onPick ? 'In Editor laden' : 'Ansehen'),
            h('button', { type: 'button', class: 'btn sm', onClick: () => actionDialog({ op: 'files.restore', args: { id: row.id }, title: 'Frühere Version wiederherstellen', lead: path, text: 'Die aktuelle Fassung wird vorher gesichert und dann ersetzt.', okLabel: 'Wiederherstellen', success: 'Wiederhergestellt', after: reload }) }, 'Wiederherstellen')) },
        ], sort: { key: 't', dir: 'desc' }, dense: true, empty: 'Es gibt noch keine automatischen Sicherungen dieser Datei. Sie entstehen beim Überschreiben, Löschen oder Ersetzen.',
      });
      t.setRows(r.versions);
      modal({ title: 'Frühere Versionen', lead: path, wide: true, body: t.el, buttons: [{ label: 'Schließen' }] });
    }

    function searchDialog() {
      const name = h('input', { class: 'input', placeholder: 'Name enthält …', 'aria-label': 'Name enthält' });
      const size = h('input', { class: 'input num', type: 'number', placeholder: 'MB', min: 1, 'aria-label': 'Mindestgröße in MB' });
      const out = h('div');
      const run = async () => {
        out.replaceChildren(h('p', { class: 'muted loading' }, 'Suche läuft …'));
        try {
          const r = await readOp('files.find', { path: cwd, name: name.value.trim() || undefined, minSize: size.value ? +size.value : undefined });
          const t = dataTable({ columns: [
            { key: 'path', label: 'Pfad', cls: 'wrap mono', fmt: (v, row) => h('button', { type: 'button', class: 'name', style: { border: 0, background: 'none', padding: 0, textAlign: 'left', color: 'var(--accent)' }, onClick: () => { m.close(); if (row.kind === 'dir') go(v); else go(parent(v)).then(() => openFile(v)); } }, v) },
            { key: 'size', label: 'Größe', align: 'r', fmt: (v, row) => (row.kind === 'dir' ? '–' : B(v)) }, { key: 'mtime', label: 'Geändert', align: 'r', fmt: tShort },
          ], dense: true, sort: { key: 'path', dir: 'asc' }, empty: 'Nichts gefunden.', pageSize: 100 });
          t.setRows(r.list);
          out.replaceChildren(r.truncated ? banner('info', 'Nur die ersten 500 Treffer', 'Grenze die Suche enger ein.') : null, t.el);
        } catch (e) { out.replaceChildren(h('p', { class: 'err' }, e.message)); }
      };
      const m = modal({ title: 'Suchen', lead: `In ${cwd} und darunter`, wide: true, body: h('div', null, h('div', { class: 'row' }, name, size, h('button', { type: 'button', class: 'btn primary', onClick: run }, icon('search', 15), 'Suchen')), h('div', { style: { marginTop: '14px' } }, out)), buttons: [{ label: 'Schließen' }] });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    }

    // ------------------------------------------------------------ layout
    const hiddenToggle = toggle({ checked: showHidden, label: 'Versteckte Dateien', onChange: (v) => { showHidden = v; if (data) render(); } });
    const places = h('div', { class: 'row', style: { gap: '6px' } }, ...PLACES.map(([p, label]) => h('button', { type: 'button', class: 'btn sm', onClick: () => go(p) }, label)));
    const bar = h('div', { class: 'toolbar' },
      h('button', { type: 'button', class: 'btn sm icon-only', title: 'Eine Ebene hoch', 'aria-label': 'Eine Ebene hoch', onClick: () => go(parent(cwd)) }, icon('up', 16)),
      h('button', { type: 'button', class: 'btn sm icon-only', title: 'Neu laden', 'aria-label': 'Neu laden', onClick: reload }, icon('refresh', 16)),
      crumbs, pathInput,
      h('button', { type: 'button', class: 'btn sm icon-only', title: 'Pfad eintippen', 'aria-label': 'Pfad eintippen', onClick: () => { pathInput.value = cwd; crumbs.hidden = true; pathInput.hidden = false; pathInput.focus(); pathInput.select(); } }, icon('edit', 15)),
      h('span', { class: 'grow' }), hiddenToggle.el,
      h('button', { type: 'button', class: 'btn sm', onClick: newFolder }, icon('folderplus', 15), 'Ordner'),
      h('button', { type: 'button', class: 'btn sm', onClick: newFile }, icon('fileplus', 15), 'Datei'),
      h('button', { type: 'button', class: 'btn sm', onClick: () => usageDialog(cwd) }, icon('disk', 15), 'Platzbedarf'),
      h('button', { type: 'button', class: 'btn sm', onClick: searchDialog }, icon('search', 15), 'Suchen'),
      h('button', { type: 'button', class: 'btn sm primary', onClick: () => fileInput.click() }, icon('upload', 15), 'Hochladen'));
    const drop = h('div', { class: 'dropzone', hidden: '' }, 'Dateien hier loslassen, um sie in diesen Ordner hochzuladen');
    const main = card({ span: 12 }, bar, places, h('div', { style: { height: '12px' } }), info, h('div', { style: { height: '12px' } }), msg, drop, table.el, fileInput);
    root.append(h('div', { class: 'grid' }, main));
    // drag and drop
    const over = (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); drop.hidden = false; drop.classList.add('over'); } };
    const out = () => { drop.classList.remove('over'); drop.hidden = true; };
    main.addEventListener('dragover', over);
    main.addEventListener('dragleave', (e) => { if (!main.contains(e.relatedTarget)) out(); });
    main.addEventListener('drop', (e) => { e.preventDefault(); out(); if (e.dataTransfer.files.length) uploadFiles([...e.dataTransfer.files]); });
    window.addEventListener('dragover', preventNav); window.addEventListener('drop', preventNav);
    function preventNav(e) { if (!main.contains(e.target)) e.preventDefault(); }
    ctx.own({ destroy() { window.removeEventListener('dragover', preventNav); window.removeEventListener('drop', preventNav); } });
    go(cwd);
    void emptyState; void drawer;
  },
};
