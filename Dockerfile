FROM node:20-bookworm-slim
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm install

COPY . .
RUN npx prisma generate

ENV NODE_ENV=production
ENV API_PORT=4000
ENV PUPPETEER_SKIP_DOWNLOAD=true

EXPOSE 4000
# tsx avoids brittle tsc build; same runtime as local dev
CMD ["sh", "-c", "npx prisma migrate deploy && npx tsx prisma/seed.ts && npx tsx src/index.ts"]
