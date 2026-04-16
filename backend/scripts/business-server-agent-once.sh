#!/usr/bin/env bash
# Single metrics POST (for cron: run every minute). Sources env from file or current environment.
# Tested on Ubuntu (procps, iproute2) and RHEL/CentOS 7/8/9 (procps-ng, iproute).
# Requires: curl OR python3 for HTTPS POST; awk, sleep; optional: mysql, psql; IP via `ip` or hostname -I.
# Required: POST_URL, INGEST_TOKEN (or source a file that sets them before calling this)
# Optional: METRIC_NAME, METRIC_TYPE (default pdns), SAMPLE_SECONDS (default 2)

set -uo pipefail

# Cron uses a minimal PATH; curl is usually in /usr/bin (same for awk, sleep).
PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin${PATH:+:$PATH}"

POST_URL="${POST_URL:-}"
INGEST_TOKEN="${INGEST_TOKEN:-}"
METRIC_NAME="${METRIC_NAME:-$(hostname -s 2>/dev/null || hostname)}"
METRIC_TYPE="${METRIC_TYPE:-pdns}"
SAMPLE_SECONDS="${SAMPLE_SECONDS:-2}"

if [ -z "$POST_URL" ] || [ -z "$INGEST_TOKEN" ]; then
  echo "Set POST_URL and INGEST_TOKEN" >&2
  exit 1
fi

# CPU jiffies: non-idle and total per /proc/stat (portable Linux; not dependent on top(1) format).
cpu_jiffies_pair() {
  awk '/^cpu / {
    idle=$5+0; iow=$6+0; sum=0
    for (i=2;i<=NF;i++) sum+=$i+0
    print sum-idle-iow, sum
    exit
  }' /proc/stat 2>/dev/null || echo "0 1"
}

mysql_queries() {
  mysql -N -e "SHOW GLOBAL STATUS LIKE 'Queries';" 2>/dev/null | awk '{print $2}' || true
}

pg_txns() {
  psql -Atq -c "SELECT COALESCE(SUM(xact_commit + xact_rollback), 0) FROM pg_stat_database;" 2>/dev/null || true
}

read -r cpu_busy1 cpu_total1 <<< "$(cpu_jiffies_pair)"

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

read -r cpu_busy2 cpu_total2 <<< "$(cpu_jiffies_pair)"
cpu_usage=$(awk -v b1="$cpu_busy1" -v t1="$cpu_total1" -v b2="$cpu_busy2" -v t2="$cpu_total2" \
  'BEGIN { dt=t2-t1; db=b2-b1; if (dt<=0) print "0.00"; else printf "%.2f", (db*100)/dt }')

# RAM%: MemAvailable (Linux 3.14+) — fallback to free -m for old/minimal images.
memory_usage=$(awk '
  /^MemTotal:/ { t=$2+0 }
  /^MemAvailable:/ { a=$2+0 }
  END {
    if (t>0 && a>0) printf "%.2f", 100*(t-a)/t
  }
' /proc/meminfo 2>/dev/null || true)
if [ -z "${memory_usage:-}" ]; then
  memory_usage=$(free -m 2>/dev/null | awk '/Mem:/ {if ($2+0>0) printf "%.2f", $3/$2 * 100; else print "0"}' || echo "0")
fi

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

# POST ingest: prefer curl (-f fails on HTTP 4xx/5xx); else python3 stdlib (no curl on some minimal images).
post_ingest() {
  local curl_bin=""
  if command -v curl >/dev/null 2>&1; then
    curl_bin=$(command -v curl)
  elif [ -x /usr/bin/curl ]; then
    curl_bin=/usr/bin/curl
  elif [ -x /bin/curl ]; then
    curl_bin=/bin/curl
  fi

  if [ -n "$curl_bin" ]; then
    "$curl_bin" -fsS -X POST "$POST_URL" \
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
      --data-urlencode "db_qps=${db_qps}"
    return
  fi

  PY=""
  if command -v python3 >/dev/null 2>&1; then
    PY=$(command -v python3)
  elif [ -x /usr/bin/python3 ]; then
    PY=/usr/bin/python3
  fi
  if [ -n "$PY" ]; then
    export _BI_URL="$POST_URL"
    export _BI_INGEST_TOKEN="$INGEST_TOKEN"
    export _BI_NAME="$METRIC_NAME"
    export _BI_TYPE="$METRIC_TYPE"
    export _BI_IP="$server_ip"
    export _BI_CPU="$cpu_usage"
    export _BI_RAM="$memory_usage"
    export _BI_DISK="$disk_usage"
    export _BI_DL="$download_mbps"
    export _BI_UL="$upload_mbps"
    export _BI_RPS="$request_per_sec"
    export _BI_DBQ="${db_qps:-}"
    "$PY" - <<'PY' || { return 1; }
import os, sys, urllib.parse, urllib.request
u = os.environ["_BI_URL"]
fields = {
    "ingest_token": os.environ["_BI_INGEST_TOKEN"],
    "name": os.environ["_BI_NAME"],
    "type": os.environ["_BI_TYPE"],
    "ip": os.environ["_BI_IP"],
    "cpu_percent": os.environ["_BI_CPU"],
    "ram_percent": os.environ["_BI_RAM"],
    "disk_percent": os.environ["_BI_DISK"],
    "download_mbps": os.environ["_BI_DL"],
    "upload_mbps": os.environ["_BI_UL"],
    "request_per_sec": os.environ["_BI_RPS"],
    "db_qps": os.environ.get("_BI_DBQ", ""),
}
data = urllib.parse.urlencode(fields).encode("utf-8")
req = urllib.request.Request(
    u,
    data=data,
    method="POST",
    headers={"Content-Type": "application/x-www-form-urlencoded"},
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        c = r.getcode()
        if c < 200 or c >= 300:
            sys.exit(1)
except Exception:
    sys.exit(1)
PY
    return 0
  fi

  echo "curl and python3 not found; install curl: yum install curl / dnf install curl / apt-get install curl" >&2
  return 1
}

post_ingest || exit 1

exit 0
