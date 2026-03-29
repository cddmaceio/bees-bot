FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

# Instala x11vnc + noVNC + websockify para acesso visual remoto
RUN apt-get update && apt-get install -y \
    x11vnc \
    novnc \
    websockify \
    xvfb \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000
EXPOSE 6080

CMD ["sh", "-c", "\
  Xvfb :99 -screen 0 1280x900x24 & \
  sleep 1 && \
  x11vnc -display :99 -nopw -listen 0.0.0.0 -xkb -forever -shared & \
  sleep 1 && \
  websockify --web /usr/share/novnc 6080 localhost:5900 & \
  sleep 1 && \
  DISPLAY=:99 node server.js \
"]
