#!/usr/bin/env bash
set -Eeuo pipefail

IP="${1:-35.157.242.167}"
WEBROOT="/var/www/letsencrypt"
SITE="/etc/nginx/sites-available/stay"
CERT_DIR="/etc/letsencrypt/live/${IP}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "ERROR: run with sudo/root." >&2
  exit 1
fi

if ! command -v nginx >/dev/null 2>&1; then
  echo "ERROR: nginx is required." >&2
  exit 2
fi

if ! command -v certbot >/dev/null 2>&1; then
  echo "ERROR: Certbot 5.4+ is required for IP-address webroot certificates." >&2
  echo "Install a current Certbot release, then rerun this command." >&2
  exit 2
fi

CERTBOT_VERSION="$(certbot --version 2>&1 | awk '{print $2}')"
MAJOR="${CERTBOT_VERSION%%.*}"
REST="${CERTBOT_VERSION#*.}"
MINOR="${REST%%.*}"
if [[ -z "$MAJOR" || -z "$MINOR" || "$MAJOR" -lt 5 || ( "$MAJOR" -eq 5 && "$MINOR" -lt 4 ) ]]; then
  echo "ERROR: Certbot ${CERTBOT_VERSION} is too old; need 5.4+ for webroot + --ip-address." >&2
  exit 2
fi

mkdir -p "$WEBROOT/.well-known/acme-challenge"
chmod 0755 "$WEBROOT" "$WEBROOT/.well-known" "$WEBROOT/.well-known/acme-challenge"

BACKUP="${SITE}.pre-https.$(date -u +%Y%m%dT%H%M%SZ)"
cp "$SITE" "$BACKUP"

cat > "$SITE" <<EOF
server {
    listen 80 default_server;
    server_name _;

    location ^~ /.well-known/acme-challenge/ {
        root ${WEBROOT};
        default_type text/plain;
        try_files \$uri =404;
    }

    location ^~ /runtime/ {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }
}
EOF

nginx -t
systemctl reload nginx

echo "Requesting short-lived Let's Encrypt IP certificate for ${IP}..."
certbot certonly \
  --preferred-profile shortlived \
  --webroot \
  --webroot-path "$WEBROOT" \
  --ip-address "$IP" \
  --non-interactive \
  --agree-tos \
  --register-unsafely-without-email

if [[ ! -f "${CERT_DIR}/fullchain.pem" || ! -f "${CERT_DIR}/privkey.pem" ]]; then
  echo "ERROR: certificate was not created in ${CERT_DIR}." >&2
  cp "$BACKUP" "$SITE"
  nginx -t
  systemctl reload nginx
  exit 3
fi

TEMPLATE="/opt/stay/current/deploy/nginx/gateway-https.conf"
if [[ ! -f "$TEMPLATE" ]]; then
  echo "ERROR: HTTPS gateway template missing from active STAY release." >&2
  exit 3
fi

sed "s/STAY_IP/${IP}/g" "$TEMPLATE" > "$SITE"
nginx -t
systemctl reload nginx

mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-stay-nginx.sh <<'EOF'
#!/usr/bin/env bash
set -e
nginx -t
systemctl reload nginx
EOF
chmod 0755 /etc/letsencrypt/renewal-hooks/deploy/reload-stay-nginx.sh

echo
echo "HTTPS ENABLED"
echo "https://${IP}/"
echo
echo "Certbot renewal hooks will reload nginx after renewal."
