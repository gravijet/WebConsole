#!/bin/sh
# Forgot the password? Run:  sudo /home/benj/ServerDash/bin/reset-auth.sh
# Clears the password and all sessions and writes a new one-time setup code.
set -e
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo ausführen."; exit 1; }
systemctl stop server-dash
cd /home/benj/ServerDash
sudo -u serverdash env STATE_DIRECTORY=/var/lib/server-dash /usr/bin/node server.js --reset-auth
systemctl start server-dash
echo "Fertig. Öffne https://console.benjaminberger.at und richte das Passwort neu ein."
