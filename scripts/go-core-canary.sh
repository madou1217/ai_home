#!/bin/bash
# Go Core 推理切流 canary，带自动回滚（S8/S9）。需要运维者本人执行——它会改生产路由并重启 launchd 服务。
#
#   scripts/go-core-canary.sh <新增 entry id>[,<entry id>...] [监控秒数，默认 1800]
#   例：scripts/go-core-canary.sh gateway.anthropic.messages
#
# 行为：在当前 goCoreRoutes 基础上追加给定条目 → 重启 → 后台看门狗监控；
# 近 10 条该路径请求中 >=3 条 5xx，或 go_core 连续 20s 不可转发，即恢复原路由并重启。
# 别名命中、钉选不可用、Fabric 在线的请求由 Node 转发前判定留在 Node，不受 canary 影响。
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HOME/.ai_home/logs/server.log"
ADD="${1:?usage: go-core-canary.sh <entry-id>[,...] [seconds]}"
DURATION="${2:-1800}"

aih() { node "$REPO/bin/ai-home.js" "$@"; }
current_routes() {
  aih server config show --json 2>/dev/null | python3 -c "import json,sys;print(','.join(json.load(sys.stdin)['config'].get('goCoreRoutes') or []))"
}
path_for() {
  case "$1" in
    gateway.anthropic.messages) echo "/v1/messages" ;;
    gateway.openai.chat_completions) echo "/v1/chat/completions" ;;
    gateway.openai.responses|gateway.openai.responses.websocket) echo "/v1/responses" ;;
    gateway.gemini.*) echo ":generateContent" ;;
    gateway.images.*) echo "/v1/images/" ;;
    *) echo "$1" ;;
  esac
}
go_forwarding() {
  curl -s -m3 http://127.0.0.1:9527/readyz | python3 -c "
import json, sys
try:
    g = json.load(sys.stdin).get('go_core') or {}
    print(1 if g.get('state') == 'ready' and g.get('forwarding') else 0)
except Exception:
    print(0)"
}

BEFORE="$(current_routes)"
AFTER="$(printf '%s,%s' "$BEFORE" "$ADD" | tr ',' '\n' | sed '/^$/d' | sort -u | paste -sd, -)"
WATCH_PATH="$(path_for "${ADD%%,*}")"
echo "[canary] routes: ${BEFORE:-<none>} -> $AFTER"
aih server config set --go-core --go-core-routes "$AFTER" >/dev/null
aih server restart >/dev/null 2>&1

rollback() {
  echo "[canary] $(date -u +%FT%TZ) ROLLBACK: $1"
  if [ -n "$BEFORE" ]; then aih server config set --go-core --go-core-routes "$BEFORE" >/dev/null
  else aih server config set --clear-go-core-routes >/dev/null; fi
  aih server restart >/dev/null 2>&1
  exit 1
}

START="$(date -u +%Y-%m-%dT%H:%M:%S)"
END=$(( $(date +%s) + DURATION ))
notready=0
sleep 10
while [ "$(date +%s)" -lt "$END" ]; do
  bad=$(grep '"kind":"access"' "$LOG" | grep -F "$WATCH_PATH" \
    | awk -v s="$START" -F'"at":"' '{split($2,a,"\""); if (a[1] > s) print}' \
    | tail -10 | grep -cE '"status":5[0-9][0-9]' || true)
  [ "${bad:-0}" -ge 3 ] && rollback "$WATCH_PATH 5xx=$bad in last 10"
  if [ "$(go_forwarding)" = "0" ]; then notready=$((notready + 5)); else notready=0; fi
  [ "$notready" -ge 20 ] && rollback "go_core not forwarding for ${notready}s"
  sleep 5
done
echo "[canary] $(date -u +%FT%TZ) finished ${DURATION}s without rollback; routes stay: $AFTER"
