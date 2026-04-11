FROM mcr.microsoft.com/playwright:v1.58.2-jammy

WORKDIR /app

ENV DEBIAN_FRONTEND=noninteractive
ENV TZ=America/Maceio

COPY package.json .
RUN npm install

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
