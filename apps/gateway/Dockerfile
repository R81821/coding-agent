FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/providers/package.json packages/providers/package.json
RUN pnpm install --filter @harness/gateway... --frozen-lockfile=false
COPY apps/gateway apps/gateway
COPY packages/protocol packages/protocol
COPY packages/providers packages/providers
RUN pnpm --filter @harness/gateway build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/gateway/dist ./dist
COPY --from=build /app/apps/gateway/package.json ./package.json
CMD ["node", "dist/main.js"]
