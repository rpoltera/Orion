#!/usr/bin/env bash
# =============================================================================
#  Orion Media Server — Proxmox LXC Creator
#  Run this on your Proxmox HOST (not inside a container)
#  Usage: bash create_lxc.sh
# =============================================================================

set -e
YW='\033[33m'; GN='\033[1;92m'; RD='\033[01;31m'; CL='\033[m'; BL='\033[36m'; CM='\033[0;92m'
function msg_info()  { echo -e "${CM}◆ ${CL}${1}${CL}"; }
function msg_ok()    { echo -e "${GN}✔ ${CL}${1}${CL}"; }
function msg_error() { echo -e "${RD}✘ ${CL}${1}${CL}"; exit 1; }
function header()    { echo -e "\n${BL}╔══════════════════════════════════════╗${CL}"; echo -e "${BL}║   🎬  Orion Media Server Installer   ║${CL}"; echo -e "${BL}╚══════════════════════════════════════╝${CL}\n"; }

header

# ── Verify running on Proxmox ─────────────────────────────────────────────────
if ! command -v pveversion &>/dev/null; then
  msg_error "This script must be run on a Proxmox VE host."
fi

# ── Pick next available CTID ──────────────────────────────────────────────────
CTID=$(pvesh get /cluster/nextid)
msg_ok "Using container ID: ${CTID}"

# ── Storage selection ─────────────────────────────────────────────────────────
echo -e "\n${YW}Available storage pools:${CL}"
mapfile -t STORAGE_LIST < <(pvesm status | awk 'NR>1 {print $1}')
for i in "${!STORAGE_LIST[@]}"; do
  echo "  $((i+1)). ${STORAGE_LIST[$i]}"
done
echo ""
read -rp "Enter storage name or number [default: ${STORAGE_LIST[0]}]: " STORAGE_INPUT
if [[ "$STORAGE_INPUT" =~ ^[0-9]+$ ]]; then
  STORAGE="${STORAGE_LIST[$((STORAGE_INPUT-1))]}"
elif [ -z "$STORAGE_INPUT" ]; then
  STORAGE="${STORAGE_LIST[0]}"
else
  STORAGE="$STORAGE_INPUT"
fi
msg_ok "Using storage: ${STORAGE}" 

# ── Container resources ───────────────────────────────────────────────────────
read -rp "RAM in MB [default: 4096]: " RAM;     RAM=${RAM:-4096}
read -rp "CPU cores  [default: 4]:   " CORES;   CORES=${CORES:-4}
read -rp "Disk size  [default: 20]:  " DISK;    DISK=${DISK:-20}

# ── Network ───────────────────────────────────────────────────────────────────
echo -e "\n${YW}Network configuration:${CL}"
read -rp "Network bridge [default: vmbr0]: " BRIDGE; BRIDGE=${BRIDGE:-vmbr0}

echo -e "\n${YW}IP Configuration:${CL}"
echo "  1) DHCP (automatic)"
echo "  2) Static IP"
read -rp "Choose [1/2, default: 1]: " NET_CHOICE
NET_CHOICE=${NET_CHOICE:-1}

if [[ "$NET_CHOICE" == "2" ]]; then
  read -rp "  IP address (e.g. 192.168.0.50/24): " STATIC_IP
  read -rp "  Gateway   (e.g. 192.168.0.1):      " GATEWAY
  NETCONFIG="ip=${STATIC_IP},gw=${GATEWAY}"
else
  NETCONFIG="ip=dhcp"
fi

# ── NAS / CIFS mounts ─────────────────────────────────────────────────────────
echo -e "\n${YW}NAS Configuration (Samba/CIFS):${CL}"
read -rp "NAS hostname or IP (e.g. 192.168.0.245): " NAS_HOST
read -rp "NAS username [default: guest]:             " NAS_USER; NAS_USER=${NAS_USER:-guest}
read -rsp "NAS password [leave blank for none]:      " NAS_PASS; echo ""

echo -e "\n${YW}NAS Shares to mount — press Enter with blank name when done:${CL}"
echo -e "  e.g. share name: media  →  mount path: /mnt/media"
echo -e "  e.g. share name: jbod1  →  mount path: /mnt/jbod1"
declare -a SHARE_NAMES=()
declare -a SHARE_PATHS=()
i=1
while true; do
  read -rp "  Share $i name on NAS [blank to finish]: " SNAME
  [ -z "$SNAME" ] && break
  read -rp "  Mount path inside LXC [default: /mnt/${SNAME}]: " SPATH
  SPATH=${SPATH:-/mnt/${SNAME}}
  SHARE_NAMES+=("$SNAME")
  SHARE_PATHS+=("$SPATH")
  ((i++))
done
[ ${#SHARE_NAMES[@]} -eq 0 ] && echo -e "${YW}No shares — add manually later via /etc/fstab${CL}"

# ── Hostname ──────────────────────────────────────────────────────────────────
read -rp "Container hostname [default: orion]: " HOSTNAME; HOSTNAME=${HOSTNAME:-orion}

# ── Download Ubuntu 22.04 template if needed ─────────────────────────────────
msg_info "Checking for Ubuntu 22.04 template..."
TEMPLATE="local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst"
if ! pveam list local | grep -q "ubuntu-22.04"; then
  msg_info "Downloading Ubuntu 22.04 template..."
  pveam update
  pveam download local ubuntu-22.04-standard_22.04-1_amd64.tar.zst
fi
msg_ok "Template ready"

# ── Create the container ──────────────────────────────────────────────────────
msg_info "Creating LXC container ${CTID}..."
pct create ${CTID} ${TEMPLATE} \
  --hostname ${HOSTNAME} \
  --cores ${CORES} \
  --memory ${RAM} \
  --net0 name=eth0,bridge=${BRIDGE},${NETCONFIG} \
  --rootfs ${STORAGE}:${DISK} \
  --unprivileged 0 \
  --features nesting=1 \
  --ostype ubuntu \
  --start 1 \
  --onboot 1
msg_ok "Container ${CTID} created and started"

# ── Wait for container to be ready ───────────────────────────────────────────
msg_info "Waiting for container to boot..."
sleep 5
for i in {1..30}; do
  if pct exec ${CTID} -- test -f /etc/os-release 2>/dev/null; then break; fi
  sleep 2
done
msg_ok "Container is ready"

# ── Add CIFS kernel module support ────────────────────────────────────────────
pct set ${CTID} --features nesting=1,keyctl=1
msg_ok "Keyctl feature enabled for CIFS"

# ── Install CIFS utils in container ──────────────────────────────────────────
msg_info "Installing base packages..."
pct exec ${CTID} -- bash -c "apt-get update -qq && apt-get install -y -qq cifs-utils curl wget git build-essential"
msg_ok "Base packages installed"

# ── Set up CIFS mounts ────────────────────────────────────────────────────────
msg_info "Configuring NAS mounts..."
for ((i=0; i<${#SHARE_NAMES[@]}; i++)); do
  SNAME="${SHARE_NAMES[$i]}"
  SPATH="${SHARE_PATHS[$i]}"
  pct exec ${CTID} -- mkdir -p "${SPATH}"
  CREDS_FILE="/etc/cifs-${SNAME}.cred"
  pct exec ${CTID} -- bash -c "echo 'username=${NAS_USER}' > ${CREDS_FILE}; echo 'password=${NAS_PASS}' >> ${CREDS_FILE}; chmod 600 ${CREDS_FILE}"
  FSTAB_LINE="//${NAS_HOST}/${SNAME}  ${SPATH}  cifs  credentials=${CREDS_FILE},iocharset=utf8,file_mode=0755,dir_mode=0755,noperm,_netdev  0  0"
  pct exec ${CTID} -- bash -c "echo '${FSTAB_LINE}' >> /etc/fstab"
  pct exec ${CTID} -- bash -c "mount ${SPATH} 2>/dev/null || true"
  msg_ok "Mounted //${NAS_HOST}/${SNAME} → ${SPATH}"
done

# ── Save config for install script ───────────────────────────────────────────
pct exec ${CTID} -- bash -c "cat > /root/orion-config.env << 'ENVEOF'
NAS_HOST=${NAS_HOST}
NAS_USER=${NAS_USER}
ENVEOF"

# ── Run the Orion install script inside the container ────────────────────────
msg_info "Running Orion installer inside container..."
pct exec ${CTID} -- bash -c "curl -fsSL https://raw.githubusercontent.com/rpoltera/Orion/main/Orion_Server/scripts/install_container.sh | bash"

# ── Done ──────────────────────────────────────────────────────────────────────
CONTAINER_IP=$(pct exec ${CTID} -- hostname -I | awk '{print $1}')
echo ""
echo -e "${GN}╔══════════════════════════════════════════════╗${CL}"
echo -e "${GN}║   ✅  Orion installed successfully!          ║${CL}"
echo -e "${GN}╠══════════════════════════════════════════════╣${CL}"
echo -e "${GN}║   Web UI:  http://${CONTAINER_IP}:3001          ${CL}"
echo -e "${GN}║   CTID:    ${CTID}                              ${CL}"
echo -e "${GN}╚══════════════════════════════════════════════╝${CL}"
echo ""
echo -e "${YW}To manage: pct enter ${CTID}${CL}"
echo -e "${YW}Logs:      pct exec ${CTID} -- journalctl -u orion -f${CL}"
