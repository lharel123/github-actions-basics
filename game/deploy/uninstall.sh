#!/usr/bin/env bash
# Removes Legion Arena. Scores in /var/lib/legion-arena are kept unless PURGE=1.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Please run with sudo." >&2; exit 1; fi

systemctl disable --now legion-arena 2>/dev/null || true
rm -f /etc/systemd/system/legion-arena.service /etc/legion-arena.env
systemctl daemon-reload
rm -rf /opt/legion-arena
[[ "${PURGE:-0}" == "1" ]] && rm -rf /var/lib/legion-arena
echo "Removed. If you used MODE=serve, also run: sudo tailscale serve reset"
