#!/usr/bin/env bash
# with-env.sh ENV_FILE DIR CMD [ARGS...]
# Runs CMD inside DIR with the KEY=VALUE lines of ENV_FILE exported, the same way systemd reads an
# EnvironmentFile (no shell expansion; one pair of surrounding quotes is removed). Used by deploy.sh
# so npm / prisma / the seed see exactly the environment the backend service gets.
set -euo pipefail
env_file="$1"; dir="$2"; shift 2
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
  key="${line%%=*}"; val="${line#*=}"
  if [[ "$val" =~ ^\"(.*)\"$ || "$val" =~ ^\'(.*)\'$ ]]; then val="${BASH_REMATCH[1]}"; fi
  export "$key=$val"
done < "$env_file"
cd "$dir"
exec "$@"