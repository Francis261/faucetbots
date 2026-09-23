#!/bin/bash
set -uo pipefail

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

# ---- D-Bus (needed by Xfce) ----
if ! pgrep -x dbus-daemon >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID
  log "Started session D-Bus"
fi

# ---- Find startxfce4 ----
XFCE_START="$(command -v startxfce4 || true)"
if [ -z "${XFCE_START}" ]; then
  XFCE_START="/usr/bin/startxfce4"
fi
if [ ! -x "${XFCE_START}" ]; then
  # Fallback: xterm only
  XFCE_START="$(command -v xterm || command -v xfce4-terminal || echo /bin/bash)"
  log "Xfce not found, using ${XFCE_START}"
fi

# ---- Start TigerVNC ----
log "Starting VNC :${DISP} (${RESOLUTION}) via ${XFCE_START}..."
# Write xstartup
mkdir -p "${HOME}/.vnc"
cat > "${HOME}/.vnc/xstartup" << EOF
#!/bin/sh
unset SESSION_MANAGER
unset DBUS_SESSION_BUS_ADDRESS
exec ${XFCE_START}
EOF
chmod +x "${HOME}/.vnc/xstartup"

vncserver "${DISPLAY_NUM}" \
  -localhost no \
  -geometry "${RESOLUTION}" \
  -depth 24 \
  -SecurityTypes VncAuth \
  >/tmp/vncserver.log 2>&1 || {
    log "vncserver failed:"
    cat /tmp/vncserver.log
    # Retry with plain xstartup path
    vncserver -kill "${DISPLAY_NUM}" 2>/dev/null || true
    vncserver "${DISPLAY_NUM}" -localhost no -geometry "${RESOLUTION}" -depth 24 \
      >/tmp/vncserver.log 2>&1 || {
      log "vncserver retry failed:"
      cat /tmp/vncserver.log
      exit 1
    }
  }

sleep 2

# ---- noVNC web root (Alpine + Debian paths) ----
NOVNC_WEB=""
for d in /usr/share/novnc /usr/share/webapps/novnc /usr/share/novnc/web; do
  if [ -f "$d/vnc.html" ] || [ -f "$d/index.html" ]; then
    NOVNC_WEB="$d"
    break
  fi
done
if [ -z "${NOVNC_WEB}" ]; then
  log "noVNC web files not found — installing path fallback"
  NOVNC_WEB="/usr/share/novnc"
fi

log "Starting noVNC on :${NOVNC_PORT} (web: ${NOVNC_WEB})..."
websockify --web "${NOVNC_WEB}" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
  >/tmp/websockify.log 2>&1 &
NOVNC_PID=$!

sleep 1

# ---- Bot ----
BOT_PID=0
start_bot() {
  log "Starting bot..."
  cd /app || return 1
  : > /app/bot.log 2>/dev/null || true
  node --unhandled-rejections=warn bot.mjs >> /app/bot.log 2>&1 &
  BOT_PID=$!
  log "Bot PID ${BOT_PID}"
}

if [ "${START_BOT:-1}" = "1" ]; then
  start_bot
else
  log "START_BOT=0 — desktop only"
fi

log "Ready → http://localhost:${NOVNC_PORT}/vnc.html"
log "VNC password: ${VNC_PASSWORD:-rosecrypto}"

term() {
  log "Shutting down..."
  [ "${BOT_PID}" != "0" ] && kill "${BOT_PID}" 2>/dev/null || true
  kill "${NOVNC_PID:-0}" 2>/dev/null || true
  vncserver -kill "${DISPLAY_NUM}" 2>/dev/null || true
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
  if ! kill -0 "${NOVNC_PID:-0}" 2>/dev/null; then
    log "noVNC died — restarting..."
    websockify --web "${NOVNC_WEB}" "${NOVNC_PORT}" "localhost:${VNC_PORT}" \
      >/tmp/websockify.log 2>&1 &
    NOVNC_PID=$!
  fi
  sleep 10
done
