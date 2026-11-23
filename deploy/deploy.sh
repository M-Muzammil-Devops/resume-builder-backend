#!/usr/bin/env bash
# =============================================================================
# deploy.sh - STAGING deploy of Resume Builder on an Ubuntu server / AWS EC2.
#
#   host nginx (/etc/nginx, 80/443)  ->  frontend  Docker container      127.0.0.1:FRONTEND_PORT
#                                    ->  backend   HOST systemd service  127.0.0.1:BACKEND_PORT (/rb-api/)
#   backend -> postgres + redis      Docker containers (named volumes)   127.0.0.1 only
#
# The backend runs straight from the git checkout (npm ci + tsc build, unit resume-builder-backend),
# so a "git pull" goes live in seconds with --pull. The frontend is rebuilt only when it changed.
#
# Layout (default = owner's server, two sibling repos):
#   /home/ubuntu/resume-builder-backend/deploy/deploy.sh   <- this script
#   /home/ubuntu/resume-builder-frontend
# Other layouts: --backend-dir / --frontend-dir (or BACKEND_DIR / FRONTEND_DIR env vars).
#
# Usage:
#   bash deploy/deploy.sh                                 # full deploy, http://<public-ip>
#   bash deploy/deploy.sh --domain cv.example.com --email me@example.com   # + HTTPS (certbot)
#   bash deploy/deploy.sh --pull                          # FAST UPDATE: git pull + rebuild what changed
#   bash deploy/update.sh                                 # same as --pull
#   bash deploy/deploy.sh --restart                       # restart backend service + frontend
#   bash deploy/deploy.sh --nginx-only                    # only (re)write the nginx site + certificate
#   bash deploy/deploy.sh --logs [backend|frontend|postgres|redis]
#   bash deploy/deploy.sh --down                          # stop everything (data volumes are kept)
#
# Safe to re-run (idempotent): secrets, data, certificates and other nginx sites are kept.
# Secrets live only in deploy/.env and deploy/backend.env (chmod 600) and are never printed.
# =============================================================================
set -euo pipefail
IFS=$'\n\t'

# ---------- paths & defaults ----------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SCRIPT_DIR"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
ENV_FILE="$DEPLOY_DIR/.env"
ENV_EXAMPLE="$DEPLOY_DIR/.env.example"
BACKEND_ENV="$DEPLOY_DIR/backend.env"          # systemd EnvironmentFile of the backend (generated)
STATE_DIR="$DEPLOY_DIR/.state"                 # last deployed git revisions (for --pull)
SEED_MARKER="$DEPLOY_DIR/.seeded"
PROJECT_NAME="resume-builder"

UNIT_NAME="resume-builder-backend"
UNIT_FILE="/etc/systemd/system/$UNIT_NAME.service"
NODE_MAJOR=22                                  # same major as the Dockerfiles (node:22)
PY_VERSION=3.11                                # torch 2.1 wheels: python <= 3.11 (uv provides it)
TORCH_VERSION=2.1.2
DFN_VERSION=0.5.6

NGINX_SITE_NAME="resume-builder"
NGINX_TEMPLATE="$DEPLOY_DIR/nginx/resume-builder.conf"
NGINX_DIR="${NGINX_DIR:-/etc/nginx}"
NGINX_AVAILABLE="$NGINX_DIR/sites-available/$NGINX_SITE_NAME"
NGINX_ENABLED="$NGINX_DIR/sites-enabled/$NGINX_SITE_NAME"

BACKEND_DIR="${BACKEND_DIR:-}"
FRONTEND_DIR="${FRONTEND_DIR:-}"
DOMAIN_ARG=""
EMAIL_ARG=""
ADMIN_EMAIL_ARG=""
NO_CACHE=0
ACTION="deploy"
LOG_SERVICE=""
FORCE_SEED=0
DISABLE_DEFAULT=0
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-600}"

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
  --domain NAME        public domain (DNS A record must point to this server); nginx server_name
  --email ADDRESS      e-mail for Let's Encrypt (with --domain enables HTTPS via host certbot)
  --admin-email ADDR   admin login e-mail used by the first-run seed
  --backend-dir DIR    backend repo folder   (default: parent of this script)
  --frontend-dir DIR   frontend repo folder  (default: sibling resume-builder-frontend or frontend)
  --disable-default    remove the sites-enabled/default symlink so this site can be default_server
  --pull               fast update: git pull --ff-only both repos, rebuild/restart only what changed
  --restart            restart the backend service and the frontend container
  --nginx-only         only (re)write the nginx site and certificate
  --no-cache           build the frontend image without the Docker layer cache
  --seed               run the database seed again (resets sample jobs + demo user)
  --logs [SERVICE]     follow logs (backend = journalctl; frontend|postgres|redis = docker)
  --down               stop the backend service and the containers (data volumes are kept)
  -h, --help           show this help
USAGE
}

# ---------- arguments ----------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)          [[ $# -ge 2 ]] || die "--domain needs a value"; DOMAIN_ARG="$2"; shift 2 ;;
    --email)           [[ $# -ge 2 ]] || die "--email needs a value"; EMAIL_ARG="$2"; shift 2 ;;
    --admin-email)     [[ $# -ge 2 ]] || die "--admin-email needs a value"; ADMIN_EMAIL_ARG="$2"; shift 2 ;;
    --backend-dir)     [[ $# -ge 2 ]] || die "--backend-dir needs a value"; BACKEND_DIR="$2"; shift 2 ;;
    --frontend-dir)    [[ $# -ge 2 ]] || die "--frontend-dir needs a value"; FRONTEND_DIR="$2"; shift 2 ;;
    --disable-default) DISABLE_DEFAULT=1; shift ;;
    --pull|--update)   ACTION="update"; shift ;;
    --restart)         ACTION="restart"; shift ;;
    --nginx-only)      ACTION="nginx"; shift ;;
    --no-cache)        NO_CACHE=1; shift ;;
    --seed)            FORCE_SEED=1; shift ;;
    --down)            ACTION="down"; shift ;;
    --logs)            ACTION="logs"; shift; if [[ $# -gt 0 && "$1" != --* ]]; then LOG_SERVICE="$1"; shift; fi ;;
    -h|--help)         usage; exit 0 ;;
    *)                 usage; die "unknown option: $1" ;;
  esac
done

if [[ -n "$DOMAIN_ARG" && ! "$DOMAIN_ARG" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  die "invalid --domain: $DOMAIN_ARG"
fi

# ---------- privileges ----------
if [[ $EUID -eq 0 ]]; then SUDO=(); else
  command -v sudo >/dev/null 2>&1 || die "run as root or install sudo"
  SUDO=(sudo)
fi
run_root() { "${SUDO[@]}" "$@"; }
APT_UPDATED=0
apt_install() {
  if [[ $APT_UPDATED -eq 0 ]]; then run_root apt-get update -y; APT_UPDATED=1; fi
  run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@"
}
missing_pkgs() { local p; for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || printf '%s\n' "$p"; done; }
has_systemd() { [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; }

# ---------- resolve source folders + service user ----------
resolve_dirs() {
  [[ -n "$BACKEND_DIR" ]] || BACKEND_DIR="$(cd "$DEPLOY_DIR/.." && pwd)"
  if [[ -z "$FRONTEND_DIR" ]]; then
    local parent candidate; parent="$(cd "$BACKEND_DIR/.." && pwd)"
    for candidate in "$parent/resume-builder-frontend" "$parent/frontend"; do
      if [[ -f "$candidate/package.json" ]]; then FRONTEND_DIR="$candidate"; break; fi
    done
  fi
  [[ -n "$FRONTEND_DIR" ]] || die "frontend folder not found next to $BACKEND_DIR (use --frontend-dir)"
  BACKEND_DIR="$(cd "$BACKEND_DIR" && pwd)"
  FRONTEND_DIR="$(cd "$FRONTEND_DIR" && pwd)"
  [[ -f "$BACKEND_DIR/package.json" && -f "$BACKEND_DIR/prisma/schema.prisma" ]] || die "$BACKEND_DIR is not the backend repo (package.json/prisma missing)"
  [[ -f "$FRONTEND_DIR/Dockerfile" && -f "$FRONTEND_DIR/next.config.ts" ]] || die "$FRONTEND_DIR is not the frontend repo (Dockerfile/next.config.ts missing)"

  # The backend service runs as the owner of the backend checkout (ubuntu on EC2), never as root.
  APP_USER="${APP_USER:-$(stat -c %U "$BACKEND_DIR")}"
  [[ "$APP_USER" != "root" ]] || warn "the backend checkout is owned by root; the service will run as root (chown it to ubuntu to avoid this)"
  APP_GROUP="$(id -gn "$APP_USER")"
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  DATA_DIR="${DATA_DIR:-$(dirname "$BACKEND_DIR")/resume-builder-data}"   # uploads + audio temp files
  VENV_DIR="$BACKEND_DIR/audio-worker/.venv"                              # the API's default AUDIO_PYTHON
  log "backend:  $BACKEND_DIR (host service, user $APP_USER)"
  log "frontend: $FRONTEND_DIR (container)"
}

# Run a command as the service user (with its HOME), from any caller (ubuntu, sudo, root).
as_app() {
  if [[ "$(id -un)" == "$APP_USER" ]]; then env HOME="$APP_HOME" "$@"
  elif [[ $EUID -eq 0 ]]; then runuser -u "$APP_USER" -- env HOME="$APP_HOME" "$@"
  else sudo -H -u "$APP_USER" env HOME="$APP_HOME" "$@"; fi
}
# Run a command as the service user inside DIR with exactly the backend service environment.
app_run() { local dir="$1"; shift; as_app bash "$DEPLOY_DIR/host/with-env.sh" "$BACKEND_ENV" "$dir" "$@"; }

# ---------- env file helpers (values never echoed) ----------
get_env() { # get_env KEY -> value from deploy/.env (empty if missing)
  [[ -f "$ENV_FILE" ]] || return 0
  # (a trailing CR from a file edited on Windows is ignored)
  K="$1" awk '{ sub(/\r$/, "") } index($0, ENVIRON["K"] "=") == 1 { print substr($0, length(ENVIRON["K"]) + 2); exit }' "$ENV_FILE"
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
env_or()        { local v; v="$(get_env "$1")"; printf '%s' "${v:-$2}"; }
frontend_port() { env_or FRONTEND_PORT 3000; }
backend_port()  { env_or BACKEND_PORT 4000; }
port_in_use()   { ss -ltnH "( sport = :$1 )" 2>/dev/null | grep -q .; }

# ---------- docker / compose wrappers ----------
DOCKER=(docker)
compose() {
  "${DOCKER[@]}" compose --project-name "$PROJECT_NAME" --project-directory "$DEPLOY_DIR" \
    --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}
container_running() { [[ -n "$(compose ps -q --status running "$1" 2>/dev/null)" ]]; }

# ---------- state (last deployed revisions, for --pull) ----------
git_rev()   { git -C "$1" rev-parse HEAD 2>/dev/null || echo "none"; }
state_get() { cat "$STATE_DIR/$1.rev" 2>/dev/null || true; }
state_set() { mkdir -p "$STATE_DIR"; printf '%s\n' "$2" > "$STATE_DIR/$1.rev"; }
# changed_files DIR OLD NEW -> changed paths, or "__ALL__" when OLD is unknown
changed_files() {
  if [[ -z "$2" || "$2" == "none" ]] || ! git -C "$1" cat-file -e "$2^{commit}" 2>/dev/null; then echo "__ALL__"; return 0; fi
  git -C "$1" diff --name-only "$2" "$3"
}
touches() { # touches "<changed list>" REGEX
  [[ "$1" == "__ALL__" ]] && return 0
  grep -Eq "$2" <<<"$1"
}
# ---------- 1. base packages, swap ----------
install_base() {
  local missing=()
  for bin in curl openssl git awk; do command -v "$bin" >/dev/null 2>&1 || missing+=("$bin"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    log "installing base packages: ${missing[*]}"
    apt_install ca-certificates curl openssl git gawk
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
    apt_install ca-certificates curl gnupg
    run_root install -m 0755 -d /etc/apt/keyrings
    run_root curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    run_root chmod a+r /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
      | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null
    apt_install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  run_root systemctl enable --now docker >/dev/null 2>&1 || true

  if ! docker compose version >/dev/null 2>&1 && ! run_root docker compose version >/dev/null 2>&1; then
    log "installing docker compose plugin"
    apt_install docker-compose-plugin docker-buildx-plugin || die "could not install docker-compose-plugin"
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
  # On EC2 also open 80/443 (and 22) in the instance Security Group. 3000/4000/5432/6379 stay on 127.0.0.1.
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

has_cert() { [[ -n "${1:-}" ]] && run_root test -s "/etc/letsencrypt/live/$1/fullchain.pem"; }

prepare_env() {
  umask 077
  if [[ ! -f "$ENV_FILE" ]]; then
    [[ -f "$ENV_EXAMPLE" ]] || die "$ENV_EXAMPLE missing"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    log "created deploy/.env from .env.example"
  fi
  chmod 600 "$ENV_FILE"
  [[ "$(stat -c %U "$ENV_FILE")" == "$APP_USER" ]] || run_root chown "$APP_USER:$APP_GROUP" "$ENV_FILE"

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
  [[ -n "$(get_env FRONTEND_PORT)" ]] || set_env FRONTEND_PORT 3000
  [[ -n "$(get_env BACKEND_PORT)" ]] || set_env BACKEND_PORT 4000
  [[ -n "$(get_env POSTGRES_PORT)" ]] || set_env POSTGRES_PORT 5432
  [[ -n "$(get_env REDIS_PORT)" ]] || set_env REDIS_PORT 6379
  [[ -n "$ADMIN_EMAIL_ARG" ]] && set_env ADMIN_EMAIL "$ADMIN_EMAIL_ARG"
  [[ -n "$EMAIL_ARG" ]] && set_env LETSENCRYPT_EMAIL "$EMAIL_ARG"
  [[ -n "$DOMAIN_ARG" ]] && set_env DOMAIN "$DOMAIN_ARG"

  # APP_URL: https://domain once a certificate exists, http://domain before, else http://<public-ip>.
  local domain app_url
  domain="$(get_env DOMAIN)"
  if [[ -n "$domain" ]]; then
    if has_cert "$domain"; then app_url="https://$domain"; else app_url="http://$domain"; fi
  else
    app_url="$(get_env APP_URL)"
    if [[ -z "$app_url" ]]; then
      local ip; ip="$(public_ip)"
      [[ -n "$ip" ]] || die "could not detect the public IP; set APP_URL in deploy/.env"
      app_url="http://$ip"
    fi
  fi
  set_env APP_URL "$app_url"

  [[ "$(get_env ADMIN_EMAIL)" == "admin@example.com" ]] && warn "ADMIN_EMAIL is still admin@example.com (use --admin-email or edit deploy/.env)"
  log "APP_URL=$(get_env APP_URL)"
}

# ---------- 5. host nginx ----------
install_nginx() {
  if ! command -v nginx >/dev/null 2>&1; then
    log "installing nginx (host)"
    apt_install nginx
  fi
  run_root mkdir -p "$NGINX_DIR/sites-available" "$NGINX_DIR/sites-enabled"
  if ! run_root grep -Rqs 'sites-enabled' "$NGINX_DIR/nginx.conf"; then
    warn "$NGINX_DIR/nginx.conf does not include sites-enabled/*; add 'include $NGINX_DIR/sites-enabled/*;' inside http {}"
  fi
}

# Enabled site files (other than ours) that already claim default_server on port 80.
other_default_servers() {
  local f
  for f in "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf; do
    [[ -e "$f" ]] || continue
    [[ "$(basename "$f")" == "$NGINX_SITE_NAME" ]] && continue
    if run_root grep -Eqs '^[[:space:]]*listen[[:space:]]+([^;]*:)?80([[:space:]][^;]*)?[[:space:]]default_server' "$f"; then
      printf '%s\n' "$f"
    fi
  done
}

render_nginx_conf() { # render_nginx_conf DEFAULT_FLAG -> site config on stdout
  local default_flag="$1" domain server_name frontend backend
  domain="$(get_env DOMAIN)"; server_name="${domain:-_}"
  # NGINX_*_UPSTREAM overrides exist for testing / unusual setups; normally 127.0.0.1:<port>.
  frontend="${NGINX_FRONTEND_UPSTREAM:-127.0.0.1:$(frontend_port)}"
  backend="${NGINX_BACKEND_UPSTREAM:-127.0.0.1:$(backend_port)}"
  [[ "$frontend" =~ ^[A-Za-z0-9._-]+:[0-9]+$ && "$backend" =~ ^[A-Za-z0-9._-]+:[0-9]+$ ]] || die "invalid upstream address"
  [[ -f "$NGINX_TEMPLATE" ]] || die "$NGINX_TEMPLATE missing"
  sed -e "s|__SERVER_NAME__|$server_name|g" \
      -e "s|__DEFAULT_SERVER__|$default_flag|g" \
      -e "s|__FRONTEND__|$frontend|g" \
      -e "s|__BACKEND__|$backend|g" "$NGINX_TEMPLATE"
}

reload_nginx() {
  if [[ -d /run/systemd/system ]] && command -v systemctl >/dev/null 2>&1; then
    if systemctl is-active --quiet nginx; then run_root systemctl reload nginx; else run_root systemctl enable --now nginx; fi
  else
    # No systemd (e.g. a container): signal a running master, or start one.
    run_root nginx -s reload 2>/dev/null || run_root nginx
  fi
}

configure_host_nginx() {
  install_nginx
  local domain default_flag="" conflicts removed_default=0
  domain="$(get_env DOMAIN)"

  if [[ -n "$domain" ]]; then
    local same; same="$(run_root grep -lEs "server_name[^;]*[[:space:]]$domain([[:space:]]|;)" "$NGINX_DIR"/sites-enabled/* "$NGINX_DIR"/conf.d/*.conf 2>/dev/null | grep -v "/$NGINX_SITE_NAME\$" || true)"
    [[ -z "$same" ]] || warn "server_name $domain is also used by: $same (nginx will warn about a conflicting server name)"
  else
    # No domain: this site must be the default_server so http://<ip> reaches it.
    if [[ $DISABLE_DEFAULT -eq 1 && -L "$NGINX_DIR/sites-enabled/default" ]]; then
      run_root rm -f "$NGINX_DIR/sites-enabled/default"
      removed_default=1
      log "disabled $NGINX_DIR/sites-enabled/default (the file in sites-available is untouched)"
    fi
    conflicts="$(other_default_servers)"
    if [[ -z "$conflicts" ]]; then
      default_flag=" default_server"
    else
      warn "default_server on port 80 is already used by: $(echo "$conflicts" | tr '\n' ' ')"
      warn "resume-builder is installed WITHOUT default_server, so http://<ip> keeps showing that site."
      warn "Use --domain <name>, or re-run with --disable-default to disable sites-enabled/default."
    fi
  fi

  local tmp backup="" had_link=0
  tmp="$(mktemp)"
  render_nginx_conf "$default_flag" > "$tmp"
  if run_root test -f "$NGINX_AVAILABLE"; then
    backup="$NGINX_AVAILABLE.bak-$(date +%Y%m%d-%H%M%S)"
    run_root cp -p "$NGINX_AVAILABLE" "$backup"
  fi
  [[ -L "$NGINX_ENABLED" ]] && had_link=1
  run_root install -m 0644 "$tmp" "$NGINX_AVAILABLE"
  rm -f "$tmp"
  run_root ln -sfn "$NGINX_AVAILABLE" "$NGINX_ENABLED"

  if ! run_root nginx -t; then
    warn "nginx -t failed: rolling back"
    if [[ -n "$backup" ]]; then run_root cp -p "$backup" "$NGINX_AVAILABLE"; else run_root rm -f "$NGINX_AVAILABLE"; fi
    [[ $had_link -eq 1 ]] || run_root rm -f "$NGINX_ENABLED"
    [[ $removed_default -eq 1 ]] && run_root ln -sfn "$NGINX_DIR/sites-available/default" "$NGINX_DIR/sites-enabled/default"
    die "nginx config test failed; previous configuration restored (nothing reloaded)"
  fi
  reload_nginx
  log "host nginx: $NGINX_AVAILABLE (server_name ${domain:-_}${default_flag}) -> 127.0.0.1:$(frontend_port) / 127.0.0.1:$(backend_port)"

  # Keep only the 5 newest backups of our own site file.
  run_root sh -c "ls -1t '$NGINX_AVAILABLE'.bak-* 2>/dev/null | tail -n +6 | xargs -r rm -f"
}

# ---------- 6. TLS (host certbot, nginx plugin) ----------
setup_tls() {
  local domain email
  domain="$(get_env DOMAIN)"; email="$(get_env LETSENCRYPT_EMAIL)"
  [[ -n "$domain" ]] || return 0
  if [[ -z "$email" ]] && ! has_cert "$domain"; then
    warn "DOMAIN is set but no --email: staying on HTTP ($(get_env APP_URL))"
    return 0
  fi
  if ! command -v certbot >/dev/null 2>&1 || ! dpkg -s python3-certbot-nginx >/dev/null 2>&1; then
    log "installing certbot + nginx plugin"
    apt_install certbot python3-certbot-nginx
  fi
  local ip dns_ip; ip="$(public_ip)"; dns_ip="$(getent hosts "$domain" | awk '{print $1; exit}' || true)"
  [[ -n "$dns_ip" && "$dns_ip" == "$ip" ]] || warn "DNS for $domain -> '${dns_ip:-none}', server IP '$ip' (certificate may fail)"

  # Issues the certificate once (later runs only re-install it into the freshly written site file).
  local args=(--nginx -d "$domain" --cert-name "$domain" --non-interactive --agree-tos --redirect --keep-until-expiring)
  if [[ -n "$email" ]]; then args+=(--email "$email" --no-eff-email); fi
  if ! run_root certbot "${args[@]}"; then
    warn "certbot failed; site stays on HTTP. Check DNS and that port 80 is open in the Security Group, then re-run."
    return 0
  fi
  systemctl list-timers --all 2>/dev/null | grep -q certbot || warn "certbot.timer not found; renewal needs 'certbot renew' in cron"

  if [[ "$(get_env APP_URL)" != "https://$domain" ]]; then
    set_env APP_URL "https://$domain"
    if [[ "$ACTION" == "deploy" ]]; then
      log "public URL is now https://$domain: updating the backend env, rebuilding the frontend"
      write_backend_env
      restart_backend
      start_frontend build
    else
      warn "APP_URL changed to https://$domain; run a full deploy to rebuild the frontend with it"
    fi
  fi
}

# ---------- 7. host dependencies of the backend ----------
chrome_path() {
  local c
  for c in /usr/bin/google-chrome-stable /usr/bin/google-chrome /usr/bin/chromium /usr/bin/chromium-browser /snap/bin/chromium; do
    [[ -x "$c" ]] && { printf '%s' "$c"; return 0; }
  done
  return 0
}

install_node() {
  local major=""
  command -v node >/dev/null 2>&1 && major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  if [[ "$major" != "$NODE_MAJOR" ]]; then
    log "installing Node.js $NODE_MAJOR (NodeSource)${major:+, replacing Node $major}"
    local tmp; tmp="$(mktemp)"
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" -o "$tmp"
    run_root bash "$tmp"; rm -f "$tmp"
    APT_UPDATED=1
    run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
  fi
  log "node $(node -v), npm $(npm -v)"
}

install_chrome() {
  # PDF export (Puppeteer) needs a system Chrome/Chromium. Ubuntu's chromium is a snap, so on
  # x86_64 Google Chrome (.deb, pulls its own libraries) is used; on arm64 the chromium snap.
  [[ -n "$(chrome_path)" ]] && return 0
  if [[ "$(dpkg --print-architecture)" == "amd64" ]]; then
    log "installing Google Chrome (PDF export)"
    local deb; deb="$(mktemp --suffix=.deb)"
    curl -fsSL https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$deb"
    chmod 644 "$deb"
    apt_install "$deb"; rm -f "$deb"
  else
    log "installing chromium (PDF export)"
    apt_install chromium-browser || apt_install chromium || run_root snap install chromium
  fi
  [[ -n "$(chrome_path)" ]] || die "no Chrome/Chromium found after install (PDF export needs one)"
}

install_python_audio() {
  # Audio tool: a venv with CPU-only torch + DeepFilterNet3 at audio-worker/.venv (the path the API
  # uses by default). uv provides Python $PY_VERSION on any Ubuntu release.
  if ! command -v uv >/dev/null 2>&1; then
    log "installing uv (Python manager)"
    local tmp; tmp="$(mktemp)"
    curl -LsSf https://astral.sh/uv/install.sh -o "$tmp"
    run_root env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh "$tmp"; rm -f "$tmp"
  fi
  local py="$VENV_DIR/bin/python"
  if ! as_app "$py" -c 'import torch, torchaudio, df, soundfile' >/dev/null 2>&1; then
    log "creating the audio venv (CPU torch $TORCH_VERSION + DeepFilterNet $DFN_VERSION, ~1 GB, a few minutes)"
    as_app rm -rf "$VENV_DIR"
    as_app uv venv --quiet --python "$PY_VERSION" "$VENV_DIR"
    as_app uv pip install --quiet --python "$py" --index-url https://download.pytorch.org/whl/cpu \
      "torch==$TORCH_VERSION" "torchaudio==$TORCH_VERSION"
    as_app uv pip install --quiet --python "$py" "numpy==1.26.4" "deepfilternet==$DFN_VERSION" "soundfile>=0.12"
  fi
  # Prefetch the DeepFilterNet3 model into ~/.cache/DeepFilterNet (it is downloaded on first use otherwise).
  if [[ -z "$(as_app find "$APP_HOME/.cache/DeepFilterNet" -name '*.ckpt*' -print -quit 2>/dev/null || true)" ]]; then
    log "downloading the DeepFilterNet3 model"
    as_app "$py" -c "from df.enhance import init_df; init_df(log_level='ERROR', log_file=None)" >/dev/null
  fi
  log "audio venv ready ($(as_app "$py" -c 'import torch; print("torch", torch.__version__)'))"
}

install_backend_host_deps() {
  install_node
  local pkgs; pkgs="$(missing_pkgs ffmpeg git openssl ca-certificates fonts-liberation fonts-dejavu-core fonts-noto-color-emoji iproute2)"
  if [[ -n "$pkgs" ]]; then
    log "installing: $(echo "$pkgs" | tr '\n' ' ')"
    # shellcheck disable=SC2086  # word splitting of the package list is intended
    apt_install $pkgs
  fi
  install_chrome
  install_python_audio
}

# ---------- 8. backend env + systemd unit ----------
write_backend_env() {
  # deploy/.env (owner-edited) + fixed host values -> deploy/backend.env (EnvironmentFile, chmod 600).
  local pg_user pg_db pg_pw redis_pw app_url chrome tmp
  pg_user="$(env_or POSTGRES_USER resume)"; pg_db="$(env_or POSTGRES_DB resume_builder)"
  pg_pw="$(get_env POSTGRES_PASSWORD)"; redis_pw="$(get_env REDIS_PASSWORD)"
  app_url="$(get_env APP_URL)"; chrome="$(chrome_path)"
  [[ -n "$pg_pw" && -n "$redis_pw" && -n "$app_url" ]] || die "deploy/.env is incomplete; run the full deploy"
  as_app mkdir -p "$DATA_DIR/uploads" "$DATA_DIR/tmp/audio"
  # The API also loads <backend>/.env (dotenv) for keys the service does not set; warn so dev values do not leak in.
  [[ -f "$BACKEND_DIR/.env" ]] && warn "$BACKEND_DIR/.env exists: its values apply wherever deploy/.env does not set the key (remove it on the server)"

  local fixed=(
    "NODE_ENV=production"
    "API_PORT=$(backend_port)"
    "LISTEN_HOST=127.0.0.1"
    "DATABASE_URL=postgresql://$pg_user:$pg_pw@127.0.0.1:$(env_or POSTGRES_PORT 5432)/$pg_db?schema=public"
    "REDIS_ENABLED=true"
    "REDIS_URL=redis://:$redis_pw@127.0.0.1:$(env_or REDIS_PORT 6379)"
    "APP_URL=$app_url"
    "CORS_ORIGIN=$app_url"
    "FRONTEND_URL=$app_url"
    "PRINT_BASE_URL=http://127.0.0.1:$(frontend_port)"
    "FRONTEND_PUBLIC_DIR=$FRONTEND_DIR/public"
    "UPLOAD_DIR=$DATA_DIR/uploads"
    "AUDIO_TMP_DIR=$DATA_DIR/tmp/audio"
    "AUDIO_PYTHON=$VENV_DIR/bin/python"
    "FFMPEG_PATH=$(command -v ffmpeg || echo ffmpeg)"
    "FFPROBE_PATH=$(command -v ffprobe || echo ffprobe)"
    "PUPPETEER_SKIP_DOWNLOAD=true"
    "PUPPETEER_EXECUTABLE_PATH=$chrome"
    "CHROME_PATH=$chrome"
  )
  local skip="DOMAIN LETSENCRYPT_EMAIL BACKEND_DIR FRONTEND_DIR IMAGE_TAG POSTGRES_PORT REDIS_PORT FRONTEND_PORT BACKEND_PORT"
  local kv; for kv in "${fixed[@]}"; do skip+=" ${kv%%=*}"; done
  tmp="$(umask 077; mktemp "$DEPLOY_DIR/.backend.env.XXXXXX")"
  {
    echo "# GENERATED by deploy.sh from deploy/.env - edit deploy/.env instead and run deploy.sh --pull."
    SKIP="$skip" awk '{ sub(/\r$/, "") } /^[A-Za-z_][A-Za-z0-9_]*=/ {
        k = substr($0, 1, index($0, "=") - 1); n = split(ENVIRON["SKIP"], s, " ")
        for (i = 1; i <= n; i++) if (s[i] == k) next
        print }' "$ENV_FILE"
    printf '%s\n' "${fixed[@]}"
  } > "$tmp"
  chmod 600 "$tmp"
  if [[ -f "$BACKEND_ENV" ]] && cmp -s "$tmp" "$BACKEND_ENV"; then rm -f "$tmp"; BACKEND_ENV_CHANGED=0; return 0; fi
  mv -f "$tmp" "$BACKEND_ENV"
  [[ "$(stat -c %U "$BACKEND_ENV")" == "$APP_USER" ]] || run_root chown "$APP_USER:$APP_GROUP" "$BACKEND_ENV"
  BACKEND_ENV_CHANGED=1
  log "wrote deploy/backend.env (secrets not shown)"
}
BACKEND_ENV_CHANGED=0

install_unit() {
  has_systemd || die "systemd is required for the backend service"
  local node tmp; node="$(command -v node)"
  tmp="$(mktemp)"
  cat > "$tmp" <<UNIT
# Managed by $DEPLOY_DIR/deploy.sh - changes here are overwritten.
[Unit]
Description=Resume Builder backend (Fastify API, staging)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_GROUP
WorkingDirectory=$BACKEND_DIR
EnvironmentFile=$BACKEND_ENV
# listen-loopback.cjs keeps the API on 127.0.0.1 (only the host nginx can reach it).
ExecStart=$node --require $DEPLOY_DIR/host/listen-loopback.cjs dist/index.js
Restart=always
RestartSec=3
KillMode=mixed
TimeoutStopSec=20
LimitNOFILE=65536
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$UNIT_NAME

[Install]
WantedBy=multi-user.target
UNIT
  if run_root test -f "$UNIT_FILE" && run_root cmp -s "$tmp" "$UNIT_FILE"; then rm -f "$tmp"; else
    run_root install -m 0644 "$tmp" "$UNIT_FILE"; rm -f "$tmp"
    run_root systemctl daemon-reload
    log "installed $UNIT_FILE"
  fi
  run_root systemctl enable "$UNIT_NAME" >/dev/null 2>&1
}

wait_backend() {
  local i port; port="$(backend_port)"
  for ((i = 0; i < 90; i++)); do
    curl -fsS -m 3 -o /dev/null "http://127.0.0.1:$port/health" 2>/dev/null && return 0
    if (( i > 5 )) && ! systemctl is-active --quiet "$UNIT_NAME"; then break; fi
    sleep 1
  done
  run_root journalctl -u "$UNIT_NAME" -n 60 --no-pager || true
  die "backend did not answer on 127.0.0.1:$port/health (logs above; full: --logs backend)"
}

restart_backend() {
  run_root systemctl restart "$UNIT_NAME"
  wait_backend
  log "backend service restarted and healthy (127.0.0.1:$(backend_port))"
}

# ---------- 9. backend build steps (run as the service user, in the checkout) ----------
backend_npm_ci()   { log "backend: npm ci";          app_run "$BACKEND_DIR" npm ci --include=dev --no-audit --no-fund --loglevel=error; }
backend_generate() { log "backend: prisma generate"; app_run "$BACKEND_DIR" ./node_modules/.bin/prisma generate >/dev/null; }
backend_build()    { log "backend: build (tsc)";     app_run "$BACKEND_DIR" npm run --silent build; }
backend_migrate() {
  log "backend: prisma migrate deploy"
  app_run "$BACKEND_DIR" ./node_modules/.bin/prisma migrate deploy
  if [[ "$(env_or PRISMA_SYNC_SCHEMA true)" == "true" ]]; then
    # prisma/migrations does not yet cover all of schema.prisma; db push fills the gap and refuses
    # anything that would drop data (the deploy stops instead).
    log "backend: prisma db push (non-destructive schema sync)"
    app_run "$BACKEND_DIR" ./node_modules/.bin/prisma db push --skip-generate
  fi
}
backend_seed() {
  if [[ $FORCE_SEED -eq 1 || ! -f "$SEED_MARKER" ]]; then
    log "backend: seeding the database (first run only; resets sample jobs + demo user)"
    app_run "$BACKEND_DIR" ./node_modules/.bin/tsx prisma/seed.ts
    date -u +%FT%TZ > "$SEED_MARKER"
  fi
}

link_frontend_public() {
  # PDF export loads fonts from <backend>/../frontend/public/fonts; point that at the frontend checkout.
  local link; link="$(dirname "$BACKEND_DIR")/frontend"
  if [[ ! -e "$link" && "$FRONTEND_DIR" != "$link" ]]; then
    as_app ln -s "$FRONTEND_DIR" "$link"
    log "linked $link -> $FRONTEND_DIR (fonts for PDF export)"
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

# ---------- 10. containers ----------
start_datastores() {
  local svc port
  for svc in postgres redis; do
    if ! container_running "$svc"; then
      if [[ $svc == postgres ]]; then port="$(env_or POSTGRES_PORT 5432)"; else port="$(env_or REDIS_PORT 6379)"; fi
      port_in_use "$port" && die "127.0.0.1:$port ($svc) is already used by another program; set ${svc^^}_PORT in deploy/.env"
    fi
  done
  log "starting postgres + redis (127.0.0.1 only)"
  compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT" postgres redis
}

start_frontend() { # start_frontend [build]
  if [[ "${1:-}" == "build" ]]; then
    local args=()
    [[ "$ACTION" == "deploy" ]] && args+=(--pull)
    [[ $NO_CACHE -eq 1 ]] && args+=(--no-cache)
    log "frontend: building image (about 3-5 min with a warm cache)"
    compose build "${args[@]}" frontend
  fi
  if ! container_running frontend && port_in_use "$(frontend_port)"; then
    die "127.0.0.1:$(frontend_port) is already used by another program; set FRONTEND_PORT in deploy/.env"
  fi
  # --remove-orphans also removes a backend container left from an all-Docker deploy.
  if ! compose up -d --wait --wait-timeout "$HEALTH_TIMEOUT" --remove-orphans frontend; then
    compose logs --tail 80 frontend || true
    die "frontend did not become healthy"
  fi
  log "frontend container healthy (127.0.0.1:$(frontend_port))"
}

# ---------- 11. checks + summary ----------
smoke_test() {
  local ok=1 domain host_hdr base bport; bport="$(backend_port)"
  curl -fsS -m 10 -o /dev/null "http://127.0.0.1:$bport/health" || { warn "backend 127.0.0.1:$bport not answering"; ok=0; }
  if ss -ltnH "( sport = :$bport )" 2>/dev/null | awk '{print $4}' | grep -Eqv '^(127\.0\.0\.1|\[::1\]):'; then
    warn "port $bport is listening on a non-loopback address"; ok=0
  fi
  curl -fsS -m 20 -o /dev/null "http://127.0.0.1:$(frontend_port)/robots.txt" || { warn "frontend 127.0.0.1:$(frontend_port) not answering"; ok=0; }
  domain="$(get_env DOMAIN)"
  if [[ "$(get_env APP_URL)" == https://* ]]; then base="https://$domain"; host_hdr="$domain"
  else base="http://127.0.0.1"; host_hdr="${domain:-localhost}"; fi
  # Through the host nginx (Host header picks our server block; with a certificate via the domain).
  curl -fsS -m 10 -o /dev/null -H "Host: $host_hdr" "$base/nginx-health" || { warn "nginx site not reached ($base, Host: $host_hdr)"; ok=0; }
  curl -fsS -m 20 -o /dev/null -H "Host: $host_hdr" "$base/rb-api/health" || { warn "API via nginx failed: $base/rb-api/health"; ok=0; }
  curl -fsS -m 30 -o /dev/null -H "Host: $host_hdr" "$base/" || { warn "frontend via nginx failed: $base/"; ok=0; }
  [[ $ok -eq 1 ]] && log "smoke test passed (backend service, frontend container, nginx)"
  return 0
}

print_summary() {
  local url; url="$(get_env APP_URL)"
  compose ps
  systemctl --no-pager --lines=0 status "$UNIT_NAME" 2>/dev/null | head -n 3 || true
  cat <<SUMMARY

${C_B}Resume Builder (staging) is up.${C_0}
  App:          $url/
  Login:        $url/login
  Admin login:  $url/admin/login   (ADMIN_EMAIL / ADMIN_PASSWORD are in $ENV_FILE)
  API health:   $url/rb-api/health
  Audio tool:   $url/tools/audio-noise-remover
  Backend:      systemd unit $UNIT_NAME, $BACKEND_DIR, 127.0.0.1:$(backend_port)
  nginx site:   $NGINX_AVAILABLE

  Update:  bash $DEPLOY_DIR/update.sh        (git pull both repos + rebuild only what changed)
  Logs:    bash $DEPLOY_DIR/deploy.sh --logs [backend|frontend|postgres|redis]   (nginx: /var/log/nginx/)
  Stop:    bash $DEPLOY_DIR/deploy.sh --down      (data volumes are kept)
SUMMARY
  [[ "$url" == http://* ]] && warn "site is on plain HTTP. For HTTPS: --domain <name> --email <you@example.com>"
  return 0
}

pull_sources() {
  local dir
  for dir in "$BACKEND_DIR" "$FRONTEND_DIR"; do
    if [[ -d "$dir/.git" ]]; then
      log "git pull --ff-only: $dir"
      as_app git -C "$dir" pull --ff-only --quiet || die "git pull failed in $dir (local changes or diverged branch?)"
    else
      warn "$dir is not a git checkout; not pulling"
    fi
  done
}

# ---------- full deploy ----------
full_deploy() {
  local t0=$SECONDS
  install_base
  ensure_swap
  install_docker
  configure_ufw
  prepare_env
  compose config --quiet || die "docker-compose.prod.yml / deploy/.env is invalid"
  start_datastores
  install_backend_host_deps
  link_frontend_public
  write_backend_env

  backend_npm_ci
  backend_generate
  backend_migrate
  backend_seed
  verify_admin_email
  backend_build
  install_unit
  if ! systemctl is-active --quiet "$UNIT_NAME" && port_in_use "$(backend_port)"; then
    die "127.0.0.1:$(backend_port) is already used by another program; set BACKEND_PORT in deploy/.env"
  fi
  restart_backend
  state_set backend "$(git_rev "$BACKEND_DIR")"

  start_frontend build
  state_set frontend "$(git_rev "$FRONTEND_DIR")"

  configure_host_nginx
  setup_tls
  smoke_test
  print_summary
  log "full deploy finished in $((SECONDS - t0))s"
}

# ---------- fast update (--pull) ----------
fast_update() {
  local t0=$SECONDS updated=()
  if [[ ! -f "$ENV_FILE" || ! -f "$BACKEND_ENV" ]] || ! run_root test -f "$UNIT_FILE"; then
    log "no previous full deploy found: pulling, then running the full deploy"
    pull_sources; full_deploy; return 0
  fi
  install_docker >/dev/null
  pull_sources

  # --- backend (host service) ---
  local b_old b_new changes need_restart=0
  b_old="$(state_get backend)"; b_new="$(git_rev "$BACKEND_DIR")"
  write_backend_env
  [[ $BACKEND_ENV_CHANGED -eq 1 ]] && { need_restart=1; updated+=("backend env (deploy/.env)"); }
  if [[ "$b_old" != "$b_new" || ! -f "$BACKEND_DIR/dist/index.js" ]]; then
    changes="$(changed_files "$BACKEND_DIR" "$b_old" "$b_new")"
    if touches "$changes" '^package(-lock)?\.json$' || [[ ! -d "$BACKEND_DIR/node_modules" ]]; then
      backend_npm_ci; backend_generate; updated+=("backend dependencies (npm ci)")
    elif touches "$changes" '^prisma/'; then
      backend_generate
    fi
    if touches "$changes" '^prisma/'; then
      backend_migrate; verify_admin_email; updated+=("database schema (migrate + db push)")
    fi
    if touches "$changes" '^deploy/docker-compose\.prod\.yml$'; then
      start_datastores; updated+=("postgres/redis containers")
    fi
    if touches "$changes" '^deploy/nginx/'; then
      configure_host_nginx; updated+=("nginx site")
    fi
    backend_build
    need_restart=1
    updated+=("backend code ${b_old:0:7}..${b_new:0:7}")
  fi
  install_unit
  if [[ $need_restart -eq 1 ]]; then restart_backend
  elif ! systemctl is-active --quiet "$UNIT_NAME"; then restart_backend; updated+=("backend service (was stopped)")
  else log "backend: up to date (${b_new:0:7})"; fi
  state_set backend "$b_new"

  # --- frontend (container) ---
  local f_old f_new
  f_old="$(state_get frontend)"; f_new="$(git_rev "$FRONTEND_DIR")"
  if [[ "$f_old" != "$f_new" ]] || ! "${DOCKER[@]}" image inspect "resume-builder-frontend:$(env_or IMAGE_TAG latest)" >/dev/null 2>&1; then
    start_frontend build
    updated+=("frontend ${f_old:0:7}..${f_new:0:7} (image rebuilt)")
  else
    if container_running frontend; then log "frontend: up to date (${f_new:0:7})"; else start_frontend; updated+=("frontend container (was stopped)"); fi
  fi
  state_set frontend "$f_new"

  echo
  if [[ ${#updated[@]} -eq 0 ]]; then log "nothing to update: both repos already deployed"
  else log "updated:"; printf '   - %s\n' "${updated[@]}"; fi
  log "update finished in $((SECONDS - t0))s"
}

# ---------- main ----------
main() {
  resolve_dirs
  case "$ACTION" in
    down)
      install_docker
      has_systemd && run_root systemctl stop "$UNIT_NAME" 2>/dev/null || true
      [[ -f "$ENV_FILE" ]] && compose down --remove-orphans
      log "backend service and containers stopped (data kept). The nginx site answers 502 until the next deploy."
      ;;
    logs)
      if [[ "$LOG_SERVICE" == "backend" ]]; then run_root journalctl -u "$UNIT_NAME" -f -n 200; return 0; fi
      install_docker >/dev/null
      [[ -f "$ENV_FILE" ]] || die "deploy/.env not found"
      if [[ -n "$LOG_SERVICE" ]]; then compose logs -f --tail 200 "$LOG_SERVICE"; else compose logs -f --tail 200; fi
      ;;
    restart)
      install_docker >/dev/null
      write_backend_env; install_unit; restart_backend; start_frontend
      ;;
    nginx)
      [[ -f "$ENV_FILE" ]] || die "deploy/.env not found; run a full deploy first"
      [[ -n "$DOMAIN_ARG" ]] && set_env DOMAIN "$DOMAIN_ARG"
      [[ -n "$EMAIL_ARG" ]] && set_env LETSENCRYPT_EMAIL "$EMAIL_ARG"
      configure_host_nginx
      setup_tls
      ;;
    update) fast_update ;;
    deploy) full_deploy ;;
  esac
}

main "$@"