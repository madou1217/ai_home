# 2026-06-29 Next milestone diagnostics ledger

## Scope

This is the current authoritative audit for the remaining Fabric milestones on
the AWS-only target. It used the real paired server profile, the real AWS node,
the default `9527` port, real cloud-edge diagnostics, and a real `opencode`
session stream.

Target:

```text
endpoint=http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
nodeId=aws-current-node
provider=opencode
port=9527
diagnosticsFile=/tmp/aih-fabric-next-milestone-audit-20260629.json
```

No mock data was used. The old `152.*`, `155.*`, and `39.104.*` servers were
not touched.

## Command

```text
node bin/ai-home.js fabric closure audit \
  --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_DIAGNOSTICS_LEDGER_STREAM_20260629_2305 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --diagnostics-file /tmp/aih-fabric-next-milestone-audit-20260629.json
```

Result:

```text
ok=true
result=pass
status=usable_with_blockers
closurePlan.state=usable_with_external_blockers
diagnosticsFile.size=186K
```

## Milestone status

The diagnostics file reports every current software-side milestone as pass:

```text
M3=pass
M3.5=pass
M4=pass
M5=pass
M6=pass
runtime=pass
```

The real session proof:

```text
runId=f849d0d5-fd3e-47d1-a03b-4869411b9867
sessionId=ses_0ec31e659ffeCHnF8Yozb0RRuW
marker=AIH_DIAGNOSTICS_LEDGER_STREAM_20260629_2305
selectedTransportKind=webrtc
fallbackUsed=false
cursor=5
completed=true
eventCount=5
events=ready,session-created,delta,result,done
```

This proves the current usable path:

```text
local client -> paired AWS server profile -> aws-current-node -> opencode runtime -> WebRTC stream -> canonical done event
```

## Current next queue

The next queue contains only external blockers. Every item reports
`canAutomate=false`:

| id | owner | reason | verification command |
|---|---|---|---|
| `transport-cloud-edge-udp` | cloud_operator | UDP `9527` packets still do not reach AWS `enp39s0`; host firewall is not the blocker. | `aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `transport-cloud-api-readback` | cloud_operator | AWS CLI/read-only IAM are missing, so AIH cannot inspect SG/NACL rules itself. | `aih fabric transport cloud-edge --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `transport-webtransport-h3` | network_operator | Default `9527` is plain HTTP, not an HTTPS/H3 WebTransport endpoint. | `aih fabric transport webtransport --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `transport-multipath-underlay` | network_operator | No real OpenMPTCPRouter/MPTCP underlay is present. | `aih fabric transport prerequisites --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --node-id aws-current-node --json` |
| `provider-agy-blocked` | operator | AWS AGY accounts are present but not signed in. | `aih fabric provider accounts reauth --provider agy --account-id 1 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `provider-claude-blocked` | operator | AWS Claude accounts are present but not logged in. | `aih fabric provider accounts reauth --provider claude --account-id 1 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |
| `provider-codex-blocked` | operator | AWS Codex account `2` is blocked by `auth_invalid:upstream_401`. | `aih fabric provider accounts reauth --provider codex --account-id 2 --endpoint http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 --json` |

## Cloud-edge evidence

The same audit ran the real cloud-edge diagnostic:

```text
cloudEdgeReady=false
udpReachable=false
packetArrivalCaptured=false
hostFirewallBlocksUdp=false
securityGroupIds=sg-01e33f3412fabfded,sg-01e7f50a205d7b308
blockers=turn_default_udp_9527_unreachable,aws_public_udp_path_blocked,aws_cli_missing,aws_iam_role_missing,aws_local_cli_missing
```

Next actions from the report:

```text
Verify AWS Security Group inbound UDP 9527 for sg-01e33f3412fabfded,sg-01e7f50a205d7b308.
Verify subnet Network ACL inbound UDP and outbound ephemeral return rules for the same path.
Attach a read-only EC2 IAM role or configure local AWS CLI read-only credentials, then inspect SG/NACL rules; this command does not mutate cloud policy.
```

## Failure ledger

This run also records the current failure classes so they are not retried as
unknown timeouts:

| Failure class | Current cause | Do not repeat |
|---|---|---|
| Provider auth | Codex `auth_invalid:upstream_401`, Claude `auth_invalid:claude_not_logged_in`, AGY `auth_invalid:agy_not_signed_in`. | Do not rerun session markers for these providers until AWS-side reauth is completed. |
| UDP/TURN | AWS can bind UDP `9527`, but packets do not arrive at `enp39s0`; host firewall is not blocking. | Do not treat this as a Node.js server issue or solve it with more app retries. |
| Cloud API readback | Remote AWS CLI is missing and the instance has no IAM role; local AWS CLI is also missing. | Do not claim SG/NACL rules were inspected until read-only AWS API access exists. |
| WebTransport | Browser API exists in secure contexts, but the target is not an HTTPS/H3 WebTransport endpoint. | Do not mark WebTransport ready from HTTP, WSS, or WebRTC success. |
| Multipath | No real OpenMPTCPRouter/MPTCP underlay is present. | Do not infer multipath readiness from a single plain HTTP listener. |
| Local extraction error | A local one-off summary command first looked for `transportStatus.reports`, but the diagnostics file uses top-level `reports.transportStatus`. | Use the checked JSON paths from this file when extracting future ledger summaries. |

## Conclusion

The remaining milestone work is not blocked by unverified AIH software gaps at
this point. The software-side closure gate passes on the real AWS node with a
real `opencode` stream. The remaining work needs one of these real external
inputs before promotion can move:

```text
AWS-side provider account reauth for Codex/Claude/AGY
AWS SG/NACL or controlled TURN relay for UDP/TURN
read-only AWS API credentials for SG/NACL readback
real HTTPS/H3 WebTransport endpoint
real OpenMPTCPRouter/MPTCP underlay
```
