// Command console: run a shell command on the server and watch its output live. Saved commands,
// ready-made examples and the history of recent runs sit next to it.

import { h, icon } from '../dom.js';
import { card, badge, toast, dataTable, emptyState } from '../widgets.js';
import { tShort, ago } from '../fmt.js';
import { api } from '../store.js';
import { quickAction, readOp, confirmDialog, modal, fieldEl } from '../interact.js';

const PRESETS = [
  ['System', [
    ['Auslastung und Laufzeit', 'uptime && echo && free -h && echo && df -hT -x tmpfs -x devtmpfs -x overlay'],
    ['Größte Speicherverbraucher', 'ps -eo pid,user,%mem,%cpu,etime,comm --sort=-%mem | head -n 16'],
    ['Größte CPU-Verbraucher', 'ps -eo pid,user,%cpu,%mem,etime,comm --sort=-%cpu | head -n 16'],
    ['Systeminformationen', 'hostnamectl && echo && lscpu | head -n 20 && echo && uname -a'],
    ['Letzte Anmeldungen', 'last -n 15 -a'],
    ['Fehler im System-Journal (heute)', 'journalctl -p err --since today --no-pager | tail -n 60'],
  ]],
  ['Netzwerk', [
    ['Offene Ports', 'ss -tulpn'],
    ['Netzwerkschnittstellen', 'ip -br addr && echo && ip route'],
    ['Aktive Verbindungen pro Adresse', "ss -tn state established | awk 'NR>1{split($4,a,\":\"); c[a[1]]++} END{for(i in c) print c[i], i}' | sort -rn | head"],
    ['Öffentliche IP-Adresse', 'curl -s https://ifconfig.me; echo'],
    ['DNS-Test', 'getent hosts example.com && resolvectl status 2>/dev/null | head -n 20'],
  ]],
  ['Docker', [
    ['Container (alle)', "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}\\t{{.Ports}}'"],
    ['Ressourcen der Container', 'docker stats --no-stream'],
    ['Speicherverbrauch von Docker', 'docker system df'],
  ]],
  ['Pflege', [
    ['Journal verkleinern (auf 500 MB)', 'journalctl --vacuum-size=500M'],
    ['Größte Ordner unter /var', 'du -xh --max-depth=2 /var 2>/dev/null | sort -rh | head -n 20'],
    ['Alte Kernel anzeigen', "dpkg -l 'linux-image-*' | grep '^ii'"],
    ['Fehlgeschlagene Dienste', 'systemctl --failed --no-pager'],
    ['Nach Updates suchen', 'apt-get update -q && apt list --upgradable 2>/dev/null'],
  ]],
];

export default {
  id: 'console', title: 'Konsole', group: 'Verwalten', icon: 'terminal', range: false, desc: 'Befehle auf dem Server ausführen und die Ausgabe live verfolgen', keywords: 'terminal shell bash befehl kommando skript ssh',
  mount(root, ctx) {
    let data = { snippets: [] };
    let users = ['root'];
    let jobId = null; let timer = null; let polling = false;

    const cmd = h('textarea', { class: 'input mono-area', rows: 6, spellcheck: 'false', placeholder: 'Befehl eingeben, z. B.  df -h  oder  systemctl status nginx\nMehrere Zeilen und Skripte sind möglich. Strg + Enter führt aus.', 'aria-label': 'Befehl' });
    const user = h('select', { class: 'input', 'aria-label': 'Ausführen als', style: { width: 'auto' } }, h('option', { value: 'root' }, 'root'));
    const cwd = h('input', { class: 'input', placeholder: 'Arbeitsverzeichnis (leer = Home)', 'aria-label': 'Arbeitsverzeichnis', spellcheck: 'false', style: { fontFamily: 'var(--mono)', flex: '1 1 160px', width: 'auto' } });
    const limit = h('select', { class: 'input', 'aria-label': 'Zeitlimit', style: { width: 'auto' } }, ...[[60, 'Limit 1 Min'], [600, 'Limit 10 Min'], [3600, 'Limit 1 Std']].map(([v, l]) => h('option', { value: v, selected: v === 600 ? '' : null }, l)));
    const out = h('pre', { class: 'out tall console-out' }, 'Noch nichts ausgeführt.');
    const state = h('span', { class: 'badge' }, 'bereit');
    const runBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => run() }, icon('play', 14), 'Ausführen');
    const stopBtn = h('button', { type: 'button', class: 'btn danger', hidden: '', onClick: stop }, icon('stop', 14), 'Abbrechen');
    const clearBtn = h('button', { type: 'button', class: 'btn ghost sm', onClick: () => { out.textContent = ''; state.className = 'badge'; state.textContent = 'bereit'; } }, 'Leeren');
    const copyBtn = h('button', { type: 'button', class: 'btn ghost sm', onClick: () => navigator.clipboard.writeText(out.textContent).then(() => toast('Ausgabe kopiert')).catch(() => toast('Kopieren nicht möglich', 'crit')) }, icon('copy', 13), 'Kopieren');
    cmd.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

    async function run(text = cmd.value) {
      if (!text.trim()) { toast('Bitte zuerst einen Befehl eingeben', 'warn'); return; }
      runBtn.disabled = true;
      try {
        const r = await quickAction('term.run', { cmd: text, user: user.value, cwd: cwd.value.trim() || undefined, timeout: +limit.value }, { confirmTitle: 'Riskanter Befehl', confirmText: 'Dieser Befehl kann Daten löschen oder den Server beeinträchtigen. Du kannst ihn trotzdem ausführen.' });
        follow(r.job);
      } catch (e) { if (!e.cancelled) toast(e.message, 'crit'); }
      runBtn.disabled = false;
    }

    function follow(id) {
      clearTimeout(timer);
      jobId = id;
      out.textContent = 'Wird gestartet …';
      state.className = 'badge b-info'; state.textContent = 'läuft';
      stopBtn.hidden = false;
      const tick = async () => {
        if (jobId !== id || polling) return;
        polling = true;
        try {
          const r = (await api.post('/api/action', { op: 'job.get', args: { id } })).result;
          const atEnd = out.scrollTop + out.clientHeight >= out.scrollHeight - 40;
          out.textContent = r.text || (r.done ? '(keine Ausgabe)' : 'Läuft …');
          if (atEnd) out.scrollTop = out.scrollHeight;
          if (r.done) {
            state.className = `badge ${r.killed ? 'b-warn' : r.exit === 0 ? 'b-ok' : 'b-crit'}`;
            state.textContent = r.killed ? 'abgebrochen' : r.exit === 0 ? 'fertig (Exit 0)' : `Exit ${r.exit}`;
            stopBtn.hidden = true;
            polling = false; loadHistory();
            return;
          }
        } catch (e) { out.textContent = e.message; stopBtn.hidden = true; polling = false; return; }
        polling = false;
        timer = setTimeout(tick, 900);
      };
      tick();
    }
    async function stop() {
      if (!jobId) return;
      try { await api.post('/api/action', { op: 'job.stop', args: { id: jobId } }); toast('Befehl abgebrochen'); } catch (e) { toast(e.message, 'crit'); }
    }
    ctx.own({ destroy() { clearTimeout(timer); jobId = null; } });

    // ---- saved commands
    const savedBox = h('div', { class: 'snips' });
    async function saveSnippets(list) {
      data = await api.put('/api/userdata', { snippets: list });
      renderSaved();
    }
    function renderSaved() {
      const list = data.snippets || [];
      savedBox.replaceChildren(...(list.length ? list.map((s) => h('div', { class: 'snip' },
        h('button', { type: 'button', class: 'snip-main', title: 'In das Eingabefeld übernehmen', onClick: () => { cmd.value = s.cmd; user.value = [...user.options].some((o) => o.value === s.user) ? s.user : 'root'; cwd.value = s.cwd || ''; cmd.focus(); } }, h('b', null, s.name), h('code', null, s.cmd.split('\n')[0].slice(0, 70))),
        h('button', { type: 'button', class: 'btn sm icon-only ghost', title: 'Sofort ausführen', 'aria-label': 'Ausführen', onClick: () => { cmd.value = s.cmd; user.value = s.user; cwd.value = s.cwd || ''; run(s.cmd); } }, icon('play', 13)),
        h('button', { type: 'button', class: 'btn sm icon-only ghost', title: 'Löschen', 'aria-label': 'Löschen', onClick: async () => { if (await confirmDialog({ title: 'Gespeicherten Befehl löschen?', text: s.name, okLabel: 'Löschen', danger: true })) saveSnippets(list.filter((x) => x.id !== s.id)).catch((e) => toast(e.message, 'crit')); } }, icon('trash', 13)))) : [h('p', { class: 'muted' }, 'Noch nichts gespeichert. Schreibe einen Befehl ins Feld und klicke auf „Speichern“.')]));
    }
    const saveBtn = h('button', { type: 'button', class: 'btn', onClick: () => {
      if (!cmd.value.trim()) { toast('Bitte zuerst einen Befehl eingeben', 'warn'); return; }
      const f = fieldEl({ name: 'name', label: 'Name', value: cmd.value.trim().split('\n')[0].slice(0, 40) });
      modal({ title: 'Befehl speichern', body: f.el, buttons: [{ label: 'Abbrechen' }, { label: 'Speichern', kind: 'primary', onClick: async () => {
        try { await saveSnippets([...(data.snippets || []), { name: f.get(), cmd: cmd.value, user: user.value, cwd: cwd.value.trim() }]); toast('Gespeichert'); } catch (e) { toast(e.message, 'crit'); return false; }
      } }] });
    } }, icon('check', 14), 'Speichern');

    const presetBox = h('div', { class: 'presets' }, ...PRESETS.map(([group, items], i) => h('details', { open: i === 0 ? '' : null }, h('summary', null, group), ...items.map(([name, c]) => h('button', { type: 'button', class: 'preset', title: c, onClick: () => { cmd.value = c; cmd.focus(); } }, name)))));

    // ---- history
    const hist = dataTable({
      columns: [
        { key: 'title', label: 'Auftrag', cls: 'wrap tbl-title', fmt: (v) => v.replace(/^Befehl: /, '') },
        { key: 'startedAt', label: 'Gestartet', fmt: (v) => h('span', null, tShort(v), h('small', { class: 'sub' }, ago(v))) },
        { key: 'done', label: 'Status', sort: (r) => (r.done ? (r.exit === 0 ? 1 : 2) : 0), fmt: (v, r) => (!r.done ? badge('läuft', 'info') : r.killed ? badge('abgebrochen', 'warn') : r.exit === 0 ? badge('fertig', 'ok') : badge(`Exit ${r.exit}`, 'crit')) },
      ],
      sort: { key: 'startedAt', dir: 'desc' }, dense: true, pageSize: 12, empty: 'Noch keine Aufträge.',
      onRow: (r) => { follow(r.id); out.scrollIntoView({ behavior: 'smooth', block: 'center' }); },
    });
    async function loadHistory() {
      try { const r = await readOp('job.list'); hist.setRows(r.jobs); } catch {}
    }

    const main = card({ title: 'Befehl ausführen', sub: 'Läuft mit Root-Rechten, wenn du keinen anderen Benutzer wählst. Jede Ausführung wird im Ereignisprotokoll festgehalten.', span: 8 },
      cmd,
      h('div', { class: 'row', style: { marginTop: '12px', flexWrap: 'wrap', gap: '8px' } }, user, cwd, limit, saveBtn, stopBtn, runBtn),
      h('div', { class: 'out-bar' }, h('span', null, 'Ausgabe ', state), h('span', { class: 'grow' }), copyBtn, clearBtn), out);
    const side = h('div', { class: 's-4 stack' },
      card({ title: 'Gespeicherte Befehle', sub: 'Deine eigenen, auf dem Server abgelegt.', span: 12 }, savedBox),
      card({ title: 'Beispiele', sub: 'Anklicken, prüfen, ausführen.', span: 12 }, presetBox));
    root.append(h('div', { class: 'grid' }, main, side, card({ title: 'Verlauf', sub: 'Die letzten Aufträge (auch von anderen Ansichten). Anklicken zeigt die Ausgabe.', span: 12 }, hist.el)));

    (async () => {
      try { data = await api.get('/api/userdata'); } catch {}
      renderSaved();
      try {
        const u = await readOp('users.list');
        users = u.users.filter((x) => x.uid === 0 || (x.uid >= 1000 && !x.noLogin)).map((x) => x.name);
        user.replaceChildren(...[...new Set(['root', ...users])].map((n) => h('option', { value: n }, n)));
      } catch {}
      loadHistory();
    })();
    ctx.every(() => { if (!document.hidden) loadHistory(); }, 15_000);
    void emptyState;
  },
};
