// Docker: containers, images, volumes, networks, compose projects and clean-up.

import { h, icon } from '../dom.js';
import { grid, kpi, card, dataTable, badge, meter, tabs, tiles, banner, toast, emptyState } from '../widgets.js';
import { B, num, tShort, rel } from '../fmt.js';
import { api } from '../store.js';
import { dockerBtn, trigger, menu, actionDialog, readOp, containerDetail, logModal } from '../interact.js';

const stateBadge = (c) => {
  if (c.paused) return badge('pausiert', 'warn');
  if (c.state === 'running') return badge('läuft', 'ok');
  if (c.state === 'restarting') return badge('startet neu', 'warn');
  if (c.state === 'exited') return badge(`beendet (${c.exitCode})`, c.exitCode ? 'crit' : 'neutral');
  return badge(c.state, 'neutral');
};
const shortImage = (s) => (s || '').replace(/@sha256:[0-9a-f]+$/, '');

export default {
  id: 'docker', title: 'Docker', group: 'Verwalten', icon: 'docker', range: false, desc: 'Container, Images, Volumes, Netzwerke und Compose-Projekte', keywords: 'container image volume compose mailcow prune',
  mount(root, ctx) {
    const { store } = ctx;
    let inv = null; let live = new Map(); let busy = false;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 2, icon: ic }); return K[id].el; };
    const panes = { containers: h('div'), compose: h('div'), images: h('div'), volumes: h('div'), networks: h('div'), prune: h('div') };
    const t = tabs([
      { id: 'containers', label: 'Container', icon: 'docker' }, { id: 'compose', label: 'Compose-Projekte', icon: 'layers' }, { id: 'images', label: 'Images', icon: 'image' },
      { id: 'volumes', label: 'Volumes', icon: 'archive' }, { id: 'networks', label: 'Netzwerke', icon: 'network' }, { id: 'prune', label: 'Aufräumen', icon: 'trash' },
    ].map((x) => ({ ...x, icon: x.icon === 'layers' ? 'service' : x.icon })), 'containers', (id) => show(id));
    const show = (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; try { localStorage.setItem('sd.docker.tab', id); } catch {} };

    // ---- containers
    const cFilters = [
      { label: 'Alle', fn: () => true }, { label: 'Laufend', fn: (r) => r.state === 'running' && !r.paused }, { label: 'Gestoppt', fn: (r) => r.state !== 'running' }, { label: 'Probleme', fn: (r) => r.state !== 'running' || r.health === 'unhealthy' || r.restarts > 0 },
    ];
    const ctable = dataTable({
      columns: [
        { key: 'name', label: 'Container', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, r.compose ? h('small', { class: 'sub' }, r.compose.project) : null) },
        { key: 'state', label: 'Zustand', sort: (r) => `${r.state}${r.paused}`, fmt: (v, r) => h('span', null, stateBadge(r), r.health ? h('small', { class: 'sub' }, `Health: ${r.health}`) : null) },
        { key: 'cpu', label: 'CPU', align: 'r', fmt: (v) => (v == null ? '–' : meter(v, 100, { text: `${num(v, 1)} %`, tone: 'info' })) },
        { key: 'memUsage', label: 'RAM', align: 'r', fmt: (v, r) => (v == null ? '–' : meter(v, r.memLimit || store.info.ram, { text: B(v), tone: 'info' })) },
        { key: 'ports', label: 'Ports', cls: 'wrap', sort: (r) => (r.ports || []).join(), fmt: (v) => (v && v.length ? v.slice(0, 4).join(', ') + (v.length > 4 ? ` +${v.length - 4}` : '') : '–') },
        { key: 'image', label: 'Image', cls: 'wrap dim', fmt: shortImage },
        { key: 'restartPolicy', label: 'Neustart-Regel' }, { key: 'restarts', label: 'Neustarts', align: 'r', fmt: (v) => (v > 0 ? badge(String(v), 'warn') : '0') },
        { key: 'started', label: 'Gestartet', align: 'r', fmt: (v, r) => (r.state === 'running' && v ? rel(v) : '–'), sort: (r) => r.started || 0 },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => dockerBtn(r, () => setTimeout(load, 1200)) },
      ],
      search: true, searchPlaceholder: 'Container suchen …', sort: { key: 'name', dir: 'asc' }, dense: true, pageSize: 100, filters: cFilters,
      rowClass: (r) => (r.state !== 'running' || r.health === 'unhealthy' ? 'row-warn' : ''), onRow: (r) => containerDetail(r.name, () => setTimeout(load, 1200)),
    });
    panes.containers.append(card({ span: 12 }, ctable.el));

    // ---- compose
    const composeBox = h('div', { class: 'grid' });
    panes.compose.append(composeBox);
    const composeAct = (p, action, label, text, danger) => actionDialog({ op: 'docker.compose', args: { project: p.name, action }, title: `${label}`, lead: p.name, text, okLabel: label, danger, success: `${label} gestartet`, after: () => setTimeout(load, 1500) });

    // ---- images
    const itable = dataTable({
      columns: [
        { key: 'tags', label: 'Image', cls: 'wrap tbl-title', sort: (r) => (r.tags[0] || '~'), fmt: (v, r) => (v.length ? h('span', null, ...v.map((x) => h('div', null, x))) : h('span', { class: 'muted' }, '<ohne Namen>')) },
        { key: 'id', label: 'ID', cls: 'mono dim' }, { key: 'size', label: 'Größe', align: 'r', fmt: B }, { key: 'created', label: 'Erstellt', align: 'r', fmt: (v) => rel(v) },
        { key: 'usedBy', label: 'Verwendet von', cls: 'wrap', sort: (r) => r.usedBy.length, fmt: (v) => (v.length ? h('span', { class: 'pill-list' }, ...v.slice(0, 3).map((n) => h('span', { class: 'tag' }, n)), v.length > 3 ? h('span', { class: 'muted' }, `+${v.length - 3}`) : null) : badge('unbenutzt', 'warn')) },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'docker.image-remove', args: { id: r.tags[0] && r.tags.length === 1 ? r.tags[0] : r.id }, title: 'Image entfernen', lead: r.tags[0] || r.id, text: r.usedBy.length ? 'Dieses Image wird von Containern benutzt. Docker verweigert das Entfernen, solange sie existieren.' : 'Das Image wird gelöscht. Beim nächsten Start wird es erneut heruntergeladen.', danger: true, okLabel: 'Entfernen', success: 'Image entfernt', after: () => setTimeout(load, 800) }) }, 'Entfernen') },
      ],
      search: true, searchPlaceholder: 'Image suchen …', sort: { key: 'size', dir: 'desc' }, dense: true, pageSize: 100,
    });
    const pullBtn = h('button', { type: 'button', class: 'btn primary sm', onClick: () => actionDialog({ op: 'docker.image-pull', args: (v) => ({ ref: v.ref.trim() }), title: 'Image laden', lead: 'docker pull', fields: [{ name: 'ref', label: 'Image-Name', type: 'text', placeholder: 'z. B. nginx:latest', hint: 'Name mit optionalem Tag, bei Bedarf mit Registry davor.' }], validate: (v) => (v.ref.trim() ? null : 'Bitte einen Image-Namen angeben.'), okLabel: 'Laden', success: 'Download gestartet', after: () => setTimeout(load, 800) }) }, icon('download', 14), 'Image laden');
    panes.images.append(card({ span: 12, actions: pullBtn }, itable.el));

    // ---- volumes
    const vtable = dataTable({
      columns: [
        { key: 'name', label: 'Volume', cls: 'tbl-title wrap', fmt: (v) => (v.length > 40 ? h('span', { class: 'mono', title: v }, `${v.slice(0, 18)}…${v.slice(-12)}`) : v) },
        { key: 'size', label: 'Größe', align: 'r', fmt: (v) => (v == null ? '–' : B(v)) },
        { key: 'usedBy', label: 'Verwendet von', cls: 'wrap', sort: (r) => r.usedBy.length, fmt: (v) => (v.length ? h('span', { class: 'pill-list' }, ...v.slice(0, 3).map((n) => h('span', { class: 'tag' }, n))) : badge('unbenutzt', 'warn')) },
        { key: 'driver', label: 'Treiber' }, { key: 'mountpoint', label: 'Speicherort', cls: 'mono dim wrap' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'docker.volume-remove', args: { name: r.name }, title: 'Volume entfernen', lead: r.name, text: r.usedBy.length ? 'Dieses Volume wird noch benutzt. Docker verweigert das Entfernen.' : 'Alle Daten in diesem Volume gehen unwiderruflich verloren.', danger: true, word: r.name.length > 30 ? 'VOLUME' : r.name, okLabel: 'Entfernen', success: 'Volume entfernt', after: () => setTimeout(load, 800) }) }, 'Entfernen') },
      ],
      search: true, searchPlaceholder: 'Volume suchen …', sort: { key: 'size', dir: 'desc' }, dense: true, pageSize: 100,
    });
    panes.volumes.append(card({ span: 12 }, vtable.el));

    // ---- networks
    const ntable = dataTable({
      columns: [
        { key: 'name', label: 'Netzwerk', cls: 'tbl-title' }, { key: 'driver', label: 'Treiber' }, { key: 'scope', label: 'Reichweite' },
        { key: 'subnets', label: 'Subnetze', cls: 'mono', fmt: (v) => (v.length ? v.join(', ') : '–') }, { key: 'internal', label: 'Intern', fmt: (v) => (v ? 'ja' : 'nein') },
        { key: 'containers', label: 'Container', cls: 'wrap', sort: (r) => r.containers.length, fmt: (v) => (v.length ? h('span', { class: 'pill-list' }, ...v.slice(0, 4).map((n) => h('span', { class: 'tag' }, n.replace(/^mailcowdockerized-/, '').replace(/-1$/, ''))), v.length > 4 ? h('span', { class: 'muted' }, `+${v.length - 4}`) : null) : '–') },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => (r.builtin ? h('span', { class: 'muted' }, 'eingebaut') : h('button', { type: 'button', class: 'btn sm danger', onClick: () => actionDialog({ op: 'docker.network-remove', args: { name: r.name }, title: 'Netzwerk entfernen', lead: r.name, text: r.containers.length ? 'Es sind noch Container verbunden. Docker verweigert das Entfernen.' : 'Das Netzwerk wird gelöscht.', danger: true, okLabel: 'Entfernen', success: 'Netzwerk entfernt', after: () => setTimeout(load, 800) }) }, 'Entfernen')) },
      ],
      dense: true, sort: { key: 'name', dir: 'asc' },
    });
    panes.networks.append(card({ span: 12 }, ntable.el));

    // ---- prune
    const usageBox = h('div'); const infoBox = h('div'); const pruneBox = h('div', { class: 'grid' });
    panes.prune.append(h('div', { class: 'grid' }, card({ title: 'Speicherbedarf von Docker', sub: 'Was Docker auf der Festplatte belegt und was sich zurückholen ließe.', span: 8 }, usageBox), card({ title: 'Docker-Dienst', span: 4 }, infoBox), pruneBox));
    const PRUNES = [
      ['containers', 'Gestoppte Container', 'Entfernt alle beendeten Container.', false],
      ['images', 'Unbenutzte Images (ohne Namen)', 'Entfernt Zwischenstände und alte Versionen, die keinen Namen mehr tragen.', false],
      ['images-all', 'Alle unbenutzten Images', 'Entfernt jedes Image, das kein Container benutzt. Beim nächsten Start werden sie neu geladen.', false],
      ['networks', 'Unbenutzte Netzwerke', 'Entfernt Netzwerke ohne Container.', false],
      ['builder', 'Build-Cache', 'Entfernt zwischengespeicherte Build-Schritte.', false],
      ['volumes', 'Unbenutzte Volumes', 'Entfernt alle Volumes, die kein Container benutzt. Daten darin sind unwiderruflich weg.', true],
    ];
    for (const [kind, title, text, danger] of PRUNES) {
      pruneBox.append(card({ title, span: 4 }, h('p', { class: 'muted', style: { marginBottom: '12px' } }, text), h('button', { type: 'button', class: `btn sm ${danger ? 'danger' : ''}`, onClick: () => actionDialog({ op: 'docker.prune', args: { kind }, title: `Aufräumen: ${title}`, lead: 'docker prune', text, danger, okLabel: 'Aufräumen', success: (r) => `Aufgeräumt, ${r.reclaimed} frei`, after: () => setTimeout(load, 800) }) }, icon('trash', 14), 'Aufräumen')));
    }

    root.append(h('div', { class: 'grid' },
      mk('c', 'Container', 'c5', 'docker'), mk('i', 'Images', 'c4', 'image'), mk('v', 'Volumes', 'c2', 'archive'), mk('n', 'Netzwerke', 'c1', 'network'), mk('s', 'Speicher durch Docker', 'c9', 'disk'), mk('r', 'Zurückholbar', 'c7', 'trash'),
      h('div', { class: 's-12' }, t.el, panes.containers, panes.compose, panes.images, panes.volumes, panes.networks, panes.prune)));
    let initial = 'containers';
    try { initial = localStorage.getItem('sd.docker.tab') || 'containers'; } catch {}
    if (!panes[initial]) initial = 'containers';
    t.set(initial); show(initial);
    for (const p of Object.values(panes)) p.append(h('p', { class: 'muted loading' }, 'Lade …'));

    // ---- data
    function liveMerge() {
      const dk = store.detail && store.detail.docker;
      live = new Map(((dk && dk.containers) || []).map((c) => [c.name, c]));
    }
    function renderContainers() {
      if (!inv) return;
      liveMerge();
      ctable.setRows(inv.containers.map((c) => { const l = live.get(c.name) || {}; return { ...c, cpu: l.cpu ?? null, memUsage: l.memUsage ?? null, memLimit: l.memLimit ?? null }; }));
    }
    function render() {
      const running = inv.containers.filter((c) => c.state === 'running').length;
      const problems = inv.containers.filter((c) => c.state !== 'running' || c.health === 'unhealthy').length;
      const u = Object.fromEntries(inv.usage.map((x) => [x.type, x]));
      const total = inv.usage.reduce((a, b) => a + (b.size || 0), 0); const rec = inv.usage.reduce((a, b) => a + (b.reclaimable || 0), 0);
      const imgSize = inv.images.reduce((a, b) => a + b.size, 0);
      K.c.set({ value: String(running), unit: `von ${inv.containers.length}`, sub: problems ? `${problems} mit Problemen` : 'alle in Ordnung', level: problems ? 'warn' : 'ok', color: 'c5' });
      K.i.set({ value: String(inv.images.length), sub: `${B(imgSize)} gesamt · ${inv.images.filter((i) => !i.usedBy.length).length} unbenutzt`, color: 'c4' });
      K.v.set({ value: String(inv.volumes.length), sub: `${B(inv.volumes.reduce((a, b) => a + (b.size || 0), 0))} gesamt · ${inv.volumes.filter((v) => !v.usedBy.length).length} unbenutzt`, color: 'c2' });
      K.n.set({ value: String(inv.networks.length), sub: `${inv.networks.filter((n) => !n.builtin).length} eigene`, color: 'c1' });
      K.s.set({ value: B(total).split(' ')[0], unit: B(total).split(' ')[1], sub: `Images ${B((u.Images || {}).size || 0)} · Volumes ${B((u['Local Volumes'] || {}).size || 0)}`, color: 'c9' });
      K.r.set({ value: B(rec).split(' ')[0], unit: B(rec).split(' ')[1], sub: 'durch Aufräumen frei', color: 'c7' });
      t.setBadge('containers', problems || '', problems ? 'warn' : 'neutral');
      renderContainers();
      // compose
      composeBox.replaceChildren(...(inv.projects.length ? inv.projects.map((p) => {
        const members = inv.containers.filter((c) => c.compose && c.compose.project === p.name);
        return card({ title: p.name, sub: p.dir || '', span: 6, actions: badge(`${p.running}/${p.total} laufen`, p.running === p.total ? 'ok' : 'warn') },
          h('div', { class: 'pill-list', style: { marginBottom: '14px' } }, ...members.map((c) => h('span', { class: `tag`, style: { borderColor: c.state === 'running' ? 'var(--ok-line)' : 'var(--warn-line)' } }, `${c.compose.service} · ${c.state === 'running' ? 'läuft' : c.state}`))),
          h('div', { class: 'row' },
            h('button', { type: 'button', class: 'btn sm', onClick: () => composeAct(p, 'up', 'Starten / aktualisieren', 'Startet fehlende Container und wendet Änderungen der Compose-Datei an (docker compose up -d).') }, icon('play', 13), 'Starten'),
            h('button', { type: 'button', class: 'btn sm', onClick: () => composeAct(p, 'restart', 'Neu starten', 'Startet alle Container des Projekts neu.') }, icon('refresh', 13), 'Neu starten'),
            h('button', { type: 'button', class: 'btn sm', onClick: () => composeAct(p, 'pull', 'Images aktualisieren', 'Lädt neuere Versionen der Images. Die Container laufen mit den alten weiter, bis du „Starten / aktualisieren“ wählst.') }, icon('download', 13), 'Images laden'),
            h('button', { type: 'button', class: 'btn sm danger', onClick: () => composeAct(p, 'stop', 'Stoppen', 'Stoppt alle Container des Projekts. Bei einem Mailserver heißt das: keine E-Mails, bis du wieder startest.', true) }, icon('stop', 13), 'Stoppen'),
            h('button', { type: 'button', class: 'btn sm danger', onClick: () => composeAct(p, 'down', 'Herunterfahren und entfernen', 'Stoppt und entfernt alle Container und Netzwerke des Projekts. Volumes und Daten bleiben erhalten.', true) }, icon('power', 13), 'Herunterfahren')));
      }) : [h('div', { class: 's-12' }, emptyState('Keine Compose-Projekte', 'Es laufen keine Container, die mit Docker Compose gestartet wurden.', 'docker'))]));
      itable.setRows(inv.images);
      vtable.setRows(inv.volumes);
      ntable.setRows(inv.networks);
      usageBox.replaceChildren(h('div', { class: 'tbl-wrap' }, h('table', { class: 'tbl dense' }, h('thead', null, h('tr', null, ...['Art', 'Gesamt', 'Aktiv', 'Größe', 'Zurückholbar'].map((x, i) => h('th', { class: i ? 'r' : '' }, x)))), h('tbody', null, ...inv.usage.map((x) => h('tr', null, h('td', { class: 'tbl-title' }, { Images: 'Images', Containers: 'Container', 'Local Volumes': 'Volumes', 'Build Cache': 'Build-Cache' }[x.type] || x.type), h('td', { class: 'r' }, num(x.total)), h('td', { class: 'r' }, num(x.active)), h('td', { class: 'r' }, B(x.size || 0)), h('td', { class: 'r' }, B(x.reclaimable || 0))))))));
      const i = inv.info;
      infoBox.replaceChildren(h('dl', { class: 'kv' }, ...[['Version', i.version], ['Speichertreiber', i.driver], ['Datenverzeichnis', i.root], ['Cgroup', i.cgroup], ['Log-Treiber', i.logging], ['Laufzeit', i.runtime], ['Kernel', i.kernel]].flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v == null ? '–' : String(v))])));
      for (const p of Object.values(panes)) for (const l of [...p.querySelectorAll(':scope > .loading')]) l.remove();
    }
    async function load() {
      if (busy) return;
      busy = true;
      try { inv = await readOp('docker.inventory'); render(); } catch (e) { toast(e.message, 'crit'); for (const p of Object.values(panes)) for (const l of [...p.querySelectorAll(':scope > .loading')]) l.textContent = e.message; }
      busy = false;
    }
    ctx.on('detail', () => renderContainers());
    ctx.every(() => { if (!document.hidden) load(); }, 30_000);
    load();
    void api; void trigger; void menu; void logModal; void tiles; void banner; void tShort; void grid;
  },
};
