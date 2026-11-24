# Single-writer Meru Mind Team Server (Node 22+ native node:sqlite WAL + FTS5)
# Requires a persistent local block volume mounted at /var/lib/meru-mind.
FROM node:22-slim AS builder

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.5.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
COPY scripts ./scripts
COPY skills ./skills
COPY docs ./docs
RUN pnpm build && pnpm prune --prod

FROM node:22-slim AS runtime

ENV NODE_ENV=production \
    MERU_MIND_HOME=/var/lib/meru-mind \
    MERU_MIND_HOST=0.0.0.0 \
    MERU_MIND_PORT=3800

WORKDIR /app

# Create non-root runtime user and persistent volume mount point
RUN groupadd --system meru && useradd --system --gid meru --home-dir /var/lib/meru-mind meru \
    && mkdir -p /var/lib/meru-mind /var/lib/meru-mind/backups \
    && chown -R meru:meru /var/lib/meru-mind

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/skills ./skills
COPY --from=builder /app/docs ./docs

USER meru
VOLUME ["/var/lib/meru-mind"]
EXPOSE 3800

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.MERU_MIND_PORT || '3800') + '/v1/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

ENTRYPOINT ["node", "/app/dist/cli.js"]
CMD ["serve", "--host", "0.0.0.0", "--port", "3800"]
