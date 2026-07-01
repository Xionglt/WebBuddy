# syntax=docker/dockerfile:1

FROM mcr.microsoft.com/playwright:v1.60.0-noble

WORKDIR /app

ENV CI=true \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PORT=5178 \
    TRACE_OUT_DIR=/app/output \
    PLAYWRIGHT_HEADLESS=true \
    PLAYWRIGHT_VISUAL_HIGHLIGHT=false \
    PLAYWRIGHT_BLOCK_LOCALHOST=false \
    HUMAN_GATE_MODE=auto

COPY packages/web-buddy/package.json packages/web-buddy/package-lock.json ./packages/web-buddy/
COPY packages/claude-code/package.json packages/claude-code/package-lock.json ./packages/claude-code/

RUN npm --prefix packages/web-buddy ci \
  && npm --prefix packages/claude-code ci

COPY configs ./configs
COPY README.md ./README.md
COPY packages/web-buddy ./packages/web-buddy
COPY packages/claude-code ./packages/claude-code

RUN npm --prefix packages/web-buddy run build \
  && npm --prefix packages/claude-code run build \
  && mkdir -p /app/output /app/tmp/pdfs

EXPOSE 5178

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:5178/api/config').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/web-buddy/dist/web/server.js"]
