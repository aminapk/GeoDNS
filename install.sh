#!/bin/bash
set -e

echo "=== CoreDNS GeoIP + Admin Panel Deployment ==="

if [[ $EUID -ne 0 ]]; then
  echo "Please run this script as root."
  exit 1
fi

read -rp "Enter admin panel domain for HTTPS (optional, leave blank for IP-only): " ADMIN_WEB_DOMAIN
read -rp "Default nameserver 1 (e.g. ns1.example.com): " DEFAULT_NS1
read -rp "Default nameserver 2 (e.g. ns2.example.com): " DEFAULT_NS2

if [[ -z "$DEFAULT_NS1" ]]; then
  DEFAULT_NS1="ns1.example.com"
fi
if [[ -z "$DEFAULT_NS2" ]]; then
  DEFAULT_NS2="ns2.example.com"
fi

if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
  echo "Admin panel domain: $ADMIN_WEB_DOMAIN"
else
  echo "Admin panel will be exposed by IP on port 3000"
fi
echo "Default NS1: $DEFAULT_NS1"
echo "Default NS2: $DEFAULT_NS2"

echo "Updating system packages..."
apt update && apt upgrade -y

echo "Installing dependencies..."
apt install -y wget curl unzip dnsutils bind9-dnsutils bind9-utils libcap2-bin nodejs npm openssl

echo "Downloading CoreDNS..."
cd /tmp
wget -q https://github.com/coredns/coredns/releases/download/v1.14.1/coredns_1.14.1_linux_amd64.tgz
tar -xzf coredns_1.14.1_linux_amd64.tgz
mv coredns /usr/local/bin/
chmod +x /usr/local/bin/coredns

echo "Creating CoreDNS directories..."
mkdir -p /etc/coredns/geoip /etc/coredns/zones /var/lib/coredns

echo "Downloading GeoLite2-City.mmdb..."
wget -O /etc/coredns/geoip/GeoLite2-City.mmdb https://git.io/GeoLite2-City.mmdb
chmod 644 /etc/coredns/geoip/GeoLite2-City.mmdb

echo "Creating initial CoreDNS configuration..."
cat > /etc/coredns/Corefile << EOF
.:53 {
    errors
    health :8080
    ready :8181
    prometheus :9153
    log
}
EOF

echo "Setting up CoreDNS service..."
groupadd --system coredns 2>/dev/null || true
useradd --system --gid coredns --shell /bin/false --home-dir /var/lib/coredns coredns 2>/dev/null || true

cat > /etc/systemd/system/coredns.service << 'EOF'
[Unit]
Description=CoreDNS DNS server
After=network.target

[Service]
User=coredns
Group=coredns
ExecStart=/usr/local/bin/coredns -conf /etc/coredns/Corefile
Restart=on-failure
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF

chown -R coredns:coredns /etc/coredns /var/lib/coredns
setcap 'cap_net_bind_service=+ep' /usr/local/bin/coredns
echo "Disabling systemd-resolved..."
if systemctl is-active --quiet systemd-resolved; then
  systemctl stop systemd-resolved
fi
if systemctl is-enabled --quiet systemd-resolved; then
  systemctl disable systemd-resolved
fi
if [ -L /etc/resolv.conf ]; then
  rm -f /etc/resolv.conf
fi
cat > /etc/resolv.conf << EOF
nameserver 1.1.1.1
nameserver 8.8.8.8
options timeout:2 attempts:3 rotate
EOF
chmod 644 /etc/resolv.conf

systemctl daemon-reload
systemctl enable coredns
systemctl restart coredns

echo "Deploying GeoDNS admin panel..."
ADMIN_APP_DIR="/opt/geodns-admin"

# Resolve admin source directory robustly even if script is run from another cwd.
SCRIPT_FILE="${BASH_SOURCE[0]:-$0}"
SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_FILE")" 2>/dev/null && pwd || true)"
ADMIN_SRC_DIR=""

for CANDIDATE in \
  "$SCRIPT_DIR/admin" \
  "$(pwd)/admin" \
  "/root/GeoDNS/admin"
do
  if [[ -d "$CANDIDATE" ]]; then
    ADMIN_SRC_DIR="$CANDIDATE"
    break
  fi
done

if [[ -z "$ADMIN_SRC_DIR" ]]; then
  echo "Admin source directory not found."
  echo "Checked: $SCRIPT_DIR/admin, $(pwd)/admin, /root/GeoDNS/admin"
  echo "Run install.sh from the GeoDNS repo root (where ./admin exists) or use full path:"
  echo "bash /root/GeoDNS/install.sh"
  exit 1
fi

mkdir -p "$ADMIN_APP_DIR" /var/lib/geodns-admin
cp -r "$ADMIN_SRC_DIR"/. "$ADMIN_APP_DIR"/

cd "$ADMIN_APP_DIR"
echo "Installing dashboard dependencies..."
if ! PATH=/usr/bin:/bin /usr/bin/npm install --omit=dev --no-audit --no-fund --loglevel=error; then
  echo "npm install failed. Re-running with verbose output for troubleshooting..."
  PATH=/usr/bin:/bin /usr/bin/npm install --omit=dev
fi

ADMIN_SESSION_SECRET="$(openssl rand -hex 32)"

if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
  COOKIE_SECURE="true"
else
  COOKIE_SECURE="false"
fi

cat > /etc/geodns-admin.env << EOF
GEODNS_ADMIN_PORT=3000
GEODNS_ADMIN_SESSION_SECRET=$ADMIN_SESSION_SECRET
GEODNS_ADMIN_COOKIE_SECURE=$COOKIE_SECURE
GEODNS_ADMIN_DB_PATH=/var/lib/geodns-admin/admin.db
COREDNS_ROOT=/etc/coredns
GEODNS_GEOIP_DB_PATH=/etc/coredns/geoip/GeoLite2-City.mmdb
COREDNS_SERVICE=coredns
GEODNS_BACKUPS_ROOT=/var/lib/geodns-admin/backups
GEODNS_SETUP_DEFAULT_NS1=$DEFAULT_NS1
GEODNS_SETUP_DEFAULT_NS2=$DEFAULT_NS2
EOF

chmod 600 /etc/geodns-admin.env

cat > /etc/systemd/system/geodns-admin.service << 'EOF'
[Unit]
Description=GeoDNS Admin Web UI
After=network.target

[Service]
Type=simple
EnvironmentFile=/etc/geodns-admin.env
WorkingDirectory=/opt/geodns-admin
ExecStart=/usr/bin/node /opt/geodns-admin/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable geodns-admin
systemctl restart geodns-admin

if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
  echo "Installing Caddy for HTTPS reverse proxy..."
  apt install -y caddy
  cat > /etc/caddy/Caddyfile << EOF
$ADMIN_WEB_DOMAIN {
  reverse_proxy 127.0.0.1:3000
}
EOF
  systemctl enable caddy
  systemctl restart caddy
fi

echo "Configuring firewall..."
if command -v ufw >/dev/null 2>&1; then
  UFW_STATUS=$(ufw status | awk 'NR==1{print $2}')
  if [[ "$UFW_STATUS" == "active" ]]; then
    ufw allow 53/tcp
    ufw allow 53/udp
    if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
      ufw allow 80/tcp
      ufw allow 443/tcp
    else
      ufw allow 3000/tcp
    fi
    ufw reload
  fi
elif command -v firewall-cmd >/dev/null 2>&1; then
  if firewall-cmd --state >/dev/null 2>&1; then
    firewall-cmd --permanent --add-service=dns
    if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
      firewall-cmd --permanent --add-service=http
      firewall-cmd --permanent --add-service=https
    else
      firewall-cmd --permanent --add-port=3000/tcp
    fi
    firewall-cmd --reload
  fi
elif command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp --dport 53 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 53 -j ACCEPT
  iptables -C INPUT -p udp --dport 53 -j ACCEPT 2>/dev/null || iptables -A INPUT -p udp --dport 53 -j ACCEPT
  if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
    iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 80 -j ACCEPT
    iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 443 -j ACCEPT
  else
    iptables -C INPUT -p tcp --dport 3000 -j ACCEPT 2>/dev/null || iptables -A INPUT -p tcp --dport 3000 -j ACCEPT
  fi
  echo "iptables rules added but may not persist after reboot."
fi

echo "=== Deployment Complete ==="
if [[ -n "$ADMIN_WEB_DOMAIN" ]]; then
  echo "Admin panel URL: https://$ADMIN_WEB_DOMAIN"
else
  echo "Admin panel URL: http://<server-ip>:3000"
fi
echo "Open dashboard and complete Initial Setup."
