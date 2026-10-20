// Server report: one page with the state of everything that matters, made to be printed or saved as a PDF.

import { h, icon } from '../dom.js';
import { card, badge, banner, kv, toast, status } from '../widgets.js';
import { B, num, dur, tFull, ago } from '../fmt.js';
import { readOp } from '../interact.js';
import { levelOf, ratio } from './common.js';

export default {
  id: 'report', title: 'Bericht', group: 'Dashboard', icon: 'filetext', range: false, desc: 'Der Zustand des Servers auf einer Seite, zum Drucken oder als PDF speichern', keywords: 'bericht report pdf drucken zusammenfassung zustand übersicht export',
  mount(root, ctx) {
    const { store } = ctx;
    const page = h('article', { class: 'report' });
    const printBtn = h('button', { type: 'button', class: 'btn primary', onClick: () => window.print() }, icon('download', 14), 'Drucken / als PDF speichern');
    const refresh = h('button', { type: 'button', class: 'btn', onClick: () => build() }, icon('refresh', 14), 'Neu erstellen');
    root.append(h('div', { class: 'row no-print', style: { marginBottom: '14px', gap: '8px' } }, printBtn, refresh, h('span', { class: 'muted' }, 'Tipp: Im Druckdialog „Als PDF speichern“ wählen.')), page);

    const section = (title, ...kids) => h('section', { class: 'rep-sec' }, h('h3', null, title), ...kids);
    const lv = (l) => ({ ok: 'ok', warn: 'warn', crit: 'crit' }[l] || 'neutral');
    const row = (label, value, level = 'neutral', detail = '') => h('div', { class: 'rep-row' }, h('span', { class: 'rep-l' }, label), h('span', { class: 'rep-v' }, value, detail ? h('small', null, ` ${detail}`) : null), badge({ ok: 'in Ordnung', warn: 'Hinweis', crit: 'Handlungsbedarf', neutral: 'Info' }[lv(level)], lv(level)));

    async function build() {
      page.replaceChildren(h('p', { class: 'muted loading' }, 'Der Bericht wird zusammengestellt …'));
      const d = store.detail; const s = store.last(); const i = store.info;
      if (!d || !s || !i) { page.replaceChildren(h('p', { class: 'muted' }, 'Die Messwerte sind noch nicht da. Bitte gleich noch einmal versuchen.')); return; }
      const [pkg, aud, fw, certs, bak] = await Promise.allSettled([readOp('pkg.status'), readOp('sec.audit'), readOp('fw.overview'), readOp('certs.list'), readOp('backup.overview')]);
      const ok = (r) => (r.status === 'fulfilled' ? r.value : null);
      const P = ok(pkg); const A = ok(aud); const F = ok(fw); const C = ok(certs); const Bk = ok(bak);
      const alerts = d.alerts || [];
      const root_ = d.fs.find((x) => x.mount === '/') || d.fs[0];
      const diskPct = root_ ? ratio(root_.used, root_.used + root_.avail) : 0;
      const memPct = ratio(s.mu, i.ram);
      const up = d.sys.uptime + (performance.now() - store.bootAt) / 1000;
      const sl = store.slow;
      const failedSvc = sl ? sl.services.failed : 0;
      const sitesDown = sl ? sl.sites.filter((x) => x.ok === false && !x.nodns) : [];
      const dc = d.docker;
      const badC = dc.ok ? dc.containers.filter((c) => c.state !== 'running' || c.health === 'unhealthy') : [];
      const ev24 = store.events.filter((e) => Date.now() - e.t < 86400_000);
      const evBy = (l) => ev24.filter((e) => e.level === l).length;
      const soon = C ? C.certs.filter((c) => c.expires).sort((a, b) => a.expires - b.expires)[0] : null;
      const certDays = soon ? Math.floor((soon.expires - Date.now()) / 86400_000) : null;
      const sec = P ? P.upgradable.filter((u) => u.security).length : 0;
      const f2 = F && F.f2b && F.f2b.jails ? F.f2b.jails.reduce((a, j) => a + j.currentBanned, 0) : null;
      const lastBak = Bk ? Bk.plans.map((p) => p.status).filter(Boolean).sort((a, b) => b.at - a.at)[0] : null;

      const worst = alerts.some((a) => a.level === 'crit') || failedSvc || sitesDown.length ? 'crit' : alerts.length || badC.length || (P && P.reboot) || (certDays != null && certDays < 14) ? 'warn' : 'ok';
      page.replaceChildren(
        h('header', { class: 'rep-head' }, h('div', null, h('h2', null, `Serverbericht ${i.host}`), h('p', null, `${tFull(Date.now())} · ${i.os} · Kernel ${i.kernel}`)), badge({ ok: 'Alles in Ordnung', warn: 'Hinweise vorhanden', crit: 'Handlungsbedarf' }[worst], worst)),
        worst === 'ok' ? banner('ok', 'Alles in Ordnung', 'Keine aktiven Warnungen, alle Dienste und Websites laufen.') : banner(worst, worst === 'crit' ? 'Es gibt Probleme, die Aufmerksamkeit brauchen' : 'Es gibt Hinweise', [...alerts.map((a) => a.title), ...(P && P.reboot ? ['Neustart wegen Updates nötig'] : [])].slice(0, 6).join(' · ')),
        section('Auslastung jetzt',
          row('CPU', `${num(s.cpu, 1)} %`, levelOf(s.cpu, 70, 90), `Load ${num(s.l1, 2)} bei ${i.cores} Kernen`),
          row('Arbeitsspeicher', `${num(memPct, 1)} %`, levelOf(100 - ratio(s.ma, i.ram), 80, 92), `${B(s.mu)} von ${B(i.ram)}`),
          row('Swap', d.mem.swapTotal ? `${num(ratio(s.su, d.mem.swapTotal), 1)} %` : 'keiner', d.mem.swapTotal ? levelOf(ratio(s.su, d.mem.swapTotal), 60, 85) : 'neutral', d.mem.swapTotal ? `${B(s.su)} von ${B(d.mem.swapTotal)}` : ''),
          row('Festplatte /', `${num(diskPct, 1)} %`, levelOf(diskPct, 80, 92), root_ ? `${B(root_.avail)} frei von ${B(root_.total)}` : ''),
          row('Laufzeit', dur(up, 3), 'neutral', `seit ${tFull(d.sys.btime * 1000)}`)),
        section('Dienste und Anwendungen',
          row('systemd-Dienste', sl ? `${sl.services.running} laufen` : '–', failedSvc ? 'crit' : 'ok', failedSvc ? `${failedSvc} fehlgeschlagen` : 'keiner fehlgeschlagen'),
          row('Docker-Container', dc.ok ? `${dc.containers.filter((c) => c.state === 'running').length} von ${dc.containers.length} laufen` : 'keine Daten', badC.length ? 'warn' : 'ok', badC.length ? badC.map((c) => c.name).slice(0, 4).join(', ') : ''),
          row('Websites erreichbar', sl ? `${sl.sites.filter((x) => x.ok).length} von ${sl.sites.filter((x) => !x.nodns).length}` : '–', sitesDown.length ? 'crit' : 'ok', sitesDown.map((x) => x.host).slice(0, 4).join(', ')),
          row('Zertifikate', C ? `${C.certs.length} verwaltet` : '–', certDays == null ? 'neutral' : certDays < 7 ? 'crit' : certDays < 21 ? 'warn' : 'ok', soon ? `nächster Ablauf in ${certDays} Tagen (${soon.name})` : '')),
        section('Updates und Sicherheit',
          row('Verfügbare Updates', P ? String(P.upgradable.length) : '–', sec ? 'warn' : P && P.upgradable.length > 20 ? 'warn' : 'ok', sec ? `davon ${sec} Sicherheitsupdates` : ''),
          row('Neustart nötig', P ? (P.reboot ? 'ja' : 'nein') : '–', P && P.reboot ? 'warn' : 'ok', P && P.reboot ? (P.rebootPkgs || []).slice(0, 3).join(', ') : ''),
          row('Firewall (ufw)', F ? (F.ufw.active ? 'aktiv' : 'aus') : '–', F && !F.ufw.active ? 'crit' : 'ok', F && F.ufw.active ? `${F.ufw.rules.length} Regeln` : ''),
          row('fail2ban', F && F.f2b && F.f2b.available ? 'aktiv' : 'nicht verfügbar', F && F.f2b && F.f2b.available ? 'ok' : 'warn', f2 != null ? `${f2} Adressen gerade gesperrt` : ''),
          row('SSH-Anmeldung per Passwort', A && A.sshd ? A.sshd.passwordauthentication || '–' : '–', A && A.sshd && A.sshd.passwordauthentication === 'yes' ? 'warn' : 'ok', A && A.sshd ? `root-Login: ${A.sshd.permitrootlogin || '–'}` : ''),
          row('Zwei-Faktor für dieses Dashboard', store.totp ? 'eingeschaltet' : 'aus', store.totp ? 'ok' : 'warn', '')),
        section('Sicherungen',
          row('Sicherungspläne', Bk ? String(Bk.plans.length) : '–', Bk && !Bk.plans.length ? 'warn' : 'ok', Bk ? `${Bk.archives.length} Archive, ${B(Bk.total)}` : ''),
          row('Letzte Sicherung', lastBak ? ago(lastBak.at) : 'noch nie', lastBak ? (lastBak.ok ? 'ok' : 'crit') : 'warn', lastBak ? `${lastBak.ok ? 'erfolgreich' : 'fehlgeschlagen'}, ${B(lastBak.size || 0)}` : '')),
        section('Ereignisse der letzten 24 Stunden',
          h('div', { class: 'rep-pills' }, status(`${evBy('crit')} kritisch`, 'crit'), status(`${evBy('warn')} Warnungen`, 'warn'), status(`${evBy('ok')} behoben`, 'ok'), status(`${evBy('info')} Info`, 'neutral')),
          h('ul', { class: 'rep-list' }, ...ev24.filter((e) => e.level === 'crit' || e.level === 'warn').slice(0, 12).map((e) => h('li', null, h('b', null, e.title), h('small', null, ` ${ago(e.t)}${e.detail ? ` – ${e.detail}` : ''}`))), ...(ev24.some((e) => e.level === 'crit' || e.level === 'warn') ? [] : [h('li', { class: 'muted' }, 'Keine Warnungen.')]))),
        section('Rechner', kv([['Prozessor', `${(d.sys.cpuinfo && d.sys.cpuinfo.model) || i.cpu}`], ['Kerne', String(i.cores)], ['Arbeitsspeicher', B(i.ram)], ['Hauptschnittstelle', d.net.primary], ['Verbindungen', `${num(s.est)} TCP offen`]], 'cols2')),
        h('footer', { class: 'rep-foot' }, `Erstellt mit der Xeon-1 Konsole am ${tFull(Date.now())}`));
    }
    ctx.own({ destroy() {} });
    build().catch((e) => { toast(e.message, 'crit'); });
  },
};
