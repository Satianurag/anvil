# Reference container build — anvil also deploys bare-metal (see deploy/DEPLOY.md).
# Sidecars (browser, docling, PDF renderer, S3) stay external services, wired by env vars.

FROM node:24-slim AS deps
ENV PNPM_HOME=/pnpm
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-slim
ENV PNPM_HOME=/pnpm
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production PORT=4021
EXPOSE 4021
# tsx runs the TS sources directly (it is a runtime dependency, not a build step).
CMD ["node", "--import", "tsx", "src/server.ts"]
