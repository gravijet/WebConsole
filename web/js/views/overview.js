import { h, setText, icon } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, deltaChip, badge, banner as bannerBox } from '../widgets.js';
import { BarList } from '../charts.js';
import { num, B, R, pct, dur, ago, clock, tShort, tFull } from '../fmt.js';
import { api } from '../store.js';
import { nginxReload, quickAction } from '../interact.js';
import { toast } from '../widgets.js';
import { f, CPU_SERIES, MEM_SERIES, cpuDonut, memDonut, eventRow, deltas, levelOf, ratio } from './common.js';

export default {
  id: 'overview', title: 'Übersicht', group: 'Übersicht', icon: 'overview', desc: 'Der Zustand deines Servers auf einen Blick', keywords: 'start dashboard home',
  mount(root, ctx) {
    const { store } = ctx;
    const banner = h('div', { class: 's-12' });
    const mUp = h('dd'); const mCpu = h('dd'); const mProc = h('dd'); const mNet = h('dd');
    const mastTitle = h('h2'); const mastSub = h('p', { class: 'sub' }); const mastState = h('div', { class: 'hero-state' });
    const fact = (label, dd) => h('div', null, h('dt', null, label), dd);
    const mast = h('section', { class: 'card hero s-12' }, h('div', { class: 'hero-id' }, h('div', { class: 'hero-ico' }, icon('server', 28)), h('div', null, mastTitle, mastSub, mastState)), h('dl', { class: 'hero-facts' }, fact('Laufzeit', mUp), fact('Auslastung', mCpu), fact('Prozesse', mProc), fact('Verkehr', mNet)));
    const two = (big, small) => [big, h('small', null, small)];
    const K = {};
    const mk = (id, label, color, span = 3, ic) => { K[id] = kpi({ label, color, span, icon: ic }); return K[id].el; };

    const cpuStack = chartCard({ title: 'CPU-Auslastung nach Art', sub: 'Gestapelt, Prozent aller Kerne', span: 6, mode: 'stacked', series: CPU_SERIES, fmt: f.pct, yMax: 100, markers: true, height: 240 });
    const memStack = chartCard({ title: 'Arbeitsspeicher', sub: 'Belegt, Puffer, Cache, Frei', span: 6, mode: 'stacked', series: MEM_SERIES, fmt: f.bytes, base: 1024, yMax: () => (store.info ? store.info.ram : 1), markers: true, height: 240 });
    const net = chartCard({ title: 'Netzwerk', sub: 'Datenrate der Hauptschnittstelle', span: 6, mode: 'area', series: [{ key: 'rx', label: '↓ Empfang', color: 'c1' }, { key: 'tx', label: '↑ Senden', color: 'c2' }], fmt: f.rate, base: 1024, floor: 20480, markers: true, height: 240 });
    const req = chartCard({ title: 'Webserver', sub: 'Anfragen pro Sekunde und Verbindungen', span: 6, mode: 'line', series: [{ key: 'req', label: 'Anfragen/s', color: 'c1', fmt: f.ps2 }, { key: 'act', label: 'Aktive Verbindungen', color: 'c3', fmt: f.int }, { key: 'est', label: 'TCP offen', color: 'c5', fmt: f.int }], fmt: f.d1, floor: 5, height: 240 });

    const dCpu = donutCard({ title: 'CPU-Zeit jetzt', sub: 'Anteil der letzten Sekunde', span: 4, fmt: (v) => `${num(v, 1)} %`, size: 150 });
    const dMem = donutCard({ title: 'Arbeitsspeicher', sub: 'Aufteilung des RAM', span: 4, fmt: B, size: 150 });
    const dDisk = donutCard({ title: 'Festplatte /', sub: 'Belegung des Hauptdatenträgers', span: 4, fmt: B, size: 150 });
    const dTcp = donutCard({ title: 'TCP-Verbindungen', sub: 'Nach Zustand', span: 4, fmt: f.int, size: 150 });
    const dUser = donutCard({ title: 'RAM nach Benutzer', sub: 'Belegter Speicher der Prozesse', span: 4, fmt: B, size: 150 });
    const dTraffic = donutCard({ title: 'Datenverkehr seit Start', sub: 'Empfangen und gesendet, alle Schnittstellen außer Container', span: 4, fmt: B, size: 150 });

    const blCpu = new BarList(h('div'), { fmt: (v) => `${num(v, 1)} %` });
    const blMem = new BarList(h('div'), { fmt: (v) => B(v) });
    const evBox = h('div', { class: 'tl' });
    const topCpu = card({ title: 'Top-Prozesse nach CPU', sub: 'Prozent eines Kerns', span: 4 }, blCpu.host);
    const topMem = card({ title: 'Top-Prozesse nach RAM', span: 4 }, blMem.host);
    const evCard = card({ title: 'Letzte Ereignisse', sub: 'Änderungen am Server', span: 4, actions: h('a', { href: '#/events' }, 'Alle') }, evBox);

        // ---- quick access: the things you do most often, plus status of the new automation features
    const qaBtn = (ic, label, sub, run) => h('button', { type: 'button', class: 'qa', onClick: run }, icon(ic, 20), h('span', null, label), h('small', null, sub));
    const go = (id) => () => { location.hash = `#/${id}`; };
    const autoBox = h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', marginTop: '14px' } });
    const quick = card({ title: 'Schnellzugriff', sub: 'Die häufigsten Handgriffe. Mit Strg K findest du alles andere.', span: 12 },
      h('div', { class: 'qa-grid' },
        qaBtn('terminal', 'Befehl ausführen', 'Konsole', go('console')),
        qaBtn('refresh', 'nginx neu laden', 'Konfiguration anwenden', () => nginxReload()),
        qaBtn('packages', 'Updates prüfen', 'Updates & Pakete', go('packages')),
        qaBtn('archive', 'Sicherung', 'Pläne und Archive', go('backups')),
        qaBtn('box', 'App starten', 'Aus Vorlagen', go('apps')),
        qaBtn('web', 'Neue Website', 'Domain einrichten', go('nginx')),
        qaBtn('disk', 'Speicher-Karte', 'Was belegt Platz?', go('storage')),
        qaBtn('filetext', 'Serverbericht', 'Drucken / PDF', go('report'))),
      autoBox);
    void quickAction; void toast;
    async function loadAuto() {
      const chips = [];
      const res = await Promise.allSettled([api.get('/api/heal'), api.get('/api/notify'), api.get('/api/totp'), api.get('/api/userdata')]);
      const [hl, nf, tp, ud] = res.map((r) => (r.status === 'fulfilled' ? r.value : null));
      if (tp) chips.push(h('a', { href: '#/settings', class: 'chipl' }, badge(tp.enabled ? 'Zwei-Faktor an' : 'Zwei-Faktor aus', tp.enabled ? 'ok' : 'warn')));
      if (nf) chips.push(h('a', { href: '#/automation', class: 'chipl' }, badge(`${nf.channels.filter((c) => c.enabled).length} Benachrichtigungskanäle`, nf.channels.some((c) => c.enabled) ? 'ok' : 'warn')));
      if (hl) chips.push(h('a', { href: '#/automation', class: 'chipl' }, badge(hl.enabled ? `Selbstheilung an (${hl.rules.filter((r) => r.enabled).length} Regeln)` : 'Selbstheilung aus', hl.enabled ? 'ok' : 'neutral')));
      if (ud) for (const n of ud.notes.filter((x) => x.pinned).slice(0, 3)) chips.push(h('a', { href: '#/notes', class: 'chipl', title: 'Angeheftete Notiz' }, badge(`Notiz: ${n.title.slice(0, 28)}`, 'info')));
      autoBox.replaceChildren(...chips);
    }
    loadAuto();

    root.append(grid(
      mast, banner, quick,
      mk('cpu', 'CPU-Auslastung', 'c1', 3, 'cpu'), mk('load', 'Load Average (1 Min)', 'c5', 3, 'network'), mk('ram', 'Arbeitsspeicher belegt', 'c2', 3, 'memory'), mk('swap', 'Swap belegt', 'c3', 3, 'archive'),
      mk('rx', 'Netzwerk ↓ Empfang', 'c1', 3, 'download'), mk('tx', 'Netzwerk ↑ Senden', 'c4', 3, 'upload'), mk('disk', 'Festplatte /', 'c9', 3, 'disk'), mk('io', 'Festplatten-Durchsatz', 'c5', 3, 'zap'),
      mk('req', 'Webserver-Anfragen', 'c2', 3, 'web'), mk('web', 'Websites erreichbar', 'c7', 3, 'check'), mk('svc', 'Dienste (systemd)', 'c4', 3, 'service'), mk('dock', 'Container (Docker)', 'c5', 3, 'docker'),
      heading('Verlauf', 'Alle Diagramme folgen dem oben gewählten Zeitraum. Bewege die Maus darüber, um genaue Werte zu sehen.'),
      cpuStack.el, memStack.el, net.el, req.el,
      heading('Aufteilung', 'Kreisdiagramme zeigen den aktuellen Zustand. Fahre über einen Abschnitt für den Anteil.'),
      dCpu.el, dMem.el, dDisk.el, dTcp.el, dUser.el, dTraffic.el,
      heading('Was gerade los ist'),
      topCpu, topMem, evCard));
    ctx.own(cpuStack.chart); ctx.own(memStack.chart); ctx.own(net.chart); ctx.own(req.chart);

    const alertsOn = () => (store.detail ? store.detail.alerts : []);
    function renderBanner() {
      const al = alertsOn();
      const d = store.detail;
      if (!d) return;
      if (!al.length) {
        banner.replaceChildren(bannerBox('ok', 'Alles in Ordnung', `Keine aktiven Warnungen. Laufzeit: ${dur(d.sys.uptime, 3)}.`));
        return;
      }
      const worst = al.some((a) => a.level === 'crit') ? 'crit' : 'warn';
      banner.replaceChildren(bannerBox(worst, `${al.length} aktive ${al.length === 1 ? 'Warnung' : 'Warnungen'}`, null,
        h('ul', null, ...al.map((a) => h('li', null, h('b', null, a.title), a.detail ? ` – ${a.detail}` : '', h('small', null, `seit ${dur((Date.now() - a.since) / 1000, 2)}`))))));
    }

    function updateMast() {
      const s = store.last();
      const d = store.detail;
      const i = store.info;
      if (!s || !d || !i) return;
      setText(mastTitle, i.host);
      mastSub.replaceChildren(i.os, h('br'), `Kernel ${i.kernel} · ${i.cores} Kerne · ${B(i.ram)} RAM`);
      const al = alertsOn();
      const st = al.length ? badge(`${al.length} ${al.length === 1 ? 'Warnung' : 'Warnungen'}`, al.some((a) => a.level === 'crit') ? 'crit' : 'warn') : badge('Alles in Ordnung', 'ok');
      mastState.replaceChildren(st);
      const up = d.sys.uptime + (performance.now() - store.bootAt) / 1000;
      mUp.replaceChildren(...two(dur(up, 2), `seit ${tShort(d.sys.btime * 1000)}`));
      mCpu.replaceChildren(...two(`${num(s.cpu, 1)} %`, `Load ${num(s.l1, 2)} · ${i.cores} Kerne`));
      mProc.replaceChildren(...two(num(s.proc), `${s.run} laufen · ${num(s.thr)} Threads`));
      mNet.replaceChildren(...two(`${R(s.rx + s.tx)}`, `${num(s.est)} Verbindungen${s.req != null ? ` · ${num(s.req, 1)} Anfragen/s` : ''}`));
    }

    function updateKpis() {
      const s = store.last();
      const d = store.detail;
      if (!s || !d) return;
      updateMast();
      const cores = store.info.cores;
      const total = store.info.ram;
      K.cpu.set({ value: num(s.cpu, 1), unit: '%', sub: `${cores} Kerne · I/O-Wait ${num(s.cw, 1)} %`, deltas: deltas(store, 'cpu', (v) => `${num(v, 1)} pp`, deltaChip, 'down', 0.5), spark: store.series('cpu'), level: levelOf(s.cpu, 70, 90), color: 'c1' });
      K.load.set({ value: num(s.l1, 2), sub: `5 Min ${num(s.l5, 2)} · 15 Min ${num(s.l15, 2)} · ${cores} Kerne`, deltas: deltas(store, 'l1', (v) => num(v, 2), deltaChip, 'down', 0.05), spark: store.series('l1'), level: levelOf(s.l1 / cores, 0.8, 1.5), color: 'c5' });
      K.ram.set({ value: num(ratio(s.mu, total), 1), unit: '%', sub: `${B(s.mu)} von ${B(total)} · verfügbar ${B(s.ma)}`, deltas: deltas(store, 'mu', B, deltaChip, 'down', 20e6), spark: store.series('mu'), level: levelOf(100 - ratio(s.ma, total), 80, 92), color: 'c2' });
      const st = d.mem.swapTotal;
      K.swap.set({ value: st ? num(ratio(s.su, st), 1) : '–', unit: st ? '%' : '', sub: st ? `${B(s.su)} von ${B(st)}` : 'kein Swap eingerichtet', deltas: deltas(store, 'su', B, deltaChip, 'down', 20e6), spark: store.series('su'), level: st ? levelOf(ratio(s.su, st), 60, 85) : '', color: 'c3' });
      const rx = R(s.rx); const tx = R(s.tx);
      K.rx.set({ value: rx.split(' ')[0], unit: rx.split(' ')[1], sub: `${num(s.rxp)} Pakete/s · gesamt ${B(d.net.ifaces.find((i) => i.primary)?.rxT || 0)}`, deltas: deltas(store, 'rx', R, deltaChip, 'none', 2048), spark: store.series('rx'), color: 'c1' });
      K.tx.set({ value: tx.split(' ')[0], unit: tx.split(' ')[1], sub: `${num(s.txp)} Pakete/s · gesamt ${B(d.net.ifaces.find((i) => i.primary)?.txT || 0)}`, deltas: deltas(store, 'tx', R, deltaChip, 'none', 2048), spark: store.series('tx'), color: 'c2' });
      const root = d.fs.find((x) => x.mount === '/') || d.fs[0];
      if (root) {
        const p = ratio(root.used, root.used + root.avail);
        K.disk.set({ value: num(p, 1), unit: '%', sub: `${B(root.used)} von ${B(root.total)} · frei ${B(root.avail)}`, deltas: deltas(store, 'dsu', B, deltaChip, 'down', 1e6), spark: store.series('dsu'), level: levelOf(p, 80, 92), color: 'c6' });
      }
      const io = R(s.dr + s.dw);
      K.io.set({ value: io.split(' ')[0], unit: io.split(' ')[1], sub: `Lesen ${R(s.dr)} · Schreiben ${R(s.dw)} · ${num(s.du, 0)} % ausgelastet`, deltas: deltas(store, 'du', (v) => `${num(v, 1)} pp`, deltaChip, 'down', 1), spark: store.series('dr'), level: levelOf(s.du, 70, 95), color: 'c5' });
      K.req.set({ value: s.req != null ? num(s.req, 1) : '–', unit: '/s', sub: s.act != null ? `${s.act} aktive Verbindungen · ${s.est} TCP offen` : 'Webserver-Status nicht verfügbar', deltas: deltas(store, 'req', (v) => num(v, 1), deltaChip, 'none', 0.2), spark: store.series('req'), color: 'c9' });
      const dc = d.docker;
      const run = dc.containers.filter((c) => c.state === 'running').length;
      K.dock.set({ value: dc.ok ? String(run) : '–', unit: dc.ok ? `von ${dc.containers.length}` : '', sub: dc.ok ? `CPU ${num(s.dcpu, 1)} % · RAM ${B(s.dmem)}${dc.stale ? ' (Daten veraltet)' : ''}` : 'keine Docker-Daten', spark: store.series('dmem'), level: dc.ok && !dc.stale && dc.containers.some((c) => c.state !== 'running') ? 'warn' : 'ok', color: 'c10' });
    }

    function updateSlow() {
      const sl = store.slow;
      if (!sl) return;
      const all = sl.sites;
      const noDns = all.filter((x) => x.nodns).length;
      const sites = all.filter((x) => !x.nodns);
      const up = sites.filter((x) => x.ok).length;
      const checked = sites.filter((x) => x.ok != null);
      const avg = sites.filter((x) => x.ms != null);
      K.web.set({ value: checked.length ? String(up) : '–', unit: `von ${sites.length}`, sub: `${avg.length ? `Ø Antwortzeit ${num(avg.reduce((a, b) => a + b.ms, 0) / avg.length, 0)} ms` : 'wird geprüft'}${noDns ? ` · ${noDns} ohne DNS` : ''}`, level: checked.length ? (up === checked.length ? 'ok' : 'crit') : '', spark: [] });
      const sv = sl.services;
      K.svc.set({ value: String(sv.running), unit: 'laufen', sub: `${sv.active} aktiv${sv.failed ? ` · ${sv.failed} fehlgeschlagen` : ''} · ${sv.total} Units`, level: sv.failed ? 'crit' : 'ok', spark: [] });
    }

    function updateDonuts() {
      const s = store.last();
      const d = store.detail;
      if (!s || !d) return;
      dCpu.donut.update(cpuDonut(s), { value: `${num(s.cpu, 0)} %`, label: 'belegt' });
      dMem.donut.update(memDonut(s), { value: B(s.mu), label: `von ${B(store.info.ram)}` });
      const root = d.fs.find((x) => x.mount === '/') || d.fs[0];
      if (root) dDisk.donut.update([{ id: 'u', label: 'Belegt', value: root.used, color: 'c1' }, { id: 'r', label: 'Reserviert', value: root.reserved, color: 'c3' }, { id: 'a', label: 'Frei', value: root.avail, color: 'line' }], { value: `${num(ratio(root.used, root.used + root.avail), 0)} %`, label: root.dev });
      const order = ['established', 'time_wait', 'close_wait', 'listen', 'syn_recv', 'syn_sent', 'fin_wait1', 'fin_wait2', 'last_ack', 'closing', 'other'];
      const names = { established: 'Aufgebaut', time_wait: 'Time-Wait', close_wait: 'Close-Wait', listen: 'Lauscht', syn_recv: 'SYN empfangen', syn_sent: 'SYN gesendet', fin_wait1: 'FIN-Wait 1', fin_wait2: 'FIN-Wait 2', last_ack: 'Last-ACK', closing: 'Closing', other: 'Sonstige' };
      const cols = ['c1', 'c3', 'c4', 'c6', 'c5', 'c9', 'c8', 'c10', 'c2', 'c7', 'line'];
      const t = d.net.tcp;
      dTcp.donut.update(order.filter((k) => t[k]).map((k, i) => ({ id: k, label: names[k], value: t[k], color: cols[order.indexOf(k)] })), { value: num(Object.values(t).reduce((a, b) => a + b, 0)), label: 'Sockets' });
      if (d.procs) dUser.donut.update(d.procs.byUser.slice(0, 7).map((u, i) => ({ id: u.user, label: u.user, value: u.rss, color: `c${(i % 10) + 1}` })), { value: B(d.procs.byUser.reduce((a, b) => a + b.rss, 0)), label: 'in Prozessen' });
      const phys = d.net.ifaces.filter((i) => i.kind === 'Physisch');
      const rxT = phys.reduce((a, b) => a + b.rxT, 0); const txT = phys.reduce((a, b) => a + b.txT, 0);
      dTraffic.donut.update([{ id: 'rx', label: 'Empfangen', value: rxT, color: 'c1' }, { id: 'tx', label: 'Gesendet', value: txT, color: 'c2' }], { value: B(rxT + txT), label: 'gesamt' });
      if (d.procs) {
        blCpu.update(d.procs.topCpu.slice(0, 6).map((p) => ({ id: p.pid, label: p.name, sub: p.group || p.user, value: p.cpu, color: 'c1' })), Math.max(10, ...d.procs.topCpu.slice(0, 6).map((p) => p.cpu)));
        blMem.update(d.procs.topMem.slice(0, 6).map((p) => ({ id: p.pid, label: p.name, sub: p.group || p.user, value: p.rss, color: 'c2' })));
      }
    }

    let evKey = '';
    function updateEvents() {
      const list = store.events.slice(0, 7);
      const key = list.map((e) => e.id).join(',');
      if (key === evKey) { evBox.querySelectorAll('.ev-when b').forEach((b, i) => setText(b, ago(list[i].t))); return; }
      const fresh = evKey !== '';
      evKey = key;
      evBox.replaceChildren(...(list.length ? list.map((e, i) => eventRow(e, { fresh: fresh && i === 0 })) : [h('p', { class: 'muted' }, 'Noch keine Ereignisse.')]));
    }

    ctx.on('sample', updateKpis);
    ctx.on('detail', () => { renderBanner(); updateDonuts(); updateKpis(); updateSlow(); });
    ctx.on('slow', updateSlow);
    ctx.on('event', updateEvents);
    ctx.on('range', updateKpis);
    ctx.every(updateEvents, 15_000);
    renderBanner(); updateKpis(); updateSlow(); updateDonuts(); updateEvents();
  },
};
