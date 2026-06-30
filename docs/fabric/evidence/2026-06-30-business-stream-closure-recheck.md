# 2026-06-30 business stream closure recheck

## Scope

按“先业务闭环，再串流测试，再记录失败原因”的顺序，重新验证 AWS current 默认 `9527` 上的真实 Fabric 闭环。

本轮只使用 AWS current：

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node: `aws-current-node`
- provider: `opencode`
- project: `/home/ubuntu/aih-fabric-current`

不触碰旧服务器，不新增端口，不上传本地 provider 凭据，不使用 mock 数据。

## Environment

| item | value |
|---|---|
| local cwd | `/Users/model/projects/feature/ai_home` |
| remote dir | `/home/ubuntu/aih-fabric-current` |
| server port | `9527` |
| selected provider | `opencode` |
| selected transport | `webrtc` |
| fallback used | `false` |
| mobile viewport | `390x844` Chromium mobile/PWA smoke |

## Commands

```bash
curl -s "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz"
```

```bash
node "bin/ai-home.js" fabric closure resume-check \
  --handoff-file "/tmp/aih-fabric-post-mobile-strict-handoff-20260630.json" \
  --json
```

```bash
node "bin/ai-home.js" fabric closure verify \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --diagnostics-file "/tmp/aih-fabric-business-stream-closure-20260630.json" \
  --handoff-file "/tmp/aih-fabric-business-stream-handoff-20260630.json" \
  --json
```

```bash
node "bin/ai-home.js" fabric closure resume-check \
  --handoff-file "/tmp/aih-fabric-business-stream-handoff-20260630.json" \
  --json
```

```bash
npx --yes --package playwright node "scripts/fabric-real-mobile-pwa-session-smoke.js" \
  --existing-node \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --client-endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --session-provider "opencode" \
  --session-account "1" \
  --session-model "" \
  --session-project "/home/ubuntu/aih-fabric-current" \
  --timeout-ms 60000 \
  --session-timeout-ms 60000
```

## Results

### Server readiness

`/readyz` returned:

- `ok=true`
- `ready=true`
- accounts: `codex=1`, `claude=4`, `agy=7`, `opencode=1`, `gemini=0`

### Resume check

`closure resume-check` returned:

- `ok=true`
- `resume.canContinueWithoutInput=false`
- `resume.changedEvidenceCount=0`
- reason: no external prerequisite input changed since the handoff

This means repeated full closure proof should not be run unless new external evidence is supplied.

Post-closure resume-check against the newly generated handoff also returned:

- `ok=true`
- `resume.canContinueWithoutInput=false`
- `resume.changedEvidenceCount=0`
- reason: no external prerequisite input has changed since the handoff

### Business and stream closure

`closure verify` returned:

- `ok=true`
- `exitOk=true`
- `summary.status=usable_with_blockers`
- `coreReady=true`
- `nodeReady=true`
- `transportReady=true`
- `targetProviderReady=true`
- `sessionReady=true`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- session run: `acf54ccc-c1bf-4f0f-8bd8-16d720d92f20`
- session id: `ses_0e9584e97ffe0SKff7Tb9m4h31`
- marker: `AIH_FABRIC_CLOSURE_AUDIT_20260630_035152`
- event types: `ready=1`, `session-created=1`, `delta=1`, `result=1`, `done=1`
- session completed: `true`

### Mobile/PWA session stream

Mobile/PWA existing-node smoke returned:

- `ok=true`
- device pair HTTP `200`
- device `paired=true`
- start HTTP `200`
- attach HTTP `200`
- message command HTTP `200`, `accepted=true`, `resumed=true`
- message child run: `c812a761-6e70-4541-b59c-28ad435bf00a`
- session ref: `ses_0e957fdc4ffeXPwl4QftgFeFWy`
- message completion `completed=true`
- reconnect `markerFoundAfterResume=true`
- slash `/status` HTTP `200`, `accepted=true`, `type=slash`, `unsupported=false`
- stop HTTP `200`, `accepted=true`
- final `completed=true`
- final event counts: `ready=1`, `session-created=1`, `delta=2`, `result=2`, `done=2`, `aborted=1`
- duplicate events: `0`
- browser console errors: `0`

## Failure Ledger

| failure | current status | root cause | prevention |
|---|---|---|---|
| `turn_default_udp_9527_unreachable` | external blocker | AWS remote UDP echo can bind on `9527`, but local UDP probe times out. Packet capture on `enp39s0` sees `0 packets captured`, and host firewall is not blocking UDP. | Do not repeat UDP probes expecting a different result until SG/NACL, controlled TURN/UDP path, or AWS policy readback changes. |
| `aws_public_udp_path_blocked` | external blocker | UDP packets do not reach the instance public path. Current evidence points outside AIH process logic. | Verify AWS Security Group and subnet NACL for UDP `9527`, then rerun `fabric transport cloud-edge`. |
| `aws_cli_missing` / `aws_iam_role_missing` / `aws_local_cli_missing` | external blocker | AIH cannot read SG/NACL policy because AWS CLI/IAM/local AWS CLI readback is unavailable. | Attach read-only EC2 permissions or configure read-only local AWS CLI before expecting policy readback. |
| `webtransport:webtransport_h3_endpoint_missing` | external blocker | Default `9527` listener is plain AIH HTTP; browser WebTransport requires a real HTTPS/H3 endpoint. | Do not classify this as a browser bug. Configure HTTPS/H3 endpoint, then rerun WebTransport smoke. |
| `omr:openmptcprouter_not_detected` | external blocker | No real OpenMPTCPRouter underlay is configured/detected. | Do not promote multipath from a single normal HTTP listener. Require dual-ended OMR evidence. |
| `mptcp:mptcp_data_plane_not_promoted` | external blocker | MPTCP data plane is not proven end-to-end. | Require real MPTCP/OMR underlay plus transport smoke before promotion. |
| `provider_account_unavailable:agy` | external blocker | AWS has AGY runtime/accounts but all are blocked by `agy_not_signed_in`. | Complete real AWS-side OAuth/login, then revalidate. Do not copy local credentials without explicit approval. |
| `provider_account_unavailable:claude` | external blocker | AWS has Claude runtime/accounts but all are blocked by `claude_not_logged_in`. | Update or replace AWS-side API key/login, then revalidate. |
| `provider_account_unavailable:codex` | external blocker | AWS Codex account exists but is blocked by `upstream_401`. | Update or replace AWS-side API key/login, then revalidate. |
| previous `start_marker_not_found` | fixed | Old mobile prompt asked the model to concatenate a marker, so real output did not match the expected marker; the browser watchdog timer also was not cleared. | Use exact marker output prompts and clear the watchdog timer when evaluation completes. |
| previous `headless_session_run_still_running` | fixed | Slash was sent after message marker appeared but before the child run reached `completed=true`. | Wait for child run completion before slash. |
| previous slash false positive | fixed | `--allow-unsupported-slash` allowed `/status` HTTP `400` to pass. | Strict slash requires HTTP `200` and result `type=slash`; unsupported slash is failure. |

## Metrics

| metric | value | note |
|---|---:|---|
| readyz status | `ready=true` | AWS current default `9527` |
| closure verify exit | `0` | `ok=true`, `exitOk=true` |
| closure session events | `5` | ready/session-created/delta/result/done |
| closure transport fallback | `false` | selected `webrtc` |
| mobile command failures | `0` | message/slash/stop all HTTP `200` |
| mobile browser console errors | `0` | Chromium mobile/PWA smoke |
| mobile duplicate events | `0` | reconnect path |
| resume changed evidence | `0` | no external input changed |

## Interpretation

当前产品链路已经做到：

- 本地 client 能通过已授权 server profile 访问 AWS node registry。
- AWS `aws-current-node` 能作为 node/runtime host 暴露项目与 `opencode` runtime。
- 真实 `opencode` session 可以启动、产生 event stream、完成并返回 marker。
- 移动/PWA 风格客户端可以 attach、发送 message、等待 completion、执行 `/status` slash、stop，并通过 cursor reconnect 验证事件不重复。

当前不能继续靠重复执行解决的问题都在外部输入侧：

- 云边界 UDP/SG/NACL 或 TURN 路径没有新证据。
- WebTransport 缺真实 HTTPS/H3 endpoint。
- Multipath 缺真实 OpenMPTCPRouter/MPTCP underlay。
- Codex/Claude/AGY 缺 AWS 节点侧可调度凭据。

## Next Checks

只有以下任一输入变化后才继续对应检查：

- SG/NACL 或受控 TURN/UDP 路径已证明 UDP 能到达 AWS node。
- AWS CLI/IAM/local AWS CLI readback 已准备好，可以只读检查云策略。
- HTTPS/H3 WebTransport endpoint 已配置。
- 双端 OpenMPTCPRouter/MPTCP underlay 已搭好。
- AWS 节点侧 Codex/Claude/AGY 凭据已重新登录、替换或 revalidate。

在这些输入变化前，下一步不应继续重复 closure verify；应先跑 `fabric closure resume-check`，如果 `changedEvidenceCount=0`，直接停止并输出阻塞原因。

## Verdict

`pass` for business closure and mobile/PWA stream closure on AWS current with `opencode`.

`partial` for advanced transport/provider matrix because remaining WebTransport, TURN/UDP, MPTCP/OMR, Codex/Claude/AGY items require external operator/cloud/provider input.
