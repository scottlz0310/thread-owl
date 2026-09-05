# Bun バイナリのみを公式イメージから取得する（.bun-version と同じ version に固定する）。
FROM oven/bun:1.4.2-alpine AS bun

FROM node:24.19.0-alpine AS builder

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --ignore-scripts

COPY tsconfig.json .
COPY src ./src
RUN bun run build

# ---

FROM node:24.19.0-alpine AS runtime

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
CMD []
