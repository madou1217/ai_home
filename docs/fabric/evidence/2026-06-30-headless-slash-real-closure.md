# 2026-06-30 Headless Slash Real Closure

目标：把 completed headless native run 的 slash 从已知 blocker 修成真实可用路径，并按“业务闭环 -> 串流测试 -> 失败原因台账”记录。

约束：

- 只使用 AWS current：`http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- 只使用默认端口 `9527`
- 不使用 mock 数据
- 不上传本地 provider 凭据
- 不碰旧服务器

## 1. Root Cause

`fabric session message` 对 completed `opencode` run 已经会 resume 成新的 headless child run；但 `fabric session slash` 在同一 completed run 上直接返回：

- HTTP: `400`
- blocker: `headless_session_slash_unsupported`

根因不是网络、配对、WebRTC 或 provider auth，而是本地控制面硬编码拒绝了 completed headless run 的 slash。与此同时，native runtime 已有 interactive slash 能力，只是 control-plane session command 没有把 completed-run slash 接到 interactive resumed native run。

## 2. Product Fix

变更：

- `control-plane-device-session-command`：completed `opencode`/`claude` run 的 `slash` 复用 native resume 创建逻辑；slash payload 强制 `interactiveCli=true`，并把 slash 命令作为 `initialInput`。
- `control-plane-device-session-start`：新增内部 `interactiveCli`/`initialInput` 语义；未显式指定时保持旧行为，普通 `opencode` message 仍走 headless run。
- `native-session-chat`：`opencode` interactive resume 改走真实 TUI 入口 `opencode --session <id>`，不再混用 `opencode run --format json`。

## 3. Verification

Local:

```bash
node --check "lib/server/control-plane-device-session-command.js"
node --check "lib/server/control-plane-device-session-start.js"
node --check "lib/server/native-session-chat.js"
node --test "test/control-plane-device-session-command.test.js" "test/control-plane-device-session-start.test.js" "test/native-session-chat.test.js"
node --test "test/node-rpc-router.test.js" "test/server-node-rpc-wiring.test.js" "test/fabric-session-control-client.test.js" "test/fabric-real-mobile-pwa-session-smoke.test.js"
npm test
```

Result:

- focused syntax: pass
- focused behavior: `65/65 pass`
- adjacent RPC/session/mobile: `79/79 pass`
- full local test suite: `2904/2904 pass`

AWS current:

```bash
ssh -i "$HOME/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/control-plane-device-session-command.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/control-plane-device-session-start.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/native-session-chat.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/control-plane-device-session-command.test.js test/control-plane-device-session-start.test.js test/native-session-chat.test.js"
```

Result:

- focused syntax: pass
- focused behavior: `65/65 pass`

AWS server restart:

- bad restart found: direct bare command started with `accounts=0` and `/readyz ready=false`
- cause: missing original `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home` and runtime PATH
- fixed restart env:
  - `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home`
  - PATH includes `.node-runtime`, `node_modules/.bin`, `.runtime-tools/bin`, `.runtime-tools/npm/node_modules/.bin`
- final node pid: `578118`
- `/readyz`: `ok=true`, `ready=true`, accounts `codex=1`, `claude=4`, `agy=7`, `opencode=1`

## 4. Real Business And Stream Proof

Node readback:

- profile: `cp-51hq70`
- target: `aws-current-node`
- opencode runtime: `available`
- selected transport in session commands: `webrtc`
- `fallbackUsed=false`

Real start:

- run: `29e499ed-c629-45d3-83ab-252eb0a18a06`
- session: `ses_0e9754513ffeqLk14uk83x86fe`
- marker: `AIH_SLASH_FIX_START_20260630_032000`
- events: `ready/session-created/delta/result/done`
- completed: `true`
- transport: `webrtc`, `fallbackUsed=false`

Real follow-up message:

- parent run: `29e499ed-c629-45d3-83ab-252eb0a18a06`
- child run: `993f34e2-f9cd-49a7-8c50-094d62a39860`
- resumed: `true`
- resumedFromRunId: `29e499ed-c629-45d3-83ab-252eb0a18a06`
- session: `ses_0e9754513ffeqLk14uk83x86fe`
- marker: `AIH_SLASH_FIX_MESSAGE_20260630_032000`
- events: `ready/delta/result/done`
- completed: `true`
- transport: `webrtc`, `fallbackUsed=false`

Real slash:

- source completed run: `993f34e2-f9cd-49a7-8c50-094d62a39860`
- slash child run: `1915a77f-3678-4c44-9e6e-dd240e3a0fda`
- command: `/status`
- HTTP: `200`
- accepted: `true`
- resumed: `true`
- resumedFromRunId: `993f34e2-f9cd-49a7-8c50-094d62a39860`
- session: `ses_0e9754513ffeqLk14uk83x86fe`
- terminal events include `/status`, `OpenCode 1.17.11`, context/token/status panel output
- transport: `webrtc`, `fallbackUsed=false`

Cleanup:

- stop run: `1915a77f-3678-4c44-9e6e-dd240e3a0fda`
- HTTP: `200`
- events after stop: `aborted`, terminal cleanup output
- completed: `true`

## 5. Failure Ledger

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| `headless_session_slash_unsupported` on completed opencode runs | Control-plane command layer hard-coded slash rejection for completed headless runs. | Resume a completed slash as an interactive native run and send slash as `initialInput`. | Test completed opencode slash resume payload and real AWS `/status` before declaring slash unsupported. |
| Direct restart produced `/readyz ready=false` and `accounts=0` | Server was restarted without original `AIH_HOST_HOME` and runtime PATH. | Restart with `AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home` and the same runtime PATH used by fabric services. | Do not restart AWS server with a bare `node bin/ai-home.js server serve`; verify `/readyz` account counts before any real test. |
| Initial `scp` put files in AWS repo root | Multi-file `scp` target was a directory, so files landed at root instead of scoped paths. | Re-synced every file to its exact path and removed the root copies created by that command. | Use one `scp` per exact target path for AWS hot sync. |
| AWS shell `opencode` not found on plain PATH | SSH login shell did not include the AIH runtime tools PATH. | Treat server runtime env as truth; verify through node inventory and server session APIs. | Do not diagnose provider availability from bare SSH PATH; use fabric node diagnostics/runtime inventory. |

## 6. Current Remaining Blockers

This fix closes the internal slash capability gap for completed `opencode` runs. Remaining non-closed items are still the previously recorded external blockers:

- Cloud UDP: AWS edge/SG/NACL/TURN evidence not supplied.
- WebTransport: no HTTPS/H3 WebTransport endpoint.
- Multipath: no dual-side OpenMPTCPRouter/MPTCP underlay.
- Provider auth: Codex/Claude/AGY remain unavailable on AWS; opencode is ready.
