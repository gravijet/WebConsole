'use strict';
// Network inventory (interfaces, routes, listening sockets, connections) and diagnostic tools.

const { run, clip, fail, isHost, isIp, int } = require('./core');

function parseSs(text, listening) {
  const out = [];
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (!l) continue;
    const p = l.split(/\s+/);
    // tcp: State Recv-Q Send-Q Local Peer [Process]; udp: same
    const proc = /users:\(\((.*)\)\)/.exec(l);
    const procs = proc ? [...proc[1].matchAll(/"([^"]+)",pid=(\d+)/g)].map((m) => ({ name: m[1], pid: +m[2] })) : [];
    const local = p[4]; const peer = p[5];
    const split = (a) => { const i = a.lastIndexOf(':'); return { host: a.slice(0, i).replace(/^\[|\]$/g, ''), port: a.slice(i + 1) }; };
    const lo = split(local); const pe = split(peer || '*:*');
    out.push({ proto: p[0].startsWith('u') ? 'udp' : 'tcp', state: p[1], recvQ: +p[2], sendQ: +p[3], local: lo.host, port: lo.port === '*' ? 0 : +lo.port, peer: pe.host, peerPort: pe.port === '*' ? 0 : +pe.port, procs, listening });
  }
  return out;
}

const target = (v, label = 'Ziel') => { if (!isHost(v)) throw fail(`Ungültiges ${label}.`); return v; };

const ops = {
  async 'net.overview'() {
    const [addr, route, link, route6, summary] = await Promise.all([
      run('ip', ['-j', 'addr'], { timeout: 8000 }), run('ip', ['-j', 'route'], { timeout: 8000 }), run('ip', ['-j', '-s', 'link'], { timeout: 8000 }), run('ip', ['-j', '-6', 'route'], { timeout: 8000 }), run('ss', ['-s'], { timeout: 8000 }),
    ]);
    const j = (s) => { try { return JSON.parse(s); } catch { return []; } };
    const links = new Map(j(link.out).map((l) => [l.ifname, l]));
    const interfaces = j(addr.out).map((a) => {
      const l = links.get(a.ifname) || {};
      const st = l.stats64 || {};
      return {
        name: a.ifname, state: a.operstate, mac: a.address, mtu: a.mtu, flags: a.flags, kind: (l.linkinfo && l.linkinfo.info_kind) || null,
        addrs: (a.addr_info || []).map((x) => ({ family: x.family, addr: x.local, prefix: x.prefixlen, scope: x.scope })),
        rxBytes: st.rx && st.rx.bytes, txBytes: st.tx && st.tx.bytes, rxPackets: st.rx && st.rx.packets, txPackets: st.tx && st.tx.packets, rxErrors: st.rx && st.rx.errors, txErrors: st.tx && st.tx.errors, rxDropped: st.rx && st.rx.dropped, txDropped: st.tx && st.tx.dropped,
      };
    });
    let resolv = '';
    try { resolv = require('fs').readFileSync('/etc/resolv.conf', 'utf8'); } catch {}
    return {
      interfaces, routes: j(route.out).map((r) => ({ dst: r.dst, gateway: r.gateway, dev: r.dev, src: r.prefsrc, proto: r.protocol, metric: r.metric })), routes6: j(route6.out).map((r) => ({ dst: r.dst, gateway: r.gateway, dev: r.dev, metric: r.metric })),
      dns: resolv.split('\n').filter((l) => /^(nameserver|search|options)/.test(l)), summary: summary.out.trim(),
    };
  },

  async 'net.sockets'() {
    const r = await run('ss', ['-H', '-tulnp'], { timeout: 15_000 });
    return { list: parseSs(r.out, true) };
  },

  async 'net.connections'() {
    const r = await run('ss', ['-H', '-tnp', 'state', 'established'], { timeout: 15_000 });
    // "-t state established" prints neither Netid nor State: re-insert both so the parser sees the usual shape
    const fixed = r.out.split('\n').filter(Boolean).map((l) => `tcp ESTAB ${l}`).join('\n');
    const all = parseSs(fixed, false);
    return { total: all.length, list: all.slice(0, 3000) };
  },

  // ---- diagnostics
  async 'net.ping'({ host, count }) {
    target(host);
    const n = int(count || 4, 1, 10, 'Die Anzahl');
    const r = await run('ping', ['-n', '-c', String(n), '-W', '2', '--', host], { timeout: 40_000 });
    return { text: clip(r.out + r.err), ok: r.code === 0 };
  },
  async 'net.dns'({ host, type, server }) {
    target(host);
    const t = ['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'CAA', 'PTR', 'SRV', 'ANY'].includes(type) ? type : 'A';
    const args = ['+nocmd', '+noall', '+answer', '+authority', '+stats', '+time=4', '+tries=1'];
    if (server) { target(server, 'DNS-Server'); args.push(`@${server}`); }
    if (t === 'PTR' && isIp(host)) args.push('-x', host); else args.push(host, t);
    const r = await run('dig', args, { timeout: 20_000 });
    return { text: clip(r.out + r.err), ok: r.code === 0 };
  },
  async 'net.trace'({ host }) {
    target(host);
    const r = await run('traceroute', ['-n', '-w', '2', '-q', '1', '-m', '20', '--', host], { timeout: 70_000 });
    return { text: clip(r.out + r.err), ok: r.code === 0 };
  },
  async 'net.port'({ host, port }) {
    target(host);
    int(port, 1, 65535, 'Der Port');
    const started = Date.now();
    const ok = await new Promise((resolve) => {
      const s = require('net').connect({ host, port, timeout: 5000 });
      s.on('connect', () => { s.destroy(); resolve('offen'); });
      s.on('timeout', () => { s.destroy(); resolve('Zeitüberschreitung (gefiltert?)'); });
      s.on('error', (e) => resolve(e.code === 'ECONNREFUSED' ? 'geschlossen (abgelehnt)' : `Fehler: ${e.code || e.message}`));
    });
    return { text: `${host}:${port} → ${ok} (${Date.now() - started} ms)`, ok: ok === 'offen' };
  },
  async 'net.tls'({ host, port }) {
    target(host);
    const p = int(port || 443, 1, 65535, 'Der Port');
    const r = await run('openssl', ['s_client', '-connect', `${host}:${p}`, '-servername', host, '-brief'], { timeout: 15_000, input: '' });
    const cert = await run('sh', ['-c', 'echo | openssl s_client -connect "$0:$1" -servername "$0" 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName 2>&1', host, String(p)], { timeout: 15_000 });
    return { text: clip(`${(r.err + r.out).trim()}\n\n${cert.out.trim()}`), ok: r.code === 0 };
  },
  async 'net.http'({ url }) {
    if (typeof url !== 'string' || !/^https?:\/\/[A-Za-z0-9.:\[\]-]+(\/[^\s]*)?$/.test(url) || url.length > 500) throw fail('Ungültige URL (nur http:// oder https://).');
    const r = await run('curl', ['-sS', '-I', '-L', '--max-redirs', '5', '--max-time', '12', '-A', 'Xeon-1-Console', '-w', '\n--- Zeiten ---\nDNS: %{time_namelookup}s\nVerbindung: %{time_connect}s\nTLS: %{time_appconnect}s\nErstes Byte: %{time_starttransfer}s\nGesamt: %{time_total}s\nEndgültige URL: %{url_effective}\nIP: %{remote_ip}\n', '--', url], { timeout: 20_000 });
    return { text: clip(r.out + r.err), ok: r.code === 0 };
  },
  async 'net.whois'({ query }) {
    target(query, 'Domain oder IP');
    const r = await run('whois', ['--', query], { timeout: 25_000 });
    return { text: clip(r.out + r.err, 60_000), ok: r.code === 0 };
  },
};

module.exports = { ops };
