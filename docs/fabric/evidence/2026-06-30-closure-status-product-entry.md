# 2026-06-30 closure status product entry

## Scope

为 Fabric 增加轻量产品入口 `aih fabric closure status`，用于回答“当前 AWS node 能用什么、不能继续自动推进什么”。

本轮只使用 AWS current：

- endpoint: `http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- node: `aws-current-node`
- provider: `opencode`
- project: `/home/ubuntu/aih-fabric-current`
- port: default `9527`

不触碰旧服务器，不新增端口，不上传本地 provider 凭据，不使用 mock 数据。

## Product issue closed

之前 `closure status` 复用了 audit 报告后，仍把 `session-marker-proof-unchecked` 放进 `closurePlan.immediateNext` / `failureLedger.nextAutomatable`。这会让用户在已经有真实 closure proof 的情况下继续被引导重复跑 session proof，形成“测测测”的循环。

本次修复后的语义：

- `closure audit` / `closure verify` 仍保留真实 session proof 语义。
- `closure status` 只做状态读取，不启动 session proof，不跑 cloud-edge 深诊断。
- `closure status` 的 `closurePlan` / `failureLedger` 会移除 status 自己跳过的 `session-marker-proof-unchecked`。
- `statusView` 直接输出当前可用能力、blocked providers、external blockers 和是否还能自动继续。

## Commands

```bash
node "bin/ai-home.js" fabric closure status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --json
```

```bash
node "bin/ai-home.js" fabric closure status \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --node-id "aws-current-node" \
  --provider "opencode"
```

## Real AWS result

JSON status returned:

- `ok=true`
- `exitOk=true`
- `workflow=closure_status`
- `summary.status=usable_with_blockers`
- `summary.coreReady=true`
- `summary.nodeReady=true`
- `summary.transportReady=true`
- `summary.targetProviderReady=true`
- `summary.selectedTransportKind=webrtc`
- `statusView.mode=status_only`
- `statusView.sessionProof=not_run_by_status`
- `containsSkippedSessionProofNext=false`
- `statusView.canContinueWithoutInput=false`
- `statusView.decision=stop_confirmation_required`
- `reports.sessionStart=null`
- `transportStatus.steps.cloudEdge.skipped=true`

Current usable abilities:

- `node_registry`
- `relay_node`
- `project_host`
- `ssh_bootstrap`
- `open_project`
- `transport:webrtc`
- `start-session:opencode`

Blocked providers on AWS current:

- `agy`: `provider_account_unavailable:agy`
- `claude`: `provider_account_unavailable:claude`
- `codex`: `provider_account_unavailable:codex`

Remaining external prerequisites:

- WebTransport: `webtransport:webtransport_h3_endpoint_missing`
- Multipath: `omr:openmptcprouter_not_detected`, `mptcp:mptcp_data_plane_not_promoted`
- Provider credentials: AWS-side `agy`, `claude`, `codex` accounts are not schedulable

## Failure ledger update

| issue | root cause | fix | repeat prevention |
|---|---|---|---|
| `closure status` asked for `session-marker-proof-unchecked` | Status command used audit's skipped-session plan without projecting it into a status-only view. | Added a status projection that removes the skipped proof item and rebuilds the failure ledger for the status workflow. | Do not use audit's skipped proof queue as a product status next step. Status answers current ability, verify proves end-to-end session. |
| Skipped proof could be described like proven proof in repeat-prevention text | `failure-ledger` treated `streamProof.ok=true` without checking `streamProof.skipped`. | Repeat-prevention now requires `streamProof.skipped !== true` before saying business stream proof is already proven. | Never equate a skipped proof with a completed proof in machine-readable ledger text. |

## Verification

- Local focused test: `node --test "test/fabric-closure-audit.test.js"` -> `19/19 pass`
- Real AWS status JSON: `ok=true`, `exitOk=true`, `workflow=closure_status`
- Real AWS human output: no `session-marker-proof-unchecked`; immediate next is `transport-webtransport-h3`
- Real AWS status did not start a session: `reports.sessionStart=null`
- Real AWS status skipped cloud-edge deep diagnostic: `transportStatus.steps.cloudEdge.skipped=true`

## Verdict

`pass` for the product status entry on AWS current.

The current product state is usable for AWS `opencode` through `webrtc`, project open, SSH bootstrap, relay/node registry. The remaining work cannot be solved by repeated status/verify runs; it needs external HTTPS/H3 WebTransport, real OpenMPTCPRouter/MPTCP underlay, or AWS-side Codex/Claude/AGY credential repair.
