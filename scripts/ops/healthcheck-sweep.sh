#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  scripts/ops/healthcheck-sweep.sh [options]

Options:
  --target <name>        Target label in report (default: local)
  --seed <number>        Deterministic seed for synthetic latency (default: 210)
  --check <name::cmd>    Healthcheck definition, repeatable
  --output <path>        JSON report path (default: logs/healthcheck-sweep-<ts>.json)
  --dry-run              Skip command execution and simulate all checks as pass
  -h, --help             Show help

Examples:
  scripts/ops/healthcheck-sweep.sh
  scripts/ops/healthcheck-sweep.sh --check "daemon::node -e 'process.exit(0)'"
USAGE
}

TARGET="local"
SEED=210
DRY_RUN=0
TS="$(date +%Y%m%d-%H%M%S)"
OUTPUT="logs/healthcheck-sweep-${TS}.json"

CHECK_NAMES=()
CHECK_CMDS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --target)
      TARGET="${2:-}"
      shift 2
      ;;
    --seed)
      SEED="${2:-}"
      shift 2
      ;;
    --check)
      raw="${2:-}"
      if [[ "$raw" != *"::"* ]]; then
        echo "invalid --check value: $raw" >&2
        echo "expected format: name::command" >&2
        exit 2
      fi
      CHECK_NAMES+=("${raw%%::*}")
      CHECK_CMDS+=("${raw#*::}")
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

if ! [[ "$SEED" =~ ^[0-9]+$ ]]; then
  echo "--seed must be an integer" >&2
  exit 2
fi

if [[ ${#CHECK_NAMES[@]} -eq 0 ]]; then
  CHECK_NAMES=(
    "node-version"
    "npm-version"
    "logs-directory-writable"
  )
  CHECK_CMDS=(
    "node --version"
    "npm --version"
    "mkdir -p logs && test -w logs"
  )
fi

mkdir -p "$(dirname "$OUTPUT")"

det_ms() {
  local label="$1"
  local sum
  sum="$(printf '%s' "$label" | cksum | awk '{print $1}')"
  echo $(( (sum + SEED) % 700 + 120 ))
}

overall="pass"
checks_json=""
pass_count=0
fail_count=0

for i in "${!CHECK_NAMES[@]}"; do
  name="${CHECK_NAMES[$i]}"
  cmd="${CHECK_CMDS[$i]}"
  latency_ms="$(det_ms "$name")"
  rc=0
  status="pass"

  if [[ "$DRY_RUN" -eq 0 ]]; then
    if ! bash -lc "$cmd" >/dev/null 2>&1; then
      rc=$?
      status="fail"
      overall="fail"
      fail_count=$((fail_count + 1))
    else
      pass_count=$((pass_count + 1))
    fi
  else
    pass_count=$((pass_count + 1))
  fi

  check_json=$(printf '{"name":"%s","status":"%s","exit_code":%s,"synthetic_latency_ms":%s}' "$name" "$status" "$rc" "$latency_ms")

  if [[ -n "$checks_json" ]]; then
    checks_json+=$'\n'
    checks_json+="    ,$check_json"
  else
    checks_json+="    $check_json"
  fi
done

cat > "$OUTPUT" <<EOF_JSON
{
  "tool": "healthcheck-sweep",
  "version": 1,
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "target": "$TARGET",
  "seed": $SEED,
  "dry_run": $DRY_RUN,
  "overall_status": "$overall",
  "summary": {
    "total": ${#CHECK_NAMES[@]},
    "pass": $pass_count,
    "fail": $fail_count
  },
  "checks": [
$checks_json
  ]
}
EOF_JSON

echo "healthcheck-sweep: $overall"
echo "report: $OUTPUT"

if [[ "$overall" == "pass" ]]; then
  exit 0
fi
exit 1
