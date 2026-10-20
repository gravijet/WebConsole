// Network tools run from the server (ping, DNS, traceroute, port, TLS, HTTP, whois) plus small helpers.

import { h, icon } from '../dom.js';
import { card, tabs, toast, badge } from '../widgets.js';
import { cronText, rwx } from '../fmt.js';
import { api } from '../store.js';
import { readOp } from '../interact.js';
import { columns } from '../charts.js';

export default {
  id: 'tools', title: 'Werkzeuge', group: 'System', icon: 'tools', range: false, desc: 'Ping, DNS, Traceroute, Port- und Zertifikatsprüfung direkt vom Server aus', keywords: 'ping dns dig traceroute whois port tls zertifikat http passwort generator cron chmod speedtest geschwindigkeit bandbreite base64 hash json uuid zeitstempel regex cidr subnetz',
  mount(root) {
    const run = async (op, args, out, btn) => {
      btn.disabled = true;
      out.textContent = 'Läuft … (bis zu einer Minute)';
      try { const r = (await api.post('/api/action', { op, args })).result; out.textContent = r.text || '(keine Ausgabe)'; out.dataset.ok = r.ok === false ? 'no' : 'yes'; } catch (e) { out.textContent = e.message; }
      btn.disabled = false;
    };
    const input = (ph, value = '', mono = false) => h('input', { class: 'input', placeholder: ph, value, 'aria-label': ph, spellcheck: 'false', autocomplete: 'off', style: mono ? { fontFamily: 'var(--mono)' } : null });
    const sel = (opts, value) => h('select', { class: 'input', style: { width: 'auto', flex: '0 0 auto' } }, ...opts.map(([v, l]) => h('option', { value: v, selected: v === value ? '' : null }, l)));

    /** a tool: fields row + run button + output */
    function tool({ title, text, fields, go, label = 'Ausführen' }) {
      const out = h('pre', { class: 'out tall', style: { marginTop: '14px', minHeight: '120px' } }, 'Noch nichts ausgeführt.');
      const btn = h('button', { type: 'button', class: 'btn primary', onClick: () => go(out, btn) }, icon('play', 14), label);
      const row = h('div', { class: 'row' }, ...fields, btn);
      for (const f of fields) f.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
      return card({ title, sub: text, span: 12 }, row, out);
    }

    const pHost = input('Rechner oder IP, z. B. 1.1.1.1', '1.1.1.1'); const pCount = sel([[4, '4 Pakete'], [10, '10 Pakete'], [1, '1 Paket']], 4);
    const dHost = input('Domain, z. B. benjaminberger.at', 'benjaminberger.at'); const dType = sel(['A', 'AAAA', 'MX', 'TXT', 'NS', 'CNAME', 'SOA', 'CAA', 'PTR', 'SRV', 'ANY'].map((x) => [x, x]), 'A'); const dSrv = input('DNS-Server (optional), z. B. 1.1.1.1');
    const tHost = input('Ziel für Traceroute', '1.1.1.1');
    const oHost = input('Rechner'); const oPort = h('input', { class: 'input num', type: 'number', min: 1, max: 65535, value: 443, 'aria-label': 'Port' });
    const sHost = input('Domain, z. B. console.benjaminberger.at', 'console.benjaminberger.at'); const sPort = h('input', { class: 'input num', type: 'number', min: 1, max: 65535, value: 443, 'aria-label': 'Port' });
    const uUrl = input('https://beispiel.de/', 'https://benjaminberger.at/');
    const wQ = input('Domain oder IP', 'benjaminberger.at');

    const panes = {
      ping: tool({ title: 'Ping', text: 'Prüft, ob ein Ziel antwortet, und misst die Laufzeit.', fields: [pHost, pCount], go: (o, b) => run('net.ping', { host: pHost.value.trim(), count: +pCount.value }, o, b) }),
      dns: tool({ title: 'DNS-Abfrage', text: 'Fragt einen Nameserver nach Einträgen (dig).', fields: [dHost, dType, dSrv], go: (o, b) => run('net.dns', { host: dHost.value.trim(), type: dType.value, server: dSrv.value.trim() || undefined }, o, b) }),
      trace: tool({ title: 'Traceroute', text: 'Zeigt den Weg der Pakete zum Ziel. Das dauert bis zu einer Minute.', fields: [tHost], go: (o, b) => run('net.trace', { host: tHost.value.trim() }, o, b) }),
      port: tool({ title: 'Port prüfen', text: 'Versucht eine TCP-Verbindung vom Server zu Rechner und Port.', fields: [oHost, oPort], go: (o, b) => run('net.port', { host: oHost.value.trim(), port: +oPort.value }, o, b) }),
      tls: tool({ title: 'TLS-Zertifikat prüfen', text: 'Zeigt Aussteller, Gültigkeit und Namen des Zertifikats, das ein Server ausliefert.', fields: [sHost, sPort], go: (o, b) => run('net.tls', { host: sHost.value.trim(), port: +sPort.value }, o, b) }),
      http: tool({ title: 'HTTP-Abfrage', text: 'Holt nur die Antwort-Kopfzeilen (folgt bis zu 5 Weiterleitungen) und misst die Zeiten.', fields: [uUrl], go: (o, b) => run('net.http', { url: uUrl.value.trim() }, o, b) }),
      whois: tool({ title: 'WHOIS', text: 'Registrierungsdaten einer Domain oder IP-Adresse.', fields: [wQ], go: (o, b) => run('net.whois', { query: wQ.value.trim() }, o, b) }),
    };

    // ---- helpers (all in the browser)
    const pwLen = h('input', { class: 'input num', type: 'number', min: 8, max: 128, value: 24, 'aria-label': 'Länge' });
    const pwSym = h('input', { type: 'checkbox' }); pwSym.checked = true;
    const pwOut = h('input', { class: 'input', readonly: '', style: { fontFamily: 'var(--mono)' }, 'aria-label': 'Passwort' });
    const gen = () => {
      const chars = `abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789${pwSym.checked ? '!@#$%^&*-_=+?' : ''}`;
      const n = Math.min(128, Math.max(8, +pwLen.value || 24)); const buf = new Uint32Array(n); crypto.getRandomValues(buf);
      pwOut.value = Array.from(buf, (x) => chars[x % chars.length]).join('');
    };
    gen();
    const cronIn = h('input', { class: 'input', value: '*/15 * * * *', style: { fontFamily: 'var(--mono)' }, 'aria-label': 'Cron-Ausdruck' }); const cronOut = h('p', { style: { fontSize: '16px', fontWeight: 600, marginTop: '10px' } });
    const updCron = () => { cronOut.textContent = cronText(cronIn.value); }; cronIn.addEventListener('input', updCron); updCron();
    const modeIn = h('input', { class: 'input num', value: '644', maxlength: 4, 'aria-label': 'Oktalwert' }); const modeOut = h('p', { style: { fontFamily: 'var(--mono)', fontSize: '16px', marginTop: '10px' } });
    const updMode = () => { modeOut.textContent = /^[0-7]{3,4}$/.test(modeIn.value) ? `${modeIn.value} = ${rwx(modeIn.value)}` : 'Bitte 3 oder 4 Oktalziffern eingeben.'; }; modeIn.addEventListener('input', updMode); updMode();
    panes.helpers = h('div', { class: 'grid' },
      card({ title: 'Passwort-Generator', sub: 'Zufällig im Browser erzeugt, nichts wird gesendet.', span: 4 }, h('div', { class: 'form' }, pwOut, h('div', { class: 'row' }, pwLen, h('label', { class: 'check' }, pwSym, 'Sonderzeichen'), h('button', { type: 'button', class: 'btn sm primary', onClick: gen }, 'Neu erzeugen'), h('button', { type: 'button', class: 'btn sm', onClick: () => { navigator.clipboard.writeText(pwOut.value).then(() => toast('Kopiert')).catch(() => toast('Kopieren nicht möglich', 'crit')); } }, icon('copy', 13), 'Kopieren')))),
      card({ title: 'Cron-Ausdruck erklären', sub: 'Fünf Felder: Minute Stunde Tag Monat Wochentag.', span: 4 }, cronIn, cronOut),
      card({ title: 'Dateirechte (chmod)', sub: 'Oktalwert in die Schreibweise rwx umrechnen.', span: 4 }, modeIn, modeOut));


    // ---- speed test (runs on the server, against Cloudflare's speed endpoint)
    const readHist = () => { try { return JSON.parse(localStorage.getItem('sd.speedtests') || '[]'); } catch { return []; } };
    const big = (label, unit) => { const v = h('b', { class: 'big-v' }, '–'); const sub = h('small', null, ''); return { el: h('div', { class: 'big' }, h('span', null, label), h('div', null, v, h('em', null, unit)), sub), set(val, s = '') { v.textContent = val; sub.textContent = s; } }; };
    const sDown = big('Download', 'Mbit/s'); const sUp = big('Upload', 'Mbit/s'); const sLat = big('Latenz', 'ms');
    const sState = h('p', { class: 'muted' }, 'Misst die Internetanbindung dieses Servers (nicht deines Geräts). Der Test lädt kurz etwa 100 MB herunter und 45 MB hoch.');
    const histBox = h('div');
    const histTable = () => {
      const hist = readHist();
      histBox.replaceChildren(...(hist.length ? [columns(hist.slice(-24).map((x) => ({ label: new Date(x.t).toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' }), value: x.down, tip: `${new Date(x.t).toLocaleString('de-AT')}: ${x.down.toFixed(0)} Mbit/s runter, ${x.up.toFixed(0)} hoch, ${x.lat.toFixed(0)} ms`})), { height: 120, color: 'c1', fmt: (v) => `${v.toFixed(0)} Mbit/s` }), h('p', { class: 'muted', style: { marginTop: '8px' } }, 'Download-Geschwindigkeit der letzten Messungen (nur in diesem Browser gemerkt).')] : [h('p', { class: 'muted' }, 'Noch keine Messung.')]));
    };
    const speedBtn = h('button', { type: 'button', class: 'btn primary', onClick: async () => {
      speedBtn.disabled = true;
      const res = { t: Date.now(), down: 0, up: 0, lat: 0 };
      try {
        sDown.set('–'); sUp.set('–'); sLat.set('–');
        sState.textContent = 'Latenz wird gemessen …';
        const l = await readOp('net.speedtest', { part: 'latency' }); res.lat = l.latency; sLat.set(l.latency.toFixed(1), `Schwankung ${l.jitter.toFixed(1)} ms`);
        sState.textContent = 'Download wird gemessen … (bis zu 25 Sekunden)';
        const d = await readOp('net.speedtest', { part: 'down' }); res.down = d.mbit; sDown.set(d.mbit.toFixed(0), `${(d.bytes / 1e6).toFixed(0)} MB in ${d.seconds.toFixed(1)} s`);
        sState.textContent = 'Upload wird gemessen … (bis zu 25 Sekunden)';
        const u = await readOp('net.speedtest', { part: 'up' }); res.up = u.mbit; sUp.set(u.mbit.toFixed(0), `${(u.bytes / 1e6).toFixed(0)} MB in ${u.seconds.toFixed(1)} s`);
        sState.textContent = 'Fertig.';
        try { localStorage.setItem('sd.speedtests', JSON.stringify([...readHist(), res].slice(-40))); } catch {}
        histTable();
      } catch (e) { sState.textContent = e.message; toast(e.message, 'crit'); }
      speedBtn.disabled = false;
    } }, icon('zap', 14), 'Messung starten');
    panes.speed = h('div', { class: 'grid' },
      card({ title: 'Geschwindigkeitstest', sub: 'Vom Server aus gemessen', span: 12, actions: speedBtn }, h('div', { class: 'bigs' }, sDown.el, sUp.el, sLat.el), sState),
      card({ title: 'Verlauf', span: 12 }, histBox));
    histTable();

    // ---- developer helpers (all in the browser, nothing is sent)
    const area = (ph, rows = 4, ro = false) => { const a = h('textarea', { class: 'input mono-area', rows, placeholder: ph, spellcheck: 'false', 'aria-label': ph }); if (ro) a.readOnly = true; return a; };
    const btnRow = (...b) => h('div', { class: 'row', style: { gap: '8px', margin: '8px 0', flexWrap: 'wrap' } }, ...b);
    const mini = (label, fn, cls = '') => h('button', { type: 'button', class: `btn sm ${cls}`, onClick: fn }, label);
    const utf8 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
    const unutf8 = (s) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));
    const safe = (fn, out) => { try { out.value = fn(); } catch (e) { out.value = `Fehler: ${e.message}`; } };

    const b64In = area('Text oder Base64 …'); const b64Out = area('Ergebnis', 4, true);
    const urlIn = area('Text oder URL-kodierter Text …'); const urlOut = area('Ergebnis', 4, true);
    const hashIn = area('Text …'); const hashOut = area('Hashwerte', 5, true);
    const jsonIn = area('JSON einfügen …', 8); const jsonOut = area('Ergebnis', 8, true);
    const tsIn = h('input', { class: 'input', placeholder: 'Unix-Zeit oder Datum (z. B. 1760000000 oder 2026-10-20 14:30)', 'aria-label': 'Zeit', style: { fontFamily: 'var(--mono)' } }); const tsOut = h('pre', { class: 'out' }, 'Eingabe erwartet.');
    const runTs = () => {
      const v = tsIn.value.trim(); if (!v) { tsOut.textContent = `Jetzt: ${Math.floor(Date.now() / 1000)} (${new Date().toLocaleString('de-AT')})`; return; }
      let d = /^-?\d{9,13}$/.test(v) ? new Date(v.length > 11 ? +v : +v * 1000) : new Date(v);
      tsOut.textContent = Number.isNaN(+d) ? 'Das ist keine gültige Zeit.' : `Lokal (Wien): ${d.toLocaleString('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'full', timeStyle: 'medium' })}\nUTC: ${d.toISOString()}\nUnix (Sekunden): ${Math.floor(+d / 1000)}\nUnix (Millisekunden): ${+d}`;
    };
    tsIn.addEventListener('input', runTs); runTs();
    const uuidOut = area('Zufallswerte', 5, true);
    const genRand = () => { const r = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join(''); uuidOut.value = `UUID:    ${crypto.randomUUID()}\nHex 16:  ${r(8)}\nHex 32:  ${r(16)}\nHex 64:  ${r(32)}\nZahl:    ${crypto.getRandomValues(new Uint32Array(1))[0]}`; };
    genRand();
    const cidrIn = h('input', { class: 'input', value: '192.168.1.37/24', 'aria-label': 'CIDR', style: { fontFamily: 'var(--mono)' } }); const cidrOut = h('pre', { class: 'out' });
    const runCidr = () => {
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidrIn.value.trim());
      if (!m || m.slice(1, 5).some((x) => +x > 255) || +m[5] > 32) { cidrOut.textContent = 'Format: 192.168.1.37/24'; return; }
      const ip = m.slice(1, 5).reduce((a, x) => (a * 256) + +x, 0); const bits = +m[5];
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; const net = (ip & mask) >>> 0; const bc = (net | (~mask >>> 0)) >>> 0;
      const q = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      const hosts = bits >= 31 ? (bits === 32 ? 1 : 2) : 2 ** (32 - bits) - 2;
      cidrOut.textContent = `Netzwerk:    ${q(net)}/${bits}\nNetzmaske:   ${q(mask)}\nBroadcast:   ${q(bc)}\nErster Host: ${q(bits >= 31 ? net : net + 1)}\nLetzter Host: ${q(bits >= 31 ? bc : bc - 1)}\nAdressen:    ${hosts.toLocaleString('de-AT')}`;
    };
    cidrIn.addEventListener('input', runCidr); runCidr();
    const reP = h('input', { class: 'input', value: '(\\d+)\\.(\\d+)', 'aria-label': 'Muster', style: { fontFamily: 'var(--mono)' } }); const reF = h('input', { class: 'input', value: 'g', 'aria-label': 'Flags', style: { fontFamily: 'var(--mono)', maxWidth: '80px' } });
    const reT = area('Text zum Durchsuchen …', 4); reT.value = 'Version 1.22 und 3.4'; const reOut = h('pre', { class: 'out' });
    const runRe = () => { try { const re = new RegExp(reP.value, reF.value); const all = [...(re.global ? reT.value.matchAll(re) : [reT.value.match(re)].filter(Boolean))]; reOut.textContent = all.length ? all.map((m, i) => `#${i + 1} „${m[0]}“ an Position ${m.index}${m.length > 1 ? `\n    Gruppen: ${m.slice(1).map((g) => `„${g}“`).join(', ')}` : ''}`).join('\n') : 'Kein Treffer.'; } catch (e) { reOut.textContent = `Fehler im Muster: ${e.message}`; } };
    [reP, reF, reT].forEach((x) => x.addEventListener('input', runRe)); runRe();
    const sizeIn = h('input', { class: 'input', value: '1536 MB', 'aria-label': 'Größe', style: { fontFamily: 'var(--mono)' } }); const sizeOut = h('pre', { class: 'out' });
    const runSize = () => {
      const m = /^([\d.,]+)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)?$/i.exec(sizeIn.value.trim());
      if (!m) { sizeOut.textContent = 'Beispiel: 1536 MB oder 2,5 GiB'; return; }
      const u = (m[2] || 'B').toLowerCase(); const mult = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 }[u]; const n = parseFloat(m[1].replace(',', '.')) * mult;
      const f = (v) => v.toLocaleString('de-AT', { maximumFractionDigits: 3 });
      sizeOut.textContent = `Bytes: ${f(n)}\nKB:  ${f(n / 1e3)}      KiB: ${f(n / 1024)}\nMB:  ${f(n / 1e6)}      MiB: ${f(n / 1024 ** 2)}\nGB:  ${f(n / 1e9)}      GiB: ${f(n / 1024 ** 3)}\nTB:  ${f(n / 1e12)}      TiB: ${f(n / 1024 ** 4)}`;
    };
    sizeIn.addEventListener('input', runSize); runSize();

    panes.dev = h('div', { class: 'grid' },
      card({ title: 'Base64', span: 6 }, b64In, btnRow(mini('Kodieren', () => safe(() => utf8(b64In.value), b64Out), 'primary'), mini('Dekodieren', () => safe(() => unutf8(b64In.value), b64Out))), b64Out),
      card({ title: 'URL-Kodierung', span: 6 }, urlIn, btnRow(mini('Kodieren', () => safe(() => encodeURIComponent(urlIn.value), urlOut), 'primary'), mini('Dekodieren', () => safe(() => decodeURIComponent(urlIn.value), urlOut))), urlOut),
      card({ title: 'Hashwerte', sub: 'SHA-1, SHA-256, SHA-384, SHA-512', span: 6 }, hashIn, btnRow(mini('Berechnen', async () => { const data = new TextEncoder().encode(hashIn.value); const lines = []; for (const a of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512']) lines.push(`${a.padEnd(8)} ${Array.from(new Uint8Array(await crypto.subtle.digest(a, data)), (b) => b.toString(16).padStart(2, '0')).join('')}`); hashOut.value = lines.join('\n'); }, 'primary')), hashOut),
      card({ title: 'JSON', sub: 'Prüfen, formatieren, verkleinern', span: 6 }, jsonIn, btnRow(mini('Formatieren', () => safe(() => JSON.stringify(JSON.parse(jsonIn.value), null, 2), jsonOut), 'primary'), mini('Verkleinern', () => safe(() => JSON.stringify(JSON.parse(jsonIn.value)), jsonOut)), mini('Schlüssel sortieren', () => safe(() => { const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v); return JSON.stringify(sort(JSON.parse(jsonIn.value)), null, 2); }, jsonOut))), jsonOut),
      card({ title: 'Zeitstempel', sub: 'Unix-Zeit und Datum ineinander umrechnen. Leer lassen für „jetzt“.', span: 6 }, tsIn, tsOut),
      card({ title: 'Zufallswerte', sub: 'UUID, Hex-Token und Zahl, im Browser erzeugt', span: 6 }, uuidOut, btnRow(mini('Neu erzeugen', genRand, 'primary'))),
      card({ title: 'IP-Netz (CIDR)', sub: 'Netzadresse, Maske und Hostbereich', span: 6 }, cidrIn, cidrOut),
      card({ title: 'Größen umrechnen', span: 6 }, sizeIn, sizeOut),
      card({ title: 'Regulärer Ausdruck', sub: 'Live-Test mit Treffern und Gruppen', span: 12 }, h('div', { class: 'row', style: { gap: '8px' } }, reP, reF), reT, reOut));

    const order = [['ping', 'Ping'], ['dns', 'DNS'], ['trace', 'Traceroute'], ['port', 'Port prüfen'], ['tls', 'TLS-Zertifikat'], ['http', 'HTTP'], ['whois', 'WHOIS'], ['speed', 'Geschwindigkeit'], ['helpers', 'Kleine Helfer'], ['dev', 'Entwickler-Helfer']];
    const t = tabs(order.map(([id, label]) => ({ id, label })), 'ping', (id) => { for (const [k, el] of Object.entries(panes)) el.hidden = k !== id; });
    for (const [k, el] of Object.entries(panes)) el.hidden = k !== 'ping';
    root.append(h('div', { class: 'grid' }, h('div', { class: 's-12' }, t.el, ...Object.values(panes))));
    void badge;
  },
};
