# 2026-06-27 Real VPS, Claude Worker, and Isolated Deploy Evidence

## Scope

This record captures real, non-mock validation for the Fabric server deployment path on the user-provided VPS hosts and the replacement AWS host, plus the current `aih claude` worker boundary.

No systemd unit was installed. No firewall, security group, package manager, or production API configuration was changed. No secret values were printed in this record.

This file preserves the earlier three-host evidence for traceability. After the user updates on 2026-06-27, `39.104.59.31` and `155.248.183.169` are retired and must not be used for new validation.

## Local Artifacts

- Local cwd: `/Users/model/projects/feature/ai_home`
- Account export: `tmp/fabric-real-deploy/aih-accounts-real-20260627.zip`
- Account export sha256: `c7af492b148877819259b8bf2e48c601dd9a35998b04cd609ce7b117ee07dfcf`
- Official Linux Node runtime sha256: `f4cb75bb036f0d0eddf6b79d9596df1aaab9ddccd6a20bf489be5abe9467e84e`
- glibc-217 Node runtime sha256: `b9989f629d719a08fe69f7e333cc31d1be2d8388e3277968a2beae437c8d6e7b`
- Export zip contents: 15 flat JSON account records
- Exported provider records: agy, claude, codex, gemini
- Redacted structure check: records contain credential fields; no raw keys/tokens were printed

## Latest Local M2 Server Profile Bundle Evidence

Scope: local product entry for multi-client / mobile-shell server profile transfer.

Changed behavior:

- `web/src/services/control-plane-profiles.ts` can create, serialize, parse, and import `aih-control-plane-profile-bundle` v1.
- `web/src/pages/FabricServerSetup.tsx` exposes `导出当前`, `导出全部`, and `导入 Profile`.
- Exported bundle includes endpoint, descriptor, node/account/session summary, and warnings.
- Exported bundle does not include `deviceToken`, local profile id, management key, client key, API key, refresh token, or other raw secret fields.
- Importing onto a new client creates `discovered/unpaired` profiles, so the new device must pair and receive its own device token.

Commands:

```bash
node --test "test/control-plane-profiles.test.js" "test/fabric-profile-gate.test.js"
npm --prefix "web" run build
```

Results:

```text
control-plane-profiles + fabric-profile-gate: 29/29 pass
web build: tsc && vite build pass
vite warning: existing large antd/chat chunks only
```

Security interpretation:

- The transfer artifact is a portable server descriptor, not an authentication backup.
- This matches the mobile shell requirement: a client can add multiple AIH servers, but every device still has its own pairing boundary.

Verdict: pass for local profile bundle product entry. It is not yet a cross-device browser/mobile smoke.

## Latest Claude Worker Boundary

The correct worker path is the AIH Server profile path:

```bash
node "bin/ai-home.js" claude --print --no-session-persistence --permission-mode plan "<frontend review task>"
```

Observed result:

```text
[aih] Running claude (AIH Server) via PTY Sandbox
[aih] Local AIH server source is stale, restarting it now
[aih] Waiting for claude to boot...
```

The call stayed in boot wait for more than 60 seconds and was interrupted. It produced no review text and no code diff.

Incorrect worker paths attempted earlier in this session:

```text
node bin/ai-home.js claude 4 ...
node bin/ai-home.js claude 5 ...
```

Those direct-account attempts must not be counted as valid AIH Claude worker participation for Fabric frontend work.

## Current Active VPS Set After Server Replacement

Current targets for new evidence:

| Role | SSH target | Remote dir | Port | Current state |
| --- | --- | --- | ---: | --- |
| Active AWS Japan VPS | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` with `/Users/model/.ssh/aws.pem` | `/home/ubuntu/aih-fabric-current` | 9527 | current default-port deploy, `/v1/responses`, native relay Codex session, and abort cleanup passed |
| Historical AWS Japan evidence | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` with `/Users/model/.ssh/aws.pem` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v16` through `/home/ubuntu/aih-fabric-real-20260627-isolated-v22` | 19684 / local smoke ports / 19886 / 19887 | preserved for traceability only; not the current deployment shape |
| Retired Japan VPS | `ubuntu@155.248.183.169` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v12` | 19281 | historical evidence only; retired by user instruction because the link is too slow |
| Unstable Japan VPS | `opc@152.70.105.41` | `/home/opc/aih-fabric-real-20260627-isolated-v13` | 19382 | SSH banner timeout during follow-up inspection; not a current stable validation target |
| Retired | `root@39.104.59.31` | n/a | n/a | retired by user instruction; no new validation |

## Latest Current-only AWS Evidence

Scope: converge the active AWS host to one fixed deployment directory and prove the current source works there.

## Latest Default 9527 AWS Recovery Evidence

Scope: default-port current deployment, real Codex `/v1/responses`, native relay/control-plane session-start, and post-marker cleanup.

Deploy command:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir "/home/ubuntu/aih-fabric-current" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --skip-build \
  --skip-import
```

Deploy result:

```text
source artifact sha256=94de613e7fe53fd1a0b145307c8256f4e3c8990f2cd2a3df41ab59bf6f1a6895
source artifact bytes=26340463
node-runtime-cache-hit
node-modules-cache-hit
remote-start: port=9527
pid=77912
listen: http://0.0.0.0:9527
codex_client_version: 0.142.3
accounts: codex=3, gemini=1, claude=4, agy=7, opencode=0
done: remoteDir=/home/ubuntu/aih-fabric-current port=9527
```

Post-deploy checks:

```text
ps: one process only -> 77912 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
/readyz: ready=true, accounts codex=3/gemini=1/claude=4/agy=7/opencode=0
no --port 9528 process
no codex.aih-original / codex-linux-x64 / node relay residual process
```

Real default-port Codex `/v1/responses` requests after redeploy:

```text
POST http://127.0.0.1:9527/v1/responses
headers: content-type=application/json, authorization=Bearer dummy, x-provider=codex

non-stream:
  body: model=gpt-5.5, store=false, stream=false, input=list
  status: 200
  marker_present: true
  marker: AIH_AWS_CODEX_NONSTREAM_REDEPLOY_9527_OK_20260627
  response.output_text: AIH_AWS_CODEX_NONSTREAM_REDEPLOY_9527_OK_20260627

stream:
  body: model=gpt-5.5, store=false, stream=true, input=list
  status: 200
  marker_present: true
  marker: AIH_AWS_CODEX_STREAM_REDEPLOY_9527_OK_20260627
  response.output_text.done text: AIH_AWS_CODEX_STREAM_REDEPLOY_9527_OK_20260627
```

Real native relay/control-plane Codex session:

```text
command shape:
node scripts/fabric-real-outbound-relay-smoke.js \
  --endpoint http://127.0.0.1:9527 \
  --host-home /home/ubuntu/aih-fabric-current/.aih-host-home \
  --node-id aws-default-9527-a1-abort \
  --session-provider codex \
  --session-account 1 \
  --session-model gpt-5.5 \
  --session-project /home/ubuntu/aih-fabric-current

result:
ok=true
control.health=true
node.health=true
relay.online=true
relay.status=online
relay.transportKind=relay
relay.sessionIdPresent=true
device.paired=true
device.scopes=control-plane:read,nodes:read,sessions:read,sessions:write,status:read
sessions.status=200
session.startStatus=200
session.runIdPresent=true
session.expectedOutputFound=true
marker=AIH_AWS_NATIVE_RELAY_SESSION_ABORT_9527_OK_20260627
eventCounts.ready=1
eventCounts.terminal-output=437
eventCounts.aborted=1
quit.status=200
quit.accepted=true
cleanup.completed=true
cleanup.abort.status=200
cleanup.abort.accepted=true
post-smoke ps: only 77912 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

Important negative evidence:

```text
account 3 native Codex session failed with 401 Incorrect API key provided: yesboss-****udou.
This is an account credential failure, not a relay/control-plane failure.
```

Public HTTP ingress check from the local machine:

```text
nc -vz -w 5 43.207.102.163 9527 -> TCP connect succeeded
curl --noproxy "*" --max-time 10 http://43.207.102.163:9527/readyz -> timeout with 0 bytes received
```

Fixes and regression used for this pass:

```text
Codex runtime trust:
  lib/server/codex-project-registry.js writes trust config to the account CODEX_HOME when provided.
  lib/server/control-plane-device-session-start.js passes the account .codex config dir before spawning native Codex.

Native run cleanup:
  lib/server/control-plane-device-session-start.js exposes abortNativeSessionRun.
  lib/server/node-rpc-router.js wires local session-run-abort and device-node-session-run-abort.
  lib/cli/services/node/relay-client.js and lib/server/remote/relay-server.js allowlist session-run-abort.
  scripts/fabric-real-outbound-relay-smoke.js requires marker found plus completed cleanup for ok=true.

Checks:
  node --check lib/server/control-plane-device-session-start.js lib/server/node-rpc-router.js lib/cli/services/node/relay-client.js lib/server/remote/relay-server.js scripts/fabric-real-outbound-relay-smoke.js -> pass
  node --test test/control-plane-device-session-start.test.js test/server-node-rpc-wiring.test.js test/node-relay-client.test.js test/fabric-real-outbound-relay-smoke.test.js test/codex-project-registry.test.js -> 42/42 pass
  node --test test/runtime.node-pty-loader.test.js test/pty-launch.test.js test/server.codex-adapter.test.js test/server-node-rpc-wiring.test.js test/node-relay-client.test.js test/fabric-real-vps-deploy.test.js -> 79/79 pass
```

Interpretation:

- AWS current default `9527` now has real `/v1/responses` non-stream, real `/v1/responses` stream, and real native relay/control-plane Codex TUI session evidence.
- The cleanup gap is closed for this smoke: `/quit` was accepted, explicit abort was accepted, and process-level verification found no Codex/relay residual.
- Raw public HTTP ingress still does not work even though TCP connect succeeds; product default should continue to use outbound relay/overlay instead of relying on exposed high ports.

Local default-port continuation while AWS was unavailable:

```text
Existing local LaunchAgent com.clawdcodex.ai_home occupied 9527 and returned node_rpc_not_found for session-start.
The LaunchAgent was temporarily booted out, current worktree server was started with AIH_SERVER_STRICT_PORT=1 on 0.0.0.0:9527, then the LaunchAgent was restored.
No alternate port was used for the accepted local evidence; a brief accidental 9528 fallback attempt was stopped immediately and not counted as evidence.
```

Local current-worktree `/v1/responses` non-stream evidence:

```text
POST http://127.0.0.1:9527/v1/responses
headers: content-type=application/json, authorization=Bearer dummy, x-provider=codex
body: model=gpt-5.5, store=false, stream=false, input=list
status: 200
marker_present: true
marker: AIH_LOCAL_CODEX_NONSTREAM_9527_OK_20260627
response.output contains message output_text
response.output_text == AIH_LOCAL_CODEX_NONSTREAM_9527_OK_20260627
```

Local current-worktree remote session-start evidence:

```text
POST http://127.0.0.1:9527/v0/node-rpc/session-start
provider=codex, accountId=3, model=gpt-5.5, projectPath=/Users/model/projects/feature/ai_home
status: 200
runId accepted: true
eventTypes: ready=1, terminal-output=2730
marker_present_in_terminal_output: true
marker: AIH_LOCAL_NATIVE_SESSION_RESULT_9527_OK_20260627_C
cleanup: session-run-input /quit returned 200; remaining marker child processes were killed; original LaunchAgent was restored and /readyz returned ready=true
```

Local fixes added after native proof:

```text
lib/runtime/node-pty-loader.js:
- require success is no longer enough; the loader performs a spawn self-test
- if node-pty can require but spawn fails with posix_spawnp, fallback to @lydell/node-pty

lib/runtime/pty-launch.js:
- POSIX shell shims such as /Users/model/Library/pnpm/codex are wrapped as /bin/sh <shim> ...
- this avoids node-pty failing to exec shell shims directly

Tests:
node --check lib/runtime/node-pty-loader.js lib/runtime/pty-launch.js -> pass
node --test test/runtime.node-pty-loader.test.js test/pty-launch.test.js -> 9/9 pass
node --test test/runtime.node-pty-loader.test.js test/pty-launch.test.js test/server.codex-adapter.test.js test/server-node-rpc-wiring.test.js test/node-relay-client.test.js test/fabric-real-vps-deploy.test.js -> 79/79 pass
```

Updated interpretation:

- This local section is retained as historical debugging evidence from the AWS outage window.
- The AWS host later recovered and the current `/home/ubuntu/aih-fabric-current` default `9527` deployment now has real `/v1/responses` and native relay/control-plane session evidence in the section above.
- The remaining infrastructure gap is raw public HTTP ingress: TCP connects, but HTTP `/readyz` from the local machine still times out with 0 bytes.

Earlier transfer-only deployment discipline:

- Remote dir: `/home/ubuntu/aih-fabric-current`.
- No vNN / isolated directory was created.
- No account zip was transferred because this was `--skip-import`.
- No persistent server was started because this was `--skip-start`.
- No systemd unit, firewall/security group, package manager, or system configuration was changed.

Deploy command:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --remote-dir "/home/ubuntu/aih-fabric-current" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --skip-build \
  --skip-import \
  --skip-start
```

Deploy result:

```text
target: ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
source-cache-miss
upload artifact sha256=dbfeed88fce56b2f80926c3496593e9cbf78c15ef0cd5a374bcf99945f3f0956 bytes=26319739
source-cache-hit
node-runtime-cache-hit
node-runtime-ready
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-current port=18080
```

Remote focused tests:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH && \
   node --test test/fabric-real-vps-deploy.test.js test/control-plane-profiles.test.js test/fabric-profile-gate.test.js"
```

Result: 49/49 pass.

Remote Web build:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH && \
   npm --prefix web run build"
```

Result: `tsc && vite build` pass. Only the existing Vite chunk-size warning remains.

Remote outbound relay smoke:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-current && \
   export PATH=/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin:\$PATH && \
   node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000"
```

Result:

```text
ok=true
control.health=true
node.health=true
relay.online=true
relay.status=online
relay.transportKind=relay
relay.sessionIdPresent=true
relay.transportStatuses=relay:up
device.paired=true
sessions.status=200
sessions.ok=true
sessions.rpc=control_plane.device.node_sessions
sessions.total=0
sessions.returned=0
```

Remote cleanup verification:

```text
find /home/ubuntu -maxdepth 1 -type d \( -name 'aih-fabric-real-*' -o -name 'aih-fabric-current' \)
-> aih-fabric-current

ps grep for aih-fabric-current / ai-home.js server serve / node relay connect / fabric registry agent / fabric-real-outbound-relay-smoke
-> no rows
```

Interpretation: the active AWS host is now back to a single current directory with a reproducible transfer-only deploy path and a real process-level outbound relay smoke. This still does not prove a native Codex/Claude project session; it proves the control/node relay path needed before that.

Public HTTP ingress check from the local machine:

```bash
node "bin/ai-home.js" node bootstrap probe \
  --http "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:19484" \
  --timeout-ms 5000 \
  --json
```

Result:

```text
http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:19484/healthz -> timeout, latency=5007ms
summary: total=1, httpReady=0, httpFailed=1
executionPlan=[]
```

Interpretation: the active AWS node has proven local server/registry/agent data-plane evidence, but raw public HTTP ingress is still not available. Product default must remain outbound relay/overlay first.

`152.70.105.41` follow-up inspection:

```text
ssh pgrep/uptime checks both failed with "Connection timed out during banner exchange".
```

No remote process was killed and no remote system configuration was changed.

### Latest AWS V14 Evidence

Deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v14" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19484 \
  --skip-build
```

Deploy result:

```text
runtime cache hit
node_modules cache hit
imported=15 duplicates=0 invalid=0 failed=0
server started on 0.0.0.0:19484
account pool: codex=3, gemini=1, claude=4, agy=7
```

Service status read-only check:

```bash
node "bin/ai-home.js" fabric registry agent service status \
  --node-id "vps-aws-43-jp-v14" \
  --json
```

Result:

```text
ok=true
type=systemd-user
installed=false
enabled=false
active=false
state=missing
file=/home/ubuntu/aih-fabric-real-20260627-isolated-v14/.aih-host-home/.config/systemd/user/com.clawdcodex.ai_home.fabric-registry-agent.vps-aws-43-jp-v14.service
logFile=/home/ubuntu/aih-fabric-real-20260627-isolated-v14/.aih-host-home/.ai_home/fabric-registry-agent-vps-aws-43-jp-v14.log
```

Registry publish, heartbeat, and foreground agent probe:

```bash
node "scripts/fabric-real-vps-registry-publish.js" \
  --port 19484 \
  --node-id "vps-aws-43-jp-v14" \
  --name "AWS 43 Japan v14" \
  --bandwidth-kbps 3072 \
  --agent-count 2 \
  --agent-interval-ms 1000
```

Result:

```text
ok=true
publish.ok=true
heartbeat.ok=true
agent.ok=true
agent.attempts=2
agent.failures=0
agent.probes[0].status=tcp_echo_pass
agent.probes[0].successes=1
agent.probes[0].failures=0
registryCounts: nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
hostname=ip-172-31-47-163
```

This pass did not install the service. It only confirmed that the service manager can report the expected missing state on the real AWS host.

### Latest Source Artifact Cache Evidence

The real deploy script now defaults to source artifact cache mode:

- Local source is archived as tar piped through `gzip -n`, so gzip header timestamps do not poison the cache key.
- The remote cache path is `<remote-parent>/.aih-source-cache/source-<sha256>.tar.gz`.
- The remote cache artifact is verified with `sha256sum` before extraction.
- `--source-transfer stream` or `--no-source-cache` remains available as the old direct tar stream fallback.

Local deterministic artifact check:

```text
first.sha256=2ff0d858463a62a11fb7a21d7710c451980bfee3db99d83a3369e9712fb13aad
second.sha256=2ff0d858463a62a11fb7a21d7710c451980bfee3db99d83a3369e9712fb13aad
first.bytes=26298869
second.bytes=26298869
stable=true
```

AWS v16 full deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v16" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19684 \
  --skip-build
```

AWS v16 deploy result:

```text
source-cache-miss
upload artifact sha256=2ff0d858463a62a11fb7a21d7710c451980bfee3db99d83a3369e9712fb13aad bytes=26298869
source-cache-hit
node-runtime-cache-hit
node-modules-cache-hit
imported=15 duplicates=0 invalid=0 failed=0
server started on 0.0.0.0:19684
account pool: codex=3, gemini=1, claude=4, agy=7
```

AWS v17 transfer-only cache-hit verification:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v17" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19784 \
  --skip-build \
  --skip-import \
  --skip-start
```

Result:

```text
source-cache-hit
transfer-source: cache hit /home/ubuntu/.aih-source-cache/source-2ff0d858463a62a11fb7a21d7710c451980bfee3db99d83a3369e9712fb13aad.tar.gz
node-runtime-cache-hit
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-real-20260627-isolated-v17 port=19784
```

AWS v16 registry publish, heartbeat, and foreground agent probe:

```text
ok=true
publish.ok=true
heartbeat.ok=true
agent.ok=true
agent.attempts=2
agent.failures=0
agent.probes[0].status=tcp_echo_pass
agent.probes[0].successes=1
agent.probes[0].failures=0
registryCounts: nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
hostname=ip-172-31-47-163
```

AWS v16 service status read-only check:

```text
ok=true
type=systemd-user
installed=false
enabled=false
active=false
state=missing
file=/home/ubuntu/aih-fabric-real-20260627-isolated-v16/.aih-host-home/.config/systemd/user/com.clawdcodex.ai_home.fabric-registry-agent.vps-aws-43-jp-v16.service
logFile=/home/ubuntu/aih-fabric-real-20260627-isolated-v16/.aih-host-home/.ai_home/fabric-registry-agent-vps-aws-43-jp-v16.log
```

Public HTTP ingress remains unavailable:

```text
http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:19684/healthz -> timeout, latency=5006ms
summary: total=1, httpReady=0, httpFailed=1
executionPlan=[]
```

### Latest Outbound Relay Smoke Evidence

New script:

```bash
node "scripts/fabric-real-outbound-relay-smoke.js" --timeout-ms 30000
```

What the script does:

- Starts two real AIH server child processes with isolated `AIH_HOST_HOME`, `REAL_HOME`, and `HOME`.
- Writes a real remote node registry entry and a real remote-node secret into the temporary Control Plane store.
- Writes the node local server config into the temporary node store.
- Pairs a real control-plane device token in-process.
- Starts a real `aih node relay connect <control-url> --node-id relay-smoke-node` child process.
- Calls `/v0/node-rpc/device-nodes` and `/v0/node-rpc/device-node-sessions` through the Control Plane HTTP API.
- Prints a sanitized JSON report and then terminates all smoke child processes.

Local run result:

```text
ok=true
mode=outbound-relay
relay.status=online
relay.transportKind=relay
relay.transportStatuses=relay:up
sessions.status=200
sessions.rpc=control_plane.device.node_sessions
sessions.total=0
sessions.returned=0
```

Focused local verification:

```bash
node --test "test/fabric-real-outbound-relay-smoke.test.js" "test/node-relay-client.test.js" "test/server-node-rpc-wiring.test.js"
```

Result: 23/23 pass.

AWS v18 deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v18" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19884 \
  --skip-build \
  --skip-import \
  --skip-start
```

AWS v18 deploy result:

```text
source-cache-miss
upload artifact sha256=e7e4389f4eca4f3f36e01fa1d149f0ba8c25f04814f2d1aa702a83a220ca88e2 bytes=26304154
source-cache-hit
node-runtime-cache-hit
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-real-20260627-isolated-v18 port=19884
```

AWS v18 smoke command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-real-20260627-isolated-v18 && \
   export PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v18/.node-runtime/node-v22.16.0-linux-x64/bin':\$PATH && \
   node scripts/fabric-real-outbound-relay-smoke.js --timeout-ms 30000"
```

AWS v18 result:

```text
ok=true
control.endpoint=http://127.0.0.1:38615
node.endpoint=http://127.0.0.1:37513
relay.online=true
relay.status=online
relay.transportKind=relay
relay.transportId=relay-smoke-node-relay
relay.sessionIdPresent=true
relay.transportStatuses=relay:up
sessions.status=200
sessions.ok=true
sessions.rpc=control_plane.device.node_sessions
sessions.total=0
sessions.returned=0
```

AWS residue check:

```text
ps grep for fabric-real-outbound-relay-smoke / node relay connect / smoke server ports returned no rows.
```

Interpretation: this is the first real process-level outbound relay smoke on the active AWS host. It proves Control Plane -> relay WebSocket -> node local AIH server -> device-node sessions RPC. It is still not a full home/company coding session, because no real remote provider TUI was started through the relay.

### Latest Node Doctor Supervisor Evidence

This pass added a read-only supervisor view to `aih node doctor`. It composes the existing relay service manager and Fabric registry agent service manager without installing either service.

AWS v19 deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v19" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19884 \
  --skip-build \
  --skip-import \
  --skip-start
```

AWS v19 deploy result:

```text
source-cache-miss
upload artifact sha256=ad447fa105b2b218913531600c6c2d1cf697c8368d97ec5130dcf63de0ba4aaf bytes=26305489
source-cache-hit
node-runtime-cache-hit
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-real-20260627-isolated-v19 port=19884
```

AWS v19 doctor command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-real-20260627-isolated-v19 && \
   mkdir -p .aih-host-home .real-home && \
   export PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v19/.node-runtime/node-v22.16.0-linux-x64/bin':\$PATH \
     AIH_CLI_PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v19/bin/ai-home.js' \
     AIH_HOST_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v19/.aih-host-home' \
     REAL_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v19/.real-home' \
     HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v19/.real-home' && \
   node bin/ai-home.js node doctor --control-url 'http://127.0.0.1:19884' --node-id 'aws-v19' --json"
```

AWS v19 doctor result summary:

```text
ok=false
platform=linux/x64
cli.node.ok=true
cli.npm.ok=true
cli.aih.ok=true
cli.aih.source=AIH_CLI_PATH
server.managementKeyConfigured=false
issues=management_key_missing,server_loopback_only,endpoint_candidate_missing
services.relay.type=systemd-user
services.relay.state=missing
services.relay.running=false
services.registryAgent.type=systemd-user
services.registryAgent.state=missing
services.registryAgent.running=false
nodeSupervisor.ready=false
nodeSupervisor.required=relay:false,registry_agent:false
nextSteps include persistent relay service and Fabric registry agent service install commands
```

Interpretation: this is the first real AWS read-only evidence that the node supervisor view can explain why a node is not yet production-ready for long-lived remote management. The blocker is expected because v19 intentionally used an isolated home and did not import/start/write server config. The check still proves the Linux/systemd-user service discovery paths and the new `services.registryAgent` / `nodeSupervisor` JSON surface.

AWS process check after v19 doctor:

```text
No v19 server, relay, or registry agent process was started.
Existing old server serve processes are still running from v13-v16:
5502  /home/ubuntu/aih-fabric-real-20260627-isolated-v13
9282  /home/ubuntu/aih-fabric-real-20260627-isolated-v14
13641 /home/ubuntu/aih-fabric-real-20260627-isolated-v15
14772 /home/ubuntu/aih-fabric-real-20260627-isolated-v16
```

No old process was killed in this pass. Stopping them is an explicit cleanup action and needs confirmation.

Local verification for this doctor pass:

```text
node --test test/node-doctor.test.js test/node-relay-service.test.js test/fabric-registry-agent-service.test.js -> 20/20 pass
node bin/ai-home.js node doctor --control-url https://control.example.com --node-id aws-relay --json -> services + nodeSupervisor fields present
git diff --check -> pass
npm test -> 2462/2462 pass
```

### Latest Node Service Status Product Entry Evidence

This pass added a user-facing unified status command:

```bash
node "bin/ai-home.js" node service status \
  --control-url "https://control.example.com" \
  --node-id "local-service-smoke" \
  --json
```

Local result summary:

```text
ok=false
action=status
nodeId=local-service-smoke
status.supervisor.ready=false
status.services.relay.type=launchd
status.services.relay.state=missing
status.services.registryAgent.type=launchd
status.services.registryAgent.state=missing
nextSteps include relay service install and Fabric registry agent service install commands
```

AWS v20 deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v20" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19885 \
  --skip-build \
  --skip-import \
  --skip-start
```

AWS v20 deploy result:

```text
source-cache-miss
upload artifact sha256=ed232cc0c1ecbb9c63b1b7c1474ab328a77ddac46ce906d61f4bc01f17338db1 bytes=26307277
source-cache-hit
node-runtime-cache-hit
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-real-20260627-isolated-v20 port=19885
```

AWS v20 service status command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-real-20260627-isolated-v20 && \
   mkdir -p .aih-host-home .real-home && \
   export PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v20/.node-runtime/node-v22.16.0-linux-x64/bin':\$PATH \
     AIH_CLI_PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v20/bin/ai-home.js' \
     AIH_HOST_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v20/.aih-host-home' \
     REAL_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v20/.real-home' \
     HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v20/.real-home' && \
   node bin/ai-home.js node service status --control-url 'http://127.0.0.1:19885' --node-id 'aws-v20' --json"
```

AWS v20 result summary:

```text
ok=false
action=status
nodeId=aws-v20
status.platform=linux
status.arch=x64
status.server.managementKeyConfigured=false
status.supervisor.ready=false
status.supervisor.required=relay:false,registry_agent:false
status.services.relay.type=systemd-user
status.services.relay.state=missing
status.services.relay.running=false
status.services.registryAgent.type=systemd-user
status.services.registryAgent.state=missing
status.services.registryAgent.running=false
issues=management_key_missing,server_loopback_only,endpoint_candidate_missing
```

AWS v20 residue check:

```text
ps grep for v20 / node service status / node relay connect / fabric registry agent returned no rows.
```

Interpretation: this is the first real AWS proof of the product-facing supervised node status command. It is intentionally read-only and does not install service files. It closes the UX gap where operators previously had to run both `aih node relay service status` and `aih fabric registry agent service status` and mentally merge the result.

Local verification for this service-status pass:

```text
node --test test/node-doctor.test.js test/help.messages.test.js -> 14/14 pass
node --test test/node-doctor.test.js test/help.messages.test.js test/root.router.test.js test/root.dispatch.test.js -> 43/43 pass
node bin/ai-home.js node service status --control-url https://control.example.com --node-id local-service-smoke --json -> service status JSON present
```

### Latest Node Service Install Dry-run Product Entry Evidence

This pass added a supervised install orchestrator:

```bash
node "bin/ai-home.js" node service install \
  "https://control.example.com" \
  --node-id "local-install-smoke" \
  --token-file "/tmp/nonexistent.token" \
  --dry-run \
  --json
```

Local result summary:

```text
ok=true
action=install
nodeId=local-install-smoke
dryRun=true
plan.writes=false
plan.requiresConfirmation=false
plan.services=relay,registryAgent
status.services.relay.type=launchd
status.services.registryAgent.type=launchd
```

The local dry-run intentionally used a nonexistent token file. That is valid for planning because no service file is written. Real install still requires `--yes`, a readable token file, and a local `managementKey` in server config.

AWS v21 deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v21" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19886 \
  --skip-build \
  --skip-import \
  --skip-start
```

AWS v21 deploy result:

```text
source-cache-miss
upload artifact sha256=412a2f1311c29181a536e9437076d3dd6b1296dac326e1c19eccf2151686fc87 bytes=26311266
source-cache-hit
node-runtime-cache-hit
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-real-20260627-isolated-v21 port=19886
```

AWS v21 service install dry-run command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-real-20260627-isolated-v21 && \
   mkdir -p .aih-host-home .real-home && \
   export PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v21/.node-runtime/node-v22.16.0-linux-x64/bin':\$PATH \
     AIH_CLI_PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v21/bin/ai-home.js' \
     AIH_HOST_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v21/.aih-host-home' \
     REAL_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v21/.real-home' \
     HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v21/.real-home' && \
   node bin/ai-home.js node service install 'http://127.0.0.1:19886' --node-id 'aws-v21' --token-file '/home/ubuntu/aih-fabric-real-20260627-isolated-v21/.aih-host-home/fabric/aws-v21.token' --dry-run --json"
```

AWS v21 result summary:

```text
ok=true
action=install
nodeId=aws-v21
dryRun=true
plan.writes=false
plan.requiresConfirmation=false
plan.services=relay,registryAgent
plan.relay.command=aih node relay service install http://127.0.0.1:19886 --node-id aws-v21
plan.registryAgent.command=aih fabric registry agent service install http://127.0.0.1:19886 --node-id aws-v21 --token-file /home/ubuntu/aih-fabric-real-20260627-isolated-v21/.aih-host-home/fabric/aws-v21.token
status.platform=linux
status.arch=x64
status.services.relay.type=systemd-user
status.services.relay.state=missing
status.services.registryAgent.type=systemd-user
status.services.registryAgent.state=missing
status.supervisor.ready=false
issues=management_key_missing,server_loopback_only,endpoint_candidate_missing
```

AWS v21 residue check:

```text
no-service-dir
no-v21-process
```

Interpretation: this is the first real AWS proof of the product-facing supervised install planning command. It composes the relay service and Fabric registry agent service into one operator action without writing service files in dry-run mode. Actual service installation is intentionally still behind `--yes`, local management key presence, and readable token file checks.

Local verification for this service-install pass:

```text
node --test test/node-doctor.test.js test/help.messages.test.js test/node-relay-service.test.js test/fabric-registry-agent-service.test.js -> 29/29 pass
node bin/ai-home.js node service install https://control.example.com --node-id local-install-smoke --token-file /tmp/nonexistent.token --dry-run --json -> ok=true, writes=false
```

### Latest Node Service Uninstall Dry-run Product Entry Evidence

This pass added the matching supervised rollback planner:

```bash
node "bin/ai-home.js" node service uninstall \
  --node-id "local-uninstall-smoke" \
  --dry-run \
  --json
```

Local result summary:

```text
ok=true
action=uninstall
nodeId=local-uninstall-smoke
dryRun=true
plan.writes=false
plan.requiresConfirmation=false
plan.services=registryAgent,relay
```

The dry-run order is intentionally registry agent first, relay second. A real rollback should stop publishing node liveness before removing the relay client.

AWS v22 deploy command shape:

```bash
node "scripts/fabric-real-vps-deploy.js" \
  --ssh "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  --ssh-key "/Users/model/.ssh/aws.pem" \
  --accounts "tmp/fabric-real-deploy/aih-accounts-real-20260627.zip" \
  --remote-dir "/home/ubuntu/aih-fabric-real-20260627-isolated-v22" \
  --node-runtime "tmp/fabric-real-deploy/node-runtime/node-v22.16.0-linux-x64.tar.xz" \
  --port 19887 \
  --skip-build \
  --skip-import \
  --skip-start
```

AWS v22 deploy result:

```text
source-cache-miss
upload artifact sha256=3d96dff582250a7cde53357ab8e3f5cd6ab06e25208521b29bf12a4644b6bdc7 bytes=26314708
source-cache-hit
node-runtime-cache-hit
node-modules-cache-hit
done: remoteDir=/home/ubuntu/aih-fabric-real-20260627-isolated-v22 port=19887
```

AWS v22 service uninstall dry-run command:

```bash
ssh -i "/Users/model/.ssh/aws.pem" \
  "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com" \
  "cd /home/ubuntu/aih-fabric-real-20260627-isolated-v22 && \
   mkdir -p .aih-host-home .real-home && \
   export PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v22/.node-runtime/node-v22.16.0-linux-x64/bin':\$PATH \
     AIH_CLI_PATH='/home/ubuntu/aih-fabric-real-20260627-isolated-v22/bin/ai-home.js' \
     AIH_HOST_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v22/.aih-host-home' \
     REAL_HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v22/.real-home' \
     HOME='/home/ubuntu/aih-fabric-real-20260627-isolated-v22/.real-home' && \
   node bin/ai-home.js node service uninstall --node-id 'aws-v22' --dry-run --json"
```

AWS v22 result summary:

```text
ok=true
action=uninstall
nodeId=aws-v22
dryRun=true
plan.writes=false
plan.requiresConfirmation=false
plan.services=registryAgent,relay
plan.registryAgent.command=aih fabric registry agent service uninstall --node-id aws-v22
plan.relay.command=aih node relay service uninstall --node-id aws-v22
status.platform=linux
status.arch=x64
status.services.relay.type=systemd-user
status.services.relay.state=missing
status.services.registryAgent.type=systemd-user
status.services.registryAgent.state=missing
status.supervisor.ready=false
issues=management_key_missing,server_loopback_only,endpoint_candidate_missing
```

AWS v22 residue check:

```text
no-service-dir
no-v22-process
```

Interpretation: this proves the product-facing rollback command can explain what it would remove without deleting service files. Actual uninstall remains behind `--yes` because removing user startup service files is destructive.

Local verification for this service-uninstall pass:

```text
node --test test/node-doctor.test.js test/help.messages.test.js test/node-relay-service.test.js test/fabric-registry-agent-service.test.js -> 33/33 pass
node bin/ai-home.js node service uninstall --node-id local-uninstall-smoke --dry-run --json -> ok=true, writes=false
```

### Historical Active Node Agent TCP Echo Evidence

`ubuntu@155.248.183.169` v12 rerun:

```text
nodeId=vps-155-jp-v12
publish.ok=true
heartbeat.ok=true
agent.ok=true
agent.attempts=2
agent.failures=0
agent.probes[0].status=tcp_echo_pass
agent.probes[0].successes=1
agent.probes[0].failures=0
registryCounts: nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
hostname=instance-20260111-0329
```

`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` v13 rerun:

```text
nodeId=vps-aws-43-jp-v13
publish.ok=true
heartbeat.ok=true
agent.ok=true
agent.attempts=2
agent.failures=0
agent.probes[0].status=tcp_echo_pass
agent.probes[0].successes=1
agent.probes[0].failures=0
registryCounts: nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
hostname=ip-172-31-47-163
```

AWS v13 deployment notes:

- SSH baseline: Ubuntu host `ip-172-31-47-163`, no system Node/npm initially, `curl` and `python3` present.
- Runtime and `node_modules` cache were reused on rerun.
- Account import used the Python zipfile fallback because system `unzip` was unavailable.
- Import result: `imported=15 duplicates=0 invalid=0 failed=0`.
- No package manager install, firewall edit, security group edit, or systemd install was performed.

## Code Fixes Made During This Pass

### Supervised Node Service Install and Rollback Planner

`aih node service install <control-url> --node-id ID --token-file FILE` now composes the two long-lived node services that operators need for no-public-IP remote management:

- `aih node relay service install ...`
- `aih fabric registry agent service install ...`

The command supports `--dry-run` for a no-write plan, requires `--yes` before actual writes, refuses raw secret-bearing options such as `--token` and `--management-key`, and checks local `managementKey` plus token file readability before real install. It intentionally does not auto-rollback because deleting or disabling a user-owned service file is a destructive action.

`aih node service uninstall --node-id ID` is the matching rollback planner. It supports `--dry-run`, requires `--yes` before deleting service files, and composes registry agent uninstall before relay uninstall so the node stops publishing liveness before the relay client is removed.

### Isolated Remote AIH Home

`scripts/fabric-real-vps-deploy.js` now sets a deploy-scoped `AIH_HOST_HOME` for every remote `node bin/ai-home.js ...` command:

```text
<remote-dir>/.aih-host-home/.ai_home
```

Reason: previous deploys used the remote user's default `~/.ai_home`, causing repeated deploys to report `duplicates=15` and to reuse stale runtime state. The isolated home makes each evidence deploy reproducible and traceable.

### API-key Token Refresh Skip

`lib/server/token-refresh-daemon.js` now skips API-key runtime accounts before calling any OAuth token refresh implementation.

Reason: API-key accounts do not have refresh tokens by design. The previous flow did not demote them, but still emitted false startup warnings such as `missing_credentials` or `missing_refresh_token`.

### Flat OAuth Native Credential Import

`lib/account/standard-transfer.js` now converts flat standard OAuth records into provider-native credential files before writing them:

- Gemini flat records write `.gemini/oauth_creds.json` with top-level `access_token`, `refresh_token`, `id_token`, and `email`.
- Antigravity flat records write `.gemini/antigravity-cli/antigravity-oauth-token` with `auth_method` and nested `token.access_token`, `token.refresh_token`, `token.expiry`, plus `email.cache`.

Reason: the real flat zip import previously wrote the whole standard record wrapper into native credential paths. Files existed, but `loadGeminiServerAccounts()` and `loadAgyServerAccounts()` could not read them into the runtime pool.

### Productized HTTP Ingress Probe

`aih node bootstrap probe` now accepts `--http`, `--http-target`, and `--ingress` targets. HTTP targets are normalized to `http://.../healthz` when the scheme or path is omitted.

Reason: SSH/TCP bootstrap readiness and AIH client ingress readiness are different layers. The probe report now records `http-ready` and `http-failed`, and HTTP results are excluded from bootstrap execution plans because they are diagnostics, not remote install actions.

### Registry Publish From Real Server Accounts

`aih fabric registry publish` now accepts `--from-server` and optional `--from-server-url` / `--management-key`.

Reason: the real VPS registry evidence must not hand-write provider runtimes that only look plausible. `--from-server` reads the target AIH server's real `/v0/management/accounts` response, derives API runtimes from the loaded account pool, then publishes the node snapshot. The publisher does not store the device token or management key.

`lib/server/fabric-role-registry.js` and `lib/cli/services/fabric/registry-publish.js` now include `gemini` in the Fabric runtime provider whitelist. Without this, the real imported Gemini account would be loaded by the server but dropped from Fabric registry runtimes.

`scripts/fabric-real-vps-registry-publish.js` was added as the reusable remote evidence runner. It creates and consumes a local Fabric device invite in-process, runs `aih fabric registry publish --from-server --relay-node`, reads `/v0/fabric/registry` and legacy `/v0/node-rpc/device-nodes`, and prints a sanitized JSON report. It never prints the device token.

### Registry Agent Transport Probe

`aih fabric registry agent` now accepts `--probe-transport kind=url`.

Reason: v9 proved that a foreground agent can repeatedly send heartbeat state, but `--transport relay=online` was still an operator assertion. v10 moves the smoke to a real measured signal: before each heartbeat, the agent probes the transport endpoint and lets the probe result override manual health for the same transport kind.

Current probe evidence is intentionally small and safe:

- `relay=http://127.0.0.1:<port>/healthz` verifies the remote server's local HTTP health from the node itself.
- The report stores `kind`, `health`, `durationMs`, `status`, and short error/status text.
- The full probe URL is not printed in agent events, so future tokenized URLs do not leak.

## VPS Deployments

### Current V3 Redeploy After Flat OAuth Fix

All three VPS hosts were redeployed into new directories and ports after the import fix. Each deployment used `tmp/fabric-real-deploy/aih-accounts-real-20260627.zip`, a deploy-scoped `AIH_HOST_HOME`, and no mock data.

| Host | Remote dir | Port | PID | Runtime | Import | Localhost health | Runtime account pool |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `ubuntu@155.248.183.169` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v3` | 18381 | 328076 | `node-v22.16.0-linux-x64` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200 | `codex=3, gemini=1, claude=4, agy=7` |
| `opc@152.70.105.41` | `/home/opc/aih-fabric-real-20260627-isolated-v3` | 18382 | 19400 | `node-v22.16.0-linux-x64-glibc-217` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200 | `codex=3, gemini=1, claude=4, agy=7` |
| `root@39.104.59.31` | `/root/aih-fabric-real-20260627-isolated-v3` | 18383 | 1695759 | `node-v22.16.0-linux-x64` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200 | `codex=3, gemini=1, claude=4, agy=7` |

Management account reads on all three hosts:

```text
total=15
codex=3
gemini=1
claude=4
agy=7
apiKey=5
runtime buckets: all healthy/schedulable
```

Provider-native credential structure check, with values redacted by omission:

```text
geminiKeys=["access_token","email","id_token","refresh_token"]
agyKeys=["auth_method","token"] or ["auth_method","last_refresh","token"]
agyTokenKeys=["access_token","expiry","refresh_token"] plus token_type on hosts where refresh succeeded
```

Public HTTP probe from the local machine, with proxy disabled:

```text
http://155.248.183.169:18381/healthz -> timeout after 5002ms, HTTP 000
http://152.70.105.41:18382/healthz  -> timeout after 5003ms, HTTP 000
http://39.104.59.31:18383/healthz   -> timeout after 5004ms, HTTP 000
```

Productized AIH HTTP ingress probe from the local machine:

```bash
node "bin/ai-home.js" node bootstrap probe \
  --http "http://155.248.183.169:18381" \
  --http "http://152.70.105.41:18382" \
  --http "http://39.104.59.31:18383" \
  --timeout-ms 5000 \
  --json
```

Result:

```text
summary: total=3, httpReady=0, httpFailed=3
http://155.248.183.169:18381/healthz -> timeout, latency=5006ms
http://152.70.105.41:18382/healthz -> timeout, latency=5002ms
http://39.104.59.31:18383/healthz -> timeout, latency=5001ms
executionPlan=[]
```

Read-only listener checks show all three Node processes are bound to `0.0.0.0:<port>`. The public HTTP failure is therefore outside the Node bind path; likely cloud security group, host firewall, provider-side filtering, or an overlay/relay requirement. This pass intentionally did not edit firewall, security group, or system services.

The China host (`39.104.59.31`) logged Antigravity token refresh `fetch failed` warnings at startup. Management state still reports all agy accounts `healthy/schedulable`, but the warning is real evidence that Google/Code Assist refresh connectivity from that host may be unstable.

### Current V4 Redeploy With Real Registry Publish

All three VPS hosts were redeployed again after the `--from-server` publisher change. The deploy used the same real account export (`tmp/fabric-real-deploy/aih-accounts-real-20260627.zip`) and isolated `AIH_HOST_HOME`. Local `web/dist` already existed and no frontend code changed in this pass, so the v4 deploy used `--skip-build` to avoid re-running Vite on small remote hosts. No systemd unit, firewall rule, security group, or system package was changed.

| Host | Remote dir | Port | PID | Runtime | Import | Localhost health/account check | Registry publish |
| --- | --- | ---: | ---: | --- | --- | --- | --- |
| `ubuntu@155.248.183.169` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v4` | 18481 | 335329 | `node-v22.16.0-linux-x64` | `imported=15 duplicates=0 invalid=0 failed=0` | follow-up SSH banner timeout | not verified |
| `opc@152.70.105.41` | `/home/opc/aih-fabric-real-20260627-isolated-v4` | 18482 | 2780 | `node-v22.16.0-linux-x64-glibc-217` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200, total=15 | passed |
| `root@39.104.59.31` | `/root/aih-fabric-real-20260627-isolated-v4` | 18483 | 1698817 | `node-v22.16.0-linux-x64` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200, total=15 | passed |

Management account reads on the two currently reachable v4 hosts:

```text
152.70.105.41: total=15, codex=3, gemini=1, claude=4, agy=7, apiKey=5
39.104.59.31:  total=15, codex=3, gemini=1, claude=4, agy=7, apiKey=5
```

Real registry publish command shape used on reachable hosts:

```bash
node "scripts/fabric-real-vps-registry-publish.js" \
  --port <local-port> \
  --node-id <real-vps-node-id> \
  --name "<real VPS display name>" \
  --bandwidth-kbps 3072
```

The script created a local device invite, consumed it in-process, ran `aih fabric registry publish http://127.0.0.1:<port> --from-server --relay-node --json`, then read the Fabric registry and legacy node view back with the resulting device token. The token was not printed.

`opc@152.70.105.41` result:

```text
ok=true
nodeId=vps-152-jp-v4
roles=node,relay-node
fromServer.accounts=15
fromServer.providers=agy,claude,codex,gemini
fromServer.runtimes=codex:api available accounts=3 schedulable=3; gemini:api available accounts=1 schedulable=1; claude:api available accounts=4 schedulable=4; agy:api available accounts=7 schedulable=7
registryCounts: nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:unknown
legacyNodeIds=vps-152-jp-v4
```

`root@39.104.59.31` result:

```text
ok=true
nodeId=vps-39-cn-v4
roles=node,relay-node
fromServer.accounts=15
fromServer.providers=agy,claude,codex,gemini
fromServer.runtimes=codex:api available accounts=3 schedulable=3; gemini:api available accounts=1 schedulable=1; claude:api available accounts=4 schedulable=4; agy:api available accounts=7 schedulable=7
registryCounts: nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:unknown
legacyNodeIds=vps-39-cn-v4
```

`ubuntu@155.248.183.169` follow-up status:

```text
v4 deploy completed and imported 15 real records.
subsequent SSH health check: Connection timed out during banner exchange
subsequent script copy: Connection timed out during banner exchange
final SSH retry after full npm test: Connection closed by 155.248.183.169 port 22
registry publish: not verified in this pass
```

Verdict for v4 registry evidence: 2/3 VPS hosts have real non-mock node + relay-node registry publish and readback. The remaining Japanese VPS has deploy/import evidence but currently lacks registry publish evidence because SSH is intermittently unavailable at banner exchange.

### V5/V8 Registry Heartbeat and Small-Pipe Deploy Optimization

This pass added a non-destructive registry heartbeat path and reran real VPS evidence without mock data.

Heartbeat behavior:

- `POST /v0/fabric/registry/heartbeat` updates node `lastSeenAt/status`, relay node status, and transport health.
- Heartbeat requires a `nodes:write` device token and rejects mismatched node owner devices.
- Heartbeat preserves the previously published project and runtime inventory; it does not replace `projects` or `runtimes`.
- `scripts/fabric-real-vps-registry-publish.js` now publishes from real server accounts and immediately sends heartbeat, then reads Fabric registry and legacy node view back.

Small-pipe deployment optimization:

- `scripts/fabric-real-vps-deploy.js` now reuses remote runtime archives from `<remote-parent>/.aih-node-runtime-cache`.
- Runtime cache entries are verified by sha256 before reuse.
- The deploy script now reuses remote `node_modules` by a cache key derived from local `package.json + package-lock.json`.
- The cache avoids repeatedly uploading a 29-30MB Node runtime archive and avoids rerunning full `npm install` for every isolated evidence directory.
- No system package, firewall, security group, or systemd configuration was changed.

The optimization was added because `opc@152.70.105.41` v5 spent more than 5 minutes in repeated runtime transfer / dependency install paths, and concurrent SSH checks timed out during banner exchange. That is a real stability issue for 2-3Mbps VPS links, not just a convenience problem.

Real v5/v8 results:

| Host | Remote dir | Port | Cache evidence | Import | Localhost health | Registry publish + heartbeat |
| --- | --- | ---: | --- | --- | --- | --- |
| `root@39.104.59.31` | `/root/aih-fabric-real-20260627-isolated-v5` | 18583 | prior runtime/deps already installed for this dir | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200 | passed |
| `opc@152.70.105.41` | `/home/opc/aih-fabric-real-20260627-isolated-v8` | 18882 | `node-runtime-cache-hit`, `node-modules-cache-hit` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200 | passed |
| `ubuntu@155.248.183.169` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v8` | 18881 | `node-runtime-cache-hit`, `node-modules-cache-hit` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200 after startup warm-up | passed |

Registry readback on all three hosts:

```text
nodes=1
relayNodes=1
transports=1
projects=1
runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
legacyNodeIds=<matching node id>
```

`root@39.104.59.31` v5 node:

```text
nodeId=vps-39-cn-v5
fromServer.accounts=15
fromServer.providers=agy,claude,codex,gemini
heartbeat.counts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
```

`opc@152.70.105.41` v8 node:

```text
nodeId=vps-152-jp-v8
fromServer.accounts=15
fromServer.providers=agy,claude,codex,gemini
heartbeat.counts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
```

`ubuntu@155.248.183.169` v8 node:

```text
nodeId=vps-155-jp-v8
fromServer.accounts=15
fromServer.providers=agy,claude,codex,gemini
heartbeat.counts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
```

Public HTTP ingress recheck from the local machine:

```bash
node "bin/ai-home.js" node bootstrap probe \
  --http "http://155.248.183.169:18881" \
  --http "http://152.70.105.41:18882" \
  --http "http://39.104.59.31:18583" \
  --timeout-ms 5000 \
  --json
```

Result:

```text
http://155.248.183.169:18881/healthz -> timeout, latency=5007ms
http://152.70.105.41:18882/healthz -> timeout, latency=5002ms
http://39.104.59.31:18583/healthz -> timeout, latency=5002ms
summary: total=3, httpReady=0, httpFailed=3
executionPlan=[]
```

Interpretation: all three servers are usable from their own localhost and can publish registry state, but none is reachable as a public HTTP client endpoint from the local machine. The next product path must not depend on raw public ingress unless firewall/security-group/HTTPS reverse proxy is explicitly configured. The default path should move toward outbound relay/overlay.

### V9 Foreground Registry Agent Smoke

This pass added a foreground `aih fabric registry agent` loop. It reuses the heartbeat sender and repeatedly posts node/relay/transport liveness. It does not install a system service, store tokens, edit system config, or change firewall/security-group settings.

CLI shape:

```bash
node "bin/ai-home.js" fabric registry agent \
  <server-url> \
  --node-id <node-id> \
  --relay-status online \
  --transport relay=online \
  --interval-ms 30000
```

The real VPS evidence runner now performs:

```text
publish --from-server --relay-node
heartbeat --relay-status online --transport relay=online
agent --count 2 --interval-ms 1000 --relay-status online --transport relay=online
registry readback
legacy node view readback
```

Real v9 deployments used the same real account export, isolated `AIH_HOST_HOME`, and cached remote runtime/dependency path:

| Host | Remote dir | Port | Cache evidence | Import | Localhost health | Agent smoke |
| --- | --- | ---: | --- | --- | --- | --- |
| `ubuntu@155.248.183.169` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v9` | 18981 | `node-runtime-cache-hit`, `node-modules-cache-hit` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200, 0.008s | `attempts=2 failures=0` |
| `opc@152.70.105.41` | `/home/opc/aih-fabric-real-20260627-isolated-v9` | 18982 | `node-runtime-cache-hit`, `node-modules-cache-hit` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200, 0.045s | `attempts=2 failures=0` |
| `root@39.104.59.31` | `/root/aih-fabric-real-20260627-isolated-v9` | 18983 | `node-runtime-cache-hit`, `node-modules-cache-hit` | `imported=15 duplicates=0 invalid=0 failed=0` | HTTP 200, 0.005s | `attempts=2 failures=0` |

Agent readback on all three hosts:

```text
agent.ok=true
agent.attempts=2
agent.failures=0
agent.lastCounts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
registryCounts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
```

Public HTTP ingress recheck from the local machine:

```bash
node "bin/ai-home.js" node bootstrap probe \
  --http "http://155.248.183.169:18981" \
  --http "http://152.70.105.41:18982" \
  --http "http://39.104.59.31:18983" \
  --timeout-ms 5000 \
  --json
```

Result:

```text
http://155.248.183.169:18981/healthz -> timeout, latency=5006ms
http://152.70.105.41:18982/healthz -> timeout, latency=5002ms
http://39.104.59.31:18983/healthz -> timeout, latency=5001ms
summary: total=3, httpReady=0, httpFailed=3
executionPlan=[]
```

Interpretation: foreground registry agent is now proven on all three real VPS nodes, but it is still a process-level loop, not an installed daemon. The remaining product work is packaging it as a managed node agent and connecting it to outbound relay/data-plane health.

### V10 Registry Agent With Real Transport Probe

This pass redeployed the current code to three new v10 directories and ran the same real publish -> heartbeat -> foreground agent flow with measured `--probe-transport relay=http://127.0.0.1:<port>/healthz`.

The probe is not mock data and is not a hand-written `relay=online` assertion. It performs a real HTTP check from each VPS against its own running AIH server before sending heartbeat transport health.

| Host | Remote dir | Port | PID evidence | Cache evidence | Import/account pool | Localhost health | Agent probe |
| --- | --- | ---: | --- | --- | --- | --- | --- |
| `ubuntu@155.248.183.169` | `/home/ubuntu/aih-fabric-real-20260627-isolated-v10` | 19081 | `31841 node bin/ai-home.js server serve ... --port 19081` | runtime cache present, node_modules cache present | `total=15`, `codex=3, gemini=1, claude=4, agy=7` | HTTP 200 | `relay online`, reachable, 4ms |
| `opc@152.70.105.41` | `/home/opc/aih-fabric-real-20260627-isolated-v10` | 19082 | `27490 node bin/ai-home.js server serve ... --port 19082` | runtime cache present, node_modules cache present | `total=15`, `codex=3, gemini=1, claude=4, agy=7` | HTTP 200 | `relay online`, reachable, 3ms |
| `root@39.104.59.31` | `/root/aih-fabric-real-20260627-isolated-v10` | 19083 | `1733707 node bin/ai-home.js server serve ... --port 19083` | runtime cache present, node_modules cache present | `total=15`, `codex=3, gemini=1, claude=4, agy=7` | HTTP 200 | `relay online`, reachable, 14ms |

Real command shape:

```bash
node "scripts/fabric-real-vps-registry-publish.js" \
  --port <local-port> \
  --node-id <real-vps-node-id> \
  --name "<real VPS display name>" \
  --bandwidth-kbps 3072 \
  --agent-count 2 \
  --agent-interval-ms 1000
```

The evidence runner's default agent probe for this pass:

```text
--agent-probe-transport relay=http://127.0.0.1:<port>/healthz
```

Agent readback on all three v10 hosts:

```text
publish.ok=true
heartbeat.ok=true
agent.ok=true
agent.attempts=2
agent.failures=0
agent.probes=relay:online:reachable
agent.lastCounts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
registryCounts=nodes=1, relayNodes=1, transports=1, projects=1, runtimes=4
runtimeProviders=codex:api:available, gemini:api:available, claude:api:available, agy:api:available
transportKinds=relay:online
legacyNodeIds=<matching node id>
```

Per-host node ids:

```text
155.248.183.169:19081 -> vps-155-jp-v10
152.70.105.41:19082 -> vps-152-jp-v10
39.104.59.31:19083  -> vps-39-cn-v10
```

Public HTTP ingress recheck from the local machine:

```bash
node "bin/ai-home.js" node bootstrap probe \
  --http "http://155.248.183.169:19081" \
  --http "http://152.70.105.41:19082" \
  --http "http://39.104.59.31:19083" \
  --timeout-ms 5000 \
  --json
```

Result:

```text
http://155.248.183.169:19081/healthz -> timeout, latency=5008ms
http://152.70.105.41:19082/healthz -> timeout, latency=5002ms
http://39.104.59.31:19083/healthz -> timeout, latency=5001ms
summary: total=3, httpReady=0, httpFailed=3
executionPlan=[]
```

Interpretation: the v10 agent now measures local transport health before heartbeat, and that path passes on all three real VPS hosts. Public raw HTTP ingress is still unusable from the local machine. This confirms the next product layer should be outbound relay/overlay/data-plane echo, not "open a random high port and hope clients can reach it".

### Baseline V2 Deployments Before Flat OAuth Fix

#### `ubuntu@155.248.183.169`

- OS: Ubuntu 24.04 / glibc 2.39 class host
- Remote dir: `/home/ubuntu/aih-fabric-real-20260627-isolated-v2`
- AIH host home: `/home/ubuntu/aih-fabric-real-20260627-isolated-v2/.aih-host-home`
- Node runtime: `node-v22.16.0-linux-x64.tar.xz`
- Port: `18281`
- PID: `324677`
- Remote import: `imported=15 duplicates=0 invalid=0 failed=0`
- Server startup account pool: `codex=3, gemini=0, claude=4, agy=0, opencode=0`
- Management account summary: `total=7`, `codex=3`, `claude=4`, `apiKey=5`
- Localhost health: HTTP 200
- Public probe from local machine:
  - `tcp://155.248.183.169:18281`: reachable, 1ms
  - `http://155.248.183.169:18281/healthz`: HTTP timeout after 5004ms

#### `opc@152.70.105.41`

- OS: CentOS 7 / glibc 2.17 class host
- Remote dir: `/home/opc/aih-fabric-real-20260627-isolated-v2`
- AIH host home: `/home/opc/aih-fabric-real-20260627-isolated-v2/.aih-host-home`
- Node runtime: `node-v22.16.0-linux-x64-glibc-217.tar.xz`
- Port: `18282`
- PID: `11945`
- Remote import: `imported=15 duplicates=0 invalid=0 failed=0`
- Server startup account pool: `codex=3, gemini=0, claude=4, agy=0, opencode=0`
- Management account summary: `total=7`, `codex=3`, `claude=4`, `apiKey=5`
- Localhost health: HTTP 200
- Public probe from local machine:
  - `tcp://152.70.105.41:18282`: reachable, 1ms
  - `http://152.70.105.41:18282/healthz`: HTTP timeout after 5002ms

#### `root@39.104.59.31`

- OS: Debian 12 / glibc 2.36
- Remote dir: `/root/aih-fabric-real-20260627-isolated-v2`
- AIH host home: `/root/aih-fabric-real-20260627-isolated-v2/.aih-host-home`
- Node runtime: `node-v22.16.0-linux-x64.tar.xz`
- Port: `18283`
- PID: `1694448`
- Remote import: `imported=15 duplicates=0 invalid=0 failed=0`
- Server startup account pool: `codex=3, gemini=0, claude=4, agy=0, opencode=0`
- Management account summary: `total=7`, `codex=3`, `claude=4`, `apiKey=5`
- Localhost health: HTTP 200
- Localhost descriptor: HTTP 200, roles `server`, `relay`
- Public probe from local machine:
  - `tcp://39.104.59.31:18283`: reachable, 2ms
  - `http://39.104.59.31:18283/healthz`: HTTP timeout after 5003ms

## Transport Interpretation

All three VPS hosts passed remote-local HTTP checks. All three failed public HTTP checks from the local machine while TCP connect succeeded.

This means `tcp reachable` is not sufficient evidence for a client-ready server. The public ingress path is still not HTTP-usable. The likely next layer to inspect is cloud security group, host firewall, reverse proxy, or a relay/overlay path. This pass intentionally did not open ports or change firewall rules.

## Account Import Interpretation

The account zip imported 15 records on all three isolated deployments with zero duplicates and zero invalid records.

The v2 baseline exposed only 7 runtime accounts because agy/gemini flat OAuth records were written in the wrong on-disk shape:

```text
codex=3
claude=4
gemini=0
agy=0
```

The v3 redeploy fixes this. Runtime pools now expose all 15 imported records on all three hosts:

```text
codex=3
gemini=1
claude=4
agy=7
```

## Claude Worker Evidence

### Short `aih claude` call

Command:

```bash
node "bin/ai-home.js" claude 4 -p "只输出 ok"
```

Result: returned `ok` in about 7.6s.

### Frontend worker boundary call

Command:

```bash
node "bin/ai-home.js" claude 4 -p "<frontend worker boundary prompt>"
```

Result: returned in about 10.7s:

```text
status=阻塞——复杂前端 patch worker 卡在 "Waiting for claude to boot" 超 90 秒，无 diff 产出；未做任何文件改动。
boundary=短 `aih claude -p` 可正常返回，复杂前端补丁任务在启动阶段即超时；分界在 boot 引导环节，而非补丁逻辑本身。
```

Conclusion: short `aih claude -p` is usable. Complex `aih claude` frontend patch work is not yet proven stable and must not be claimed as completed by Claude.

### Patch review call

Command:

```bash
node "bin/ai-home.js" claude 4 -p "请审阅当前仓库这三个文件的未提交改动：lib/account/standard-transfer.js、test/standard-format-export.test.js、test/unified-import.test.js ..."
```

Result: returned a bounded review in about 29s. Claude agreed that the patch lands Gemini/Agy flat OAuth records into native credential layouts and does not touch Codex/Claude branches. It flagged expiry-shape consistency as a minor risk; current Agy metadata parsing accepts ISO `token.expiry`, so no code change was needed for that point.

### Frontend readonly worker call

Command:

```bash
node "bin/ai-home.js" claude 4 -p "<frontend readonly worker prompt>"
```

Result: after a long boot wait, Claude returned a frontend risk review and did not modify files.

Claude's key findings:

```text
status=large Fabric frontend feature is partially implemented; it is suitable for Claude to take over only after tests and blast-radius confirmation.
risks=the current global Fabric setup gate can redirect Dashboard, Accounts, Chat, Usage, Models, and Settings to /server-setup when the fabric profile is not ready; this could lock the existing product if backend routes are not fully wired.
next=verify web build/lint, confirm fabric backend route wiring, narrow the gate to /fabric/* unless the global gate is explicitly intended, and add tests for fabric-profile-gate/fabric-registry.
```

Local verification after this review did run `npm run web:build`; it passed. The global WebUI gate risk identified by Claude was handled in the follow-up gate scope fix below.

### Frontend patch worker retry

Command:

```bash
node "bin/ai-home.js" claude 4 -p "<restricted frontend gate patch prompt>"
```

Allowed file scope:

```text
web/src/services/fabric-profile-gate.ts
web/src/App.tsx
test/fabric-profile-gate.test.js
```

Result: Claude stayed in `Waiting for claude to boot` for more than 90s and was interrupted with Ctrl-C. No Claude-generated diff was accepted from this run.

### Frontend readonly worker retry on 2026-06-27

Command:

```bash
env AIH_NO_PERSIST=1 node "bin/ai-home.js" claude 4 -p "<frontend readonly review prompt for Fabric WebUI files>"
```

Result: Claude stayed in `Waiting for claude to boot` for more than 90s and was interrupted with Ctrl-C. It returned no review content and made no file changes. This pass therefore contains no frontend change that can be attributed to `aih claude`.

### Frontend Gate Scope Fix

Codex applied the narrow follow-up fix after the failed Claude patch run:

- `web/src/services/fabric-profile-gate.ts` now owns the route classification via `isFabricRoute()` and `isFabricProfileProtectedPath()`.
- Existing app routes such as `/`, `/accounts`, `/chat`, `/usage`, `/models`, and `/settings` are not redirected to `/server-setup` when no ready Fabric profile exists.
- `/server-setup`, `/fabric/nodes`, and `/fabric/webrtc-lab` remain usable without a ready profile. `FabricNodes` keeps its page-level warning and setup action.
- `web/src/App.tsx` no longer carries a separate `allowFabricPageWithoutReadyProfile` exception; it delegates the decision to `shouldRedirectToFabricServerSetup()`.

Reason: the app must expose Fabric server configuration without locking the existing local WebUI surfaces. Any future Fabric route that truly requires a ready server profile can become protected by updating the single gate function and its tests.

## Test Evidence

Focused tests:

```bash
node --test "test/node-bootstrap-probe.test.js"
node --test "test/web-ui-router.remote-nodes.test.js"
node --test "test/help.messages.test.js"
node --test "test/standard-format-export.test.js"
node --test "test/unified-import.test.js"
node --test "test/server.accounts.test.js"
node --test "test/fabric-real-vps-deploy.test.js"
node --test "test/fabric-profile-gate.test.js"
node --test "test/server.token-refresh-daemon.test.js"
node --test "test/server-node-rpc-wiring.test.js" "test/control-plane-profiles.test.js"
node --test "test/pty-runtime.test.js"
node --test "test/fabric-transport-probe.test.js"
node --test "test/control-plane-profiles.test.js"
node --test "test/fabric-registry-publish.test.js" "test/fabric-role-registry.test.js"
node --test "test/fabric-real-vps-registry-publish.test.js"
node --test "test/fabric-real-vps-deploy.test.js" "test/fabric-registry-heartbeat.test.js" "test/fabric-role-registry.test.js" "test/server-node-rpc-wiring.test.js" "test/fabric-real-vps-registry-publish.test.js"
node --test "test/fabric-registry-agent.test.js" "test/fabric-registry-heartbeat.test.js" "test/fabric-real-vps-registry-publish.test.js" "test/fabric-real-vps-deploy.test.js" "test/fabric-role-registry.test.js" "test/server-node-rpc-wiring.test.js"
```

Results:

- `node-bootstrap-probe`: 42/42 pass
- `web-ui-router.remote-nodes`: 23/23 pass
- `help.messages`: 1/1 pass
- `standard-format-export`: 9/9 pass
- `unified-import`: 19/19 pass
- `server.accounts`: 35/35 pass
- `fabric-real-vps-deploy`: 8/8 pass
- `fabric-profile-gate`: 3/3 pass
- `server.token-refresh-daemon`: 9/9 pass
- `server-node-rpc-wiring + control-plane-profiles`: 29/29 pass
- `pty-runtime`: 119/119 pass
- `fabric-transport-probe`: 7/7 pass
- `control-plane-profiles`: 23/23 pass
- `fabric-registry-publish + fabric-role-registry`: 7/7 pass after `--from-server`
- `fabric-real-vps-registry-publish`: 2/2 pass
- `fabric-real-vps-deploy + fabric-registry-heartbeat + fabric-role-registry + server-node-rpc-wiring + fabric-real-vps-registry-publish`: 28/28 pass after heartbeat and deploy cache changes
- `fabric-registry-agent + fabric-registry-heartbeat + fabric-real-vps-registry-publish + fabric-real-vps-deploy + fabric-role-registry + server-node-rpc-wiring`: 32/32 pass after foreground agent changes

Full suite:

```bash
npm test
```

Result after the v4 `--from-server` pass: 2425 tests passed, 0 failed.

Additional local checks:

```bash
git diff --check
npm run web:build
```

Results: both passed. Vite emitted an existing large-chunk warning for `antd-core`.

Latest focused verification after the v8 real VPS pass:

```bash
node --test "test/fabric-real-vps-deploy.test.js" "test/fabric-registry-heartbeat.test.js" "test/fabric-role-registry.test.js" "test/server-node-rpc-wiring.test.js" "test/fabric-real-vps-registry-publish.test.js"
git diff --check
```

Results: 28/28 pass; `git diff --check` passed.

Latest focused verification after the v9 foreground agent pass:

```bash
node --test "test/fabric-registry-agent.test.js" "test/fabric-registry-heartbeat.test.js" "test/fabric-real-vps-registry-publish.test.js" "test/fabric-real-vps-deploy.test.js" "test/fabric-role-registry.test.js" "test/server-node-rpc-wiring.test.js"
git diff --check
```

Results: 32/32 pass; `git diff --check` passed.

Latest focused verification after the v10 real transport-probe pass:

```bash
node --test "test/fabric-registry-agent.test.js" "test/fabric-registry-heartbeat.test.js" "test/fabric-real-vps-registry-publish.test.js" "test/fabric-transport-probe.test.js" "test/fabric-real-vps-deploy.test.js" "test/fabric-role-registry.test.js" "test/server-node-rpc-wiring.test.js"
git diff --check
```

Results: 42/42 pass; `git diff --check` passed.

Latest focused verification after the registry agent service pass:

```bash
node --test "test/fabric-registry-agent.test.js" "test/fabric-registry-agent-service.test.js" "test/fabric-real-vps-registry-publish.test.js" "test/root.dispatch.test.js" "test/fabric-real-vps-deploy.test.js" "test/fabric-transport-tcp-echo.test.js" "test/node-relay-client.test.js"
git diff --check
```

Results: 50/50 pass; `git diff --check` passed.

Latest full suite after the relay stream test race fix:

```bash
npm test
```

Result: 2451/2451 pass.

Latest focused verification after source artifact cache:

```bash
node --test "test/fabric-real-vps-deploy.test.js" "test/fabric-real-vps-registry-publish.test.js" "test/fabric-registry-agent.test.js" "test/fabric-registry-agent-service.test.js" "test/fabric-transport-tcp-echo.test.js"
git diff --check
```

Results: 40/40 pass; `git diff --check` passed.

Latest full suite after source artifact cache:

```bash
npm test
```

Result: 2457/2457 pass.

Latest focused verification after outbound relay smoke:

```bash
node --test "test/fabric-real-outbound-relay-smoke.test.js" "test/node-relay-client.test.js" "test/server-node-rpc-wiring.test.js"
node "scripts/fabric-real-outbound-relay-smoke.js" --timeout-ms 30000
```

Results: 23/23 pass; local real smoke returned `ok=true`.

Latest full suite after outbound relay smoke:

```bash
npm test
```

Result: 2461/2461 pass.

## Real Issues Still Open

1. Public HTTP ingress is not usable on the current active AWS VPS. Current localhost `127.0.0.1:9527/readyz` passes and TCP `43.207.102.163:9527` connects, but the local-machine public HTTP probe to AWS `:9527/readyz` times out with 0 bytes.
2. `152.70.105.41` remains unstable under follow-up inspection. SSH pgrep/uptime checks timed out during banner exchange, so it is not a current stable validation target.
3. `155.248.183.169` is retired by user instruction because the link is too slow. Historical evidence is preserved above, but no new validation should target that host.
4. `39.104.59.31` is retired by user instruction. Historical evidence is preserved above, but no new validation should target that host.
5. Complex `aih claude` frontend patch worker is not stable. Do not attribute frontend code changes to Claude until a real patch run produces diff and browser/build evidence.
6. `node bin/ai-home.js export --help` is a real CLI UX bug: it treats `--help` as an export target and creates `./--help.zip`. The accidental artifact was removed after reproduction.
7. Source upload now uses a stable remote artifact cache, so repeated isolated deploys with the same source no longer retransmit the 26MB source archive. Changed-source delta upload is still not implemented.
8. `aih fabric registry agent` has foreground evidence and service manager/status/install/uninstall code, and `aih node service install/uninstall --dry-run` now composes relay + registry agent service plans. It is still not a production node daemon until a confirmed real install/start/rollback path is validated.
9. AWS current proves real native relay/control-plane Codex TUI session with cleanup, but it is still a single-host relay loopback proof, not a full home/company two-machine remote coding session with separate client and node devices.

## Verdict

Partial.

Real deployment, default `9527` server startup, source artifact cache reuse, import, isolated AIH home, credential layout, full provider runtime loading, `/v1/responses` non-stream/stream Codex calls, native relay/control-plane Codex TUI session cleanup, registry publish, registry heartbeat, foreground registry agent loop, service status reporting, supervised service install/uninstall dry-run planning, measured local TCP echo probe, and real outbound relay sessions RPC are verified on the current active AWS host: `ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`. Public HTTP ingress is still not client-ready, `152.70.105.41` is currently unstable, `155.248.183.169` and `39.104.59.31` are retired, and complex Claude frontend development is still not proven.
