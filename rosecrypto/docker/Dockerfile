FROM alpine:latest

ENV DISPLAY=:1 \
    RESOLUTION=1280x800 \
    VNC_PASSWORD=rosecry \
    LANG=C.UTF-8 \
    CHROME_PATH=/usr/bin/chromium-browser \
    CHROME_CHANNEL=chromium \
    HOME=/home/bot

# Desktop + VNC/noVNC + Chromium + Node
RUN apk add --no-cache \
    bash \
    sudo \
    procps \
    psmisc \
    curl \
    ca-certificates \
    ttf-freefont \
    ttf-dejavu \
    font-noto \
    font-noto-emoji \
    # Xfce
    xfce4 \
    xfce4-terminal \
    xfce4-panel \
    xfce4-session \
    xfwm4 \
    xfdesktop \
    thunar \
    xfce4-settings \
    xfce4-appfinder \
    mousepad \
    dbus \
    dbus-x11 \
    # TigerVNC (vncpasswd for the x11vnc auth file) + noVNC
    tigervnc \
    novnc \
    websockify \
    x11vnc \
    # Xvfb (DISPLAY_MODE=xvfb: virtual display, no desktop/VNC needed)
    xvfb \
    xvfb-run \
    xauth \
    # Browser
    chromium \
    # Node.js
    nodejs \
    npm \
    # Chromium runtime libs
    libstdc++ \
    libxfixes \
    libxi \
    libxtst \
    nss \
    cups-libs \
    libxcomposite \
    libxdamage \
    libxrandr \
    mesa-gbm \
    && update-ca-certificates

# Non-root user (busybox adduser takes a single -G group; add the rest via addgroup)
RUN adduser -D -s /bin/bash -G wheel bot \
    && addgroup bot audio \
    && addgroup bot video \
    && echo "bot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/bot \
    && chmod 0440 /etc/sudoers.d/bot

# App
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY bot.mjs vision.mjs config.json accounts.json manage.sh ./
RUN chown -R bot:wheel /app

# Mount points for the profile volumes.  Pre-create them owned by bot so the
# first use of a fresh named volume inherits uid/gid 1000 instead of root:root
# (which would make every per-account mkdir fail with EACCES).
RUN mkdir -p /home/bot/.rosecrypto-profiles /home/bot/.rosecrypto-chrome-profile \
    && chown -R bot:wheel /home/bot/.rosecrypto-profiles /home/bot/.rosecrypto-chrome-profile

# VNC password (VNC passwords are max 8 chars — bake the truncated value with
# the non-interactive -f filter so builds never stall on a prompt)
RUN mkdir -p /home/bot/.vnc \
    && printf '%s' "${VNC_PASSWORD:0:8}" | vncpasswd -f > /home/bot/.vnc/passwd \
    && chmod 600 /home/bot/.vnc/passwd \
    && chown -R bot:wheel /home/bot/.vnc

# Xfce autostart: terminal tailing bot log
RUN mkdir -p /home/bot/.config/autostart \
    && printf '%s\n' \
      '[Desktop Entry]' \
      'Type=Application' \
      'Name=Bot Log' \
      'Exec=xfce4-terminal -H -e "tail -f /app/bot.log"' \
      'X-GNOME-Autostart-enabled=true' \
      > /home/bot/.config/autostart/bot-terminal.desktop \
    && chown -R bot:wheel /home/bot/.config

COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

EXPOSE 6080 5901

USER bot
WORKDIR /app

ENTRYPOINT ["/entrypoint.sh"]
