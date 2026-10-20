// Logs: journal search, log files in /var/log, and visitor statistics from the nginx access logs.

import { h, icon } from '../dom.js';
import { card, dataTable, tabs, toast, tiles, banner, donutCard } from '../widgets.js';
import { BarList, columns } from '../charts.js';
import { num, B, tShort, tFull, rel } from '../fmt.js';
import { api } from '../store.js';
import { readOp, modal, logViewer, ensureUnlock } from '../interact.js';

const hl = (l) => (/\b(error|fail(ed|ure)?|fatal|critical|panic|denied|refused|segfault|oom)\b/i.test(l) ? 'l-err' : /\b(warn(ing)?|timeout|retry|deprecated)\b/i.test(l) ? 'l-warn' : '');

export default {
  id: 'logs', title: 'Protokolle', group: 'Zugriff', icon: 'logs', range: false, desc: 'System-Journal durchsuchen, Logdateien lesen und Besucher auswerten', keywords: 'journal log logs fehler nginx access error dmesg kernel besucher statistik',
  mount(root, ctx) {
    const panes = { journal: h('div'), files: h('div'), visitors: h('div') };
    const t = tabs([{ id: 'journal', label: 'System-Journal' }, { id: 'files', label: 'Logdateien' }, { id: 'visitors', label: 'Besucher (nginx)' }], 'journal', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; if (id === 'files' && !filesLoaded) loadFiles(); if (id === 'visitors' && !visitorsInit) initVisitors(); });
    panes.files.hidden = true; panes.visitors.hidden = true;

    // ------------------------------------------------------------ journal
    const sel = (opts, value, label) => h('select', { class: 'input', 'aria-label': label, style: { width: 'auto', minWidth: '130px' } }, ...opts.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value) ? '' : null }, l)));
    const unitSel = sel([['', 'Alle Dienste']], '', 'Dienst');
    const prioSel = sel([['', 'Alle Stufen'], ['err', 'Fehler und schlimmer'], ['warning', 'Warnungen und schlimmer'], ['notice', 'Hinweise und schlimmer'], ['info', 'Info und schlimmer']], 'warning', 'Priorität');
    const sinceSel = sel([['10m', 'Letzte 10 Min'], ['1h', 'Letzte Stunde'], ['6h', 'Letzte 6 Std'], ['24h', 'Letzte 24 Std'], ['7d', 'Letzte 7 Tage'], ['30d', 'Letzte 30 Tage']], '24h', 'Zeitraum');
    const linesSel = sel([[200, '200 Zeilen'], [500, '500 Zeilen'], [1000, '1000 Zeilen'], [2000, '2000 Zeilen']], 500, 'Zeilen');
    const grep = h('input', { type: 'search', class: 'tbl-search', placeholder: 'Suchen (Text oder Regex) …', 'aria-label': 'Suchen', onKeydown: (e) => { if (e.key === 'Enter') runJournal(); } });
    const out = h('div', { class: 'logbox', style: { maxHeight: '66vh' } }, 'Lade …');
    const meta = h('span', { class: 'tbl-info' });
    let text = ''; let timer = null;
    const live = h('label', { class: 'switch' }, h('input', { type: 'checkbox', class: 'sw-in', onChange: (e) => { clearInterval(timer); if (e.target.checked) timer = setInterval(runJournal, 4000); } }), h('i'), h('span', null, 'live (4 Sek)'));
    ctx.own({ destroy() { clearInterval(timer); } });
    for (const el of [unitSel, prioSel, sinceSel, linesSel]) el.addEventListener('change', runJournal);
    function paint() {
      const frag = document.createDocumentFragment();
      const needle = grep.value.trim();
      let re = null;
      try { re = needle ? new RegExp(needle, 'ig') : null; } catch { re = null; }
      const rows = text.split('\n').filter(Boolean);
      for (const l of rows) {
        const line = h('span', { class: hl(l) });
        if (re) { let last = 0; re.lastIndex = 0; let m; while ((m = re.exec(l)) && m[0]) { line.append(l.slice(last, m.index), h('mark', null, m[0])); last = m.index + m[0].length; } line.append(l.slice(last)); } else line.append(l);
        frag.append(line, '\n');
      }
      out.replaceChildren(frag);
      if (!rows.length) out.textContent = 'Keine Einträge für diese Auswahl.';
      meta.textContent = `${num(rows.length)} Zeilen`;
    }
    let jBusy = false;
    async function runJournal() {
      if (jBusy) return; jBusy = true;
      const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
      try {
        const r = await api.post('/api/action', { op: 'logs.query', args: { unit: unitSel.value || undefined, priority: prioSel.value || undefined, since: sinceSel.value, lines: +linesSel.value, grep: grep.value.trim() || undefined } });
        text = r.result.text; paint(); if (atEnd) out.scrollTop = out.scrollHeight;
      } catch (e) { out.textContent = e.message; }
      jBusy = false;
    }
    const dl = h('button', { type: 'button', class: 'btn sm', onClick: () => { const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'journal.txt' }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 14), 'Als Datei');
    panes.journal.append(card({ span: 12 }, h('div', { class: 'tbl-bar' }, unitSel, prioSel, sinceSel, linesSel, grep, live, h('span', { class: 'grow' }), meta, h('button', { type: 'button', class: 'btn sm', onClick: runJournal }, icon('refresh', 14), 'Neu laden'), dl), out));
    api.get('/api/services').then((r) => { for (const u of r.list.filter((x) => x.active === 'active' || x.active === 'failed').map((x) => x.id).sort()) unitSel.append(h('option', { value: u }, u)); }).catch(() => {});

    // ------------------------------------------------------------ files
    let filesLoaded = false; let fileList = [];
    const ftable = dataTable({
      columns: [
        { key: 'path', label: 'Datei', cls: 'tbl-title mono wrap', fmt: (v) => h('span', { class: 'fi' }, icon('filetext', 16), v.replace(/^\/var\/log\//, '')) },
        { key: 'size', label: 'Größe', align: 'r', fmt: B }, { key: 'mtime', label: 'Zuletzt geändert', align: 'r', sort: (r) => r.mtime, fmt: (v) => h('span', null, rel(v), h('small', { class: 'sub' }, tShort(v))) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, h('button', { type: 'button', class: 'btn sm', onClick: () => open(r.path) }, 'Lesen'), h('button', { type: 'button', class: 'btn sm', onClick: async () => { if (!(await ensureUnlock())) return; const a = h('a', { href: `/api/download?path=${encodeURIComponent(r.path)}`, download: r.path.split('/').pop() }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 13))) },
      ],
      search: true, searchPlaceholder: 'Logdatei suchen …', sort: { key: 'mtime', dir: 'desc' }, dense: true, pageSize: 100, onRow: (r) => open(r.path),
    });
    panes.files.append(card({ title: 'Logdateien in /var/log', sub: 'Komprimierte Archive (.gz) werden beim Lesen automatisch entpackt. Es werden die letzten Zeilen gezeigt.', span: 12 }, ftable.el));
    function open(path) { const lv = logViewer({ kind: 'file', name: path, lines: 500 }); modal({ title: 'Logdatei', lead: path, wide: true, body: lv.el, buttons: [{ label: 'Schließen', onClick: () => lv.destroy() }], onClose: () => lv.destroy() }); }
    async function loadFiles() {
      filesLoaded = true;
      try { const r = await readOp('logs.files'); fileList = r.files; ftable.setRows(fileList); fillSites(); } catch (e) { toast(e.message, 'crit'); }
    }

    // ------------------------------------------------------------ visitors
    let visitorsInit = false;
    const siteSel = h('select', { class: 'input', 'aria-label': 'Protokoll', style: { width: 'auto', minWidth: '280px' }, onChange: () => runVisitors() });
    const vBox = h('div', { class: 'grid' });
    const nSel = sel([[5000, 'Letzte 5.000 Anfragen'], [20000, 'Letzte 20.000 Anfragen'], [100000, 'Letzte 100.000 Anfragen']], 20000, 'Umfang');
    nSel.addEventListener('change', runVisitors);
    panes.visitors.append(h('div', { class: 'grid' }, card({ title: 'Besucher-Statistik', sub: 'Aus den nginx-Zugriffsprotokollen (Combined-Format). Hinter Cloudflare sind das die echten Besucher-Adressen.', span: 12, actions: [siteSel, nSel] }, vBox)));
    function fillSites() {
      const logs = fileList.filter((f) => /^\/var\/log\/nginx\/.*access.*\.log$/.test(f.path)).sort((a, b) => b.size - a.size);
      siteSel.replaceChildren(...logs.map((f) => h('option', { value: f.path }, `${f.path.replace('/var/log/nginx/', '')} (${B(f.size)})`)));
    }
    async function initVisitors() {
      visitorsInit = true;
      if (!filesLoaded) await loadFiles(); else fillSites();
      runVisitors();
    }
    async function runVisitors() {
      if (!siteSel.value) { vBox.replaceChildren(h('div', { class: 's-12' }, banner('info', 'Keine Zugriffsprotokolle gefunden', 'Unter /var/log/nginx liegt keine *access*.log-Datei.'))); return; }
      vBox.replaceChildren(h('p', { class: 'muted loading s-12' }, 'Wird ausgewertet …'));
      try {
        const d = await readOp('logs.access-stats', { file: siteSel.value, lines: +nSel.value });
        if (!d.total) { vBox.replaceChildren(h('div', { class: 's-12' }, banner('info', 'Keine auswertbaren Zeilen', 'Das Protokoll ist leer oder hat ein anderes Format.'))); return; }
        const span = d.first && d.last ? (d.last - d.first) / 1000 : 0;
        const hourly = columns(d.hourly.map((x) => { const dt = new Date(x[0]); return { label: `${String(dt.getHours()).padStart(2, '0')}:00`, value: x[1], tip: `${tShort(x[0])}: ${num(x[1])} Anfragen` }; }), { height: 110, color: 'c1', fmt: (v) => num(v) });
        const dS = donutCard({ title: 'Antwort-Codes', span: 4, fmt: (v) => num(v), size: 140 });
        const names = { '2xx': 'Erfolg (2xx)', '3xx': 'Weiterleitung (3xx)', '4xx': 'Client-Fehler (4xx)', '5xx': 'Server-Fehler (5xx)' };
        const colors = { '2xx': 'c7', '3xx': 'c5', '4xx': 'c3', '5xx': 'c8' };
        dS.donut.update(Object.entries(d.status).sort().map(([k, v]) => ({ id: k, label: names[k] || k, value: v, color: colors[k] || 'c6' })), { value: num(d.total), label: 'Anfragen' });
        const pl = h('div'); const pb = new BarList(pl, { fmt: (v) => num(v) });
        pb.update(d.paths.slice(0, 12).map(([p, c], i) => ({ id: p, label: p, value: c, color: 'c1' })));
        const ua = h('div'); const ub = new BarList(ua, { fmt: (v) => num(v) });
        ub.update(d.agents.slice(0, 8).map(([p, c]) => ({ id: p, label: p.length > 60 ? `${p.slice(0, 60)}…` : p, value: c, color: 'c4' })));
        const ipt = dataTable({ columns: [{ key: '0', label: 'Adresse', cls: 'mono tbl-title' }, { key: '1', label: 'Anfragen', align: 'r', fmt: (v) => num(v) }], dense: true, sort: { key: '1', dir: 'desc' } });
        ipt.setRows(d.ips.map((x) => ({ 0: x[0], 1: x[1] })));
        vBox.replaceChildren(
          h('div', { class: 's-12' }, tiles([{ label: 'Anfragen', value: num(d.total), sub: span ? `in ${Math.round(span / 60)} Min · Ø ${num(d.total / Math.max(1, span), 2)}/s` : '' }, { label: 'Datenmenge', value: B(d.bytes) }, { label: 'Bots und Skripte', value: `${num((d.bots / d.total) * 100, 0)} %`, sub: `${num(d.bots)} Anfragen` }, { label: 'Verschiedene Adressen', value: `≥ ${num(d.ips.length)}`, sub: 'Top-Liste unten' }, { label: 'Fehlerquote', value: `${num((((d.status['4xx'] || 0) + (d.status['5xx'] || 0)) / d.total) * 100, 1)} %`, tone: (d.status['5xx'] || 0) > d.total * 0.02 ? 'crit' : '' }])),
          card({ title: 'Anfragen pro Stunde', span: 8 }, hourly.el), dS.el,
          card({ title: 'Beliebteste Adressen (Pfade)', span: 6 }, pl), card({ title: 'Häufigste Besucher-Adressen', span: 3 }, ipt.el), card({ title: 'Programme (User-Agent)', span: 3 }, ua));
      } catch (e) { vBox.replaceChildren(h('div', { class: 's-12' }, banner('warn', 'Auswertung nicht möglich', e.message))); }
    }

    root.append(h('div', { class: 'grid' }, h('div', { class: 's-12' }, t.el, panes.journal, panes.files, panes.visitors)));
    runJournal();
    void tFull;
  },
};
