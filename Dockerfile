# Liyuan Agent 1.0 — production image
# Build: docker build -t liyuan:1.0.0 .
# Run:   docker run -d -p 7620:7620 -v liyuan-data:/app/.liyuan-data-proxy liyuan:1.0.0
FROM node:22-bookworm-slim

WORKDIR /app

# Install dependencies first (better layer cache)
COPY package.json package-lock.json ./
COPY packages ./packages
# file: deps need package manifests present before npm install
RUN npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force

# App sources + prebuilt web (if missing, build below)
COPY server ./server
COPY src ./src
COPY assets ./assets
COPY skills ./skills
COPY presets ./presets
COPY .liyuan/extensions ./.liyuan/extensions
COPY liyuan.config.example.json liyuan.agent.example.json ./
COPY start.sh docker-entrypoint.sh ./
COPY web/dist ./web/dist
COPY web/package.json ./web/package.json

# Fallback: build frontend if dist not in build context
RUN if [ ! -f web/dist/index.html ]; then \
      npm --prefix web install && npm run web:build && rm -rf web/node_modules; \
    fi

# 默认素材备份：assets/cards 与 assets/lorebooks 会被卷挂载遮住，
# entrypoint 首启时从这里补回默认角色卡/世界书
RUN mkdir -p assets/default \
  && cp -r assets/cards assets/default/cards \
  && cp -r assets/lorebooks assets/default/lorebooks \
  && cp -r skills assets/default/skills

# 配置真身放在 /app/config（卷挂载点），/app 下同名文件由 entrypoint 软链过去。
# 不在这里 cp 出 liyuan.*.json：镜像内的真文件会和 compose 的目录挂载冲突（issue #1）。
RUN mkdir -p config \
  && chmod +x start.sh docker-entrypoint.sh

ENV HOST=0.0.0.0
ENV PORT=7620
ENV NODE_ENV=production

EXPOSE 7620

# Persist runtime dirs via anonymous volumes (sessions live under ~/.liyuan/agent by design)
# /app/config 存 liyuan.config.json / liyuan.agent.json（含 API Key），重建镜像不丢
VOLUME ["/root/.liyuan", "/app/config", "/app/.liyuan-state", "/app/.liyuan-uploads", "/app/.liyuan-media", "/app/.liyuan-audio", "/app/.liyuan-artifacts", "/app/.liyuan-codex", "/app/.liyuan-lore", "/app/.liyuan-memory", "/app/.liyuan-skills", "/app/.liyuan-assistant", "/app/.liyuan-worldline", "/app/.liyuan-cache", "/app/assets/presets", "/app/assets/personas", "/app/liyuan-profiles", "/app/skills"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7620)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server/main.ts"]
