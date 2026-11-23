# Deploying Resume Builder (STAGING: host backend + Docker frontend + host nginx)

`deploy/deploy.sh` sets up an Ubuntu server (AWS EC2). Built for a staging box where a `git pull` must
go live in seconds:

| Component | Where | Listens on |
|-----------|-------|------------|
| nginx     | host (installed only if missing); site `/etc/nginx/sites-available/resume-builder` | **80, 443** |
| backend   | **host**, systemd unit `resume-builder-backend` (User=ubuntu, runs `dist/` from the checkout) | `127.0.0.1:${BACKEND_PORT:-4000}` |
| frontend  | container `resume-builder-frontend` (Next.js standalone, host network) | `127.0.0.1:${FRONTEND_PORT:-3000}` |
| postgres  | container `postgres:16-alpine`, volume `pgdata` | `127.0.0.1:${POSTGRES_PORT:-5432}` |
| redis     | container `redis:7-alpine`, volume `redisdata` | `127.0.0.1:${REDIS_PORT:-6379}` |

nginx (template `deploy/nginx/resume-builder.conf`) routes `/` to the frontend and `/rb-api/*` to the
backend (prefix stripped), allows 110 MB uploads, streams audio with 1-hour timeouts, gzip, security
headers, WebSockets. Other sites in `/etc/nginx` are never modified.

The backend Dockerfile stays in the repo for a future all-Docker production setup; this deploy does not use it.

## Requirements
- Ubuntu 22.04 / 24.04. 2 vCPU, 4 GB RAM (8 GB recommended for the audio tool), 30 GB disk.
  A 4 GB swapfile is added automatically when RAM < 4 GB.
- EC2 Security Group: inbound TCP 22, 80, 443 only (everything else is loopback).
- HTTPS: a DNS A record for the domain pointing at the instance's public IP.

## First deploy
```bash
cd /home/ubuntu
git clone -b staging https://github.com/M-Muzammil-Devops/resume-builder-backend.git
git clone -b staging https://github.com/M-Muzammil-Devops/resume-builder-frontend.git
cd resume-builder-backend
bash deploy/deploy.sh --admin-email you@example.com                       # http://<public-ip>
# or with a domain + HTTPS (host certbot, nginx plugin):
bash deploy/deploy.sh --domain cv.example.com --email you@example.com --admin-email you@example.com
```
Run it as `ubuntu` (it uses sudo where needed). It:
1. installs Docker + compose if missing, adds a swapfile on small instances, opens 80/443 in UFW if UFW is on;
2. creates `deploy/.env` from `.env.example` with random secrets (never printed) and starts postgres + redis;
3. installs the backend host deps: Node 22 (NodeSource), ffmpeg, git, openssl, fonts, Google Chrome
   (Chromium snap on arm64) for PDF export, and `audio-worker/.venv` (uv, Python 3.11, CPU torch 2.1.2,
   DeepFilterNet 0.5.6, model prefetched to `~/.cache/DeepFilterNet`);
4. writes `deploy/backend.env` (the unit's EnvironmentFile, chmod 600) from `deploy/.env`;
5. `npm ci`, `prisma generate`, `prisma migrate deploy` + non-destructive `prisma db push`, the seed
   (first run only), marks the admin e-mail verified, `npm run build`;
6. installs/enables `/etc/systemd/system/resume-builder-backend.service`, restarts it, waits for `/health`;
7. builds and starts the frontend container; writes the nginx site, `nginx -t` (rolls back on failure),
   reloads; with `--domain/--email` runs `certbot --nginx`; smoke test; prints the URLs.

Timings (measured): frontend image ~4-5 min cold, ~3 min after a source change; backend first install
(Node, Chrome, torch venv) ~5-10 min depending on bandwidth; backend update (build + restart) ~10-20 s.

## Fast update (staging)
```bash
bash deploy/update.sh          # = bash deploy/deploy.sh --pull
```
- `git pull --ff-only` in both repos (as ubuntu).
- backend: `npm ci` only if `package.json`/`package-lock.json` changed; `prisma generate` + migrate + db push
  only if `prisma/` changed; then `npm run build` and `systemctl restart resume-builder-backend`.
  Changes to `deploy/.env` are picked up too (backend.env rewritten, service restarted).
- frontend: image rebuilt and container restarted only if the frontend repo changed.
- prints what was updated and the time taken. "Changed" is measured against the last revision that was
  deployed (`deploy/.state/`), so a manual `git pull` followed by `update.sh` works the same.

## Day-2
```bash
bash deploy/deploy.sh --restart        # restart backend service + frontend container
bash deploy/deploy.sh --logs backend   # journalctl -u resume-builder-backend -f
bash deploy/deploy.sh --logs frontend  # container logs (nginx: /var/log/nginx/)
bash deploy/deploy.sh --nginx-only     # rewrite the nginx site / certificate only
bash deploy/deploy.sh --down           # stop the service + containers (data kept)
bash deploy/deploy.sh --seed           # re-run the seed (resets sample jobs + demo user!)
sudo systemctl status resume-builder-backend
```
Settings (Gemini key, SMTP, audio limits, ports): edit `deploy/.env`, then `bash deploy/update.sh`.
Admin login: `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `deploy/.env`.

## Backups
```bash
docker compose -p resume-builder exec -T postgres pg_dump -U resume resume_builder | gzip > backup-$(date +%F).sql.gz
```
Uploads live in `/home/ubuntu/resume-builder-data/uploads`.

## Notes
- The API code listens on `0.0.0.0`; the unit preloads `deploy/host/listen-loopback.cjs`, which binds it to
  `127.0.0.1` instead (no code change). Only nginx can reach it.
- Migrations: `prisma migrate deploy`, then (while `PRISMA_SYNC_SCHEMA=true`) a non-destructive
  `prisma db push`, because `prisma/migrations` does not yet contain every table/column in `schema.prisma`.
- The seeded admin has no verified e-mail and login requires one, so deploy.sh marks only `ADMIN_EMAIL` verified.
- CSP `upgrade-insecure-requests`: over plain HTTP nginx drops only that directive; over HTTPS it passes.
- PDF export: Chrome on the host opens `http://127.0.0.1:${FRONTEND_PORT}/print/:id` (loopback, so the CSP
  is fine). Fonts come from `/home/ubuntu/frontend/public/fonts`, a symlink deploy.sh creates to the frontend repo.
- The seed also creates a demo account with a well-known password (`prisma/seed.ts`); change or remove it
  on a public server.
- `deploy/.env`, `deploy/backend.env`, `deploy/.seeded`, `deploy/.state/` are git-ignored. Never commit them.