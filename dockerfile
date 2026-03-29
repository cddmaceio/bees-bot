FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x900x24 & sleep 1 && DISPLAY=:99 node server.js"]