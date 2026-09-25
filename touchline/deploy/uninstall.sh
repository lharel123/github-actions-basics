#!/usr/bin/env bash
# Removes Touchline. Scores in /var/lib/touchline are kept unless PURGE=1.
set -euo pipefail
if [[ $EUID -ne 0 ]]; then echo "Please run with sudo." >&2; exit 1; fi

systemctl disable --now touchline 2>/dev/null || true
rm -f /etc/systemd/system/touchline.service /etc/touchline.env
systemctl daemon-reload
rm -rf /opt/touchline
[[ "${PURGE:-0}" == "1" ]] && rm -rf /var/lib/touchline
echo "Removed. If you used MODE=serve, also run: sudo tailscale serve reset"
