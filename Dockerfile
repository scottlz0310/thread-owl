FROM node:22-alpine AS builder

RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json .
COPY src ./src
RUN pnpm run build

# ---

FROM node:22-alpine AS runtime

RUN npm install -g pnpm

WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "dist/index.js"]
