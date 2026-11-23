#!/usr/bin/env bash
# Downloads / refreshes the free DB-IP "IP to City Lite" database (CC BY 4.0, https://db-ip.com)
# used for offline login geolocation. No account or key is needed. DB-IP publishes a new file
# monthly; run this from cron/systemd monthly, e.g.  0 4 3 * *  cd ~/resume-builder-backend && npm run geoip:update
# Usage: bash scripts/update-geoip.sh [target-file]   (default: $GEOIP_DB_PATH or data/geoip/dbip-city-lite.mmdb)
set -euo pipefail
cd "$(dirname "$0")/.."

TARGET="${1:-${GEOIP_DB_PATH:-data/geoip/dbip-city-lite.mmdb}}"
DIR="$(dirname "$TARGET")"
mkdir -p "$DIR"
TMP="$(mktemp "$DIR/.dbip.XXXXXX")"
trap 'rm -f "$TMP" "$TMP.gz"' EXIT

fetch() {
  local month="$1"
  local url="https://download.db-ip.com/free/dbip-city-lite-${month}.mmdb.gz"
  echo "[geoip] trying $url"
  curl -fsSL --retry 2 --max-time 600 -o "$TMP.gz" "$url"
}

THIS_MONTH="$(date -u +%Y-%m)"
LAST_MONTH="$(date -u -d "$(date -u +%Y-%m-01) -1 month" +%Y-%m)"
if ! fetch "$THIS_MONTH"; then
  fetch "$LAST_MONTH"
fi

gunzip -c "$TMP.gz" > "$TMP"
SIZE="$(stat -c %s "$TMP")"
if [ "$SIZE" -lt 1000000 ]; then
  echo "[geoip] downloaded file is too small ($SIZE bytes); keeping the old database" >&2
  exit 1
fi
chmod 644 "$TMP"
mv -f "$TMP" "$TARGET"
echo "[geoip] updated $TARGET ($((SIZE / 1024 / 1024)) MB). The API picks it up after its idle reload (GEOIP_IDLE_MS)."
