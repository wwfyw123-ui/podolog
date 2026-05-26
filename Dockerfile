FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY server.mjs ./
COPY index.html admin.html privacy.html consent.html ./
COPY config ./config
COPY scripts ./scripts

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=4173
ENV DATABASE_PATH=/app/data/clinic.sqlite

EXPOSE 4173

CMD ["node", "server.mjs"]
