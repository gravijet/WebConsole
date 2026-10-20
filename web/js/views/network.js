import { h } from '../dom.js';
import { grid, heading, kpi, card, chartCard, donutCard, deltaChip, dataTable, kv, badge, status } from '../widgets.js';
import { num, B, R, bits, ms } from '../fmt.js';
import { f, deltas, levelOf } from './common.js';

const STATES = [['est', 'Aufgebaut', 'c1'], ['tw', 'Time-Wait', 'c3'], ['cwt', 'Close-Wait', 'c4'], ['fw', 'FIN-Wait', 'c5'], ['syn', 'SYN', 'c9'], ['lst', 'Lauschend', 'c6']];
const STATE_NAMES = { established: 'Aufgebaut', time_wait: 'Time-Wait', close_wait: 'Close-Wait', listen: 'Lauschend', syn_recv: 'SYN empfangen', syn_sent: 'SYN gesendet', fin_wait1: 'FIN-Wait 1', fin_wait2: 'FIN-Wait 2', last_ack: 'Last-ACK', closing: 'Closing', other: 'Sonstige' };

export default {
  id: 'network', title: 'Netzwerk', group: 'Messwerte', icon: 'network', desc: 'Datenverkehr, Verbindungen und Schnittstellen', keywords: 'internet traffic verbindungen ports',
  mount(root, ctx) {
    const { store } = ctx;
    const K = {};
    const mk = (id, label, color) => { K[id] = kpi({ label, color, span: 2 }); return K[id].el; };

    const thr = chartCard({ title: 'Durchsatz', sub: 'Hauptschnittstelle, optional dazu der Verkehr der Container', span: 8, mode: 'area', series: [{ key: 'rx', label: '↓ Empfang', color: 'c1' }, { key: 'tx', label: '↑ Senden', color: 'c2' }, { key: 'vrx', label: 'Container ↓', color: 'c5', hidden: true }, { key: 'vtx', label: 'Container ↑', color: 'c3', hidden: true }], fmt: f.rate, base: 1024, floor: 20480, markers: true, height: 260, statsOpen: true });
    const dIf = donutCard({ title: 'Datenverkehr seit Start', sub: 'Empfangen + gesendet je Schnittstelle', span: 4, fmt: B, size: 160 });
    const pk = chartCard({ title: 'Pakete pro Sekunde', span: 6, series: [{ key: 'rxp', label: 'Empfangen', color: 'c1', fmt: f.int }, { key: 'txp', label: 'Gesendet', color: 'c2', fmt: f.int }], fmt: f.ps, floor: 100, height: 200 });
    const er = chartCard({ title: 'Fehler und verworfene Pakete', sub: 'Pro Sekunde auf der Hauptschnittstelle (sollte nahe 0 liegen)', span: 6, series: [{ key: 'rxe', label: 'Empfangsfehler', color: 'c4', fmt: f.ps2 }, { key: 'txe', label: 'Sendefehler', color: 'c3', fmt: f.ps2 }, { key: 'rxd', label: 'Empfang verworfen', color: 'c5', fmt: f.ps2 }, { key: 'txd', label: 'Senden verworfen', color: 'c8', fmt: f.ps2 }], fmt: f.ps2, floor: 1, height: 200 });
    const seg = chartCard({ title: 'TCP-Segmente', sub: 'Eingehend, ausgehend und neu übertragen', span: 6, series: [{ key: 'tIn', label: 'Eingehend', color: 'c1', fmt: f.int }, { key: 'tOut', label: 'Ausgehend', color: 'c2', fmt: f.int }, { key: 'tRet', label: 'Neu übertragen', color: 'c4', fmt: f.ps2 }], fmt: f.ps, floor: 100, height: 210 });
    const conn = chartCard({ title: 'Verbindungsaufbau', sub: 'Neue Verbindungen pro Sekunde', span: 6, series: [{ key: 'tPO', label: 'Eingehend angenommen', color: 'c1', fmt: f.ps2 }, { key: 'tAO', label: 'Selbst aufgebaut', color: 'c2', fmt: f.ps2 }, { key: 'tFail', label: 'Fehlgeschlagen', color: 'c3', fmt: f.ps2 }, { key: 'tRst', label: 'Reset gesendet', color: 'c4', fmt: f.ps2 }], fmt: f.ps2, floor: 2, height: 210 });
    const states = chartCard({ title: 'TCP-Verbindungen nach Zustand', sub: 'Gestapelt, Anzahl Sockets', span: 6, mode: 'stacked', series: STATES.map(([k, l, c]) => ({ key: k, label: l, color: c, fmt: f.int })), fmt: f.int, floor: 10, height: 210 });
    const udp = chartCard({ title: 'UDP-Datagramme', sub: 'Pro Sekunde', span: 6, series: [{ key: 'uIn', label: 'Eingehend', color: 'c1', fmt: f.int }, { key: 'uOut', label: 'Ausgehend', color: 'c2', fmt: f.int }], fmt: f.ps, floor: 20, height: 210 });
    const req = chartCard({ title: 'Webserver: Anfragen', sub: 'HTTP-Anfragen pro Sekunde an nginx', span: 6, mode: 'area', series: [{ key: 'req', label: 'Anfragen/s', color: 'c1', fmt: f.ps2 }], fmt: f.ps2, floor: 2, height: 200 });
    const ngc = chartCard({ title: 'Webserver: Verbindungen', sub: 'Lesend, schreibend, wartend (Keep-Alive)', span: 6, mode: 'stacked', series: [{ key: 'rdg', label: 'Request lesen', color: 'c1', fmt: f.int }, { key: 'wrg', label: 'Antwort schreiben', color: 'c3', fmt: f.int }, { key: 'wtg', label: 'Wartend', color: 'c2', fmt: f.int }], fmt: f.int, floor: 5, height: 200 });
    const lat = chartCard({ title: 'Internet-Latenz', sub: 'TCP-Verbindungsaufbau zu den eingestellten Zielen und DNS-Antwortzeit (Einstellungen: Internet)', span: 12, series: [{ key: 'lat1', label: 'Ziel 1', color: 'c1', fmt: f.ms2 }, { key: 'lat2', label: 'Ziel 2', color: 'c3', fmt: f.ms2 }, { key: 'lat3', label: 'Ziel 3', color: 'c5', fmt: f.ms2 }, { key: 'dns', label: 'DNS', color: 'c2', fmt: f.ms2 }], fmt: f.ms, floor: 10, height: 220 });
    [thr, pk, er, seg, conn, states, udp, req, ngc, lat].forEach((c) => ctx.own(c.chart));

    const dTcp = donutCard({ title: 'TCP-Zustände jetzt', span: 4, fmt: f.int, size: 150 });
    const ifTable = dataTable({
      columns: [
        { key: 'name', label: 'Schnittstelle', cls: 'tbl-title', fmt: (v, r) => h('span', null, v, r.primary ? ' ' : '', r.primary ? badge('Haupt', 'info') : null) },
        { key: 'kind', label: 'Typ' }, { key: 'state', label: 'Status', fmt: (v) => (v ? status(v === 'up' ? 'aktiv' : v === 'unknown' ? 'aktiv' : v, v === 'down' ? 'crit' : 'ok') : '–') },
        { key: 'mtu', label: 'MTU', align: 'r', fmt: (v) => (v ? num(v) : '–') }, { key: 'speed', label: 'Link', align: 'r', fmt: (v) => (v ? `${num(v)} Mbit/s` : '–') },
        { key: 'addrs', label: 'Adressen', cls: 'wrap', sort: (r) => r.addrs.join(), fmt: (v) => (v && v.length ? v.join(', ') : '–') },
        { key: 'rx', label: '↓ jetzt', align: 'r', fmt: R }, { key: 'tx', label: '↑ jetzt', align: 'r', fmt: R },
        { key: 'rxp', label: 'Pakete/s ↓', align: 'r', fmt: (v) => num(v, 0) }, { key: 'txp', label: 'Pakete/s ↑', align: 'r', fmt: (v) => num(v, 0) },
        { key: 'rxT', label: '↓ gesamt', align: 'r', fmt: B }, { key: 'txT', label: '↑ gesamt', align: 'r', fmt: B },
        { key: 'errs', label: 'Fehler gesamt', align: 'r', sort: (r) => (r.rxET || 0) + (r.txET || 0), fmt: (v, r) => (r.aggregate ? '–' : num((r.rxET || 0) + (r.txET || 0))) },
        { key: 'drops', label: 'Verworfen gesamt', align: 'r', sort: (r) => (r.rxDT || 0) + (r.txDT || 0), fmt: (v, r) => (r.aggregate ? '–' : num((r.rxDT || 0) + (r.txDT || 0))) },
      ],
      sort: { key: 'rxT', dir: 'desc' }, dense: true, pageSize: 30,
    });
    const portTable = dataTable({
      columns: [{ key: 'port', label: 'Port', align: 'r', cls: 'tbl-title' }, { key: 'proto', label: 'Protokoll' }, { key: 'scope', label: 'Erreichbar von', fmt: (v) => badge(v, v === 'lokal' ? 'ok' : v.startsWith('alle') ? 'warn' : 'neutral') }],
      search: true, searchPlaceholder: 'Port suchen …', sort: { key: 'port', dir: 'asc' }, dense: true, pageSize: 60,
    });
    const countersBox = h('div');
    const sockBox = h('div');

    root.append(grid(
      mk('rx', '↓ Empfang', 'c1'), mk('tx', '↑ Senden', 'c2'), mk('pps', 'Pakete/s', 'c5'), mk('est', 'TCP aufgebaut', 'c3'), mk('err', 'Fehler + Drops', 'c4'), mk('lat', 'Latenz Ziel 1', 'c9'),
      thr.el, dIf.el, pk.el, er.el, seg.el, conn.el, states.el, udp.el, req.el, ngc.el, lat.el,
      heading('Schnittstellen', 'Alle Netzwerkgeräte des Servers. Container-Schnittstellen (veth) sind zusammengefasst.'),
      card({ span: 12 }, ifTable.el),
      heading('Verbindungen und Zähler'),
      dTcp.el,
      card({ title: 'Offene Ports (TCP, lauschend)', sub: 'Dienste, die Verbindungen annehmen', span: 4 }, portTable.el),
      card({ title: 'Sockets', sub: 'Kernel-Statistik (sockstat)', span: 4 }, sockBox),
      card({ title: 'Zähler seit Systemstart', sub: 'TCP, UDP, IP und Webserver, alle Werte stehen auch unter „Rohdaten“', span: 12 }, countersBox)));

    function onSample() {
      const s = store.last();
      const d = store.detail;
      if (!s) return;
      K.rx.set({ value: R(s.rx).split(' ')[0], unit: R(s.rx).split(' ')[1], sub: bits(s.rx), deltas: deltas(store, 'rx', R, deltaChip, 'none', 2048), spark: store.series('rx'), color: 'c1' });
      K.tx.set({ value: R(s.tx).split(' ')[0], unit: R(s.tx).split(' ')[1], sub: bits(s.tx), deltas: deltas(store, 'tx', R, deltaChip, 'none', 2048), spark: store.series('tx'), color: 'c2' });
      K.pps.set({ value: num(s.rxp + s.txp), unit: '/s', sub: `${num(s.rxp)} ein · ${num(s.txp)} aus`, spark: store.series('rxp'), color: 'c5' });
      K.est.set({ value: num(s.est), sub: `${s.tw} Time-Wait · ${s.cwt} Close-Wait · ${s.lst} lauschend`, deltas: deltas(store, 'est', (v) => num(v, 0), deltaChip, 'none', 2), spark: store.series('est'), color: 'c3' });
      const e = s.rxe + s.txe + s.rxd + s.txd;
      K.err.set({ value: num(e, 2), unit: '/s', sub: `${num(s.tRet, 2)} TCP-Neuübertragungen/s`, spark: store.series('rxd'), color: 'c4', level: e > 0 ? 'warn' : 'ok' });
      const t0 = d && d.internet.targets[0];
      K.lat.set({ value: s.lat1 != null ? num(s.lat1, 1) : '–', unit: s.lat1 != null ? 'ms' : '', sub: t0 ? `${t0.name} (${t0.host}) · DNS ${s.dns != null ? `${num(s.dns, 1)} ms` : '–'}` : '', deltas: deltas(store, 'lat1', (v) => `${num(v, 1)} ms`, deltaChip, 'down', 1), spark: store.series('lat1'), color: 'c9', level: s.lat1 == null ? 'crit' : '' });
    }

    let namesDone = '';
    function onDetail() {
      const d = store.detail;
      if (!d) return;
      const t = d.net.tcp;
      const keys = Object.keys(STATE_NAMES).filter((k) => t[k]);
      const cols = { established: 'c1', time_wait: 'c3', close_wait: 'c4', listen: 'c6', syn_recv: 'c5', syn_sent: 'c9', fin_wait1: 'c8', fin_wait2: 'c10', last_ack: 'c2', closing: 'c7', other: 'line' };
      dTcp.donut.update(keys.map((k) => ({ id: k, label: STATE_NAMES[k], value: t[k], color: cols[k] })), { value: num(Object.values(t).reduce((a, b) => a + b, 0)), label: 'TCP-Sockets' });
      dIf.donut.update(d.net.ifaces.filter((i) => i.rxT != null && (i.kind !== 'Loopback')).map((i, k) => ({ id: i.name, label: i.name, value: i.rxT + i.txT, color: `c${(k % 10) + 1}` })), { value: B(d.net.ifaces.filter((i) => i.kind !== 'Loopback').reduce((a, i) => a + i.rxT + i.txT, 0)), label: 'ohne Loopback' });
      ifTable.setRows(d.net.ifaces);
      portTable.setRows(d.net.listen.map((l) => ({ port: l.port, proto: l.v6 ? 'TCP (IPv6)' : 'TCP', scope: l.scope })));

      const names = d.internet.targets.map((x) => x.name).join('|') + d.internet.dnsName;
      if (names !== namesDone) {
        namesDone = names;
        const tg = d.internet.targets;
        lat.chart.setSeries([
          ...tg.map((x, i) => ({ key: `lat${i + 1}`, label: `${x.name} (${x.host}:${x.port})`, color: ['c1', 'c3', 'c5'][i], fmt: f.ms2 })),
          { key: 'dns', label: `DNS (${d.internet.dnsName})`, color: 'c2', fmt: f.ms2 },
        ]);
      }
      const sk = d.net.sock;
      sockBox.replaceChildren(kv([
        ['Sockets in Benutzung', num((sk.sockets || {}).used || 0)], ['TCP in Benutzung', num((sk.TCP || {}).inuse || 0)], ['TCP verwaist (orphan)', num((sk.TCP || {}).orphan || 0)],
        ['TCP im Time-Wait', num((sk.TCP || {}).tw || 0)], ['TCP zugewiesen', num((sk.TCP || {}).alloc || 0)], ['TCP Speicher', `${num(((sk.TCP || {}).mem || 0) * 4096 / 1024, 0)} KB`],
        ['UDP in Benutzung', num((sk.UDP || {}).inuse || 0)], ['UDP-Sockets (Tabelle)', num(d.net.udp)], ['Raw-Sockets', num((sk.RAW || {}).inuse || 0)],
      ]));
      const T = d.net.snmpTcp; const U = d.net.snmpUdp; const I = d.net.snmpIp; const W = d.web;
      const retr = T.OutSegs ? (T.RetransSegs / T.OutSegs) * 100 : 0;
      countersBox.replaceChildren(kv([
        ['TCP: aktiv geöffnet', num(T.ActiveOpens)], ['TCP: passiv angenommen', num(T.PassiveOpens)], ['TCP: Verbindungsversuche fehlgeschlagen', num(T.AttemptFails)], ['TCP: Verbindungen zurückgesetzt', num(T.EstabResets)],
        ['TCP: Segmente empfangen', num(T.InSegs)], ['TCP: Segmente gesendet', num(T.OutSegs)], ['TCP: neu übertragen', `${num(T.RetransSegs)} (${num(retr, 2)} %)`], ['TCP: fehlerhafte Segmente', num(T.InErrs)],
        ['TCP: RST gesendet', num(T.OutRsts)], ['UDP: Datagramme empfangen', num(U.InDatagrams)], ['UDP: Datagramme gesendet', num(U.OutDatagrams)], ['UDP: keine Zielport', num(U.NoPorts)],
        ['UDP: Fehler', num(U.InErrors)], ['IP: empfangen', num(I.InReceives)], ['IP: weitergeleitet', num(I.ForwDatagrams)], ['IP: verworfen', num(I.InDiscards)],
        ['IP: Adressfehler', num(I.InAddrErrors)], ['IP: ausgeliefert', num(I.InDelivers)], ['IP: gesendet', num(I.OutRequests)], ['IP: Zeitüberschreitung Reassembly', num(I.ReasmTimeout)],
        W.ok ? ['Webserver: Anfragen gesamt', num(W.requests)] : null, W.ok ? ['Webserver: Verbindungen angenommen', num(W.accepts)] : null, W.ok ? ['Webserver: Verbindungen bearbeitet', num(W.handled)] : null, W.ok ? ['Webserver: verworfen', num(W.accepts - W.handled)] : null,
      ], 'cols2'));
    }

    ctx.on('sample', onSample);
    ctx.on('detail', onDetail);
    ctx.on('range', onSample);
    onSample(); onDetail();
  },
};
