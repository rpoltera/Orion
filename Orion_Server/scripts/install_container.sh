#!/usr/bin/env bash
# =============================================================================
#  Orion Media Server — Container Install Script
#  Runs INSIDE the LXC container
#  Pulls from: https://github.com/rpoltera/Orion
# =============================================================================

set -e
YW='\033[33m'; GN='\033[1;92m'; RD='\033[01;31m'; CL='\033[m'; CM='\033[0;92m'
function msg_info()  { echo -e "${CM}◆ ${CL}${1}${CL}"; }
function msg_ok()    { echo -e "${GN}✔ ${CL}${1}${CL}"; }
function msg_error() { echo -e "${RD}✘ ${CL}${1}${CL}"; exit 1; }

ORION_DIR="/opt/orion"
ORION_DATA="/var/lib/orion"
ORION_USER="orion"
NODE_VERSION="20"

msg_info "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq
msg_ok "System updated"

msg_info "Installing system dependencies..."
apt-get install -y -qq \
  curl wget git build-essential \
  ffmpeg cifs-utils \
  ca-certificates gnupg \
  python3 sqlite3 unzip
msg_ok "Dependencies installed"

msg_info "Installing Node.js ${NODE_VERSION}..."
curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs
msg_ok "Node.js $(node -v) installed"

msg_info "Installing yt-dlp..."
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
msg_ok "yt-dlp installed"

msg_info "Creating orion user..."
if ! id "$ORION_USER" &>/dev/null; then
  useradd -r -s /bin/bash -d "$ORION_DIR" -m "$ORION_USER"
fi
msg_ok "User ready"

msg_info "Cloning Orion from GitHub..."
if [ -d "$ORION_DIR/.git" ]; then
  cd "$ORION_DIR" && sudo -u "$ORION_USER" git pull --quiet
else
  rm -rf "$ORION_DIR"
  git clone --depth=1 https://github.com/rpoltera/Orion.git "$ORION_DIR"
  chown -R "$ORION_USER:$ORION_USER" "$ORION_DIR"
fi
msg_ok "Repository ready"

msg_info "Creating data directory..."
mkdir -p "$ORION_DATA"
chown -R "$ORION_USER:$ORION_USER" "$ORION_DATA"
msg_ok "Data dir: ${ORION_DATA}"

msg_info "Installing npm dependencies (skipping Electron)..."
cd "$ORION_DIR"
sudo -u "$ORION_USER" npm install --ignore-scripts --omit=optional --quiet 2>&1 | tail -2

msg_info "Rebuilding better-sqlite3 for Linux..."
sudo -u "$ORION_USER" npm rebuild better-sqlite3 2>&1 | tail -2
msg_ok "better-sqlite3 ready"

msg_info "Writing .env..."
cat > "$ORION_DIR/.env" << 'ENVEOF'
PORT=3000
BROWSER=none
SKIP_PREFLIGHT_CHECK=true
FAST_REFRESH=false
INLINE=false
GENERATE_SOURCEMAP=false
ENVEOF
chown "$ORION_USER:$ORION_USER" "$ORION_DIR/.env"
msg_ok ".env written"

msg_info "Building React frontend (2-3 min)..."
cd "$ORION_DIR"
# React build — source is in root, server is in Orion_Server/
sudo -u "$ORION_USER" npm run react-build 2>&1 | tail -5
[ -f "$ORION_DIR/build/index.html" ] || msg_error "React build failed"
msg_ok "React built"

msg_info "Configuring data directory..."
if [ -f "$ORION_DIR/Orion_Server/config.js" ]; then
  sed -i "s|const DATA_DIR = path.join(process.env.APPDATA.*);|const DATA_DIR = process.env.ORION_DATA_DIR \|\| path.join(process.env.HOME \|\| __dirname, 'orion-data');|g" \
    "$ORION_DIR/Orion_Server/config.js" 2>/dev/null || true
fi
cat > /etc/default/orion << ENVEOF
ORION_DATA_DIR=${ORION_DATA}
NODE_ENV=production
ENVEOF
msg_ok "Data path configured"

if [ ! -f "$ORION_DATA/config.json" ]; then
  cat > "$ORION_DATA/config.json" << 'CFGEOF'
{
  "port": 3001,
  "moviePaths": [],
  "tvPaths": [],
  "musicPaths": [],
  "musicVideoPaths": [],
  "tmdbApiKey": "",
  "youtubeApiKey": "",
  "autocollections": {}
}
CFGEOF
  chown "$ORION_USER:$ORION_USER" "$ORION_DATA/config.json"
  msg_ok "Default config.json created"
fi

msg_info "Creating systemd service..."
cat > /etc/systemd/system/orion.service << SERVICEEOF
[Unit]
Description=Orion Media Server
Documentation=https://github.com/rpoltera/Orion
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
Type=simple
User=${ORION_USER}
WorkingDirectory=${ORION_DIR}
EnvironmentFile=/etc/default/orion
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/node Orion_Server/index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=orion
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload
systemctl enable orion
systemctl start orion
sleep 3
systemctl is-active --quiet orion && msg_ok "Orion service started" || msg_error "Service failed — check: journalctl -u orion -n 50"

cat > /usr/local/bin/orion-update << 'UPDATEEOF'
#!/bin/bash
set -e
echo "Stopping Orion..."
systemctl stop orion
cd /tmp
rm -rf orion-repo
git clone --depth=1 https://github.com/rpoltera/Orion.git orion-repo
if [ -d orion-repo/Orion_Server ]; then
  rsync -a --exclude=node_modules --exclude=build orion-repo/Orion_Server/ /opt/orion/
  for f in package.json package-lock.json .env src public; do
    [ -e "orion-repo/$f" ] && cp -r "orion-repo/$f" /opt/orion/
  done
else
  rsync -a --exclude=node_modules --exclude=build orion-repo/ /opt/orion/
fi
rm -rf /tmp/orion-repo
chown -R orion:orion /opt/orion
echo "Installing dependencies..."
sudo -u orion npm install --ignore-scripts --quiet
sudo -u orion npm rebuild better-sqlite3 --quiet
echo "Building frontend..."
sudo -u orion npm run react-build
echo "Starting Orion..."
echo "Starting Orion..."
systemctl start orion
echo "Done."
UPDATEEOF
chmod +x /usr/local/bin/orion-update
msg_ok "orion-update command installed"

IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "${GN}╔══════════════════════════════════════════════════════╗${CL}"
echo -e "${GN}║   ✅  Orion installed successfully!                   ║${CL}"
echo -e "${GN}╠══════════════════════════════════════════════════════╣${CL}"
echo -e "${GN}║   Web UI:   http://${IP}:3001                     ║${CL}"
echo -e "${GN}║   Data:     ${ORION_DATA}                       ║${CL}"
echo -e "${GN}║   Logs:     journalctl -u orion -f                   ║${CL}"
echo -e "${GN}║   Update:   orion-update                             ║${CL}"
echo -e "${GN}╚══════════════════════════════════════════════════════╝${CL}"
echo ""
echo -e "${YW}Next steps:${CL}"
echo "  1. Open http://${IP}:3001 in your browser"
echo "  2. Settings → Library → add your NAS mount paths"
echo "  3. Run a library scan"
