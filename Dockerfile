FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
# TV-2 C4: ship scripts/ (bench-engines.js and the series-ladder tool) in the
# image so the reviewer can run the backtest on the staged server.
COPY scripts ./scripts
COPY public ./public
# Mobile Companion app (mounted at /mobile by src/server.js). Runtime code +
# static SPA; docs/ and test/ are excluded via .dockerignore.
COPY mobile ./mobile
ENV NODE_ENV=production \
    PORT=7000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 7000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://localhost:7000/health || exit 1
# --experimental-sqlite: enables the built-in node:sqlite (Node 22). No native
# module / build tools needed — the watched + recommended stores use it.
CMD ["node", "--experimental-sqlite", "src/server.js"]
