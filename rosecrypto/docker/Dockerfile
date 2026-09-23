FROM alpine:latest

ENV DISPLAY=:1 \
    RESOLUTION=1280x800 \
    VNC_PASSWORD=rosecrypto \
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
    # TigerVNC + noVNC
    tigervnc \
    novnc \
    websockify \
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

# Non-root user
RUN adduser -D -s /bin/bash -G wheel,audio,video bot \
    && echo "bot ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/bot \
    && chmod 0440 /etc/sudoers.d/bot

# App
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY bot.mjs vision.mjs config.json accounts.json manage.sh ./
RUN chown -R bot:bot /app

# VNC password
RUN mkdir -p /home/bot/.vnc \
    && printf '%s\n%s\n' "${VNC_PASSWORD}" "${VNC_PASSWORD}" | vncpasswd \
    && chmod 600 /home/bot/.vnc/passwd \
    && chown -R bot:bot /home/bot/.vnc

# Xfce autostart: terminal tailing bot log
RUN mkdir -p /home/bot/.config/autostart \
    && printf '%s\n' \
      '[Desktop Entry]' \
      'Type=Application' \
      'Name=Bot Log' \
      'Exec=xfce4-terminal -H -e "tail -f /app/bot.log"' \
      'X-GNOME-Autostart-enabled=true' \
      > /home/bot/.config/autostart/bot-terminal.desktop \
    && chown -R bot:bot /home/bot/.config

COPY --chmod=755 docker/entrypoint.sh /entrypoint.sh

EXPOSE 6080 5901

USER bot
WORKDIR /app

ENTRYPOINT ["/entrypoint.sh"]
