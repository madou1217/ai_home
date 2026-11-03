#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/ops/session-orphan-cleaner.sh [options]

Options:
  --target-dir <path>    Directory to scan for orphan session artifacts (default: logs/workers)
  --max-age-min <int>    Age threshold in minutes; older files are treated as orphaned (default: 30)
  --output <path>        JSON report path (default: logs/session-orphan-cleaner-<ts>.json)
  --dry-run              Do not delete files; only report candidates
  -h, --help             Show help

Examples:
  scripts/ops/session-orphan-cleaner.sh --dry-run
  scripts/ops/session-orphan-cleaner.sh --target-dir logs/workers --max-age-min 120
USAGE
}

TARGET_DIR="logs/workers"
MAX_AGE_MIN=30
DRY_RUN=0
TS="$(date +%Y%m%d-%H%M%S)"
OUTPUT="logs/session-orphan-cleaner-${TS}.json"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target-dir)
      TARGET_DIR="${2:-}"
      shift 2
      ;;
    --max-age-min)
      MAX_AGE_MIN="${2:-}"
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

if ! [[ "$MAX_AGE_MIN" =~ ^[0-9]+$ ]]; then
  echo "--max-age-min must be a non-negative integer" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT")"
mkdir -p "$TARGET_DIR"

now_epoch="$(date +%s)"
scanned=0
candidate_count=0
deleted_count=0
retained_count=0
items_json=""

get_mtime_epoch() {
  local p="$1"
  local out=""
  if out="$(stat -f %m "$p" 2>/dev/null)"; then
    printf '%s' "$out"
    return 0
  fi
  if out="$(stat -c %Y "$p" 2>/dev/null)"; then
    printf '%s' "$out"
    return 0
  fi
  return 1
}

while IFS= read -r -d '' file; do
  scanned=$((scanned + 1))
  mtime_epoch="$(get_mtime_epoch "$file" || echo "$now_epoch")"
  age_min=$(( (now_epoch - mtime_epoch) / 60 ))

  action="retain"
  orphan=0

  if (( age_min >= MAX_AGE_MIN )); then
    orphan=1
    candidate_count=$((candidate_count + 1))
    if (( DRY_RUN == 0 )); then
      rm -f -- "$file"
      action="deleted"
      deleted_count=$((deleted_count + 1))
    else
      action="candidate"
    fi
  else
    retained_count=$((retained_count + 1))
  fi

  item=$(printf '{"path":"%s","age_min":%s,"orphan":%s,"action":"%s"}' "$file" "$age_min" "$orphan" "$action")
  if [[ -n "$items_json" ]]; then
    items_json+=$'\n'
    items_json+="    ,$item"
  else
    items_json+="    $item"
  fi
done < <(find "$TARGET_DIR" -type f -print0 2>/dev/null)

cat > "$OUTPUT" <<EOF_JSON
{
  "tool": "session-orphan-cleaner",
  "version": 1,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "target_dir": "$TARGET_DIR",
  "max_age_min": $MAX_AGE_MIN,
  "dry_run": $DRY_RUN,
  "summary": {
    "scanned": $scanned,
    "candidates": $candidate_count,
    "deleted": $deleted_count,
    "retained": $retained_count
  },
  "items": [
$items_json
  ]
}
EOF_JSON

echo "session-orphan-cleaner: scanned=$scanned candidates=$candidate_count deleted=$deleted_count"
echo "report: $OUTPUT"
