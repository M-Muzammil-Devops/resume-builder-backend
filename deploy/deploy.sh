#!/usr/bin/env bash
# =============================================================================
# deploy.sh - production deploy of Resume Builder on a (new) Ubuntu server / AWS EC2.
#
# Creates and starts: nginx (80/443) -> frontend (Next.js) + backend (Fastify API, audio tool)
#                     + postgres + redis (named volumes, not published to the internet).
#
# Layout (default = owner's server, two sibling repos):
#   /home/ubuntu/resume-builder-backend/deploy/deploy.sh   <- this script
#   /home/ubuntu/resume-builder-frontend
# Other layouts: --backend-dir / --frontend-dir (or BACKEND_DIR / FRONTEND_DIR env vars).
#
# Usage:
#   bash deploy/deploy.sh                                 # http://<public-ip>
#   bash deploy/deploy.sh --domain cv.example.com --email me@example.com   # + Let's Encrypt HTTPS
#   bash deploy/deploy.sh --pull                          # git pull both repos, then deploy
#   bash deploy/deploy.sh --no-cache                      # rebuild images from scratch
#   bash deploy/deploy.sh --logs [service]                # follow logs
#   bash deploy/deploy.sh --down                          # stop the stack (data volumes are kept)
#
# Safe to re-run (idempotent): existing secrets, data volumes and certificates are kept.
# Secrets live only in deploy/.env (chmod 600) and are never printed.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ---------- paths & defaults ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
ENV_FILE="$DEPLOY_DIR/.env"
ENV_EXAMPLE="$DEPLOY_DIR/.env.example"
SEED_MARKER="$DEPLOY_DIR/.seeded"
PROJECT_NAME="resume-builder"

BACKEND_DIR="${BACKEND_DIR:-}"
FRONTEND_DIR="${FRONTEND_DIR:-}"
DOMAIN_ARG=""
EMAIL_ARG=""
ADMIN_EMAIL_ARG=""
NO_CACHE=0
ACTION="deploy"
LOG_SERVICE=""
DO_PULL=0
FORCE_SEED=0
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-900}"

# ---------- output helpers ----------
if [[ -t 1 ]]; then C_G=$'\e[32m'; C_Y=$'\e[33m'; C_R=$'\e[31m'; C_B=$'\e[1m'; C_0=$'\e[0m'; else C_G=""; C_Y=""; C_R=""; C_B=""; C_0=""; fi
log()  { printf '%s[deploy]%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die()  { printf '%s[error]%s %s\n' "$C_R" "$C_0" "$*" >&2; exit 1; }
trap 'die "failed at line $LINENO: $BASH_COMMAND"' ERR

usage() {
  # Print the comment header of this file (everything up to the first non-comment line).
  awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}"
  cat <<'USAGE'
Options:
  --domain NAME        public domain (DNS A record must point to this server)
  --email ADDRESS      e-mail for Let's Encrypt (with --domain enables HTTPS)
  --admin-email ADDR   admin login e-mail used by the first-run seed
  --backend-dir DIR    backend repo folder   (default: parent of this script)
  --frontend-dir DIR   frontend repo folder  (default: sibling resume-builder-frontend or frontend)
  --pull               git pull --ff-only both repos before building
  --no-cache           build images without the Docker layer cache
  --seed               run the database seed again (resets sample jobs + demo user)
  --logs [SERVICE]     follow logs (all services, or one: nginx|frontend|backend|postgres|redis)
  --down               stop and remove containers (volumes/data are kept)
  -h, --help           show this help
USAGE
}

# ---------- arguments ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)       [[ $# -ge 2 ]] || die "--domain needs a value"; DOMAIN_ARG="$2"; shift 2 ;;
    --email)        [[ $# -ge 2 ]] || die "--email needs a value"; EMAIL_ARG="$2"; shift 2 ;;
    --admin-email)  [[ $# -ge 2 ]] || die "--admin-email needs a value"; ADMIN_EMAIL_ARG="$2"; shift 2 ;;
    --backend-dir)  [[ $# -ge 2 ]] || die "--backend-dir needs a value"; BACKEND_DIR="$2"; shift 2 ;;
    --frontend-dir) [[ $# -ge 2 ]] || die "--frontend-dir needs a value"; FRONTEND_DIR="$2"; shift 2 ;;
    --pull)         DO_PULL=1; shift ;;
    --no-cache)     NO_CACHE=1; shift ;;
    --seed)         FORCE_SEED=1; shift ;;
    --down)         ACTION="down"; shift ;;
    --logs)         ACTION="logs"; shift; if [[ $# -gt 0 && "$1" != --* ]]; then LOG_SERVICE="$1"; shift; fi ;;
    -h|--help)      usage; exit 0 ;;
    *)              usage; die "unknown option: $1" ;;
  esac
done

# ---------- privileges ----------
if [[ $EUID -eq 0 ]]; then SUDO=(); else
  command -v sudo >/dev/null 2>&1 || die "run as root or install sudo"
  SUDO=(sudo)
fi
run_root() { "${SUDO[@]}" "$@"; }

# ---------- resolve source folders ----------
resolve_dirs() {
  [[ -n "$BACKEND_DIR" ]] || BACKEND_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
  if [[ -z "$FRONTEND_DIR" ]]; then
    local parent; parent="$(cd "$BACKEND_DIR/.." && pwd)"
    for candidate in "$parent/resume-builder-frontend" "$parent/frontend"; do
      if [[ -f "$candidate/package.json" ]]; then FRONTEND_DIR="$candidate"; break; fi
    done
  fi
  [[ -n "$FRONTEND_DIR" ]] || die "frontend folder not found next to $BACKEND_DIR (use --frontend-dir)"
  BACKEND_DIR="$(cd "$BACKEND_DIR" && pwd)"
  FRONTEND_DIR="$(cd "$FRONTEND_DIR" && pwd)"
  [[ -f "$BACKEND_DIR/Dockerfile" && -f "$BACKEND_DIR/prisma/schema.prisma" ]] || die "$BACKEND_DIR is not the backend repo (Dockerfile/prisma missing)"
  [[ -f "$FRONTEND_DIR/Dockerfile" && -f "$FRONTEND_DIR/next.config.ts" ]] || die "$FRONTEND_DIR is not the frontend repo (Dockerfile/next.config.ts missing)"
  log "backend:  $BACKEND_DIR"
  log "frontend: $FRONTEND_DIR"
}

# ---------- env file helpers (values never echoed) ----------
get_env() { # get_env KEY -> value from deploy/.env (empty if missing)
  [[ -f "$ENV_FILE" ]] || return 0
  K="$1" awk 'index($0, ENVIRON["K"] "=") == 1 { print substr($0, length(ENVIRON["K"]) + 2); exit }' "$ENV_FILE"
}
set_env() { # set_env KEY VALUE -> replace or append (value passed via environment, not argv)
  local tmp; tmp="$(mktemp "$DEPLOY_DIR/.env.XXXXXX")"
  K="$1" V="$2" awk 'BEGIN { done = 0 }
    index($0, ENVIRON["K"] "=") == 1 { print ENVIRON["K"] "=" ENVIRON["V"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["K"] "=" ENVIRON["V"] }' "$ENV_FILE" > "$tmp"
  cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
}
rand_hex() { openssl rand -hex "${1:-32}"; }
is_placeholder() { [[ -z "$1" || "$1" =~ [Cc]hange[-_]?me || "$1" =~ ^your[-_] || "$1" == "placeholder" ]]; }

# ---------- docker / compose wrappers ----------
DOCKER=(docker)
compose() {
  "${DOCKER[@]}" compose --project-name "$PROJECT_NAME" --project-directory "$DEPLOY_DIR" \
    --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

# ---------- 1. base packages, swap ----------
install_base() {
  local missing=()
  for bin in curl openssl git awk; do command -v "$bin" >/dev/null 2>&1 || missing+=("$bin"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing base packages: ${missing[*]}"
    run_root apt-get update -y
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl openssl git gawk
  fi
}

ensure_swap() {
  # Next.js + torch builds need memory; add a 4 GB swapfile on small instances (< 4 GB RAM, no swap).
  local mem_kb swap_kb
  mem_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  swap_kb="$(awk '/SwapTotal/ {print $2}' /proc/meminfo)"
  if [[ "$mem_kb" -lt 4000000 && "$swap_kb" -eq 0 && ! -f /swapfile ]]; then
    log "low memory ($((mem_kb / 1024)) MB) and no swap: creating 4 GB /swapfile"
    run_root fallocate -l 4G /swapfile || run_root dd if=/dev/zero of=/swapfile bs=1M count=4096
    run_root chmod 600 /swapfile
    run_root mkswap /swapfile >/dev/null
    run_root swapon /swapfile
    grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | run_root tee -a /etc/fstab >/dev/null
  fi
}

# ---------- 2. Docker Engine + compose plugin ----------
install_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "installing Docker Engine (official apt repository)"
    [[ -r /etc/os-release ]] || die "/etc/os-release missing; this script supports Ubuntu"
    # shellcheck disable=SC1091
    . /etc/os-release
    [[ "${ID:-}" == "ubuntu" ]] || warn "OS is '${ID:-unknown}', not Ubuntu; trying the Ubuntu Docker repo anyway"
    run_root apt-get update -y
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg
    run_root install -m 0755 -d /etc/apt/keyrings
    run_root curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    run_root chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
      | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null
    run_root apt-get update -y
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
      docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  run_root systemctl enable --now docker >/dev/null 2>&1 || true

  if ! docker compose version >/dev/null 2>&1 && ! run_root docker compose version >/dev/null 2>&1; then
    log "installing docker compose plugin"
    run_root apt-get update -y
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin docker-buildx-plugin \
      || die "could not install docker-compose-plugin"
  fi

  # Use the docker group when available; otherwise sudo (a fresh group membership needs a new login).
  if docker info >/dev/null 2>&1; then DOCKER=(docker); else DOCKER=("${SUDO[@]}" docker); fi
  if [[ $EUID -ne 0 ]] && ! id -nG "$USER" | grep -qw docker; then
    run_root usermod -aG docker "$USER" || true
    log "added $USER to the docker group (takes effect on next login)"
  fi
  "${DOCKER[@]}" info >/dev/null 2>&1 || die "Docker daemon is not reachable"
  log "docker $("${DOCKER[@]}" version --format '{{.Server.Version}}'), $("${DOCKER[@]}" compose version --short 2>/dev/null || echo compose)"
}

# ---------- 3. firewall (only if UFW is active) ----------
configure_ufw() {
  if command -v ufw >/dev/null 2>&1 && run_root ufw status 2>/dev/null | grep -q '^Status: active'; then
    log "UFW active: allowing 22, 80, 443/tcp"
    run_root ufw allow 22/tcp >/dev/null
    run_root ufw allow 80/tcp >/dev/null
    run_root ufw allow 443/tcp >/dev/null
  fi
  # On EC2 also open 80/443 (and 22) in the instance Security Group.
}

# ---------- 4. deploy/.env with generated secrets ----------
public_ip() {
  local token ip=""
  # EC2 instance metadata (IMDSv2), then a public echo service.
  token="$(curl -fsS -m 2 -X PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' 2>/dev/null || true)"
  if [[ -n "$token" ]]; then
    ip="$(curl -fsS -m 2 -H "X-aws-ec2-metadata-token: $token" http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)"
  fi
  [[ "$ip" =~ ^[0-9.]+$ ]] || ip="$(curl -fsS -m 4 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
  [[ "$ip" =~ ^[0-9.]+$ ]] || ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  printf '%s' "$ip"
}

prepare_env() {
  umask 077
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ENV_EXAMPLE" ]] || die "$ENV_EXAMPLE missing"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    log "created deploy/.env from .env.example"
  fi
  chmod 600 "$ENV_FILE"

  # Generate any missing or placeholder secret (existing values are kept => idempotent).
  local key
  for key in POSTGRES_PASSWORD REDIS_PASSWORD JWT_SECRET AUDIO_PREVIEW_SECRET ADMIN_PASSWORD; do
    if is_placeholder "$(get_env "$key")"; then
      set_env "$key" "$(rand_hex 32)"
      log "generated $key"
    fi
  done

  set_env BACKEND_DIR "$BACKEND_DIR"
  set_env FRONTEND_DIR "$FRONTEND_DIR"
  [[ -n "$ADMIN_EMAIL_ARG" ]] && set_env ADMIN_EMAIL "$ADMIN_EMAIL_ARG"
  [[ -n "$EMAIL_ARG" ]] && set_env LETSENCRYPT_EMAIL "$EMAIL_ARG"
  if [[ -n "$DOMAIN_ARG" ]]; then
    set_env DOMAIN "$DOMAIN_ARG"
    if [[ "$(get_env APP_URL)" != "https://$DOMAIN_ARG" ]]; then set_env APP_URL "http://$DOMAIN_ARG"; fi
  fi

  local domain app_url
  domain="$(get_env DOMAIN)"; app_url="$(get_env APP_URL)"
  if [[ -z "$app_url" ]]; then
    if [[ -n "$domain" ]]; then app_url="http://$domain"; else
      local ip; ip="$(public_ip)"
      [[ -n "$ip" ]] || die "could not detect the public IP; set APP_URL in deploy/.env"
      app_url="http://$ip"
    fi
    set_env APP_URL "$app_url"
  fi
  # Without a certificate nginx must run in http mode.
  if [[ "$(get_env NGINX_MODE)" == "https" ]] && ! cert_exists "$domain"; then set_env NGINX_MODE http; fi
  [[ -n "$(get_env NGINX_MODE)" ]] || set_env NGINX_MODE http

  [[ "$(get_env ADMIN_EMAIL)" == "admin@example.com" ]] && warn "ADMIN_EMAIL is still admin@example.com (use --admin-email or edit deploy/.env)"
  log "APP_URL=$(get_env APP_URL)"
}

# ---------- 5. TLS (Let's Encrypt via certbot webroot) ----------
cert_exists() {
  local domain="${1:-}"
  [[ -n "$domain" ]] || return 1
  "${DOCKER[@]}" volume inspect "${PROJECT_NAME}_letsencrypt" >/dev/null 2>&1 || return 1
  "${DOCKER[@]}" run --rm -v "${PROJECT_NAME}_letsencrypt:/etc/letsencrypt:ro" alpine:3 \
    test -s "/etc/letsencrypt/live/$domain/fullchain.pem" >/dev/null 2>&1
}

setup_tls() {
  local domain email
  domain="$(get_env DOMAIN)"; email="$(get_env LETSENCRYPT_EMAIL)"
  [[ -n "$domain" ]] || return 0
  if [[ -z "$email" ]]; then
    warn "DOMAIN is set but no --email: staying on HTTP ($(get_env APP_URL))"
    return 0
  fi
  if ! cert_exists "$domain"; then
    log "requesting Let's Encrypt certificate for $domain"
    local dns_ip ip; ip="$(public_ip)"; dns_ip="$(getent hosts "$domain" | awk '{print $1; exit}' || true)"
    [[ -n "$dns_ip" && "$dns_ip" == "$ip" ]] || warn "DNS for $domain -> '${dns_ip:-none}', server IP '$ip' (certificate may fail)"
    if ! compose --profile certbot run --rm certbot certonly --webroot -w /var/www/certbot \
        -d "$domain" --email "$email" --agree-tos --no-eff-email --non-interactive --keep-until-expiring; then
      warn "certbot failed; site stays on HTTP. Fix DNS / Security Group (port 80) and re-run."
      return 0
    fi
  fi
  if [[ "$(get_env NGINX_MODE)" != "https" || "$(get_env APP_URL)" != "https://$domain" ]]; then
    set_env NGINX_MODE https
    set_env APP_URL "https://$domain"
    log "switching to HTTPS: rebuilding frontend (public URL changed) and restarting"
    compose build frontend
    compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT" --remove-orphans
  fi
  install_renew_cron
}

install_renew_cron() {
  local cron=/etc/cron.d/resume-builder-certbot docker_bin
  docker_bin="$(command -v docker)"
  run_root tee "$cron" >/dev/null <<CRON
# Renew Let's Encrypt certificates twice a day and reload nginx (installed by deploy.sh)
SHELL=/bin/sh
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3,15 * * * root cd $DEPLOY_DIR && $docker_bin compose --project-name $PROJECT_NAME --env-file $ENV_FILE -f $COMPOSE_FILE --profile certbot run --rm certbot renew --webroot -w /var/www/certbot --quiet && $docker_bin compose --project-name $PROJECT_NAME --env-file $ENV_FILE -f $COMPOSE_FILE exec -T nginx nginx -s reload >/dev/null 2>&1
CRON
  run_root chmod 644 "$cron"
}

# ---------- 6. build, migrate, start ----------
pull_sources() {
  local dir
  for dir in "$BACKEND_DIR" "$FRONTEND_DIR"; do
    if [[ -d "$dir/.git" ]]; then
      log "git pull --ff-only in $dir"
      git -C "$dir" pull --ff-only
    else
      warn "$dir is not a git checkout; skipping --pull"
    fi
  done
}

build_and_start() {
  compose config --quiet || die "docker-compose.prod.yml / deploy/.env is invalid"

  log "building images (this takes a while on the first run)"
  local build_args=(--pull)
  [[ $NO_CACHE -eq 1 ]] && build_args+=(--no-cache)
  compose build "${build_args[@]}"

  log "starting postgres + redis"
  compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT" postgres redis

  # Migrations (prisma migrate deploy) run in the backend entrypoint; run them here first so a broken
  # migration stops the deploy before the old containers are replaced.
  local seed=false
  if [[ $FORCE_SEED -eq 1 || ! -f "$SEED_MARKER" ]]; then seed=true; fi
  log "running database migrations$([[ $seed == true ]] && echo ' + first-run seed')"
  compose run --rm --no-deps -e RUN_MIGRATIONS=true -e RUN_SEED="$seed" backend true
  [[ $seed == true ]] && date -u +%FT%TZ > "$SEED_MARKER"
  verify_admin_email

  log "starting all services and waiting for health checks (timeout ${HEALTH_TIMEOUT}s)"
  if ! compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT" --remove-orphans; then
    compose ps || true
    compose logs --tail 80 backend frontend nginx || true
    die "services did not become healthy"
  fi
}

verify_admin_email() {
  # The seed creates the admin without emailVerifiedAt and login refuses unverified accounts, so on a
  # server without SMTP the admin could never sign in. Mark only that one account verified (idempotent).
  local email; email="$(get_env ADMIN_EMAIL)"
  [[ -n "$email" ]] || return 0
  # shellcheck disable=SC2016  # $POSTGRES_* / $1 are expanded inside the postgres container
  printf '%s\n' "UPDATE \"User\" SET \"emailVerifiedAt\" = NOW() WHERE email = :'admin_email' AND \"emailVerifiedAt\" IS NULL;" \
    | compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -q -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v admin_email="$1"' _ "$email" >/dev/null \
    || warn "could not mark the admin e-mail as verified"
}

smoke_test() {
  local port; port="$(get_env HTTP_PORT)"; port="${port:-80}"
  local base="http://127.0.0.1:$port" ok=1
  curl -fsS -m 10 "$base/nginx-health" >/dev/null || { warn "nginx health check failed"; ok=0; }
  # In https mode port 80 redirects, so test the API/app through the redirect with the Host header.
  if [[ "$(get_env NGINX_MODE)" == "https" ]]; then
    base="https://$(get_env DOMAIN)"
  fi
  curl -fsS -m 20 -L "$base/rb-api/health" >/dev/null || { warn "API check failed: $base/rb-api/health"; ok=0; }
  curl -fsS -m 30 -L -o /dev/null "$base/" || { warn "frontend check failed: $base/"; ok=0; }
  [[ $ok -eq 1 ]] && log "smoke test passed (nginx, /rb-api/health, /)"
}

print_summary() {
  local url; url="$(get_env APP_URL)"
  compose ps
  cat <<SUMMARY

${C_B}Resume Builder is up.${C_0}
  App:          $url/
  Login:        $url/login
  Admin login:  $url/admin/login   (ADMIN_EMAIL / ADMIN_PASSWORD are in $ENV_FILE)
  API health:   $url/rb-api/health
  Audio tool:   $url/tools/audio-noise-remover

  Logs:    bash $DEPLOY_DIR/deploy.sh --logs [backend|frontend|nginx|postgres|redis]
  Stop:    bash $DEPLOY_DIR/deploy.sh --down      (data volumes are kept)
  Update:  bash $DEPLOY_DIR/deploy.sh --pull
SUMMARY
  [[ "$url" == http://* ]] && warn "site is on plain HTTP. For HTTPS: --domain <name> --email <you@example.com>"
  return 0
}

# ---------- main ----------
main() {
  resolve_dirs
  case "$ACTION" in
    down)
      install_docker
      [[ -f "$ENV_FILE" ]] || die "deploy/.env not found; nothing to stop"
      compose --profile certbot down --remove-orphans
      log "stack stopped (volumes kept)"
      return 0 ;;
    logs)
      install_docker
      [[ -f "$ENV_FILE" ]] || die "deploy/.env not found"
      if [[ -n "$LOG_SERVICE" ]]; then compose logs -f --tail 200 "$LOG_SERVICE"; else compose logs -f --tail 200; fi
      return 0 ;;
  esac

  install_base
  ensure_swap
  install_docker
  configure_ufw
  [[ $DO_PULL -eq 1 ]] && pull_sources
  prepare_env
  build_and_start
  setup_tls
  smoke_test || true
  print_summary
}

main "$@"
