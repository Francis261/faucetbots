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

# Credentials — REPLACE committed stores so only this run's account is used
export LOGIN_EMAIL="$EMAIL" LOGIN_PASSWORD="$PASSWORD" LOGIN_USERNAME="${USERNAME:-$EMAIL}"
case "$BOT" in
  onlyfaucet)
    if [ -z "$EMAIL" ]; then echo "onlyfaucet requires EMAIL"; exit 1; fi
    node -e '
      const fs = require("fs");
      fs.writeFileSync("onlyfaucet/accounts.json", JSON.stringify([{ email: process.env.EMAIL, claims: 0, lastClaim: null }], null, 2));
      console.log("onlyfaucet accounts.json ->", process.env.EMAIL);
    '
    ;;
  rosecrypto)
    ROSE_USER="${USERNAME:-$EMAIL}"
    if [ -z "$ROSE_USER" ]; then echo "rosecrypto requires username or EMAIL"; exit 1; fi
    if [ -z "$PASSWORD" ]; then echo "rosecrypto requires PASSWORD"; exit 1; fi
    export ROSE_USER PASSWORD LOGIN_USERNAME="$ROSE_USER"
    node -e '
      const fs = require("fs");
      const u = process.env.ROSE_USER;
      const pw = process.env.PASSWORD || "";
      if (!u || !pw) { console.error("rosecrypto requires email/username + password"); process.exit(1); }
      fs.writeFileSync("rosecrypto/accounts.json", JSON.stringify([{ username: u, password: pw, claims: 0, lastClaim: null }], null, 2));
      console.log("rosecrypto accounts.json ->", u);
    '
    ;;
  1xfaucet)
    if [ -z "$EMAIL" ]; then echo "1xfaucet requires EMAIL"; exit 1; fi
    if [ -z "$PASSWORD" ]; then echo "1xfaucet requires PASSWORD"; exit 1; fi
    export EMAIL PASSWORD
    node -e '
      const Database = require("better-sqlite3");
      const { join } = require("path");
      const dbPath = join(process.env.HOME, "adbch", "1xfaucet", "accounts.db");
      const db = new Database(dbPath);
      db.pragma("journal_mode = WAL");
      db.exec(`CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        status TEXT DEFAULT '\''active'\'',
        last_claim_at TEXT,
        next_available_at TEXT,
        total_claims INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('\''now'\'')),
        updated_at TEXT DEFAULT (datetime('\''now'\''))
      );`);
      db.prepare("DELETE FROM accounts WHERE email <> ?").run(process.env.EMAIL);
      db.prepare(`
        INSERT INTO accounts (email, password, status, next_available_at, updated_at)
        VALUES (?, ?, '\''active'\'', NULL, datetime('\''now'\''))
        ON CONFLICT(email) DO UPDATE SET password=excluded.password, status='\''active'\'', next_available_at=NULL, updated_at=datetime('\''now'\'')
      `).run(process.env.EMAIL, process.env.PASSWORD);
      console.log("1xfaucet accounts.db ->", process.env.EMAIL);
      db.close();
    '
    node -e '
      const fs = require("fs");
      const p = "1xfaucet/config.json";
      const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
      cfg.email = process.env.EMAIL; cfg.password = process.env.PASSWORD;
      fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
    '
    ;;
  *) echo "Unknown BOT=$BOT"; exit 1;;
esac
echo "Active credentials: bot=$BOT email=${EMAIL:-} username=${USERNAME:-}"

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
