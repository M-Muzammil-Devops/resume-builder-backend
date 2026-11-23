# syntax=docker/dockerfile:1.7
# -----------------------------------------------------------------------------
# Resume Builder API (Fastify + Prisma) - production image
#
#   deps      -> all npm deps (needed to compile TypeScript)
#   build     -> prisma generate + tsc  => dist/
#   prod-deps -> runtime node_modules (prod deps + prisma CLI for migrate + tsx for seed)
#   pyenv     -> Python venv for the audio tool (DeepFilterNet3, CPU torch) + baked model
#   runtime   -> slim Debian, ffmpeg + chromium (PDF export), non-root "node" user
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:22-bookworm-slim

# ---------- base (openssl so prisma generate picks the right engine: debian-openssl-3.0.x) ----------
FROM ${NODE_IMAGE} AS base
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# ---------- deps ----------
FROM base AS deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund

# ---------- build ----------
FROM deps AS build
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
RUN npx prisma generate && npx tsc -p tsconfig.json

# ---------- prod-deps ----------
# prisma (migrate deploy) and tsx (prisma/seed.ts) are devDependencies but are needed at runtime,
# so we keep the full install and drop only the compile-time-only packages.
FROM base AS prod-deps
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund \
 && npx prisma generate \
 && rm -rf node_modules/typescript node_modules/@types

# ---------- pyenv (audio tool) ----------
FROM ${NODE_IMAGE} AS pyenv
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ENV VIRTUAL_ENV=/opt/venv \
    PATH=/opt/venv/bin:$PATH \
    XDG_CACHE_HOME=/opt/cache \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
# Same versions as the dev venv (torch 2.1.2 CPU build, numpy < 2 for torch 2.1).
RUN python3 -m venv /opt/venv \
 && pip install --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple \
      "torch==2.1.2+cpu" "torchaudio==2.1.2+cpu" \
 && pip install "numpy==1.26.4" "deepfilternet==0.5.6" "soundfile>=0.12" \
 && find /opt/venv -name '__pycache__' -prune -exec rm -rf {} + \
 && rm -rf /opt/venv/lib/python3*/site-packages/torch/include /opt/venv/lib/python3*/site-packages/torch/test
# Bake the DeepFilterNet3 model into the image (no download at runtime).
RUN python -c "from df.enhance import init_df; init_df(log_level='ERROR', log_file=None)" \
 && ls -la /opt/cache/DeepFilterNet

# ---------- runtime ----------
FROM ${NODE_IMAGE} AS runtime
# ffmpeg: decode/encode + RNNoise/afftdn fallbacks; chromium + fonts: PDF export (puppeteer);
# python3: interpreter the venv links to; git: DeepFilterNet's logger shells out to it;
# openssl: prisma engines; tini: PID 1 / signal handling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ffmpeg python3 chromium fonts-liberation fonts-dejavu-core fonts-noto-color-emoji \
      git openssl ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    API_PORT=4000 \
    UPLOAD_DIR=/app/uploads \
    AUDIO_TMP_DIR=/app/tmp/audio \
    AUDIO_PYTHON=/opt/venv/bin/python \
    XDG_CACHE_HOME=/opt/cache \
    PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    CHROME_PATH=/usr/bin/chromium \
    NPM_CONFIG_UPDATE_NOTIFIER=false

WORKDIR /app
COPY --from=pyenv /opt/venv /opt/venv
COPY --from=pyenv --chown=node:node /opt/cache /opt/cache
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node prisma ./prisma
# src/ is only needed by prisma/seed.ts (run with tsx); the server itself runs from dist/.
COPY --chown=node:node src ./src
COPY --chown=node:node audio-worker ./audio-worker
COPY deploy/docker/backend-entrypoint.sh /usr/local/bin/backend-entrypoint.sh
COPY deploy/docker/print-proxy.cjs /usr/local/lib/print-proxy.cjs
RUN sed -i 's/\r$//' /usr/local/bin/backend-entrypoint.sh \
 && chmod 0755 /usr/local/bin/backend-entrypoint.sh \
 && mkdir -p /app/uploads /app/tmp/audio \
 && chown -R node:node /app/uploads /app/tmp

USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# -g: forward signals to the whole process group (server + PDF print forwarder).
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/backend-entrypoint.sh"]
CMD ["node", "dist/index.js"]
