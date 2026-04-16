#!/usr/bin/env bash
# Apply nginx reverse proxy for CDN monitor (needs sudo).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONF_SRC="${ROOT}/deploy/nginx-cdn-monitor.conf"
SITE="/etc/nginx/sites-available/cdn-monitor"

if [[ ! -f "${CONF_SRC}" ]]; then
	echo "Missing ${CONF_SRC}" >&2
	exit 1
fi

if [[ "${EUID}" -ne 0 ]]; then
	echo "Run with sudo: sudo bash scripts/apply-nginx-proxy.sh" >&2
	exit 1
fi

cp -f "${CONF_SRC}" "${SITE}"
ln -sf "${SITE}" /etc/nginx/sites-enabled/cdn-monitor
# Remove stock default that often returns 404 for /
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx
echo "OK: nginx proxies :80 → http://127.0.0.1:5000 (ensure Node backend is running)."
