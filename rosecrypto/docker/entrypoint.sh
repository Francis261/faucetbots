#!/bin/bash
set -uo pipefail

# DISPLAY_MODE:
#   xvfb (default) - bot runs under xvfb-run: virtual display, no desktop,
#                    no VNC, no window ever drawn (Cloudflare sees a normal
#                    headed Chrome on a real X display).
#   vnc            - Xvfb + Xfce desktop + x11vnc/noVNC on :6080 for visually
#                    watching/debugging the browser.
DISPLAY_MODE="${DISPLAY_MODE:-xvfb}"
DISPLAY_NUM="${DISPLAY_NUM:-:1}"
RESOLUTION="${RESOLUTION:-1280x800}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
DISP="${DISPLAY_NUM#:}"
VNC_PORT="590${DISP}"
export DISPLAY="${DISPLAY_NUM}"
export HOME="${HOME:-/home/bot}"

log() { echo "[entrypoint $(date +%H:%M:%S)] $*"; }

# Clean stale locks
rm -f "/tmp/.X${DISP}-lock" "/tmp/.X11-unix/X${DISP}" /tmp/rosecrypto.lock 2>/dev/null || true
mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix 2>/dev/null || true

NOVNC_PID=0
X11VNC_PID=0
NOVNC_WEB=""

if [ "${DISPLAY_MODE}" = "xvfb" ]; then
  log "xvfb mode: no desktop/VNC — bot will run under xvfb-run (${RESOLUTION})"
else
  # ---- Xvfb (shared virtual display for desktop + browser) ----
  log "Starting Xvfb ${DISPLAY_NUM} (${RESOLUTION}x24)..."
  Xvfb "${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" >/tmp/xvfb.log 2>&1 &
  XVFB_PID=$!
  sleep 2
  if ! kill -0 "${XVFB_PID}" 2>/dev/null; then
    log "Xvfb failed:"; cat /tmp/xvfb.log; exit 1
  fi

  # ---- D-Bus (needed by Xfce) ----
  if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
    eval "$(dbus-launch --sh-syntax)"
    export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
    log "Started session D-Bus"
  fi

  # ---- Xfce desktop (window manager = normal X environment for Chrome) ----
  log "Starting Xfce desktop..."
  ( unset SESSION_MANAGER; unset DBUS_SESSION_BUS_ADDRESS; startxfce4 ) >/tmp/xfce.log 2>&1 &
  sleep 3

  # ---- x11vnc: share the Xvfb display (Alpine's TigerVNC vncserver CLI
  #      changed; x11vnc is simpler and shares any X display directly) ----
  mkdir -p "${HOME}/.vnc"
  log "Starting x11vnc on :${VNC_PORT}..."
  x11vnc -display "${DISPLAY_NUM}" -rfbport "${VNC_PORT}" -localhost \
    -forever -shared -rfbauth "${HOME}/.vnc/passwd" \
    >/tmp/x11vnc.log 2>&1 &
  X11VNC_PID=$!

  # ---- noVNC web root ----
  for d in /usr/share/novnc /usr/share/webapps/novnc /usr/share/novnc/web; do
    if [ -f "$d/vnc.html" ] || [ -f "$d/index.html" ]; then
      NOVNC_WEB="$d"
      break
    fi
  done
  [ -z "${NOVNC_WEB}" ] && NOVNC_WEB="/usr/share/novnc"

  log "Starting noVNC on :${NOVNC_PORT} (web: ${NOVNC_WEB})..."
  websockify --web "${NOVNC_WEB}" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
    >/tmp/websockify.log 2>&1 &
  NOVNC_PID=$!

  sleep 1
fi

# ---- Bot ----
BOT_PID=0
start_bot() {
  log "Starting bot (display mode: ${DISPLAY_MODE})..."
  cd /app || return 1
  : > /app/bot.log 2>/dev/null || true
  if [ "${DISPLAY_MODE}" = "xvfb" ]; then
    # xvfb-run gives Chrome a fresh virtual X display — headed browser, no
    # window drawn, no VNC needed.  --auto-servernum picks a free display.
    xvfb-run --auto-servernum --server-args="-screen 0 ${RESOLUTION}x24" \
      node --unhandled-rejections=warn bot.mjs >> /app/bot.log 2>&1 &
  else
    node --unhandled-rejections=warn bot.mjs >> /app/bot.log 2>&1 &
  fi
  BOT_PID=$!
  log "Bot PID ${BOT_PID}"
}

if [ "${START_BOT:-1}" = "1" ]; then
  start_bot
else
  log "START_BOT=0 — display only"
fi

if [ "${DISPLAY_MODE}" = "xvfb" ]; then
  log "Ready (xvfb mode). Tail logs: ./manage.sh logs | ./manage.sh log"
else
  log "Ready → http://localhost:${NOVNC_PORT}/vnc.html"
  log "VNC password: ${VNC_PASSWORD:-rosecry}"
fi

term() {
  log "Shutting down..."
  [ "${BOT_PID}" != "0" ] && kill "${BOT_PID}" 2>/dev/null || true
  kill "${NOVNC_PID:-0}" "${X11VNC_PID:-0}" 2>/dev/null || true
  [ "${DISPLAY_MODE}" != "xvfb" ] && kill "${XVFB_PID:-0}" 2>/dev/null || true
  exit 0
}
trap term SIGTERM SIGINT

while true; do
  if [ "${START_BOT:-1}" = "1" ]; then
    if [ "${BOT_PID}" = "0" ] || ! kill -0 "${BOT_PID}" 2>/dev/null; then
      log "Bot died — restarting..."
      rm -f /tmp/rosecrypto.lock
      start_bot
    fi
  fi
  if [ "${DISPLAY_MODE}" != "xvfb" ]; then
    if ! kill -0 "${XVFB_PID:-0}" 2>/dev/null; then
      log "Xvfb died — restarting..."
      Xvfb "${DISPLAY_NUM}" -screen 0 "${RESOLUTION}x24" >/tmp/xvfb.log 2>&1 &
      XVFB_PID=$!
    fi
    if ! kill -0 "${X11VNC_PID:-0}" 2>/dev/null; then
      log "x11vnc died — restarting..."
      x11vnc -display "${DISPLAY_NUM}" -rfbport "${VNC_PORT}" -localhost \
        -forever -shared -rfbauth "${HOME}/.vnc/passwd" \
        >/tmp/x11vnc.log 2>&1 &
      X11VNC_PID=$!
    fi
    if ! kill -0 "${NOVNC_PID:-0}" 2>/dev/null; then
      log "noVNC died — restarting..."
      websockify --web "${NOVNC_WEB}" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
        >/tmp/websockify.log 2>&1 &
      NOVNC_PID=$!
    fi
  fi
  sleep 10
done
