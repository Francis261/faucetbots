#!/usr/bin/env bash
# Local helper: same desktop + tunnel stack as the GitHub Action.
# Usage: BOT=onlyfaucet EMAIL=... [PASSWORD=...] ./scripts/run-bot-local.sh
set -euo pipefail

BOT="${BOT:-onlyfaucet}"
EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"
USERNAME="${USERNAME:-}"
VNC_PASSWORD="${VNC_PASSWORD:-}"
DISPLAY_NUM="${DISPLAY:-:99}"
RESOLUTION="${RESOLUTION:-1920x1080}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
VNC_PORT="${VNC_PORT:-5900}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

log() { echo "[local $(date +%H:%M:%S)] $*"; }

if [ -z "$EMAIL" ]; then
  echo "EMAIL is required"; exit 1
fi

export DISPLAY="$DISPLAY_NUM"
cd "$REPO_ROOT"

# Credentials
case "$BOT" in
  onlyfaucet)
    node onlyfaucet/bot.mjs add "$EMAIL"
    ;;
  rosecrypto)
    ROSE_USER="${USERNAME:-$EMAIL}"
    if [ -z "$ROSE_USER" ]; then echo "rosecrypto requires username or EMAIL"; exit 1; fi
    if [ -z "$PASSWORD" ]; then echo "rosecrypto requires PASSWORD"; exit 1; fi
    export ROSE_USER PASSWORD
    node -e '
      const fs = require("fs");
      const p = "rosecrypto/accounts.json";
      const u = process.env.ROSE_USER;
      const pw = process.env.PASSWORD || "";
      if (!u || !pw) { console.error("rosecrypto requires email/username + password"); process.exit(1); }
      let arr = [];
      try { arr = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
      arr = arr.filter(a => a.username !== u);
      arr.push({ username: u, password: pw, claims: 0, lastClaim: null });
      fs.writeFileSync(p, JSON.stringify(arr, null, 2));
      console.log("rosecrypto account ready:", u);
    '
    ;;
  1xfaucet)
    node 1xfaucet/accounts.mjs add "$EMAIL" "$PASSWORD" || true
    EMAIL="$EMAIL" PASSWORD="$PASSWORD" node -e '
      const fs = require("fs");
      const p = "1xfaucet/config.json";
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg.email = process.env.EMAIL; cfg.password = process.env.PASSWORD;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    '
    ;;
  *) echo "Unknown BOT=$BOT"; exit 1;;
esac

# Desktop
DISP="${DISPLAY_NUM#:}"
rm -f "/tmp/.X${DISP}-lock" "/tmp/.X11-unix/X${DISP}" 2>/dev/null || true
Xvfb "$DISPLAY_NUM" -screen 0 "$RESOLUTION"x24 -ac >/tmp/xvfb.log 2>&1 &
sleep 1

if [ -n "$VNC_PASSWORD" ]; then
  x11vnc -storepasswd "$VNC_PASSWORD" /tmp/.vncpass >/dev/null 2>&1 || true
  x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -rfbauth /tmp/.vncpass -shared -forever -nopn -quiet \
    >/tmp/x11vnc.log 2>&1 &
else
  x11vnc -display "$DISPLAY_NUM" -rfbport "$VNC_PORT" -nopw -shared -forever -nopn -quiet \
    >/tmp/x11vnc.log 2>&1 &
fi

NOVNC_WEB=""
for d in /usr/share/novnc /usr/share/webapps/novnc; do
  [ -f "$d/vnc.html" ] && NOVNC_WEB="$d" && break
done
websockify --web "$NOVNC_WEB" "$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >/tmp/websockify.log 2>&1 &

cloudflared tunnel --url "http://127.0.0.1:$NOVNC_PORT" --no-autoupdate >/tmp/cloudflared.log 2>&1 &
for i in $(seq 1 40); do
  NOVNC_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cloudflared.log | head -1 || true)
  [ -n "$NOVNC_URL" ] && break
  sleep 1
done
log "noVNC: ${NOVNC_URL:-http://127.0.0.1:$NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale&scale=local&viewOnly=false"

# Bot
case "$BOT" in
  onlyfaucet) setsid nohup node onlyfaucet/bot.mjs >/tmp/onlyfaucet.log 2>&1 < /dev/null & ;;
  rosecrypto) setsid nohup node --unhandled-rejections=warn rosecrypto/bot.mjs >/tmp/rosecrypto.log 2>&1 < /dev/null & ;;
  1xfaucet)   setsid nohup node 1xfaucet/bot.mjs >/tmp/1xfaucet.log 2>&1 < /dev/null & ;;
esac
log "Bot started ($BOT). Ctrl+C does not stop background procs; kill by pid file / pgrep."
wait
