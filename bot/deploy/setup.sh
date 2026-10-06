#!/usr/bin/env bash
# Provision (or update) an Ubuntu server for the SEPTA Transit Alerts bots.
#
#   curl -fsSL https://raw.githubusercontent.com/garlicbuffalo/septa-transit-alerts/main/bot/deploy/setup.sh | sudo bash
#
# Installs Node.js, ffmpeg, SQLite, and fonts; clones the repository to
# /opt/septa-transit-alerts; creates the `septa-bots` system user with its
# state in /var/lib/septa-bots; installs the systemd service, the
# /etc/septa-bots.env settings file (first run only), and the `septa-bots`
# operator command; then starts the service. Safe to re-run: it pulls the
# latest code, refreshes dependencies, and restarts.
#
# The service starts in dry-run mode — it collects data and writes would-be
# posts to /var/lib/septa-bots/assets, but posts and publishes nothing until
# /etc/septa-bots.env says so. See bot/README.md.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/garlicbuffalo/septa-transit-alerts.git}"
BRANCH="${BRANCH:-main}"
APP_DIR=/opt/septa-transit-alerts
STATE_DIR=/var/lib/septa-bots
ENV_FILE=/etc/septa-bots.env
NODE_MAJOR=24

if [[ $EUID -ne 0 ]]; then
  echo "Run as root: sudo bash $0" >&2
  exit 1
fi

echo "==> System packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q ca-certificates curl git ffmpeg sqlite3 fontconfig fonts-inter unattended-upgrades

if ! command -v node >/dev/null || (( $(node -p 'process.versions.node.split(".")[0]') < NODE_MAJOR )); then
  echo "==> Node.js ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y -q nodejs
fi

echo "==> Service user and state directory"
if ! id septa-bots >/dev/null 2>&1; then
  useradd --system --home-dir "$STATE_DIR" --shell /usr/sbin/nologin septa-bots
fi
install -d -o septa-bots -g septa-bots -m 750 "$STATE_DIR"

echo "==> Code (${BRANCH})"
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" fetch -q origin "$BRANCH"
  git -C "$APP_DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
npm ci --prefix "$APP_DIR/bot" --omit=dev --no-audit --no-fund

echo "==> Configuration"
if [[ ! -f "$ENV_FILE" ]]; then
  install -m 600 -o root -g root "$APP_DIR/bot/deploy/septa-bots.env.example" "$ENV_FILE"
  CREATED_ENV=1
fi
install -m 644 "$APP_DIR/bot/deploy/septa-bots.service" /etc/systemd/system/septa-bots.service
install -m 755 "$APP_DIR/bot/deploy/septa-bots" /usr/local/bin/septa-bots

echo "==> Service"
systemctl daemon-reload
systemctl enable -q septa-bots
systemctl restart septa-bots
sleep 3
systemctl --no-pager --lines=5 status septa-bots || true

cat <<EOF

Done. The bots are running in dry-run mode.

Next:
  1. Fill in ${ENV_FILE} (Bluesky app passwords, Mapbox token, GitHub token):
       sudo nano ${ENV_FILE}
  2. Check every credential:            sudo septa-bots check
  3. Apply settings:                    sudo systemctl restart septa-bots
  4. Watch it work:                     sudo septa-bots logs
  5. Review would-be posts in ${STATE_DIR}/assets, then set BOT_MODE=live
     and PUBLISH=1 in ${ENV_FILE} and restart.
EOF
if [[ "${CREATED_ENV:-}" == 1 ]]; then
  echo
  echo "(${ENV_FILE} was just created from the template.)"
fi
