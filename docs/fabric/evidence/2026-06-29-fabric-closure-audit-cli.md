# 2026-06-29 Fabric closure audit CLI

This evidence records the new product closure command:

```sh
node bin/ai-home.js fabric closure audit
```

The command aggregates the paired server registry, target node capabilities,
transport status, provider start gates, and an optional real session marker
proof. It does not mock registry/session state.

`--skip-cloud-edge` is available for self-audits on a remote server that does not
have the local AWS SSH key; the default local audit still runs the cloud-edge
diagnostic.

## Changed files

- `lib/cli/services/fabric/closure-audit.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-closure-audit.test.js`

## Local focused verification

```sh
node --check lib/cli/services/fabric/closure-audit.js
node --check lib/cli/commands/fabric-router.js
node --test test/fabric-closure-audit.test.js
node --test test/fabric-closure-audit.test.js test/fabric-nodes-client.test.js test/fabric-transport-status.test.js test/fabric-session-start-client.test.js
npm test
```

Result:

- closure audit focused tests: 7/7 pass.
- adjacent Fabric nodes/status/session tests: 24/24 pass.
- full test suite: 2825/2825 pass.

The focused suite includes the real remote failure mode found during deploy:
when a paired profile or target node inventory is unavailable, closure audit now
returns a blocked report with `nodeReady=false` instead of crashing while
summarizing provider state.

## Real AWS lightweight audit

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --skip-session \
  --json
```

Result:

- status: `usable_with_blockers`
- coreReady: `true`
- nodeReady: `true`
- transportReady: `true`
- targetProviderReady: `true`
- sessionReady: `true` because the session proof was explicitly skipped.
- selectedTransportKind: `webrtc`
- fallbackUsed: `null`
- startableProviders: `opencode`
- M3: pass
- M3.5: pass
- M4/M5: unchecked because `--skip-session` was used.
- M6: pass, `default=webrtc fallback=true advanced=true`
- runtime: pass for selected provider `opencode`

The same report kept the remaining real blockers visible:

- `codex:provider_account_unavailable:codex`
- `claude:provider_account_unavailable:claude`
- `agy:provider_account_unavailable:agy`
- `webtransport:webtransport_endpoint_not_configured`
- `webtransport:webtransport_not_promoted`
- `omr:openmptcprouter_not_detected`
- `mptcp:mptcp_data_plane_not_promoted`
- `turn_default_udp_9527_unreachable`
- `aws_public_udp_path_blocked`
- `aws_cli_missing`
- `aws_iam_role_missing`

## Real AWS session marker audit

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_CLOSURE_AUDIT_FINAL_REAL_20260629_1706 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --diagnostics-file /tmp/aih-fabric-closure-audit-final-20260629-1706.json
```

Result:

```text
AIH Fabric closure audit
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  node_id: aws-current-node
  provider: opencode
  status: usable_with_blockers
  core_ready: yes
  selected_transport: webrtc
  fallback_used: no
  startable_providers: opencode
  can_use_ssh: yes
  can_open_project: yes
  session_proof: pass run=6c715b38-3c08-4abd-a6f9-647fecab3c7c marker=yes done=yes events=5
  milestones:
    - M3: pass (node=aws-current-node relay=true project_host=true)
    - M3.5: pass (actions=8 runtime_gaps=3 ssh=true)
    - M4: pass (run=6c715b38-3c08-4abd-a6f9-647fecab3c7c marker=true)
    - M5: pass (events=5 done=true cursor=5)
    - M6: pass (default=webrtc fallback=true advanced=true)
    - runtime: pass (opencode: start=true)
  runtime_blockers:
    - agy: provider_account_unavailable:agy
    - claude: provider_account_unavailable:claude
    - codex: provider_account_unavailable:codex
  result: pass
```

Parsed diagnostics summary:

```json
{
  "ok": true,
  "exitOk": true,
  "status": "usable_with_blockers",
  "runId": "6c715b38-3c08-4abd-a6f9-647fecab3c7c",
  "markerFound": true,
  "doneObserved": true,
  "eventCount": 5,
  "selectedTransport": "webrtc",
  "fallbackUsed": false,
  "providers": ["opencode"]
}
```

## AWS deployment verification

Deployment uses a clean `git archive HEAD` artifact copied to:

```text
/home/ubuntu/aih-fabric-current/source-<commit>.tar.gz
```

Remote commands:

```sh
cd /home/ubuntu/aih-fabric-current
tar -xzf source-<commit>.tar.gz
printf '%s\n' '<commit>' > DEPLOYED_GIT_HEAD
.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/closure-audit.js
.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/commands/fabric-router.js
.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-closure-audit.test.js
```

Remote result:

- `node --check` passed for the closure audit service and router.
- AWS focused closure audit tests: 7/7 pass.

Remote self-audit command:

```sh
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
  .node-runtime/node-v22.16.0-linux-x64/bin/node \
  bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --skip-session \
  --skip-cloud-edge
```

Remote self-audit result:

- process exit status: `1`
- status: `blocked`
- blocker: `readiness:ready_server_profile_missing`
- conclusion: AWS server data does not contain a ready self-paired server
  profile, but the CLI now returns a structured blocked report instead of
  crashing while summarizing provider state.

## Real AWS strict gate

Command:

```sh
node bin/ai-home.js fabric closure audit \
  --node-id aws-current-node \
  --provider opencode \
  --skip-session \
  --fail-on-incomplete
```

Result:

- process exit status: `1`
- report result: `incomplete`
- reason: core remote development is usable, but strict mode keeps unchecked
  M4/M5 session proof and all external blockers as failures.

## Conclusion

AWS current default `9527` is usable for the selected `opencode` provider:

- local client can read the paired AWS registry;
- `aws-current-node` is visible as node + relay + project host + runtime host;
- local SSH binding is visible;
- default remote-development transport is WebRTC with relay fallback ready;
- a real OpenCode session produced the requested marker through Fabric session
  start/events and did not use fallback.

Remaining work is not a Fabric connectivity blocker:

- Codex/Claude/AGY accounts are not schedulable on AWS.
- TURN/WebTransport/MPTCP/OpenMPTCPRouter still need real external prerequisites
  before they can be promoted as independent advanced transport paths.
