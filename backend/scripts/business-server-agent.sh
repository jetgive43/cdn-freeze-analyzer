#!/usr/bin/env bash
# Legacy loop agent (continuous). Prefer: business-server-agent-once.sh + cron every minute (installed from UI).
# POST metrics to .../api/business-servers/ingest
# Required env: POST_URL (full ingest URL), INGEST_TOKEN (64 hex)
# Optional: METRIC_NAME (defaults hostname), METRIC_TYPE (default pdns), INTERVAL_SECONDS (default 5)

set -uo pipefail

POST_URL="${POST_URL:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
METRIC_NAME="${METRIC_NAME:-$(hostname -s 2>/dev/null || hostname)}"
METRIC_TYPE="${METRIC_TYPE:-pdns}"
INTERVAL_SECONDS="${INTERVAL_SECONDS:-5}"
SAMPLE_SECONDS=2
SLEEP_AFTER_SEND=$((INTERVAL_SECONDS - SAMPLE_SECONDS))
if [ "$SLEEP_AFTER_SEND" -lt 0 ]; then
  SLEEP_AFTER_SEND=0
fi

if [ -z "$POST_URL" ] || [ -z "$INGEST_TOKEN" ]; then
  echo "Set POST_URL and INGEST_TOKEN" >&2
  exit 1
fi

mysql_queries() {
  mysql -N -e "SHOW GLOBAL STATUS LIKE 'Queries';" 2>/dev/null | awk '{print $2}' || true
}

pg_txns() {
  psql -Atq -c "SELECT COALESCE(SUM(xact_commit + xact_rollback), 0) FROM pg_stat_database;" 2>/dev/null || true
}

while true; do
  cpu_usage=$(top -b -n 1 2>/dev/null | awk '/Cpu\(s\)/ {printf "%.2f", $2 + $4}' || echo "0")
  memory_usage=$(free -m 2>/dev/null | awk '/Mem:/ {if ($2+0>0) printf "%.2f", $3/$2 * 100; else print "0"}' || echo "0")
  disk_usage=$(df -P / 2>/dev/null | awk 'NR==2 {gsub("%", "", $5); printf "%.2f", $5}' || echo "0")
  current_interface=$(ip route show 2>/dev/null | awk '/default/ {print $5; exit}')
  server_ip=""
  if [ -n "$current_interface" ]; then
    server_ip=$(ip -4 addr show "$current_interface" 2>/dev/null | awk '/inet / {print $2}' | cut -d/ -f1 | head -n 1)
  fi
  [ -z "$server_ip" ] && server_ip=$(hostname -I 2>/dev/null | awk '{print $1}')

  rx_bytes_1=0
  tx_bytes_1=0
  rx_packets_1=0
  tx_packets_1=0
  if [ -n "$current_interface" ] && [ -r "/sys/class/net/$current_interface/statistics/rx_bytes" ]; then
    rx_bytes_1=$(<"/sys/class/net/$current_interface/statistics/rx_bytes")
    tx_bytes_1=$(<"/sys/class/net/$current_interface/statistics/tx_bytes")
    rx_packets_1=$(<"/sys/class/net/$current_interface/statistics/rx_packets")
    tx_packets_1=$(<"/sys/class/net/$current_interface/statistics/tx_packets")
  fi

  db_q1=""
  db_kind=""
  q=$(mysql_queries)
  if [ -n "${q:-}" ] && printf '%s' "$q" | grep -qE '^[0-9]+$'; then
    db_q1=$q
    db_kind="mysql"
  fi
  if [ -z "$db_q1" ]; then
    q=$(pg_txns)
    if [ -n "${q:-}" ] && printf '%s' "$q" | grep -qE '^[0-9]+$'; then
      db_q1=$q
      db_kind="pg"
    fi
  fi

  sleep "$SAMPLE_SECONDS"

  rx_bytes_2=$rx_bytes_1
  tx_bytes_2=$tx_bytes_1
  rx_packets_2=$rx_packets_1
  tx_packets_2=$tx_packets_1
  if [ -n "$current_interface" ] && [ -r "/sys/class/net/$current_interface/statistics/rx_bytes" ]; then
    rx_bytes_2=$(<"/sys/class/net/$current_interface/statistics/rx_bytes")
    tx_bytes_2=$(<"/sys/class/net/$current_interface/statistics/tx_bytes")
    rx_packets_2=$(<"/sys/class/net/$current_interface/statistics/rx_packets")
    tx_packets_2=$(<"/sys/class/net/$current_interface/statistics/tx_packets")
  fi

  download_mbps=$(awk "BEGIN {printf \"%.2f\", ($rx_bytes_2 - $rx_bytes_1)/$SAMPLE_SECONDS / 125000}")
  upload_mbps=$(awk "BEGIN {printf \"%.2f\", ($tx_bytes_2 - $tx_bytes_1)/$SAMPLE_SECONDS / 125000}")
  request_per_sec=$(awk "BEGIN {printf \"%.2f\", ((($rx_packets_2 - $rx_packets_1) + ($tx_packets_2 - $tx_packets_1)) / 2) / $SAMPLE_SECONDS}")

  db_qps=""
  if [ -n "$db_q1" ] && [ -n "$db_kind" ]; then
    if [ "$db_kind" = "mysql" ]; then
      db_q2=$(mysql_queries || echo "")
      if [ -n "$db_q2" ] && printf '%s' "$db_q2" | grep -qE '^[0-9]+$'; then
        db_qps=$(awk "BEGIN {printf \"%.2f\", ($db_q2 - $db_q1) / $SAMPLE_SECONDS}")
      fi
    elif [ "$db_kind" = "pg" ]; then
      db_q2=$(pg_txns || echo "")
      if [ -n "$db_q2" ]; then
        db_qps=$(awk "BEGIN {printf \"%.2f\", ($db_q2 - $db_q1) / $SAMPLE_SECONDS}")
      fi
    fi
  fi

  curl -sS -X POST "$POST_URL" \
    --data-urlencode "ingest_token=${INGEST_TOKEN}" \
    --data-urlencode "name=${METRIC_NAME}" \
    --data-urlencode "type=${METRIC_TYPE}" \
    --data-urlencode "ip=${server_ip}" \
    --data-urlencode "cpu_percent=${cpu_usage}" \
    --data-urlencode "ram_percent=${memory_usage}" \
    --data-urlencode "disk_percent=${disk_usage}" \
    --data-urlencode "download_mbps=${download_mbps}" \
    --data-urlencode "upload_mbps=${upload_mbps}" \
    --data-urlencode "request_per_sec=${request_per_sec}" \
    --data-urlencode "db_qps=${db_qps}" \
    || true

  echo
  sleep "$SLEEP_AFTER_SEND"
done
