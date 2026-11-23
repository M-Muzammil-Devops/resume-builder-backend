#!/bin/sh
# Backend container entrypoint: apply DB migrations, optionally sync/seed, then exec the server.
#   RUN_MIGRATIONS=true       (default) -> prisma migrate deploy (idempotent)
#   PRISMA_SYNC_SCHEMA=false  (default) -> afterwards "prisma db push" (non-destructive: it refuses any
#                                          change that would drop data). Needed while prisma/migrations
#                                          lags behind schema.prisma; deploy/docker-compose.prod.yml turns
#                                          it on. Set false once the migrations are complete.
#   RUN_SEED=false            (default) -> prisma/seed.ts. NOTE: the seed resets the sample job list and
#                                          the demo user, so deploy.sh runs it only on the first deploy.
set -eu

# PDF export: loopback forwarder 127.0.0.1:$PRINT_PROXY_PORT -> $PRINT_PROXY_TARGET (see print-proxy.cjs).
# Restarted automatically if it ever exits.
if [ -n "${PRINT_PROXY_TARGET:-}" ]; then
  ( while :; do node /usr/local/lib/print-proxy.cjs || true; sleep 2; done ) &
fi

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] prisma migrate deploy"
  ./node_modules/.bin/prisma migrate deploy
fi

if [ "${PRISMA_SYNC_SCHEMA:-false}" = "true" ]; then
  echo "[entrypoint] prisma db push (non-destructive schema sync)"
  ./node_modules/.bin/prisma db push --skip-generate
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
  echo "[entrypoint] seeding database (prisma/seed.ts)"
  ./node_modules/.bin/tsx prisma/seed.ts
fi

exec "$@"
