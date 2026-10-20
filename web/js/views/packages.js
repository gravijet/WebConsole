// Updates and packages (apt): what can be updated, install, remove, hold, clean up.

import { h, icon } from '../dom.js';
import { kpi, card, dataTable, badge, tabs, toast, banner, emptyState } from '../widgets.js';
import { num, tShort, rel, B } from '../fmt.js';
import { readOp, actionDialog } from '../interact.js';

export default {
  id: 'packages', title: 'Updates & Pakete', group: 'Verwalten', icon: 'packages', range: false, desc: 'Updates einspielen, Pakete installieren, entfernen und aufräumen', keywords: 'apt update upgrade installieren kernel debian sicherheit',
  mount(root, ctx) {
    let st = null; let busy = false;
    const K = {};
    const mk = (id, label, color, ic) => { K[id] = kpi({ label, color, span: 2, icon: ic }); return K[id].el; };
    const banners = h('div', { class: 's-12' });
    const panes = { updates: h('div'), installed: h('div'), install: h('div'), kernels: h('div') };
    const t = tabs([{ id: 'updates', label: 'Updates' }, { id: 'installed', label: 'Installiert' }, { id: 'install', label: 'Neu installieren' }, { id: 'kernels', label: 'Kernel' }], 'updates', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; });
    for (const k of ['installed', 'install', 'kernels']) panes[k].hidden = true;

    const holdBtn = (name, on) => h('button', { type: 'button', class: 'btn sm', onClick: () => actionDialog({ op: 'pkg.hold', args: { name, on }, title: on ? 'Version festhalten' : 'Festhalten aufheben', lead: name, text: on ? 'Das Paket wird bei Updates übersprungen.' : 'Das Paket wird bei Updates wieder berücksichtigt.', okLabel: on ? 'Festhalten' : 'Freigeben', success: on ? 'Paket festgehalten' : 'Paket freigegeben', after: () => setTimeout(load, 600) }) }, on ? 'Festhalten' : 'Freigeben');
    const updates = dataTable({
      columns: [
        { key: 'name', label: 'Paket', cls: 'tbl-title' }, { key: 'from', label: 'Installiert', cls: 'mono dim' }, { key: 'version', label: 'Neu', cls: 'mono' },
        { key: 'security', label: 'Art', sort: (r) => (r.security ? 0 : 1), fmt: (v) => (v ? badge('Sicherheit', 'crit') : badge('normal', 'neutral')) }, { key: 'suite', label: 'Quelle', cls: 'dim' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => holdBtn(r.name, true) },
      ],
      search: true, searchPlaceholder: 'Update suchen …', sort: { key: 'security', dir: 'asc' }, dense: true, pageSize: 100, empty: 'Alles aktuell. Es gibt keine Updates.',
    });
    panes.updates.append(card({ span: 12 }, updates.el));

    const inst = dataTable({
      columns: [
        { key: 'name', label: 'Paket', cls: 'tbl-title' }, { key: 'version', label: 'Version', cls: 'mono dim' }, { key: 'sizeKb', label: 'Größe', align: 'r', fmt: (v) => B(v * 1024) },
        { key: 'summary', label: 'Beschreibung', cls: 'wrap dim' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => h('span', null, holdBtn(r.name, !(st && st.held.includes(r.name))), h('button', { type: 'button', class: 'btn sm danger', onClick: () => removeDialog([r.name]) }, 'Entfernen')) },
      ],
      sort: { key: 'name', dir: 'asc' }, dense: true, pageSize: 100, empty: 'Keine Treffer.',
    });
    const q = h('input', { type: 'search', class: 'tbl-search', placeholder: 'Installierte Pakete suchen (Name oder Beschreibung) …', 'aria-label': 'Installierte Pakete suchen' });
    const instInfo = h('span', { class: 'tbl-info' });
    let qt = null;
    q.addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(loadInstalled, 300); });
    panes.installed.append(card({ span: 12 }, h('div', { class: 'tbl-bar' }, q, h('span', { class: 'grow' }), instInfo), inst.el));
    async function loadInstalled() {
      try { const r = await readOp('pkg.installed', { q: q.value.trim() }); inst.setRows(r.list); instInfo.textContent = `${num(r.matches)} Treffer von ${num(r.total)} Paketen${r.matches > r.list.length ? ' (die ersten 500 werden angezeigt)' : ''}`; } catch (e) { toast(e.message, 'crit'); }
    }

    const sq = h('input', { type: 'search', class: 'tbl-search', placeholder: 'Paket im Debian-Archiv suchen (z. B. htop, ncdu, rsync) …', 'aria-label': 'Paket suchen' });
    const results = dataTable({
      columns: [
        { key: 'name', label: 'Paket', cls: 'tbl-title' }, { key: 'summary', label: 'Beschreibung', cls: 'wrap dim' },
        { key: 'act', label: '', sortable: false, cls: 'acts', fmt: (v, r) => (h('button', { type: 'button', class: 'btn sm primary', onClick: () => actionDialog({ op: 'pkg.install', args: { names: [r.name] }, title: 'Paket installieren', lead: r.name, text: r.summary, okLabel: 'Installieren', success: 'Installation gestartet', after: () => setTimeout(load, 800) }) }, icon('download', 13), 'Installieren')) },
      ],
      sort: { key: 'name', dir: 'asc' }, dense: true, pageSize: 100, empty: 'Gib oben einen Suchbegriff ein und drücke Enter.',
    });
    sq.addEventListener('keydown', async (e) => { if (e.key !== 'Enter') return; try { const r = await readOp('pkg.search', { q: sq.value.trim() }); results.setRows(r.list); } catch (er) { toast(er.message, 'crit'); } });
    panes.install.append(card({ span: 12 }, h('div', { class: 'tbl-bar' }, sq), results.el));
    const kernelBox = h('div'); panes.kernels.append(card({ title: 'Kernel', sub: 'Der laufende Kernel und alle installierten Versionen.', span: 12 }, kernelBox));

    function removeDialog(names) {
      return actionDialog({ op: 'pkg.remove', args: (v) => ({ names, purge: !!v.purge }), title: 'Paket entfernen', lead: names.join(', '), text: 'Das Paket wird deinstalliert. Würden dabei weitere Pakete mitgelöscht, wird das aus Sicherheitsgründen verweigert.', fields: [{ name: 'purge', label: 'Auch Konfigurationsdateien löschen (purge)', type: 'checkbox', value: false }], danger: true, okLabel: 'Entfernen', success: 'Entfernen gestartet', after: () => setTimeout(load, 800) });
    }

    const bar = h('div', { class: 'row s-12' },
      h('button', { type: 'button', class: 'btn', onClick: () => actionDialog({ op: 'pkg.update', args: {}, title: 'Paketlisten aktualisieren', lead: 'apt update', text: 'Fragt die Paketquellen nach neuen Versionen. Es wird nichts installiert.', okLabel: 'Aktualisieren', success: 'Gestartet', after: () => setTimeout(load, 500) }) }, icon('refresh', 15), 'Paketlisten aktualisieren'),
      h('button', { type: 'button', class: 'btn primary', onClick: () => actionDialog({ op: 'pkg.upgrade', args: {}, title: 'Alle Updates installieren', lead: 'apt upgrade', text: h('div', null, h('p', null, 'Installiert alle verfügbaren Updates. Dienste mit neuen Programmdateien werden dabei unter Umständen neu gestartet; kurze Unterbrechungen sind möglich.'), st && st.upgradable.length ? h('p', { class: 'muted' }, `${st.upgradable.length} Pakete: ${st.upgradable.slice(0, 8).map((p) => p.name).join(', ')}${st.upgradable.length > 8 ? ' …' : ''}`) : null), okLabel: 'Updates installieren', success: 'Update gestartet', after: () => setTimeout(load, 800) }) }, icon('download', 15), 'Alle Updates installieren'),
      h('button', { type: 'button', class: 'btn', onClick: () => actionDialog({ op: 'pkg.autoremove', args: {}, title: 'Nicht benötigte Pakete entfernen', lead: 'apt autoremove', text: st && st.removable.length ? `Entfernt: ${st.removable.join(', ')}` : 'Entfernt Pakete, die nur als Abhängigkeit installiert wurden und nicht mehr gebraucht werden.', okLabel: 'Aufräumen', success: 'Gestartet', after: () => setTimeout(load, 800) }) }, icon('trash', 15), 'Aufräumen'),
      h('button', { type: 'button', class: 'btn', onClick: () => actionDialog({ op: 'pkg.clean', args: {}, title: 'Zwischenspeicher leeren', lead: 'apt clean', text: 'Löscht heruntergeladene .deb-Dateien. Gibt Platz frei.', okLabel: 'Leeren', success: 'Gestartet' }) }, 'Zwischenspeicher leeren'));

    root.append(h('div', { class: 'grid' }, mk('u', 'Updates verfügbar', 'c1', 'download'), mk('s', 'Sicherheits-Updates', 'c8', 'shield'), mk('i', 'Installierte Pakete', 'c4', 'packages'), mk('a', 'Nicht mehr benötigt', 'c3', 'trash'), mk('l', 'Paketlisten', 'c2', 'clock'), mk('r', 'Neustart nötig', 'c9', 'power'), banners, bar, h('div', { class: 's-12' }, t.el, panes.updates, panes.installed, panes.install, panes.kernels)));

    function render() {
      const sec = st.upgradable.filter((p) => p.security).length;
      K.u.set({ value: String(st.upgradable.length), sub: st.upgradable.length ? 'bereit zur Installation' : 'alles aktuell', level: st.upgradable.length ? 'warn' : 'ok', color: 'c1' });
      K.s.set({ value: String(sec), sub: sec ? 'bitte bald installieren' : 'keine offen', level: sec ? 'crit' : 'ok', color: 'c8' });
      K.i.set({ value: num(st.installed), sub: `${st.held.length} festgehalten`, color: 'c4' });
      K.a.set({ value: String(st.removable.length), sub: st.removable.length ? st.removable.slice(0, 2).join(', ') : 'nichts zu entfernen', color: 'c3' });
      K.l.set({ value: st.lastUpdate ? rel(st.lastUpdate).replace(/^vor /, '') : '–', sub: st.lastUpdate ? `zuletzt ${tShort(st.lastUpdate)}` : 'unbekannt', level: st.lastUpdate && Date.now() - st.lastUpdate > 7 * 86400_000 ? 'warn' : '', color: 'c2' });
      K.r.set({ value: st.reboot ? 'Ja' : 'Nein', sub: st.reboot ? st.rebootPkgs.join(', ') || 'durch Updates' : 'kein Neustart nötig', level: st.reboot ? 'warn' : 'ok', color: 'c9' });
      t.setBadge('updates', st.upgradable.length || '', sec ? 'crit' : 'warn');
      banners.replaceChildren(...[st.reboot ? banner('warn', 'Ein Neustart ist nötig', `Aktualisierte Pakete (${st.rebootPkgs.join(', ') || 'Kernel'}) wirken erst nach einem Neustart. Gehe zu System → Server neu starten, wenn es dir passt.`) : null, sec ? banner('crit', `${sec} Sicherheits-Updates verfügbar`, 'Sie schließen bekannte Schwachstellen. Installiere sie zeitnah.') : null].filter(Boolean));
      updates.setRows(st.upgradable);
      kernelBox.replaceChildren(h('dl', { class: 'kv' }, h('dt', null, 'Laufender Kernel'), h('dd', null, st.running), ...st.kernels.flatMap((k, i) => [h('dt', null, i ? '' : 'Installiert'), h('dd', { class: 'mono' }, k.replace(/^linux-image-/, ''))])), st.kernels.length > 1 ? h('p', { class: 'muted', style: { marginTop: '10px' } }, 'Mehrere Kernel sind installiert. Ältere kannst du nach einem erfolgreichen Neustart über „Aufräumen“ entfernen lassen, sobald sie nicht mehr benötigt werden.') : null);
    }
    async function load() {
      if (busy) return; busy = true;
      try { st = await readOp('pkg.status'); render(); } catch (e) { toast(e.message, 'crit'); }
      busy = false;
    }
    ctx.every(() => { if (!document.hidden) load(); }, 120_000);
    load(); loadInstalled();
    void emptyState;
  },
};
