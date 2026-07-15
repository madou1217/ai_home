# 2026-06-30 Native Session Runtime Blocker And Dialogue Closure

目标：在业务闭环和串流 proof 之外，真实验证 Fabric session 的后续 `message` 链路，并修复一次真实 AWS 对话暴露出的 `opencode` runtime blocker 误判。

约束：

- 只使用 AWS current：`http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- 只使用默认端口 `9527`
- 不使用 mock 数据
- 不上传本地 provider 凭据
- 不修改 AWS 云配置

## 1. Failure Found By Real Dialogue

真实 start/message/slash 验证先暴露了一个产品级误判：

- start run: `0212eaf8-6fb7-40f5-a707-a6df503dd99b`
- session: `ses_0e98b73a7ffeUrEK5CuZ1sbG4R`
- start events included real assistant output, but also:
  - `runtime-blocked`
  - `reason=auth_invalid_reauth_required`
  - final `error.code=native_runtime_blocked`
- message run: `097f8187-672d-473f-b4b9-61f2b184b99c`
- message resumed from: `0212eaf8-6fb7-40f5-a707-a6df503dd99b`
- slash `/status`: HTTP `400`, blocker `headless_session_slash_unsupported`

Root cause:

`native-session-chat` scanned every raw non-interactive JSON stream chunk through the auth blocker classifier. Normal `opencode run --format json` output can include tool output and repository text containing auth/token/error-looking strings. That is not an auth failure surface. The classifier persisted a false `auth_invalid_reauth_required` runtime block even though the same run produced a normal assistant response.

## 2. Product Fix

Changed runtime blocker scanning policy:

- interactive CLI terminal output may still be scanned;
- structured non-interactive `error` events may be scanned;
- non-zero process exit output may be scanned;
- normal non-interactive stdout chunks are not scanned.

This keeps real Codex/Claude/AGY auth failures diagnosable while preventing ordinary `opencode` JSON/tool output from poisoning account state.

Files:

- `lib/server/native-session-chat.js`
- `test/native-session-chat.test.js`

## 3. Verification

Local:

```bash
node --check "lib/server/native-session-chat.js"
node --test "test/native-session-chat.test.js"
```

Result:

- syntax check: pass
- focused tests: `37/37 pass`

AWS current:

```bash
ssh -i "$HOME/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/native-session-chat.js && ./.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/native-session-chat.test.js"
```

Result:

- syntax check: pass
- focused tests: `37/37 pass`

AWS server restart:

- old server pid: `536155`
- new server node pid: `574351`
- port: `9527`
- `/readyz`: `ok=true`, `ready=true`

The temporary `nohup` wrapper pid `574346` was cleaned; the real node process stayed alive.

## 4. Runtime State Repair

Read-only audit after the old-code dialogue showed the false block persisted:

- provider: `opencode`
- `runtimeBlocked=1`
- reason: `auth_invalid:auth_invalid_reauth_required`
- `clearableRuntimeBlocks=1`

Product repair command:

```bash
node "bin/ai-home.js" fabric provider accounts revalidate \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --providers opencode \
  --yes \
  --json
```

Result:

- `runtimeBlockClear.cleared=1`
- `postSessionAudit.providers[opencode].runtimeBlocked=0`
- real validation session run: `40ae9a39-3abe-47af-93b5-4dbb5f32bb04`
- `markerFound=true`
- events: `ready/session-created/delta/result/done`
- `transportKind=webrtc`
- `fallbackUsed=false`

## 5. Post-Fix Real Dialogue

Real start:

- run: `518f272e-ac80-4d3c-8c29-82ac7de94518`
- session: `ses_0e9841eebffekpOOMuN6oUZz2K`
- events: `ready/session-created/delta/result/done`
- marker: `AIH_REAL_DIALOGUE_START_FIXED_20260630_031000`
- `hasRuntimeBlocked=false`
- `hasError=false`

Real follow-up message:

- run: `17b20864-a227-4345-b1b1-701d170ea0f1`
- resumed from: `518f272e-ac80-4d3c-8c29-82ac7de94518`
- session: `ses_0e9841eebffekpOOMuN6oUZz2K`
- events: `ready/delta/result/done`
- marker: `AIH_REAL_DIALOGUE_MESSAGE_FIXED_20260630_031000`
- `hasRuntimeBlocked=false`
- `hasError=false`

Slash:

- command: `/status`
- HTTP: `400`
- blocker: `headless_session_slash_unsupported`

Conclusion:

- Real start works.
- Real resumed message works.
- Real WebRTC stream works.
- The previous `opencode` runtime-blocked error was a local classifier bug and is fixed.
- Slash remains a separate capability gap for headless completed runs; it must not be diagnosed as transport, auth, or session-start failure.

## 6. Repeat Prevention

| Failure | Cause | Fix | Repeat prevention |
|---|---|---|---|
| Valid opencode session was marked `auth_invalid_reauth_required` | Normal non-interactive JSON/tool output was scanned as auth failure text. | Only scan interactive terminal output, structured error events, or non-zero exit output. | Do not classify raw non-interactive stdout chunks as account auth state. |
| Product looked connected but provider state became degraded later | The false runtime block was persisted to account state after a successful answer. | Revalidated opencode and cleared one runtime block. | After any runtime classifier change, run provider audit before and after real session proof. |
| Slash looked like a general session failure | Headless completed-run slash is not implemented for this path. | Recorded exact blocker `headless_session_slash_unsupported`. | Treat slash as a provider/session capability gap, not network or provider credential failure. |
