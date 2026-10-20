'use strict';
// Client for the privileged action helper (bin/actions-daemon.js) plus the dashboard-side policy:
// which operations exist, which need the password, which need a typed confirmation, and how each
// one is described in the event log. The helper validates everything again on its own.

const net = require('net');

const SOCKET = process.env.SD_ACTIONS_SOCKET || '/run/server-dash-actions.sock';

/** units where a mistake locks the owner out or takes the whole machine down: typed confirmation */
const CRITICAL_UNITS = new Set([
  'ssh.service', 'sshd.service', 'nginx.service', 'docker.service', 'containerd.service', 'server-dash.service',
  'mariadb.service', 'mysql.service', 'redis-server.service', 'networking.service', 'systemd-networkd.service',
  'cron.service', 'fail2ban.service', 'chrony.service', 'dbus.service', 'ufw.service', 'systemd-logind.service', 'systemd-journald.service',
]);

/** system files where a typo can lock the owner out or stop the server from booting */
const CRITICAL_FILES = /^\/etc\/(ssh\/sshd_config(\.d\/.*)?|sudoers(\.d\/.*)?|fstab|passwd|group|shadow|hosts|resolv\.conf|crontab|pam\.d\/.*|ufw\/.*|fail2ban\/.*|network\/.*|netplan\/.*|systemd\/network\/.*)$/;

function call(op, args = {}, timeout = 190_000) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(SOCKET);
    sock.setEncoding('utf8');
    let buf = '';
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('Zeitüberschreitung beim Aktions-Helfer.')); }, timeout);
    sock.on('connect', () => sock.write(`${JSON.stringify({ op, args })}\n`));
    sock.on('data', (c) => { buf += c; });
    sock.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'Der Aktions-Helfer ist nicht erreichbar.' : `Aktions-Helfer: ${e.code || e.message}`)); });
    sock.on('end', () => {
      clearTimeout(timer);
      try {
        const r = JSON.parse(buf.trim());
        if (r.ok) resolve(r.result); else { const e = new Error(r.error || 'Aktion fehlgeschlagen.'); e.user = true; reject(e); }
      } catch { reject(new Error('Ungültige Antwort vom Aktions-Helfer.')); }
    });
  });
}

// ------------------------------------------------------------------ what exists

/** harmless lookups: a valid session is enough */
const READ_OPS = new Set([
  'proc.info', 'unit.info', 'nginx.test', 'nginx.sites', 'certs.list', 'system.reboot-status',
  'sys.identity', 'sys.hardware', 'sys.sysctl', 'sys.modules',
  'logs.unit', 'logs.kernel', 'logs.system', 'logs.nginx', 'logs.docker', 'logs.query', 'logs.files', 'logs.tail', 'logs.access-stats',
  'docker.inventory', 'docker.inspect',
  'net.overview', 'net.sockets', 'net.connections', 'net.ping', 'net.dns', 'net.trace', 'net.port', 'net.tls', 'net.http', 'net.whois',
  'fw.overview', 'fw.iptables', 'sec.audit', 'auth.ssh', 'auth.last', 'users.list', 'pkg.status', 'pkg.installed', 'pkg.search',
  'cron.overview', 'db.overview', 'files.list', 'files.stat', 'files.du', 'files.find', 'files.versions', 'job.get', 'job.list',
  'sys.timers', 'sys.analyze', 'sys.swap', 'net.speedtest', 'backup.overview', 'backup.contents', 'docker.stack-list',
]);

/** reads that can expose secrets (file contents, key lists): password confirmation first */
const SENSITIVE_OPS = new Set(['files.read', 'files.version-read', 'users.keys-get', 'cron.user-get', 'docker.stack-get']);

/** everything that changes the machine */
const WRITE_OPS = new Set([
  'proc.signal', 'proc.renice', 'unit.control', 'unit.daemon-reload', 'nginx.reload', 'nginx.site-toggle', 'certs.renew',
  'system.reboot', 'system.cancel-reboot', 'sys.set-hostname', 'sys.set-timezone',
  'docker.control', 'docker.remove', 'docker.rename', 'docker.restart-policy', 'docker.image-pull', 'docker.image-remove', 'docker.volume-remove', 'docker.network-remove', 'docker.prune', 'docker.compose',
  'fw.ufw-add', 'fw.ufw-delete', 'fw.ufw-enable', 'f2b.ban', 'f2b.unban',
  'users.add', 'users.lock', 'users.sudo', 'users.delete', 'users.session-kill', 'users.keys-set',
  'pkg.update', 'pkg.upgrade', 'pkg.autoremove', 'pkg.clean', 'pkg.install', 'pkg.remove', 'pkg.hold',
  'cron.user-set', 'db.mysql-kill', 'job.stop',
  'files.write', 'files.mkdir', 'files.rename', 'files.copy', 'files.delete', 'files.chmod', 'files.chown', 'files.restore',
  'term.run', 'docker.exec', 'docker.stack-save', 'docker.stack-delete', 'nginx.site-create', 'nginx.site-delete', 'certs.issue', 'certs.delete',
  'backup.plan-save', 'backup.plan-delete', 'backup.run', 'backup.delete', 'backup.restore', 'sys.swap-create', 'sys.swap-remove',
]);

/** commands where a slip is hard to undo: the console asks for a typed word first (a guard against accidents, not a security boundary) */
const RISKY_CMD = /(\brm\s+(-\S+\s+)*-\S*[rf]\S*\s+(-\S+\s+)*(\/|~|\*|\$HOME)(\s|$)|\bmkfs(\.|\s)|\bdd\s+[^|;&]*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|vd|xvd)|\b(shutdown|reboot|poweroff|halt)\b|\binit\s+[06]\b|:\(\)\s*\{|\bchmod\s+-R\s+\S+\s+\/(\s|$)|\bchown\s+-R\s+\S+\s+\/(\s|$)|\bsystemctl\s+(stop|disable|mask|kill)\s+(ssh|sshd|server-dash|networking|nginx|docker)|\bufw\s+(disable|reset)|\biptables\s+(-F|--flush)|\bwipefs\b|\b(fdisk|parted|sfdisk|cfdisk)\b|\bcrontab\s+-r|\buserdel\b|(^|[;&|(]\s*|sudo\s+)passwd(\s|$)|\bvisudo\b|\bnft\s+flush)/;

// ------------------------------------------------------------------ labels

const SIG_LABEL = { TERM: 'beendet (SIGTERM)', KILL: 'hart beendet (SIGKILL)', HUP: 'zum Neuladen aufgefordert (SIGHUP)', INT: 'unterbrochen (SIGINT)', STOP: 'angehalten (SIGSTOP)', CONT: 'fortgesetzt (SIGCONT)', USR1: 'SIGUSR1 gesendet', USR2: 'SIGUSR2 gesendet' };
const UNIT_LABEL = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet', reload: 'neu geladen', 'reload-or-restart': 'neu geladen/gestartet', 'try-restart': 'neu gestartet (falls aktiv)', 'reset-failed': 'Fehlerstatus zurückgesetzt', enable: 'für den Autostart aktiviert', disable: 'vom Autostart entfernt', mask: 'maskiert (gesperrt)', unmask: 'entsperrt' };
const DOCKER_LABEL = { start: 'gestartet', stop: 'gestoppt', restart: 'neu gestartet', pause: 'pausiert', unpause: 'fortgesetzt', kill: 'hart beendet' };
const PRUNE_LABEL = { containers: 'gestoppte Container', images: 'unbenutzte Images (ohne Namen)', 'images-all': 'alle unbenutzten Images', networks: 'unbenutzte Netzwerke', builder: 'Build-Cache', volumes: 'unbenutzte Volumes' };
const bad = (m) => { const e = new Error(m); e.user = true; return e; };
const short = (s, n = 90) => (typeof s === 'string' ? (s.length > n ? `${s.slice(0, n)}…` : s) : '');
const base = (p) => (typeof p === 'string' ? p.split('/').filter(Boolean).pop() || '/' : '');

/**
 * Dashboard-side rules for one write operation.
 * Returns { title, level, confirm } (confirm = word the user has to type) or throws a user error.
 */
function plan(op, args, ctx = {}) {
  const a = args || {};
  switch (op) {
    case 'proc.signal':
      if (!Number.isInteger(a.pid)) throw bad('Ungültige Prozess-ID.');
      return { title: `Prozess ${a.name || ''} (PID ${a.pid}) ${SIG_LABEL[a.signal] || 'signalisiert'}`.replace('  ', ' '), level: a.signal === 'KILL' ? 'warn' : 'info' };
    case 'proc.renice': return { title: `Priorität von ${a.name || 'PID'} ${a.pid} auf ${a.nice} gesetzt`, level: 'info' };
    case 'unit.control': {
      if (typeof a.unit !== 'string') throw bad('Ungültiger Einheitenname.');
      const critical = CRITICAL_UNITS.has(a.unit) && ['stop', 'restart', 'disable', 'mask'].includes(a.action);
      return { title: `${a.unit} ${UNIT_LABEL[a.action] || a.action}`, level: ['stop', 'disable', 'mask'].includes(a.action) ? 'warn' : 'info', confirm: critical ? a.unit : null };
    }
    case 'unit.daemon-reload': return { title: 'systemd-Konfiguration neu eingelesen (daemon-reload)', level: 'info' };
    case 'nginx.reload': return { title: 'nginx neu geladen', level: 'info' };
    case 'nginx.site-toggle': return { title: `nginx-Website ${a.name} ${a.enable ? 'aktiviert' : 'deaktiviert'} (noch nicht geladen)`, level: 'warn' };
    case 'certs.renew': return { title: `Zertifikate ${a.dry ? 'geprüft (Testlauf)' : 'erneuert'}${a.name ? `: ${a.name}` : ''}`, level: 'info' };
    case 'system.reboot': return { title: `Neustart des Servers geplant (in ${a.delay} s)`, level: 'crit', confirm: 'NEUSTART' };
    case 'system.cancel-reboot': return { title: 'Geplanter Neustart abgebrochen', level: 'info' };
    case 'sys.set-hostname': return { title: `Rechnername auf „${short(a.name, 40)}“ gesetzt`, level: 'warn', confirm: 'RECHNERNAME' };
    case 'sys.set-timezone': return { title: `Zeitzone auf ${short(a.tz, 40)} gesetzt`, level: 'info' };

    case 'docker.control': return { title: `Container ${a.name} ${DOCKER_LABEL[a.action] || a.action}`, level: ['stop', 'kill', 'pause'].includes(a.action) ? 'warn' : 'info' };
    case 'docker.remove': return { title: `Container ${a.name} entfernt`, level: 'warn', confirm: a.name };
    case 'docker.rename': return { title: `Container ${a.name} umbenannt in ${a.to}`, level: 'info' };
    case 'docker.restart-policy': return { title: `Neustart-Regel von ${a.name} auf „${a.policy}“ gesetzt`, level: 'info' };
    case 'docker.image-pull': return { title: `Image ${short(a.ref)} geladen`, level: 'info' };
    case 'docker.image-remove': return { title: `Image ${short(a.id)} entfernt`, level: 'warn' };
    case 'docker.volume-remove': return { title: `Volume ${a.name} entfernt`, level: 'warn', confirm: a.name };
    case 'docker.network-remove': return { title: `Docker-Netzwerk ${a.name} entfernt`, level: 'warn' };
    case 'docker.prune': return { title: `Docker aufgeräumt: ${PRUNE_LABEL[a.kind] || a.kind}`, level: 'warn', confirm: a.kind === 'volumes' ? 'VOLUMES' : null };
    case 'docker.compose': return { title: `Compose-Projekt ${a.project}: ${a.action}`, level: a.action === 'down' ? 'warn' : 'info', confirm: ['down', 'stop'].includes(a.action) ? a.project : null };

    case 'fw.ufw-add': return { title: `Firewall: ${a.action} Port ${a.port}/${a.proto || 'any'} von ${a.from || 'überall'}`, level: 'warn' };
    case 'fw.ufw-delete': return { title: `Firewall-Regel ${a.number} gelöscht`, level: 'warn', confirm: 'FIREWALL' };
    case 'fw.ufw-enable': return { title: `Firewall ${a.on ? 'eingeschaltet' : 'ausgeschaltet'}`, level: a.on ? 'info' : 'crit', confirm: a.on ? null : 'FIREWALL' };
    case 'f2b.ban':
    case 'f2b.unban':
      if (op === 'f2b.ban' && a.ip && a.ip === ctx.ip) throw bad('Das ist deine eigene Adresse. Du würdest dich selbst aussperren.');
      return { title: `fail2ban (${a.jail}): ${a.ip} ${op === 'f2b.ban' ? 'gesperrt' : 'entsperrt'}`, level: 'warn' };

    case 'users.add': return { title: `Benutzer ${a.name} angelegt`, level: 'warn' };
    case 'users.lock': return { title: `Benutzer ${a.name} ${a.lock ? 'gesperrt' : 'entsperrt'}`, level: 'warn' };
    case 'users.sudo': return { title: `Benutzer ${a.name}: Administratorrechte ${a.on ? 'erteilt' : 'entzogen'}`, level: 'warn', confirm: a.on ? a.name : null };
    case 'users.delete': return { title: `Benutzer ${a.name} gelöscht${a.removeHome ? ' (samt Home-Verzeichnis)' : ''}`, level: 'crit', confirm: a.name };
    case 'users.session-kill': return { title: `Sitzung ${a.id} beendet`, level: 'warn' };
    case 'users.keys-set': return { title: `SSH-Schlüssel von ${a.name} geändert`, level: 'warn', confirm: a.name };

    case 'pkg.update': return { title: 'Paketlisten aktualisiert (apt update)', level: 'info' };
    case 'pkg.upgrade': return { title: 'Alle Updates installiert (apt upgrade)', level: 'warn' };
    case 'pkg.autoremove': return { title: 'Nicht benötigte Pakete entfernt (autoremove)', level: 'info' };
    case 'pkg.clean': return { title: 'Paket-Zwischenspeicher geleert', level: 'info' };
    case 'pkg.install': return { title: `Pakete installiert: ${short((a.names || []).join(', '))}`, level: 'warn' };
    case 'pkg.remove': return { title: `Pakete entfernt: ${short((a.names || []).join(', '))}`, level: 'warn', confirm: 'ENTFERNEN' };
    case 'pkg.hold': return { title: `Paket ${a.name}: Version ${a.on ? 'festgehalten' : 'freigegeben'}`, level: 'info' };

    case 'cron.user-set': return { title: `Crontab von ${a.user} geändert`, level: 'warn' };
    case 'db.mysql-kill': return { title: `MariaDB-Verbindung ${a.id} beendet`, level: 'warn' };
    case 'job.stop': return { title: 'Hintergrundauftrag abgebrochen', level: 'warn' };

    case 'files.write': return { title: `Datei ${a.create ? 'angelegt' : 'gespeichert'}: ${short(a.path)}`, level: CRITICAL_FILES.test(a.path || '') ? 'warn' : 'info', confirm: CRITICAL_FILES.test(a.path || '') ? 'SYSTEMDATEI' : null };
    case 'files.mkdir': return { title: `Ordner angelegt: ${short(a.path)}`, level: 'info' };
    case 'files.rename': return { title: `Verschoben: ${short(a.from, 60)} → ${short(a.to, 60)}`, level: CRITICAL_FILES.test(a.from || '') ? 'warn' : 'info', confirm: CRITICAL_FILES.test(a.from || '') ? 'SYSTEMDATEI' : null };
    case 'files.copy': return { title: `Kopiert: ${short(a.from, 60)} → ${short(a.to, 60)}`, level: 'info' };
    case 'files.delete': return { title: `Gelöscht: ${short(a.path)}${a.recursive ? ' (samt Inhalt)' : ''}`, level: 'warn', confirm: a.recursive ? 'LÖSCHEN' : CRITICAL_FILES.test(a.path || '') ? 'SYSTEMDATEI' : null };
    case 'files.chmod': return { title: `Rechte von ${short(a.path)} auf ${a.mode} gesetzt${a.recursive ? ' (rekursiv)' : ''}`, level: 'warn', confirm: a.recursive ? 'REKURSIV' : null };
    case 'files.chown': return { title: `Besitzer von ${short(a.path)} auf ${a.owner}${a.group ? `:${a.group}` : ''} gesetzt${a.recursive ? ' (rekursiv)' : ''}`, level: 'warn', confirm: a.recursive ? 'REKURSIV' : null };
    case 'files.restore': return { title: `Frühere Version einer Datei wiederhergestellt`, level: 'warn' };
    case 'files.install': return { title: `Datei hochgeladen: ${short(a.dest)}`, level: 'info' };

    case 'term.run': {
      const risky = RISKY_CMD.test(a.cmd || '');
      return { title: `Befehl ausgeführt${a.user && a.user !== 'root' ? ` als ${a.user}` : ''}: ${short((a.cmd || '').trim().split('\n')[0], 90)}`, level: risky ? 'warn' : 'info', confirm: risky ? 'RISIKO' : null };
    }
    case 'docker.exec': return { title: `Befehl im Container ${a.name}: ${short((a.cmd || '').trim().split('\n')[0], 70)}`, level: 'warn' };
    case 'docker.stack-save': return { title: `Docker-Projekt ${a.name} ${a.up ? 'gespeichert und gestartet' : 'gespeichert'}`, level: 'warn' };
    case 'docker.stack-delete': return { title: `Docker-Projekt ${a.name} entfernt${a.volumes ? ' (samt Volumes)' : ''}`, level: 'warn', confirm: a.name };
    case 'nginx.site-create': return { title: `Website angelegt: ${a.name} (${short(Array.isArray(a.domains) ? a.domains.join(', ') : '', 80)})`, level: 'warn' };
    case 'nginx.site-delete': return { title: `Website gelöscht: ${a.name}`, level: 'warn', confirm: a.name };
    case 'certs.issue': return { title: `Zertifikat angefordert: ${short(Array.isArray(a.domains) ? a.domains.join(', ') : '', 80)}`, level: 'info' };
    case 'certs.delete': return { title: `Zertifikat gelöscht: ${a.name}`, level: 'warn', confirm: a.name };
    case 'backup.plan-save': return { title: `Sicherungsplan ${a.id} gespeichert`, level: 'info' };
    case 'backup.plan-delete': return { title: `Sicherungsplan ${a.id} gelöscht${a.archives ? ' (samt Archiven)' : ''}`, level: 'warn', confirm: a.id };
    case 'backup.run': return { title: `Sicherung gestartet: ${a.id}`, level: 'info' };
    case 'backup.delete': return { title: `Sicherungsarchiv gelöscht: ${short(a.id, 70)}`, level: 'warn' };
    case 'backup.restore': return { title: `Sicherung wiederhergestellt: ${short(a.id, 60)} → ${short(a.dest, 50)}`, level: 'warn', confirm: a.dest === '/' ? 'WIEDERHERSTELLEN' : null };
    case 'sys.swap-create': return { title: `Auslagerungsdatei ${a.path} angelegt (${a.sizeMb} MB)`, level: 'info' };
    case 'sys.swap-remove': return { title: `Auslagerung ${a.path} entfernt`, level: 'warn', confirm: 'AUSLAGERUNG' };
    default: throw bad('Unbekannte Aktion.');
  }
}

module.exports = { call, plan, READ_OPS, SENSITIVE_OPS, WRITE_OPS, CRITICAL_UNITS, CRITICAL_FILES };
