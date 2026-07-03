FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production \
    PORT=7000 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 7000
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://localhost:7000/health || exit 1
CMD ["node", "src/server.js"]
