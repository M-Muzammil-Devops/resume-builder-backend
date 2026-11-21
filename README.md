# Resume Builder – Backend

REST API for the Resume Builder: authentication, resumes, cover letters, templates, jobs, ATS checks, AI rewriting, PDF/DOCX export and the admin console.

## Stack

| Item | Version (from `package.json`) |
| --- | --- |
| Fastify | ^5.2.1 (`@fastify/cors`, `jwt`, `multipart`, `static`) |
| TypeScript | ^5.8.2 (run in dev with `tsx` ^4.19.3) |
| Prisma ORM / Client | ^6.5.0 |
| Database | PostgreSQL (16-alpine in `docker-compose.yml`) |
| Cache | Redis via ioredis ^6.0.0 (optional, `REDIS_ENABLED`) |
| PDF export | puppeteer ^24.4.0 |
| DOCX export | docx ^9.16.0 |
| AI | @google/generative-ai ^0.24.0 (Gemini) |
| Email | nodemailer ^10.6.0 (SMTP) |
| Validation / auth | zod ^3.24.2, bcryptjs ^3.0.2 |

## Port and health check

- **Port:** `4000` (`API_PORT`, default 4000; listens on `0.0.0.0`).
- **Health check:** `GET /health`

```bash
curl http://localhost:4000/health
# {"ok":true}
```

## Prerequisites

- Node.js 20 or newer (the Dockerfile uses `node:20-bookworm-slim`).
- Docker, to run PostgreSQL and Redis with the project's `docker-compose.yml`:

```bash
docker compose up -d postgres redis
```

  Containers: `resume-builder-db` (Postgres, port 5432) and `resume-builder-redis` (Redis, port 6379).
- Chrome or Edge for PDF export (auto-detected), or run `npm run browsers:install`.

## Environment setup

```bash
cp .env.example .env
```

Variable names only. Set real values in your own `.env`, which is git-ignored.

| Variable | Description |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string (required). |
| `API_PORT` | API port (default 4000). |
| `JWT_SECRET` | Secret for signing tokens. In production it must be random and at least 32 characters, or the server refuses to start. |
| `CORS_ORIGIN` | Comma-separated allowed browser origins (defaults to the `APP_URL` origin). |
| `PUBLIC_BASE_URL` | Public API base as seen by browsers, used for `/uploads` links. |
| `UPLOAD_DIR` | Folder for uploaded files (default `uploads`). |
| `LOG_LEVEL` | Log level (`info` in production, `debug` otherwise by default). |
| `GEMINI_API_KEY` | Google Gemini key for AI features. |
| `GEMINI_MODEL` | Gemini model name. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `ADMIN_NAME` | Admin account created by the seed. |
| `REDIS_ENABLED` | Turn the Redis cache on or off. |
| `REDIS_URL` | Redis connection URL. |
| `REDIS_TTL_SECONDS` | Cache TTL in seconds. |
| `CHROME_PATH` | Chrome/Edge path for PDF export (optional; auto-detected). |
| `APP_URL` | Public site URL used in verification and password-reset emails. |
| `FRONTEND_URL` | Public frontend URL for links (defaults to `APP_URL`). |
| `PRINT_BASE_URL` | Internal URL Puppeteer opens to render PDFs (default `http://127.0.0.1:3000`). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SMTP_REQUIRE_TLS` | SMTP delivery for verification and reset emails. Leave `SMTP_HOST` empty to skip delivery. |

## Install, database and run

```bash
npm install
npm run prisma:generate        # prisma generate
npm run prisma:migrate         # prisma migrate deploy && prisma generate
npm run prisma:migrate:dev     # prisma migrate dev --name init (development)
npm run prisma:seed            # create the admin account (tsx prisma/seed.ts)

npm run dev                    # development with watch: tsx watch src/index.ts
npm run build                  # tsc -> dist/
npm run start                  # production: node dist/index.js
```

Production start used on the Windows host (after `npm run build`):

```bat
set NODE_ENV=production
node dist\index.js
```

Tests: `npm test` (unit), `npm run test:e2e`, `npm run test:db`.

## Frontend integration

The frontend does not call this API directly from the browser. Next.js (port 3000) forwards `/rb-api/*` to this service on port 4000. Set the frontend's `API_INTERNAL_URL` if the API is not at `http://127.0.0.1:4000`.

## Folder structure

```
backend/
├── prisma/
│   ├── schema.prisma   models: User, Resume, CoverLetter, Template, Job, ...
│   ├── migrations/
│   └── seed.ts
├── scripts/
├── src/
│   ├── ai/  ats/  config/  lib/  routes/  scripts/  shared/  e2e/
│   ├── prisma.ts
│   └── index.ts        Fastify entry point
├── Dockerfile
└── package.json
```