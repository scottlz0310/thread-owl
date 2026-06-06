FROM node:22.22.3-alpine AS builder

RUN npm install -g pnpm@11

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY tsconfig.json .
COPY src ./src
RUN pnpm run build

# ---

FROM node:22.22.3-alpine AS runtime

RUN npm install -g pnpm@11

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

ENTRYPOINT ["node", "dist/index.js"]
CMD []
