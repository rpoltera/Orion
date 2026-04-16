#!/usr/bin/env bash
# Orion Media Server — Container Install Script
set -e
YW='\033[33m'; GN='\033[1;92m'; RD='\033[01;31m'; CL='\033[m'; CM='\033[0;92m'
function msg_info()  { echo -e "${CM}◆ ${CL}${1}${CL}"; }
function msg_ok()    { echo -e "${GN}✔ ${CL}${1}${CL}"; }
function msg_error() { echo -e "${RD}✘ ${CL}${1}${CL}"; exit 1; }

# All files live in Orion_Server/ inside the repo
REPO_DIR="/opt/orion"
ORION_DIR="/opt/orion/Orion_Server"
ORION_DATA="/var/lib/orion"

msg_info "Updating system packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get upgrade -y -qq
msg_ok "System updated"

msg_info "Installing system dependencies..."
apt-get install -y -qq curl wget git build-essential ffmpeg cifs-utils ca-certificates gnupg python3 sqlite3 unzip
msg_ok "Dependencies installed"

msg_info "Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
apt-get install -y -qq nodejs
msg_ok "Node.js $(node -v) installed"

msg_info "Installing yt-dlp..."
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
msg_ok "yt-dlp installed"

msg_info "Creating orion user..."
id orion &>/dev/null || useradd -r -s /bin/bash -m -d /opt/orion orion
msg_ok "User ready"

msg_info "Cloning Orion from GitHub..."
rm -rf "$REPO_DIR"
git clone --depth=1 https://github.com/rpoltera/Orion.git "$REPO_DIR"
git config --global --add safe.directory "$REPO_DIR"
chown -R orion:orion "$REPO_DIR"
msg_ok "Repository cloned to $REPO_DIR"

# Verify structure
[ -d "$ORION_DIR" ] || msg_error "Orion_Server folder not found in repo"
[ -f "$ORION_DIR/package.json" ] || msg_error "package.json not found in Orion_Server/"
msg_ok "Repo structure verified"

msg_info "Creating fresh data directory..."
rm -rf "$ORION_DATA"
mkdir -p "$ORION_DATA"
chown -R orion:orion "$ORION_DATA"
msg_ok "Data dir: ${ORION_DATA}"

msg_info "Installing npm dependencies..."
cd "$ORION_DIR"
sudo -u orion npm install --ignore-scripts --omit=optional --quiet 2>&1 | tail -3
msg_ok "npm install done"

msg_info "Rebuilding better-sqlite3 for Linux..."
cd "$ORION_DIR"
sudo -u orion npm rebuild better-sqlite3 2>&1 | tail -2
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
chown orion:orion "$ORION_DIR/.env"
msg_ok ".env written"

msg_info "Fixing any hardcoded localhost references..."
python3 << 'PYEOF'
import os, re
def fix(content):
    content = re.sub(
        r"(const\s+(?:API|BASE|API_BASE)\s*=\s*)'http://localhost:3001(/api)?'",
        lambda m: f"{m.group(1)}(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001{m.group(2) or ''}' : `http://${{window.location.hostname}}:3001{m.group(2) or ''}`",
        content
    )
    content = re.sub(
        r'(const\s+(?:API|BASE|API_BASE)\s*=\s*)"http://localhost:3001(/api)?"',
        lambda m: f"{m.group(1)}(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') ? 'http://localhost:3001{m.group(2) or ''}' : `http://${{window.location.hostname}}:3001{m.group(2) or ''}`",
        content
    )
    content = content.replace('`http://localhost:3001', '`http://${window.location.hostname}:3001')
    content = re.sub(r"'http://localhost:3001([^']*)'", lambda m: f"`http://${{window.location.hostname}}:3001{m.group(1)}`", content)
    content = re.sub(r'"http://localhost:3001([^"]*)"', lambda m: f"`http://${{window.location.hostname}}:3001{m.group(1)}`", content)
    return content
src = '/opt/orion/Orion_Server/src'
for root, dirs, files in os.walk(src):
    for f in files:
        if not (f.endswith('.jsx') or f.endswith('.js')): continue
        path = os.path.join(root, f)
        orig = open(path).read()
        if 'localhost:3001' not in orig: continue
        fixed = fix(orig)
        open(path, 'w').write(fixed)
        print(f'Fixed: {path}')
PYEOF
msg_ok "Localhost references fixed"

msg_info "Building React frontend (2-3 min)..."
cd "$ORION_DIR"
sudo -u orion npm run react-build 2>&1 | tail -5
[ -f "$ORION_DIR/build/index.html" ] || msg_error "React build failed"
msg_ok "React built"

msg_info "Patching config.js for Linux data path..."
CONFIG="$ORION_DIR/server/config.js"
[ -f "$CONFIG" ] && sed -i \
  "s|const DATA_DIR = path.join(process.env.APPDATA.*);|const DATA_DIR = process.env.ORION_DATA_DIR || path.join(process.env.HOME || __dirname, 'orion-data');|g" \
  "$CONFIG" 2>/dev/null || true
msg_ok "config.js patched"

cat > /etc/default/orion << ENVEOF
APPDATA=${ORION_DATA}
ORION_DATA_DIR=${ORION_DATA}
NODE_ENV=production
ENVEOF

[ -f "$ORION_DATA/config.json" ] || cat > "$ORION_DATA/config.json" << 'CFGEOF'
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
chown orion:orion "$ORION_DATA/config.json" 2>/dev/null || true
msg_ok "Config ready"


msg_info "Creating systemd service..."
cat > /etc/systemd/system/orion.service << SERVICEEOF
[Unit]
Description=Orion Media Server
After=network-online.target remote-fs.target
Wants=network-online.target

[Service]
Type=simple
User=orion
WorkingDirectory=${ORION_DIR}
EnvironmentFile=/etc/default/orion
ExecStartPre=/bin/sleep 5
ExecStart=/usr/bin/node server/index.js
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
sleep 8

systemctl is-active --quiet orion && msg_ok "Orion service started" || {
  echo "Service failed. Logs:"
  journalctl -u orion -n 20 --no-pager
}

msg_info "Seeding scheduled tasks..."
python3 << 'PYEOF'
import json, subprocess, uuid
tasks = [
    {"id": str(uuid.uuid4()), "name": "Scan Libraries", "description": "Scan all library folders for new or removed media", "icon": "📁", "type": "scan", "schedule": "daily", "scheduleTime": "02:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Refresh Metadata", "description": "Re-fetch metadata for items missing posters/info", "icon": "🎭", "type": "metadata", "schedule": "daily", "scheduleTime": "03:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Build Collections", "description": "Rebuild auto genre, decade and franchise collections", "icon": "📁", "type": "collections", "schedule": "daily", "scheduleTime": "04:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Database Backup", "description": "Backup the library database to a .bak file", "icon": "💾", "type": "backup", "schedule": "weekly", "scheduleTime": "01:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Database Optimize", "description": "Remove orphaned entries and compact the database", "icon": "🔧", "type": "optimize", "schedule": "weekly", "scheduleTime": "01:30", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Clear Debug Log", "description": "Automatically clear the debug log", "icon": "🗑", "type": "clearlog", "schedule": "daily", "scheduleTime": "06:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Check for Updates", "description": "Check if a new version of Orion is available", "icon": "🔄", "type": "checkupdate", "schedule": "daily", "scheduleTime": "07:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Download Trailers", "description": "Download and cache trailers for all movies from TMDB/YouTube", "icon": "🎬", "type": "trailers", "schedule": "weekly", "scheduleTime": "02:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Download TV Trailers", "description": "Download and cache trailers for all TV shows from TMDB/YouTube", "icon": "📺", "type": "tv-trailers", "schedule": "weekly", "scheduleTime": "03:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Generate Missing Thumbnails", "description": "Auto-generate video screenshots for items with no poster art", "icon": "🖼", "type": "thumbnails", "schedule": "daily", "scheduleTime": "05:00", "enabled": True, "lastRun": None},
    {"id": str(uuid.uuid4()), "name": "Fetch Music Video Metadata", "description": "Fetch album art and artist info for music videos via iTunes/Last.fm", "icon": "🎵", "type": "musicvideo-meta", "schedule": "daily", "scheduleTime": "04:00", "enabled": True, "lastRun": None},
]
val = json.dumps(tasks).replace("'", "''")
subprocess.run(["sqlite3", "/var/lib/orion/orion.db", f"INSERT OR REPLACE INTO kv_arrays (key, value) VALUES ('scheduledTasks', '{val}');"])
print("Scheduled tasks seeded")
PYEOF
msg_ok "Scheduled tasks seeded" 

cat > /usr/local/bin/orion-update << 'UPDATEEOF'
#!/bin/bash
set -e
git config --global --add safe.directory /opt/orion
# Flush database before stopping
curl -s -X POST http://localhost:3001/api/db/flush --max-time 5 > /dev/null 2>&1 || true
sleep 2
systemctl stop orion
cd /opt/orion
git pull
cd /opt/orion/Orion_Server
npm install --ignore-scripts --quiet
npm rebuild better-sqlite3 --quiet
npm run react-build
systemctl start orion
sleep 8
# Seed scheduled tasks via API if missing
TASKS=$(curl -s http://localhost:3001/api/scheduler | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('tasks',[])))" 2>/dev/null || echo "0")
if [ "$TASKS" = "0" ]; then
  echo "Seeding scheduled tasks..."
  curl -s --max-time 30 -X POST http://localhost:3001/api/scheduler \
    -H "Content-Type: application/json" \
    -d '[{"name":"Scan Libraries","description":"Scan all library folders for new or removed media","icon":"📁","type":"scan","schedule":"daily","scheduleTime":"02:00","enabled":true},{"name":"Refresh Metadata","description":"Re-fetch metadata for items missing posters/info","icon":"🎭","type":"metadata","schedule":"daily","scheduleTime":"03:00","enabled":true},{"name":"Build Collections","description":"Rebuild auto genre, decade and franchise collections","icon":"📁","type":"collections","schedule":"daily","scheduleTime":"04:00","enabled":true},{"name":"Database Backup","description":"Backup the library database to a .bak file","icon":"💾","type":"backup","schedule":"weekly","scheduleTime":"01:00","enabled":true},{"name":"Database Optimize","description":"Remove orphaned entries and compact the database","icon":"🔧","type":"optimize","schedule":"weekly","scheduleTime":"01:30","enabled":true},{"name":"Clear Debug Log","description":"Automatically clear the debug log","icon":"🗑","type":"clearlog","schedule":"daily","scheduleTime":"06:00","enabled":true},{"name":"Check for Updates","description":"Check if a new version of Orion is available","icon":"🔄","type":"checkupdate","schedule":"daily","scheduleTime":"07:00","enabled":true},{"name":"Download Trailers","description":"Download and cache trailers for all movies from TMDB/YouTube","icon":"🎬","type":"trailers","schedule":"weekly","scheduleTime":"02:00","enabled":true},{"name":"Download TV Trailers","description":"Download and cache trailers for all TV shows from TMDB/YouTube","icon":"📺","type":"tv-trailers","schedule":"weekly","scheduleTime":"03:00","enabled":true},{"name":"Generate Missing Thumbnails","description":"Auto-generate video screenshots for items with no poster art","icon":"🖼","type":"thumbnails","schedule":"daily","scheduleTime":"05:00","enabled":true},{"name":"Fetch Music Video Metadata","description":"Fetch album art and artist info for music videos via iTunes/Last.fm","icon":"🎵","type":"musicvideo-meta","schedule":"daily","scheduleTime":"04:00","enabled":true}]' > /dev/null
  echo "Scheduled tasks seeded."
else
  echo "Scheduled tasks OK ($TASKS tasks)."
fi
echo "Orion updated and restarted."
UPDATEEOF
chmod +x /usr/local/bin/orion-update

# Quick update — server only, no React rebuild (much faster)
cat > /usr/local/bin/orion-update-server << 'UPDATEEOF'
#!/bin/bash
set -e
git config --global --add safe.directory /opt/orion
systemctl stop orion
cd /opt/orion
git pull
cd /opt/orion/Orion_Server
npm install --ignore-scripts --quiet
npm rebuild better-sqlite3 --quiet
systemctl start orion
echo "Server updated and restarted (no React rebuild)."
UPDATEEOF
chmod +x /usr/local/bin/orion-update-server

IP=$(hostname -I | awk '{print $1}')
echo ""
echo -e "\033[1;92m╔══════════════════════════════════════════╗\033[m"
echo -e "\033[1;92m║  ✅  Orion installed!                     ║\033[m"
echo -e "\033[1;92m║  Web UI:  http://${IP}:3001           ║\033[m"
echo -e "\033[1;92m║  Logs:    journalctl -u orion -f         ║\033[m"
echo -e "\033[1;92m║  Update:  orion-update                   ║\033[m"
echo -e "\033[1;92m╚══════════════════════════════════════════╝\033[m"
