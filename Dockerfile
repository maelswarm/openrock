# Website deployment: one container serving the web app and the API.
#   docker build -t open-rock .
#   docker run -p 8787:8787 --env-file .env -e OPEN_ROCK_AUTH_TOKEN=change-me -v open-rock-data:/data open-rock

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY shared shared
COPY server server
COPY web web
COPY tsconfig.base.json ./
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
    OPEN_ROCK_HOST=0.0.0.0 \
    OPEN_ROCK_PORT=8787 \
    OPEN_ROCK_DATA_DIR=/data \
    OPEN_ROCK_WEB_DIR=/app/web/dist
COPY --from=build /app/server/dist/index.mjs server/dist/index.mjs
COPY --from=build /app/web/dist web/dist
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "server/dist/index.mjs"]
