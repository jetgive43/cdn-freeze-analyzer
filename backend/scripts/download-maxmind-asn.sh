#!/usr/bin/env bash
# Download GeoLite2-ASN MMDB (requires MaxMind free account + license key).
# https://dev.maxmind.com/geoip/geolite2-free-geolocation-data
#
# Usage:
#   export MAXMIND_LICENSE_KEY=your_key
#   ./scripts/download-maxmind-asn.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST_DIR="${ROOT}/data"
mkdir -p "${DEST_DIR}"
KEY="${MAXMIND_LICENSE_KEY:-}"
if [[ -z "${KEY}" ]]; then
  echo "Set MAXMIND_LICENSE_KEY in the environment (MaxMind account)." >&2
  exit 1
fi
TMP="${DEST_DIR}/GeoLite2-ASN.tar.gz"
URL="https://download.maxmind.com/app/geoip_download?edition_id=GeoLite2-ASN&license_key=${KEY}&suffix=tar.gz"
echo "Downloading GeoLite2-ASN..."
curl -fsSL -o "${TMP}" "${URL}"
tar -xzf "${TMP}" -C "${DEST_DIR}" --strip-components=1 --wildcards '*/GeoLite2-ASN.mmdb'
rm -f "${TMP}"
echo "Installed: ${DEST_DIR}/GeoLite2-ASN.mmdb"
REPO_ROOT="$(cd "${ROOT}/.." && pwd)"
cp -f "${DEST_DIR}/GeoLite2-ASN.mmdb" "${REPO_ROOT}/GeoLite2-ASN.mmdb"
echo "Copied to: ${REPO_ROOT}/GeoLite2-ASN.mmdb"
