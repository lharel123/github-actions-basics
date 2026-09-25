#!/usr/bin/env bash
# Installs Touchline on Ubuntu and exposes it ONLY on your Tailscale network.
#
# Usage (from the touchline/ directory):
#   sudo ./deploy/install.sh            # listen on the Tailscale IP, http://<ts-ip>:8080
#   sudo MODE=serve ./deploy/install.sh # listen on 127.0.0.1 + `tailscale serve` (HTTPS inside the tailnet)
#   sudo PORT=9000 ./deploy/install.sh
set -euo pipefail

MODE="${MODE:-direct}"
PORT="${PORT:-8080}"
APP_DIR=/opt/touchline
DATA_DIR=/var/lib/touchline
APP_USER=touchline
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Please run with sudo." >&2
  exit 1
fi

echo "==> Checking Node.js"
NODE_MAJOR=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
fi
if (( NODE_MAJOR < 18 )); then
  echo "    Installing Node.js 20 (NodeSource)"
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Checking Tailscale"
if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi
if ! tailscale ip -4 >/dev/null 2>&1; then
  echo "    Tailscale is not logged in. Opening login..."
  tailscale up
fi
TS_IP="$(tailscale ip -4 | head -n1)"
TS_NAME="$(tailscale status --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).Self.DNSName.replace(/\.$/,""))}catch(e){}})' || true)"
echo "    Tailscale IP: $TS_IP ${TS_NAME:+($TS_NAME)}"

echo "==> Creating user and directories"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR" "$DATA_DIR"
rm -rf "$APP_DIR/public"
cp "$SRC_DIR/server.js" "$APP_DIR/"
cp -r "$SRC_DIR/public" "$APP_DIR/"
echo "==> Downloading club crests"
"$SRC_DIR/deploy/fetch_crests.sh" "$APP_DIR/public/crests" || echo "    Crest download failed; the game falls back to kit-colour badges."
chown -R root:root "$APP_DIR"
chmod -R a+rX "$APP_DIR"
chown -R "$APP_USER:$APP_USER" "$DATA_DIR"
chmod 750 "$DATA_DIR"

if [[ "$MODE" == "serve" ]]; then
  BIND=127.0.0.1
else
  BIND="$TS_IP"
fi

cat > /etc/touchline.env <<EOF
HOST=$BIND
PORT=$PORT
DATA_DIR=$DATA_DIR
ALLOWED_NETS=100.64.0.0/10,fd7a:115c:a1e0::/48,127.0.0.0/8,::1/128
EOF

echo "==> Installing systemd service"
cp "$SRC_DIR/deploy/touchline.service" /etc/systemd/system/touchline.service
systemctl daemon-reload
systemctl enable touchline
systemctl restart touchline

echo "==> Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow in on tailscale0 to any port "$PORT" proto tcp comment 'Touchline (Tailscale only)'
  ufw deny "$PORT"/tcp comment 'Touchline: block outside Tailscale'
else
  echo "    ufw is not active; the server still binds only to $BIND and rejects non-Tailscale IPs."
fi

if [[ "$MODE" == "serve" ]]; then
  echo "==> Enabling tailscale serve (HTTPS, tailnet only)"
  tailscale serve --bg --https=443 "http://127.0.0.1:$PORT"
fi

sleep 1
if systemctl is-active --quiet touchline; then
  echo
  echo "Touchline is running. Open it from any device connected to your Tailscale:"
  if [[ "$MODE" == "serve" ]]; then
    echo "   https://${TS_NAME:-<machine-name>.<tailnet>.ts.net}/"
  else
    echo "   http://$TS_IP:$PORT/"
    [[ -n "$TS_NAME" ]] && echo "   http://$TS_NAME:$PORT/"
  fi
  echo
  echo "Logs: journalctl -u touchline -f"
else
  echo "Service failed to start. Check: journalctl -u touchline -e" >&2
  exit 1
fi
