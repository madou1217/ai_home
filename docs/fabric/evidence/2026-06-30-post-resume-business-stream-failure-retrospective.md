# 2026-06-30 Post-Resume Business Stream Failure Retrospective

目标：先确认真实业务闭环和真实串流，再记录本轮所有失败/阻塞的原因，避免继续在同一类问题上重复空跑。

约束：

- 只使用 AWS current：`http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527`
- 只使用默认端口 `9527`
- 不碰旧 VPS
- 不上传本地 provider 凭据
- 不修改 AWS 云配置
- 不使用 mock 数据

## 1. 当前 AWS Server Ready

命令：

```bash
curl -s "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527/readyz"
```

结果：

- `ok=true`
- `ready=true`
- accounts: `codex=1`, `claude=4`, `agy=7`, `opencode=1`

## 2. Resume Check

命令：

```bash
node "bin/ai-home.js" fabric closure resume-check \
  --handoff-file "/tmp/aih-fabric-target-local-closure-handoff-20260630.json" \
  --json
```

结果：

- `ok=true`
- `previousDecision.decision=stop_awaiting_external_input`
- `checks[cloud-udp-policy].status=unchanged`
- `checks[cloud-udp-policy].cloudApi.cloudApiCredentialsReady=false`
- `checks[cloud-udp-policy].cloudApi.blockers=["aws_cli_missing","aws_iam_role_missing","aws_local_cli_missing"]`
- `checks[webtransport-h3-endpoint].status=unchanged`
- `checks[multipath-underlay].status=unchanged`
- `checks[provider-credentials].status=unchanged`
- `resume.canContinueWithoutInput=false`
- `resume.changedEvidenceCount=0`

结论：没有新的外部输入。继续跑深度 transport/session 诊断不会让 AWS SG/NACL、TURN、H3、MPTCP 或 provider 凭据自动变好。

## 3. Business Closure And Stream Proof

命令：

```bash
node "bin/ai-home.js" fabric closure verify \
  --node-id "aws-current-node" \
  --provider "opencode" \
  --endpoint "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527" \
  --diagnostics-file "/tmp/aih-fabric-closure-verify-20260630-post-resume.json" \
  --handoff-file "/tmp/aih-fabric-closure-handoff-20260630-post-resume.json" \
  --json
```

结果：

- `ok=true`
- `workflow=closure_verify`
- `summary.status=usable_with_blockers`
- `selectedTransportKind=webrtc`
- `fallbackUsed=false`
- `sessionProof.ok=true`
- `sessionProof.marker=AIH_FABRIC_CLOSURE_AUDIT_20260630_025104`
- `runId=42baea7f-5161-48b1-a739-1a47a6274cfd`
- `sessionId=ses_0e98ff286ffe5vlC0pgGugl4nf`
- stream events: `ready -> session-created -> delta -> result -> done`
- `eventCount=5`
- `failureLedger.status=usable_with_recorded_failures`
- `failureLedger.summary.total=7`
- `failureLedger.summary.external=7`
- `failureLedger.automation.runnableCount=0`
- `failureLedger.automation.canContinueWithoutInput=false`

结论：业务闭环和串流已经真实通过。当前产品可用路径是本地 client -> AWS server profile -> AWS node -> WebRTC -> `opencode` real session。

## 4. Failure Ledger

| Failure | Real cause | Evidence | Repeat prevention |
|---|---|---|---|
| 反复超时/反复跑 closure 没有推进 | 没有先用 handoff 做 resume 判断，导致在外部输入未变化时重复跑同一批诊断。 | `resume.changedEvidenceCount=0`，`resume.canContinueWithoutInput=false`。 | 每次继续前先跑 `closure resume-check`；只有 `changedEvidenceCount>0` 或用户明确要求最新 proof 时才跑 `closure verify`。 |
| Cloud UDP 不通 | 本机 UDP 发到 `9527` 超时，AWS `tcpdump` 在 `enp39s0` 抓到 0 包；AWS host firewall 未阻塞。真实问题在 SG/NACL/云边界或受控 TURN/UDP 路径，不是 AIH session 逻辑。 | `udp.local.error=udp_echo_timeout`，`packetCapture.captured=false`，`hostFirewallBlocksUdp=false`，blockers 包含 `turn_default_udp_9527_unreachable`、`aws_public_udp_path_blocked`。 | 不并行跑 UDP probe；先提供 SG/NACL readback 或 controlled TURN 证据，再重跑 cloud-edge。 |
| SG/NACL 不能自动读回 | AWS node 没有 AWS CLI 和 IAM role，本机也没有 AWS CLI readback。AIH 当前只能证明缺少只读诊断权限，不能读取云规则。 | blockers: `aws_cli_missing`、`aws_iam_role_missing`、`aws_local_cli_missing`。 | 只有在 AWS node 加只读 IAM/CLI，或本机配置只读 AWS CLI 后，才重跑 cloud API readback。 |
| WebTransport 不能 promotion | 当前默认 `9527` 是 plain HTTP，不是 HTTPS/H3 WebTransport endpoint。 | blocker: `webtransport:webtransport_h3_endpoint_missing`。 | 不把它当浏览器能力问题；先部署真实 HTTPS/H3 endpoint，再跑 browser WebTransport probe。 |
| Multipath 不能 promotion | 没有双端 OpenMPTCPRouter/MPTCP underlay，不能从单个 Linux 节点或普通 HTTP listener 推断 multipath ready。 | blockers: `omr:openmptcprouter_not_detected`、`mptcp:mptcp_data_plane_not_promoted`。 | 必须有双端 underlay evidence，再跑 prerequisites/promotion-gate。 |
| Codex 不能在 AWS node start session | AWS 侧 Codex 账号存在但不可调度，真实原因是上游 401。 | `provider=codex`，`runtime:auth_invalid:upstream_401=1`。 | 不当 transport failure 处理；更新/替换 AWS 侧 API key 后跑 provider audit/revalidate。 |
| Claude 不能在 AWS node start session | AWS 侧 Claude CLI/runtime 存在，但账号未登录或 API key 不可用。 | `provider=claude`，`runtime:auth_invalid:claude_not_logged_in=4`。 | 不复制本机凭据；需 operator 明确处理 AWS 侧账号后 revalidate。 |
| AGY 不能在 AWS node start session | AWS 侧 AGY runtime 存在，但 OAuth 未登录。 | `provider=agy`，`runtime:auth_invalid:agy_not_signed_in=7`。 | 需要 AWS 侧真实 OAuth/login flow，再 provider audit/revalidate。 |
| AWS-local cloud API snapshot 曾报泛化失败 | 之前在 AWS 本机运行时还 SSH 自己，找 `/home/ubuntu/.ssh/aws.pem` 导致假失败。 | 旧现象为 `aws_cloud_api_probe_failed` 或 publickey。 | 已修复为 target-local 本机执行；后续看到 generic cloud API failed 必须先检查 commandMode/proofScope。 |
| UDP probe 曾出现 busy/并发假失败 | 多个默认端口 UDP 诊断同时绑定/抓包，制造 `turn_default_udp_probe_busy`。 | 已归类为 `diagnostic_concurrency`。 | transport 诊断串行执行；busy 不归为云边界失败。 |

## 5. Current Stop Condition

当前不是代码循环问题。最新 handoff 的执行结论是：

- `decision=stop_awaiting_external_input`
- `canContinueWithoutInput=false`
- `nextCommand=""`

恢复条件：

1. SG/NACL readback 或 controlled TURN/UDP 能证明 packet 到达 AWS node。
2. 真实 HTTPS/H3 WebTransport endpoint 已部署并能完成 browser handshake。
3. 双端 MPTCP/OpenMPTCPRouter underlay 已存在，并能做 promoted transport smoke。
4. AWS 侧 Codex/Claude/AGY 凭据被重新认证或替换，provider audit 清除 auth blockers。

在这些输入变化前，继续跑 closure/session proof 只能得到同样结论。
