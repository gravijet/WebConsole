import { h, icon } from '../dom.js';
import { grid, card, toast } from '../widgets.js';
import { num, B, tFull } from '../fmt.js';

const TITLES = {
  meminfo: ['Arbeitsspeicher', '/proc/meminfo, Werte in Byte'], vmstat: ['Virtueller Speicher', '/proc/vmstat, Zähler seit Start'], snmp: ['Netzwerk-Zähler (SNMP)', '/proc/net/snmp'],
  netstat: ['Netzwerk-Zähler (erweitert)', '/proc/net/netstat'], sockstat: ['Sockets', '/proc/net/sockstat'], stat: ['CPU-Zeiten und Zähler', '/proc/stat (Ticks)'],
  psi: ['Pressure Stall Information', '/proc/pressure/*'], limits: ['Systemgrenzen', '/proc/sys'], diskstats: ['Datenträger-Zähler', '/proc/diskstats (nur ganze Platten)'], netdev: ['Schnittstellen-Zähler', '/proc/net/dev'],
  cpuinfo: ['Prozessor', '/proc/cpuinfo (Auszug)'], swaps: ['Swap', '/proc/swaps'], mounts: ['Eingehängte Dateisysteme', '/proc/mounts'], interrupts: ['Interrupts', '/proc/interrupts (Anfang)'],
  osRelease: ['Betriebssystem', '/etc/os-release'], ifaces: ['Netzwerkgeräte', '/sys/class/net'],
};
const SCALARS = { loadavg: '/proc/loadavg', uptime: '/proc/uptime', version: '/proc/version', cmdlineBoot: 'Kernel-Kommandozeile' };

function flatten(obj, prefix = '') {
  const rows = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) rows.push(...flatten(v, key));
    else rows.push([key, Array.isArray(v) ? v.join(', ') : v]);
  }
  return rows;
}

export default {
  id: 'raw', title: 'Rohdaten', group: 'Dashboard', icon: 'raw', range: false, desc: 'Alle Messwerte, wie sie der Server liefert', keywords: 'json debug',
  mount(root, ctx) {
    const open = new Set(['meminfo']);
    let filter = '';
    let data = null;
    const box = h('div', { class: 'grid s-12' });
    const search = h('input', { type: 'search', class: 'tbl-search', placeholder: 'In allen Rohdaten suchen (z. B. Retrans, Dirty, sda) …', 'aria-label': 'Rohdaten durchsuchen', onInput: (e) => { filter = e.target.value.toLowerCase(); render(); } });
    const stamp = h('span', { class: 'tbl-info' });
    const dl = h('button', { type: 'button', class: 'btn', onClick: () => { const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }); const a = h('a', { href: URL.createObjectURL(blob), download: `xeon-1-rohdaten-${new Date().toISOString().slice(0, 19)}.json` }); document.body.append(a); a.click(); a.remove(); } }, icon('down', 14), 'Als JSON speichern');
    const cp = h('button', { type: 'button', class: 'btn', onClick: async () => { try { await navigator.clipboard.writeText(JSON.stringify(data, null, 2)); toast('In die Zwischenablage kopiert'); } catch { toast('Kopieren nicht möglich', 'crit'); } } }, icon('copy', 14), 'Kopieren');

    root.append(grid(card({ span: 12 }, h('div', { class: 'tbl-bar' }, search, h('span', { class: 'grow' }), stamp, cp, dl), h('p', { class: 'muted' }, 'Alle Werte so, wie der Kernel sie liefert. Aktualisiert alle 5 Sekunden. Abschnitte aufklappen, um die Tabelle zu sehen.')), box));

    const BYTEY = /mem|Mem|Cache|Swap|Slab|Page|Huge|Commit|Vmalloc|Dirty|Active|Inactive|Mapped|Shmem|Buffers|Anon|Kernel|Unevict|Mlock|Writeback|Bounce|Percpu|Hardware|Free|Total|Bytes|B$/;
    const rowOf = ([k, v]) => {
      const numeric = typeof v === 'number';
      const human = numeric && v >= 1048576 && BYTEY.test(k) ? B(v) : '';
      return h('tr', null, h('td', { class: 'mono' }, k), h('td', { class: 'r mono' }, numeric ? num(v) : String(v)), h('td', { class: 'r dim' }, human));
    };

    function section(key, title, sub, rows) {
      const filtered = filter ? rows.filter(([k, v]) => `${k} ${v}`.toLowerCase().includes(filter) || title.toLowerCase().includes(filter)) : rows;
      if (filter && !filtered.length) return null;
      const head = h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', { class: 'r' }, 'Wert'), h('th', { class: 'r' }, 'Lesbar')));
      const table = h('table', { class: 'tbl dense' }, head, h('tbody', null, ...filtered.map(rowOf)));
      const isOpen = open.has(key) || (filter && filtered.length);
      const d = h('details', { class: 'card s-12', open: isOpen ? '' : null },
        h('summary', { class: 'raw-sum' }, h('b', null, title), h('span', { class: 'muted' }, ` ${sub} · ${num(filtered.length)} Einträge`)),
        h('div', { class: 'tbl-wrap tall' }, table));
      d.addEventListener('toggle', () => { if (d.open) open.add(key); else open.delete(key); });
      return d;
    }

    function render() {
      if (!data) return;
      const sections = [];
      for (const [key, [title, sub]] of Object.entries(TITLES)) {
        const v = data[key];
        if (v == null) continue;
        const rows = Array.isArray(v) ? v.map((x, i) => [String(i + 1), typeof x === 'object' ? JSON.stringify(x) : x]) : flatten(v);
        const s = section(key, title, sub, rows);
        if (s) sections.push(s);
      }
      const scal = Object.entries(SCALARS).map(([k, label]) => [label, data[k]]);
      const s = section('scalars', 'Kernel und Laufzeit', 'loadavg, uptime, version, Kommandozeile', scal);
      if (s) sections.push(s);
      box.replaceChildren(...sections);
      stamp.textContent = `Stand ${tFull(data.t)}`;
    }

    async function load() {
      try { data = await ctx.api.get('/api/raw'); render(); } catch {}
    }
    ctx.every(load, 5000);
    load();
  },
};
