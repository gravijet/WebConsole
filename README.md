# Xeon-1 Console

Private live dashboard: https://console.benjaminberger.at (login required).

- `server.js` – HTTP server, auth routes, SSE stream. No dependencies (Node 22).
- `lib/` – `proc.js` (/proc + /sys readers), `collector.js` (1 Hz sampling, detail snapshot, alerts), `slow.js` (systemd units, websites from nginx config, certificates, internet latency), `history.js`, `events.js`, `settings.js`, `auth.js`.
- `web/` – frontend (plain ES modules + canvas/SVG charts, no build step, no external requests).
- `bin/docker-snapshot.js` – runs as root via timer, writes a whitelisted JSON of container facts.
- Nothing about the machine is hard-coded: websites come from nginx `server_name`, services/containers/processes/disks/interfaces are enumerated at runtime. Everything adjustable lives in the settings page (`/var/lib/server-dash/settings.json`).

## Login
Only one e-mail address may sign in (`ALLOWED_EMAIL`, default in `lib/auth.js`). First run: the owner needs the one-time setup code and chooses a password.

    sudo cat /var/lib/server-dash/setup-code.txt      # first time only

Forgot the password:

    sudo /home/benj/ServerDash/bin/reset-auth.sh      # clears password + sessions, new setup code

Security: scrypt (N=2^15) password hashes, 256-bit random session tokens (only SHA-256 stored), `__Host-` cookie (Secure, HttpOnly, SameSite=Strict), 12 h idle / 7 d absolute lifetime, CSRF header + origin check, per-IP lockout with escalation, generic error messages, constant-work login, strict CSP, nginx rate limit on `/auth/`, origin only reachable through Cloudflare.

## Operation
    systemctl status server-dash        sudo journalctl -u server-dash -f
    sudo systemctl restart server-dash  # needed after changes in server.js / lib/; web/ is read from disk

State (`/var/lib/server-dash`): `auth.json`, `history.json` (24 h), `events.json`, `sites.json`, `settings.json`, `docker.json`.

## Deployment files (`deploy/`)
- `server-dash.service` → `/etc/systemd/system/` (user `serverdash`, sandboxed)
- `server-dash-actions.socket` + `.service` → `/etc/systemd/system/`
- `server-dash-docker.service` + `.timer` → `/etc/systemd/system/`, helper script → `/usr/local/lib/server-dash/`
- `console.benjaminberger.at.nginx` → `/etc/nginx/sites-enabled/console.benjaminberger.at`
- `server-dash-status.conf` → `/etc/nginx/conf.d/` (loopback `stub_status`)

## Server management (views and the root helper)
The dashboard itself runs unprivileged. Everything that reads protected data or changes the machine goes through a root helper:
- `bin/actions-daemon.js` + `bin/daemon/*.js` → `/usr/local/lib/server-dash/` (copy the **whole** `daemon/` folder). Started on demand by `server-dash-actions.socket` (unix socket, only root + group `serverdash`), exits when idle. Modules: `system` (processes, units, nginx, certificates, reboot, hardware, logs), `console` (command console as job, docker exec, compose projects in /opt/stacks), `sites` (nginx site wizard, certbot issue/delete), `backup` (+ `backup-run.js`, copied next to the helper), `sysx` (timers, boot analysis, swap, speed test), `docker`, `net` (interfaces, sockets, ping/dig/traceroute/tls/http/whois), `security` (ufw, fail2ban, SSH activity, audit), `users`, `pkg` (apt), `cron`, `files`, `db`, `jobs`.
- Only a fixed set of operations with strict validation; no arbitrary command execution. `lib/actions.js` lists them as **lookups** (session is enough), **sensitive lookups** (file contents, key lists: fresh password), and **changes** (fresh password, rate limit, event log entry, typed confirmation for dangerous ones such as critical units, reboot, firewall off, user delete, recursive delete, system files).
- Long work (apt, docker pull/compose, certbot) runs as a transient systemd unit `sd-job-*`; output is polled via `job.get`.
- File manager: secrets (shadow, SSH host/private keys, certificate keys, the dashboard's own auth files) are never read; the helper's own code and the dashboard state are write-protected; every overwrite/delete of a file ≤ 8 MB keeps a copy in `/var/backups/server-dash`; nginx/sshd configs are validated after saving (old version restored on failure), sudoers before. Uploads (≤ 90 MB, Cloudflare limit) and downloads (≤ 256 MB) stream through `/var/lib/server-dash/{uploads,outbox}`.
- The helper's systemd unit must **not** use `ProtectSystem`/`ProtectHome`/`PrivateTmp`, otherwise it cannot see or change `/etc`, `/home` and `/tmp`.
- After changing the helper: copy it to `/usr/local/lib/server-dash/` and `sudo systemctl stop server-dash-actions.service` (the socket restarts it on the next request).

Dashboard-side features (state in `/var/lib/server-dash`): `lib/notify.js` (push to ntfy/Telegram/Discord/Slack/webhook, tokens never sent to the browser), `lib/heal.js` (self-healing restarts with delay, hourly limit, respects deliberate stops), `lib/userdata.js` (notes, saved commands, favourites), TOTP two-factor login in `lib/auth.js` (login, unlocking actions, recovery codes; QR via vendored `web/js/vendor/qrcode.js`, MIT).
Backups: plans in `/etc/server-dash/backups.json`, archives in `/var/backups/sd-archives` (root only), schedule written to `/etc/cron.d/server-dash-backups`.
nginx needs a body-size location for `/api/userdata` (see `deploy/console.benjaminberger.at.nginx`).
Test overrides for the helper: `SD_CONF_DIR`, `SD_ARCHIVE_DIR`, `SD_CRON_FILE`, `SD_BACKUP_RUNNER`, `SD_STACKS_DIR`.

Views: Übersicht, Ereignisse, CPU, Arbeitsspeicher, Netzwerk, Datenträger, Prozesse, Dienste, Docker, Apps (compose templates), Websites, nginx & Zertifikate, Dateien, Speicher-Karte, Konsole, Zeitpläne, Sicherungen, Updates & Pakete, Benutzer & SSH, Sicherheit, Protokolle, Datenbanken, Werkzeuge, System, Alarme & Automatik, Notizen, Bericht, Einstellungen, Rohdaten. Ctrl+K searches views, actions, containers and services; `g` + letter jumps between views, `?` lists the shortcuts. Theme: light (default), dark or automatic (`localStorage sd.theme`, applied early by `web/theme.js`).
