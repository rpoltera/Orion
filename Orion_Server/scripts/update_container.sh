#!/usr/bin/env bash
# Orion Media Server — in-container updater
# Run inside an existing Orion LXC as root.  It never creates or changes an LXC.

set -Eeuo pipefail

APP_ROOT="/opt/orion"
APP_DIR="$APP_ROOT/Orion_Server"
SERVICE="orion"
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="/opt/orion-backups/update-$STAMP"
REPO="https://github.com/rpoltera/Orion.git"

YW='\033[33m'; GN='\033[1;92m'; RD='\033[01;31m'; CL='\033[m'; CM='\033[0;92m'
info() { echo -e "${CM}◆ ${CL}$*"; }
ok()   { echo -e "${GN}✔ ${CL}$*"; }
fail() { echo -e "${RD}✘ ${CL}$*" >&2; exit 1; }

[ "${EUID}" -eq 0 ] || fail "Run this inside the Orion LXC as root."
[ -d "$APP_ROOT/.git" ] || fail "$APP_ROOT is not a Git checkout. This updater will not overwrite it."
[ -f "$APP_DIR/package.json" ] || fail "Orion_Server/package.json was not found."

CURRENT_VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"

mkdir -p "$BACKUP_DIR"
info "Saving rollback information to $BACKUP_DIR"
[ -f "$APP_DIR/.env" ] && cp -a "$APP_DIR/.env" "$BACKUP_DIR/Orion_Server.env"
git -C "$APP_ROOT" status --short > "$BACKUP_DIR/git-status-before.txt" || true
git -C "$APP_ROOT" diff --binary > "$BACKUP_DIR/local-edits.patch" || true

info "Stopping Orion"
systemctl stop "$SERVICE"

info "Fetching Orion 2.0 from GitHub"
git -C "$APP_ROOT" remote set-url origin "$REPO"
git -C "$APP_ROOT" fetch --depth=1 origin main
git -C "$APP_ROOT" reset --hard origin/main

# .env is deployment-specific and is deliberately preserved across source updates.
[ -f "$BACKUP_DIR/Orion_Server.env" ] && cp -a "$BACKUP_DIR/Orion_Server.env" "$APP_DIR/.env"

if id orion &>/dev/null; then
  chown -R orion:orion "$APP_ROOT"
  RUN_AS=(runuser -u orion --)
else
  RUN_AS=()
fi

info "Installing matching dependencies"
cd "$APP_DIR"
"${RUN_AS[@]}" npm ci --ignore-scripts --include=dev
"${RUN_AS[@]}" npm rebuild better-sqlite3

info "Building the Orion web interface"
"${RUN_AS[@]}" npm run react-build

systemctl daemon-reload
info "Starting Orion"
systemctl start "$SERVICE"
sleep 8
systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" -n 60 --no-pager
  fail "Orion did not start. Your pre-update files are in $BACKUP_DIR."
}

NEW_VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"
HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3001/ || true)"
ok "Orion updated: $CURRENT_VERSION → $NEW_VERSION"
ok "Service active; web interface HTTP $HTTP"
echo "Backup: $BACKUP_DIR"
