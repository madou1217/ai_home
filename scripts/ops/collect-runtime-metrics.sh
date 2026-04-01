#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/ops/collect-runtime-metrics.sh [options]

Options:
  --target <name>        Target label in report (default: local)
  --samples <count>      Number of samples to collect (default: 3)
  --interval-ms <ms>     Delay between samples in milliseconds (default: 1000)
  --seed <number>        Deterministic seed for synthetic dry-run metrics (default: 909)
  --output <path>        JSON report path (default: logs/runtime-metrics-<ts>.json)
  --dry-run              Do not read system state; emit deterministic synthetic metrics
  -h, --help             Show help

Examples:
  scripts/ops/collect-runtime-metrics.sh
  scripts/ops/collect-runtime-metrics.sh --samples 5 --interval-ms 250
  scripts/ops/collect-runtime-metrics.sh --dry-run --seed 42
USAGE
}

TARGET="local"
SAMPLES=3
INTERVAL_MS=1000
SEED=909
DRY_RUN=0
TS="$(date +%Y%m%d-%H%M%S)"
OUTPUT="logs/runtime-metrics-${TS}.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --samples)
      SAMPLES="${2:-}"
      shift 2
      ;;
    --interval-ms)
      INTERVAL_MS="${2:-}"
      shift 2
      ;;
    --seed)
      SEED="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if ! [[ "$SAMPLES" =~ ^[0-9]+$ ]] || [[ "$SAMPLES" -lt 1 ]]; then
  echo "--samples must be an integer >= 1" >&2
  exit 2
fi

if ! [[ "$INTERVAL_MS" =~ ^[0-9]+$ ]] || [[ "$INTERVAL_MS" -lt 0 ]]; then
  echo "--interval-ms must be an integer >= 0" >&2
  exit 2
fi

if ! [[ "$SEED" =~ ^[0-9]+$ ]]; then
  echo "--seed must be an integer" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT")"

node_metrics() {
  node -e 'const os=require("os"); const data={load_1m:Number(os.loadavg()[0].toFixed(3)),load_5m:Number(os.loadavg()[1].toFixed(3)),load_15m:Number(os.loadavg()[2].toFixed(3)),mem_total_bytes:os.totalmem(),mem_free_bytes:os.freemem(),uptime_sec:Math.floor(os.uptime())}; process.stdout.write(JSON.stringify(data));'
}

disk_used_pct() {
  df -Pk / | awk 'NR==2 {gsub("%", "", $5); print $5+0}'
}

process_count() {
  ps -A | wc -l | tr -d ' '
}

sleep_ms() {
  local ms="$1"
  if [[ "$ms" -le 0 ]]; then
    return
  fi
  local secs
  secs=$(awk -v m="$ms" 'BEGIN {printf "%.3f", m / 1000}')
  sleep "$secs"
}

synthetic_metric_value() {
  local index="$1"
  local salt="$2"
  echo $(( (SEED + index * 97 + salt) % 100 ))
}

samples_json=""

for ((i=1; i<=SAMPLES; i++)); do
  sample_ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    load_1m="0.$(printf '%02d' "$(synthetic_metric_value "$i" 3)")"
    load_5m="0.$(printf '%02d' "$(synthetic_metric_value "$i" 11)")"
    load_15m="0.$(printf '%02d' "$(synthetic_metric_value "$i" 23)")"
    mem_total_bytes=$((16 * 1024 * 1024 * 1024))
    mem_free_bytes=$(( (8 + $(synthetic_metric_value "$i" 31) % 6) * 1024 * 1024 * 1024 ))
    uptime_sec=$((86400 + i * 30))
    disk_used_percent=$((30 + $(synthetic_metric_value "$i" 47) % 40))
    proc_count=$((120 + $(synthetic_metric_value "$i" 53)))
  else
    node_json="$(node_metrics)"
    load_1m="$(printf '%s' "$node_json" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.load_1m));')"
    load_5m="$(printf '%s' "$node_json" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.load_5m));')"
    load_15m="$(printf '%s' "$node_json" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.load_15m));')"
    mem_total_bytes="$(printf '%s' "$node_json" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.mem_total_bytes));')"
    mem_free_bytes="$(printf '%s' "$node_json" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.mem_free_bytes));')"
    uptime_sec="$(printf '%s' "$node_json" | node -e 'const fs=require("fs"); const j=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(String(j.uptime_sec));')"
    disk_used_percent="$(disk_used_pct)"
    proc_count="$(process_count)"
  fi

  sample_json=$(printf '{"sample":%s,"timestamp":"%s","load_1m":%s,"load_5m":%s,"load_15m":%s,"mem_total_bytes":%s,"mem_free_bytes":%s,"disk_used_percent":%s,"process_count":%s,"uptime_sec":%s}' \
    "$i" "$sample_ts" "$load_1m" "$load_5m" "$load_15m" "$mem_total_bytes" "$mem_free_bytes" "$disk_used_percent" "$proc_count" "$uptime_sec")

  if [[ -n "$samples_json" ]]; then
    samples_json+=$'\n'
    samples_json+="    ,$sample_json"
  else
    samples_json+="    $sample_json"
  fi

  if [[ "$i" -lt "$SAMPLES" ]]; then
    sleep_ms "$INTERVAL_MS"
  fi
done

cat > "$OUTPUT" <<EOF_JSON
{
  "tool": "runtime-metrics-collector",
  "version": 1,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "target": "$TARGET",
  "dry_run": $DRY_RUN,
  "seed": $SEED,
  "summary": {
    "samples": $SAMPLES,
    "interval_ms": $INTERVAL_MS
  },
  "metrics": [
$samples_json
  ]
}
EOF_JSON

echo "runtime-metrics: collected $SAMPLES sample(s)"
echo "report: $OUTPUT"
