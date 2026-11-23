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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google sign-in (OIDC). The button shows only when both are set. |
| `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET` | Facebook sign-in. The button shows only when both are set. |
| `OAUTH_REDIRECT_BASE` | Public origin providers redirect back to (defaults to `APP_URL`), e.g. `https://devops.elevatesofts.com`. |

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

## Sign-in: Google, Facebook and email magic code

All three buttons sit on `/login` and `/register`. `GET /auth/providers` returns `{ google, facebook, email }` and the UI hides a button whose provider is not configured (`email` needs SMTP).

| Route | What it does |
| --- | --- |
| `GET /auth/providers` | Which sign-in options are configured (public). |
| `GET /auth/oauth/:provider/start?next=&intent=` | `google` or `facebook`. Stores state, nonce and the PKCE verifier in Redis (10 min, one use), sets a short HttpOnly state cookie and 302s to the provider. |
| `GET /auth/oauth/:provider/callback` | Server-side code exchange. Google: auth code + PKCE, ID token checked for `iss`, `aud`, `exp` and `nonce`. Facebook: code exchange + Graph `/me` with `appsecret_proof`. Links by provider id, else by **verified** email, else creates the user. Then 302 to `/auth/callback#code=<one-time handoff>`. |
| `POST /auth/oauth/exchange` | `{ code }` (one use, 2 min) returns the normal session (`token`, `refreshToken`, `user`). |
| `POST /auth/magic/request` | `{ email, intent: "login" \| "signup", name? }`. Emails a 6-digit code: valid 10 min, stored only as an HMAC, 5 tries. 3 codes per email per 15 min and 10 requests per IP per 15 min. The reply is the same whether or not the email has an account (an unknown email on the login flow gets a "no account yet" email instead of a code). |
| `POST /auth/magic/verify` | `{ email, code }` returns the normal session. On the sign-up flow a new account is created (verified, with a random password; "Forgot password" can set a real one). |

Redirect URIs to register with the providers (`OAUTH_REDIRECT_BASE` + `/rb-api/auth/oauth/<provider>/callback`):

- Google (OAuth client "Web application"): `https://devops.elevatesofts.com/rb-api/auth/oauth/google/callback`, authorized JavaScript origin `https://devops.elevatesofts.com`.
- Facebook (Facebook Login, "Valid OAuth Redirect URIs"): `https://devops.elevatesofts.com/rb-api/auth/oauth/facebook/callback`.

Security notes: identities are stored in `OAuthAccount (provider, providerUserId, userId)` (migration `20261124140000_oauth_account`). When a verified email (SSO or magic code) claims an account that was never verified, that account's password is replaced with a random one and its sessions are ended, so a stranger who pre-registered the address cannot keep access. Logout (`POST /auth/logout`) revokes the refresh token and the access token server-side.

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
## Contact form

Public endpoint behind the frontend `/contact` page. Sends one email to `ADMIN_EMAIL` through the existing SMTP mailer (`src/lib/mailer.ts`).

| Method | Path | Body | Answers |
|---|---|---|---|
| `POST` | `/contact` | JSON `{ name, email, message, website }` | **202** `{ ok: true }` · **400** `{ field, error }` · **429** rate limited · **503** SMTP not configured · **502** send failed |

- **Validation:** name 2–100 chars, a valid email, message 10–5000 chars. Control characters are stripped and CR/LF never reach the subject or header-bound fields; the HTML copy is escaped.
- **Rate limit:** 5 per hour per client IP (`CONTACT_LIMIT_PER_HOUR`, in-memory). The IP comes from `X-Real-IP` only when the socket peer is loopback (nginx overwrites that header), so it cannot be spoofed from outside.
- **Honeypot:** if the hidden `website` field is filled, the API answers 202 and sends nothing.
- **Code / tests:** `src/routes/contact.ts`, `src/routes/contact.test.ts` (part of `npm test`).

## Audio tool (Noise Remover)

Cleans background noise from any audio or video file. Used by `/tools/audio-noise-remover`. The old `/tools/ai-voice-cleaner` page and the **Voice clean** mode (voice EQ + loudness) were retired: the page redirects here, and an upload with `mode=voice` is processed as plain **Remove noise** (`parseMode()` in `media.ts`), so old clients keep working.

### Features

- **Remove noise:** AI denoise only. The voice stays untouched.
- **Keep all voices** (`mode=conversation`): for meetings, interviews and rooms with several talkers. Gentle cap of **8–12 dB** (11.2 dB at 80%), no gating and 10% of the original mixed back in, so quiet or far-away voices are never removed.
- **Strength:** 0–100% (default 80). An empty or blank `strength` field counts as missing and uses the default 80.
- **Any input format** ffmpeg can read: MP3, WAV, M4A, AAC, OGG, OPUS, FLAC, WEBM, WMA, AIFF, AMR, AC3, CAF and more. For video (MP4, MOV, MKV, AVI) the audio track is extracted.
- **Output:** same as input, MP3, WAV or FLAC. If the input format can't be written, the file is saved as MP3 and the result says so.
- **Before/After previews:** small **mono MP3, 48 kbps** (never more than the source bitrate; 32/24/16 kbps for smaller sources), streamed from short-lived signed links, plus waveform peaks for the player.
- **Same as input** keeps the input codec **and bitrate** (e.g. AAC 48 kbps in → AAC 48 kbps out; MP3/AC-3 snap to the nearest legal rate).

### How strong is "strength"? (BUG-1340 / BUG-1343)

Strength sets the most DeepFilterNet may take off (`atten_lim_db`). It never gates speech to silence: a voice can lose at most this many dB.

| Strength | Remove noise | Keep all voices |
|---|---|---|
| 0% | 6 dB (+15% original mixed back) | 8 dB (+10% original) |
| 20% | 8.4 dB (+9% original) | 8.8 dB |
| 50% | 12 dB | 10 dB |
| 80% (default) | **15 dB** | 11.2 dB |
| 100% | 18 dB | 12 dB |

- The mapping is piecewise linear and strictly increasing (unit test in `round25.test.ts`). The old mapping let 80% take up to ~81 dB, which wiped quiet far-away talkers (QA: 52–57 dB down).
- The RNNoise and afftdn fallbacks get the same cap (`mix = 1 − 10^(−limit/20)`, `nr = limit`).
- **Stereo:** when left and right really differ (side/mid energy above −40 dB), each channel is cleaned on its own and the output stays stereo. Otherwise one mono pass is used.
- The result has `maxReductionDb` (the cap used) and `channels`.

**Far-field regression fixture:** `audio-worker/testdata/farfield.ogg` (+ `farfield.json` segment list) mixes a near talker at −20 dBFS with two band-limited, reverberant far talkers at −36 and −40 dBFS over room noise. `audio-worker/test_farfield.py` runs the real DFN3 model on it and asserts no speech segment ends more than 18 dB down at the default (10 dB for Keep all voices), and that background reduction grows with strength. Rebuild the fixture with `testdata/make_farfield.py`.

| Max speech-segment drop | Old 80% | New 80% | 50% | 20% | Keep all voices 80% |
|---|---|---|---|---|---|
| far-field fixture | 30.1 dB | 14.6 dB | 11.8 dB | 7.1 dB | 9.0 dB |
| QA recording, 110–120 s (quiet far talker) | 56.8 dB median | 15.0 dB | 12.0 dB | 7.2 dB | 9.2 dB |
| QA recording, 297–307 s | 52.0 dB median | 15.0 dB | 12.0 dB | 7.2 dB | 9.2 dB |

Background noise at 80% is still lowered by ~15 dB (it was ~39 dB with the old mapping).

### "Background noise" numbers (BUG-1344)

`noiseFloorBeforeDb` / `noiseFloorAfterDb` are the real background level: the input is read once at 8 kHz mono in 50 ms windows; the quietest 20% of non-silent windows (≈ the 10th percentile, i.e. the gaps between words) give the "before" level, and the same windows in the output give "after". Digital silence is skipped, so a gated output can no longer show a fake −90 dB.

### CPU

- One DeepFilterNet worker process for the whole server, one job at a time (jobs queue). The UI and the API run exactly the same pipeline.
- Per job: decode → denoise → encode → 2 previews → one 8 kHz PCM read per file (peaks + background level) → one `ebur128` pass on the result. The old extra `astats` passes and 800 Hz peak passes are gone.

### Engine

| Order | Engine | Notes |
|---|---|---|
| 1 | **DeepFilterNet3** | Long-lived Python worker (`audio-worker/worker.py`). The model loads once. Device comes from `AUDIO_DEVICE` (default **cpu**, about 16× realtime on the i9). Long files are processed in chunks (see below). |
| 2 | **RNNoise** (ffmpeg `arnndn`) | Used automatically when the worker is down or fails. Model: `audio-worker/models/sh.rnnn`. |
| 3 | **afftdn** (ffmpeg) | Last resort when the RNNoise model is missing. |

The job result reports which engine was used.

### Long files (chunked processing)

- The worker reads and writes the file in **60 s chunks** with SoundFile, so memory stays flat (a 19-minute file peaks at ~90 MB RSS in the API).
- Each chunk gets 1 s of pre-roll context, and neighbouring chunks overlap by **0.5 s** with an equal-gain raised-cosine crossfade, so there are no clicks at the seams. A very short last chunk (< 5 s) is merged into the previous one.
- After each chunk the worker prints `{"type":"progress","done":n,"total":N}`. `GET /audio/jobs/:id` returns real progress and `chunks: { done, total }`; the frontend shows "Part 3 of 19 · about 40 s left".
- The ffmpeg fallback engines report real % from `-progress pipe:1`.
- Local smoke (i9, CPU): a 19-minute MP3 took **72 s** end to end; a 21-minute file is rejected with "This recording is 21:00 long. The limit is 20 minutes."
- Code: `audio-worker/chunking.py` (plan, fades, stitcher; mono or multi-channel). Tests: `npm run test:worker` (Python unittest: 13 chunking/stereo/dry-mix tests + 5 far-field tests on the real model, ~40 s).

### Device: CPU (default) or GPU

`AUDIO_DEVICE` = `cpu` (default) / `cuda` / `auto`. CUDA is used only when it is requested **and** `torch.cuda.is_available()` is true; otherwise the worker logs `[audio-worker] WARNING: ... falling back to CPU` and runs on CPU. The current host runs on CPU.

To move to a GPU later:

1. Use a GPU machine, e.g. an AWS EC2 **g4dn.xlarge** (NVIDIA T4) with the NVIDIA driver installed (`nvidia-smi` works).
2. Install the CUDA build of torch in the worker venv:
   ```powershell
   cd resume-builder-backend\audio-worker
   uv pip install --python .venv\Scripts\python.exe torch==2.1.2 torchaudio==2.1.2 --index-url https://download.pytorch.org/whl/cu121
   .venv\Scripts\python.exe -c "import torch; print(torch.cuda.is_available())"   # must print True
   ```
   (Linux: `.venv/bin/python` and the same `pip install` line.)
3. Set `AUDIO_DEVICE=cuda` in `.env`.
4. Restart the backend (`logs\deploy.ps1 -Backend`). `GET /audio/capabilities` shows the device in use.

### Job state in Redis

- **One active job per user, no separate lock key.** "Active" is always worked out from the job's own state (queued or processing), so every terminal state — done, failed, canceled, or a crash (always ends as failed) — frees the slot at once. Stale jobs (see *Max job time* below) are released automatically; on start-up nothing restored can hold a slot unless it is really back in the queue.

- Each job is saved in Redis under `audio:job:v1:<id>` with a **1 hour TTL** (refreshed on every update; progress writes are throttled to 1 per second). Without Redis (`REDIS_ENABLED` off) an in-memory store is used.
- After a backend restart: finished jobs whose files still exist keep working (status, previews, download); queued jobs whose upload is still on disk are resumed; jobs that were **running** are marked failed with *"The server restarted while your file was being cleaned. Please upload it again to retry."* (`SERVER_RESTARTED`) and their files are deleted.
- Only folders inside `AUDIO_TMP_DIR` are trusted when restoring.

### Endpoints

All routes need sign-in, except the signed preview links below. A job belongs to its owner; anyone else gets **404**.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/audio/capabilities` | Engine status, limits, output encoders |
| `POST` | `/audio/denoise` | Multipart: `mode` (`noise`/`conversation`; anything else, including the retired `voice`, is treated as `noise`), `strength` (whole number 0–100, default 80; anything else is **400** `BAD_STRENGTH`), `output` (`same`/`mp3`/`wav`/`flac`), `file`. Returns **202** `{ jobId }` |
| `GET` | `/audio/jobs/active` | The caller's queued / processing job (`{ job }` or `{ job: null }`), so any tab can resume tracking or cancel it |
| `GET` | `/audio/jobs/:id` | Status, progress, step, input info, result or error. When done: `previews: { original, clean, expiresAt, ttlSeconds }` (signed links) |
| `GET` | `/audio/p/:id/:which/:exp/:sig` | **Signed preview link** (no Bearer needed, so `<audio src>` can stream it). HMAC-SHA256 over job id + track + user id + expiry, valid **5 minutes**. `Range` → **206**, `Content-Length`, `ETag` (**304** on `If-None-Match`), `Cache-Control: private, max-age=300`. Bad or tampered link → **404**, expired → **403** `LINK_EXPIRED` (the player asks for a fresh link) |
| `GET` | `/audio/jobs/:id/download` | The clean file (attachment) |
| `GET` | `/audio/jobs/:id/preview?which=original\|clean` | Same preview with Bearer auth (`Range`, `ETag`, private cache). `which` must be exactly `original` or `clean` (**400** `BAD_WHICH`) |
| `DELETE` | `/audio/jobs/:id` | Cancel the job and delete its files now |

Through the frontend these are served as `/rb-api/audio/...`.

### Limits and safety

| Rule | Value |
|---|---|
| File size | 100 MB (**413**), `AUDIO_MAX_MB` |
| Duration | 20 min (**422** `TOO_LONG`, with the real length: "This recording is 21:00 long."), `AUDIO_MAX_SECONDS` |
| Uploads | 10 **completed** jobs per hour per user (`AUDIO_HOURLY_LIMIT`). Canceled, stale or server-failed jobs give their slot back. **Admin / owner** accounts are not limited. Over the limit: **429** `RATE_LIMITED` with `Retry-After` and "Try again in ~N min". Files are validated first, so a too-big or bad file always gets its real error (413/415/422), never a 429 |
| Rejected uploads | Abuse guard: 60 rejected files per hour per user (**429** `TOO_MANY_INVALID`, with `Retry-After`) |
| Active jobs | 1 per user (**409** `JOB_IN_PROGRESS`, body includes `activeJobId`, `activeStatus`, `activeProgress`, `activeName`) |
| Max job time | 30 min (`AUDIO_MAX_JOB_MINUTES`). A job still processing after that, or one marked processing/queued that the queue is not actually running, is **stale**: it is stopped, failed with `JOB_STALE` ("took too long… upload it again") and no longer blocks the user. Checked on every upload, on start-up and every 5 min |
| Temp files | `tmp/audio/<uuid>/`, deleted 1 hour after the job ends, on cancel, and on restart |

- Files are checked by content (magic bytes + ffprobe), not by extension.
- Duration comes from the **audio stream** (then `duration_ts × time_base`, then the container). When the header says "too long" or has no duration (N/A), a fast stream-copy scan measures the real length first. An unknown length is never rejected. Audio-only MP4/M4A files are not treated as video (cover art never counts).
- Playlists and list formats are refused (m3u, m3u8, pls, ffconcat, hls, concat, …), and ffmpeg runs with `-protocol_whitelist file,pipe`.
- Every process is spawned with an args array, never a shell string. Uploaded file names never reach ffmpeg.
- Temp files are never written under `uploads/`, which is public.
- Download names: the upload name is percent-decoded, then CR/LF, control characters and quotes are stripped; Unicode letters are kept. The header sends both an ASCII `filename="..."` and `filename*=UTF-8''...` (RFC 5987).
- Output sample rate follows the input (e.g. 44.1 kHz in → 44.1 kHz out). Only inputs above 48 kHz are lowered to 48 kHz, and formats with a fixed rate list (MP3, Opus, AAC, AC-3, AMR, …) use the nearest allowed rate at or above the input.

### Setup (Windows host)

```powershell
winget install --id Gyan.FFmpeg -e          # ffmpeg + ffprobe
winget install --id astral-sh.uv -e         # uv (Python manager)

cd resume-builder-backend\audio-worker
uv python install 3.11
uv venv .venv -p 3.11
uv pip install --python .venv\Scripts\python.exe torch==2.1.2 torchaudio==2.1.2 --index-url https://download.pytorch.org/whl/cpu
uv pip install --python .venv\Scripts\python.exe deepfilternet soundfile "numpy<2"
.venv\Scripts\python.exe -c "from df.enhance import init_df; init_df()"   # downloads + caches the model
```

Download `sh.rnnn` from [GregorR/rnnoise-models](https://github.com/GregorR/rnnoise-models) into `audio-worker\models\`.
For GPU, see *Device: CPU (default) or GPU* above.

### Environment (names only)

| Variable | Purpose | Default |
|---|---|---|
| `FFMPEG_PATH`, `FFPROBE_PATH` | Full paths to the binaries | `ffmpeg`, `ffprobe` on PATH |
| `AUDIO_PYTHON` | Python in the worker venv | `audio-worker/.venv/Scripts/python.exe` |
| `AUDIO_ENGINE` | `auto` / `deepfilternet` / `rnnoise` / `afftdn` | `auto` |
| `AUDIO_DEVICE` | `cpu` / `cuda` / `auto` (cuda only if available, else CPU with a warning) | `cpu` |
| `AUDIO_RNNOISE_MODEL` | RNNoise model file | `audio-worker/models/sh.rnnn` |
| `AUDIO_TMP_DIR` | Temp folder (outside `uploads/`) | `tmp/audio` |
| `AUDIO_MAX_MB`, `AUDIO_MAX_SECONDS` | Size and duration limits | `100`, `1200` |
| `AUDIO_HOURLY_LIMIT`, `AUDIO_TTL_MINUTES` | Files per user per hour (old name `AUDIO_UPLOADS_PER_HOUR` still works) and file lifetime | `10`, `60` |
| `AUDIO_MAX_JOB_MINUTES` | After this a running job counts as stale (queued: 2×) | `30` |
| `AUDIO_PREVIEW_SECRET` | HMAC key for signed preview links (set it so links survive a restart) | random per process |

### Code

```
audio-worker/worker.py        DeepFilterNet3 worker (JSON lines on stdin/stdout)
src/routes/audio.ts           HTTP routes, limits, ownership
src/lib/audio/service.ts      queue + pipeline (decode → denoise → encode → previews)
src/lib/audio/media.ts        probe rules, formats, filter chains (unit-tested)
src/lib/audio/dfWorker.ts     worker process manager with crash back-off, chunk progress
src/lib/audio/previewToken.ts signed preview links (HMAC, 5 min TTL)
audio-worker/test_farfield.py far-field regression test (real model) + testdata/
audio-worker/chunking.py      chunk plan + crossfade stitcher
src/lib/audio/jobStore.ts     Redis / memory job store (1 h TTL)
```

Tests: `src/lib/audio/media.test.ts`, `jobStore.test.ts`, `dfWorker.test.ts` and `src/routes/audio.test.ts` (part of `npm test`); worker: `npm run test:worker`.

## Users & Activity, cookie consent, PDF & template control (admin)

**Migration:** `prisma/migrations/20261124020000_activity_consent_pdf_control` adds the `LoginEvent`
columns (region, countryCode, browser, os, device, enrichedAt) and the tables `ConsentLog`, `PageView`,
`TemplateSetting`, `ExportEvent`, `AppSetting` and `AdminAuditLog`. Apply with `npx prisma migrate deploy`.

**Client IP:** Fastify runs with `trustProxy` = `TRUST_PROXY` (default `127.0.0.1,::1`), so `request.ip`
is the address the host nginx writes into `X-Forwarded-For` (nginx overwrites that header; client values
are never trusted). This also gives the login rate limiter the real client IP.

**Offline geolocation:** free DB-IP *IP to City Lite* database (CC BY 4.0, no key), read with the
`maxmind` package. No external call is made per request.

```bash
npm run geoip:update            # downloads data/geoip/dbip-city-lite.mmdb (~120 MB, git-ignored)
# monthly refresh (cron):  0 4 3 * *  cd /home/ubuntu/resume-builder-backend && npm run geoip:update
```

| Env | Default | Meaning |
| --- | --- | --- |
| `GEOIP_DB_PATH` | `data/geoip/dbip-city-lite.mmdb` | database file |
| `GEOIP_IDLE_MS` | `600000` | the DB (~130 MB RAM) is loaded on first lookup and released after this idle time |
| `TRUST_PROXY` | `127.0.0.1,::1` | proxies whose `X-Forwarded-For` is trusted |

Login events are written by the auth routes with ip + user-agent; `src/lib/activity.ts` fills in
city / region / country and browser / OS / device (`src/lib/userAgent.ts`, no dependency) in batches
when an admin opens the activity view, so every login path that creates a `LoginEvent` is covered.

**Admin API** (all behind `adminGuard`):

| Route | |
| --- | --- |
| `GET /admin/activity` | logins; `search`, `from`, `to` (YYYY-MM-DD), `country`, `device`, `take`, `skip` |
| `GET /admin/activity/facets` | countries / devices for the filters |
| `GET /admin/activity/export.csv` | same filters, CSV (formula-injection safe) |
| `GET /admin/activity/users/:id` | user, login history, consented page views |
| `GET /admin/analytics/summary` | consented page views, top pages, consent choices |
| `GET /admin/builtin-templates` | the 12 built-in templates + settings + resume / export counts |
| `PATCH /admin/builtin-templates/:id` | name, category, description, isActive, featured |
| `PUT /admin/builtin-templates/order` | `{ ids: [...] }` gallery order |
| `GET /admin/resumes`, `GET/DELETE /admin/resumes/:id` | user resumes; search, template, status, dates |
| `GET /admin/resumes/:id/pdf[?inline=1]` | view / download any resume as PDF |
| `GET /admin/exports` | recent exports |
| `GET/PUT /admin/settings/export` | default page size, extra margin, free watermark, monthly PDF caps |
| `GET /admin/audit` | admin audit log (every admin write, view and download above) |

**Public:** `POST /consent` (anonymous id, version, choices; audit trail), `POST /analytics/pageview`
(stored only when the visitor's own `rb_consent` cookie allows analytics; path only, no query string,
no IP), `GET /template-settings` (landing gallery), `GET /export-settings`.

**Export settings** apply to `GET/POST /export/:id`: the admin default page size is used only for
resumes without one; the watermark is added for non-admin accounts when enabled; the monthly PDF cap
(0 = unlimited) answers `429 EXPORT_LIMIT`; every successful export is recorded in `ExportEvent`.

**Privacy note:** login IP, approximate location and device are personal data. The privacy policy has
to say they are collected for security and account monitoring, how long they are kept, and that DB-IP
is used offline (attribution is shown in the admin page). Page views are stored only with analytics
consent and Google Analytics loads only after that consent.
