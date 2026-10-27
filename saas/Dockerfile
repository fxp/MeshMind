FROM node:22-bookworm-slim
WORKDIR /app/saas
COPY saas/package.json saas/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && mkdir /data && chown node:node /data
COPY saas/src ./src
COPY saas/bin ./bin
COPY saas/scripts ./scripts
COPY saas/public ./public
COPY saas/gateway.*.example.json ./
USER node
ENV NODE_ENV=production BIND_HOST=0.0.0.0 PORT=8788 DATABASE=/data/meshmind.sqlite ALLOW_SIGNUP=false
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "node_modules/tsx/dist/cli.mjs", "src/main.ts"]
