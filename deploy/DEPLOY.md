# Deploying Resume Builder (production, Docker)

One script sets up a fresh Ubuntu server (AWS EC2 tested layout) with:

| Service  | Image / build                     | Exposed            |
|----------|-----------------------------------|--------------------|
| nginx    | `nginx:1.28-alpine`               | **80, 443** (only) |
| frontend | `resume-builder-frontend` (Next.js standalone) | internal :3000 |
| backend  | `resume-builder-backend` (Fastify, Prisma, ffmpeg, DeepFilterNet3, Chromium) | internal :4000 |
| postgres | `postgres:16-alpine`, volume `pgdata` | not published  |
| redis    | `redis:7-alpine`, volume `redisdata`  | not published  |

nginx routes `/` to the frontend and `/rb-api/*` to the backend (prefix stripped), allows 110 MB uploads
(audio tool), streams audio uploads/previews, sets gzip and security headers.

## Requirements
- Ubuntu 22.04 / 24.04, x86_64 (arm64 should work but is not tested).
- At least 2 vCPU, 4 GB RAM (8 GB recommended for the audio tool), 30 GB disk.
  The script adds a 4 GB swapfile when RAM < 4 GB.
- EC2 Security Group: inbound TCP 22, 80, 443.
- For HTTPS: a DNS A record for your domain pointing at the instance's public IP.

## Layout
```
/home/ubuntu/resume-builder-backend     # this repo (deploy/ lives here)
/home/ubuntu/resume-builder-frontend    # frontend repo (sibling folder)
```
Other layouts: `--backend-dir DIR --frontend-dir DIR`.

## First deploy
```bash
cd /home/ubuntu
git clone https://github.com/M-Muzammil-Devops/resume-builder-backend.git
git clone https://github.com/M-Muzammil-Devops/resume-builder-frontend.git
cd resume-builder-backend
bash deploy/deploy.sh --admin-email you@example.com                 # http://<public-ip>
# or, with HTTPS:
bash deploy/deploy.sh --domain cv.example.com --email you@example.com --admin-email you@example.com
```
The script installs Docker + compose if needed, creates `deploy/.env` from `deploy/.env.example`
with strong random secrets (DB, Redis, JWT, audio preview, admin password; never printed), builds the
images, runs `prisma migrate deploy` (+ the seed on the first run only), starts everything, waits for the
health checks and prints the URLs. The first build takes 10-20 minutes.

Optional settings (Gemini key, SMTP, audio limits): edit `deploy/.env`, then re-run `bash deploy/deploy.sh`.
The admin login is `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `deploy/.env` (`sudo cat` it on the server).

## Day-2
```bash
bash deploy/deploy.sh --pull          # git pull both repos, rebuild, migrate, restart
bash deploy/deploy.sh --no-cache      # full rebuild
bash deploy/deploy.sh --logs backend  # follow logs (nginx|frontend|backend|postgres|redis)
bash deploy/deploy.sh --down          # stop (volumes kept)
bash deploy/deploy.sh --seed          # re-run the seed (resets sample jobs + demo user!)
```
Certificates renew automatically (`/etc/cron.d/resume-builder-certbot`).

## Backups
Postgres data is in the Docker volume `resume-builder_pgdata`; uploads in `resume-builder_uploads`.
```bash
docker compose -p resume-builder exec -T postgres pg_dump -U resume resume_builder | gzip > backup-$(date +%F).sql.gz
```

## Notes
- Migrations: the container runs `prisma migrate deploy`, then (while `PRISMA_SYNC_SCHEMA=true`, the
  default) a non-destructive `prisma db push`, because `prisma/migrations` does not yet contain every
  table/column in `schema.prisma`. Once a complete migration is committed, set `PRISMA_SYNC_SCHEMA=false`
  (existing servers then need `prisma migrate resolve --applied <name>` for that migration).
- The seeded admin has no verified e-mail and login requires one, so deploy.sh marks only `ADMIN_EMAIL`
  as verified in the database.
- The app's CSP contains `upgrade-insecure-requests`; on plain HTTP nginx drops only that directive
  (otherwise no script/style would load). Use `--domain/--email` for real HTTPS.
- PDF export: Chromium in the backend opens `/print/:id` through nginx's internal port 8080 (not published).
- The first-run seed creates the sample templates/jobs, the admin user and a demo account with a
  well-known password from `prisma/seed.ts`. Change or remove the demo account on a public server.
- The audio tool runs DeepFilterNet3 on CPU (one job at a time); the model is baked into the image.
- `deploy/.env` and `deploy/.seeded` are git-ignored. Never commit them.
