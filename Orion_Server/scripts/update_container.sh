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
command -v git >/dev/null || fail "git is required but is not installed."
command -v node >/dev/null || fail "Node.js is required but is not installed."
[ -d "$APP_ROOT" ] || fail "$APP_ROOT does not exist. Use the LXC creator only for a brand-new install."
[ -f "$APP_DIR/package.json" ] || fail "Orion_Server/package.json was not found."

CURRENT_VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"

mkdir -p "$BACKUP_DIR"
info "Saving rollback information to $BACKUP_DIR"
[ -f "$APP_DIR/.env" ] && cp -a "$APP_DIR/.env" "$BACKUP_DIR/Orion_Server.env"
if [ -d "$APP_ROOT/.git" ]; then
  git -C "$APP_ROOT" status --short > "$BACKUP_DIR/git-status-before.txt" || true
  git -C "$APP_ROOT" diff --binary > "$BACKUP_DIR/local-edits.patch" || true
fi

# Build a complete replacement alongside the running install. This works for
# both Git installs and earlier ZIP installs that have no .git directory.
STAGE="/opt/orion-stage-$STAMP"
info "Downloading Orion 2.0 from GitHub"
git clone --depth=1 --branch main "$REPO" "$STAGE"
STAGE_APP="$STAGE/Orion_Server"
[ -f "$STAGE_APP/package.json" ] || fail "Downloaded source is missing Orion_Server/package.json."

if id orion &>/dev/null; then
  chown -R orion:orion "$STAGE"
  NPM_CACHE="$STAGE/.npm-cache"
  install -d -o orion -g orion "$NPM_CACHE"
  NPM=(runuser -u orion -- env "npm_config_cache=$NPM_CACHE" npm)
else
  NPM_CACHE="$STAGE/.npm-cache"
  mkdir -p "$NPM_CACHE"
  NPM=(env "npm_config_cache=$NPM_CACHE" npm)
fi

info "Installing matching dependencies"
cd "$STAGE_APP"
"${NPM[@]}" ci --ignore-scripts --include=dev
"${NPM[@]}" rebuild better-sqlite3

info "Building the Orion web interface"
"${NPM[@]}" run react-build

# Do the only short outage after download and build have completed successfully.
info "Switching Orion to the new build"
systemctl stop "$SERVICE"
mv "$APP_ROOT" "$BACKUP_DIR/orion-previous"
mv "$STAGE" "$APP_ROOT"
APP_DIR="$APP_ROOT/Orion_Server"

# .env is deployment-specific and is deliberately preserved across source updates.
[ -f "$BACKUP_DIR/Orion_Server.env" ] && cp -a "$BACKUP_DIR/Orion_Server.env" "$APP_DIR/.env"
if id orion &>/dev/null; then
  chown orion:orion "$APP_DIR/.env" 2>/dev/null || true
fi

systemctl daemon-reload
info "Starting Orion"
systemctl start "$SERVICE" || true
sleep 8
systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" -n 60 --no-pager
  info "Restoring the pre-update Orion source"
  systemctl stop "$SERVICE" || true
  mv "$APP_ROOT" "$BACKUP_DIR/orion-failed-new"
  mv "$BACKUP_DIR/orion-previous" "$APP_ROOT"
  systemctl start "$SERVICE" || true
  fail "The update was rolled back. Diagnostics and the failed new source are in $BACKUP_DIR."
}

NEW_VERSION="$(node -p "require('$APP_DIR/package.json').version" 2>/dev/null || echo unknown)"
HTTP="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 http://127.0.0.1:3001/ || true)"
ok "Orion updated: $CURRENT_VERSION → $NEW_VERSION"
ok "Service active; web interface HTTP $HTTP"
echo "Backup: $BACKUP_DIR"
