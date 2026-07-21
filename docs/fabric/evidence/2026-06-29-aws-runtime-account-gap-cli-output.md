# 2026-06-29 AWS Runtime Account Gap CLI Output

## Scope

This evidence records a follow-up product clarity fix for AWS current runtime
diagnostics. Only AWS current was used for live verification:

- SSH: `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- key: `/Users/model/.ssh/aws.pem`
- remote dir: `/home/ubuntu/aih-fabric-current`
- product port: default `9527`

No old VPS host was touched. No provider credentials were imported to AWS.

## Product Change

`aih fabric nodes <node-id>` already exposed runtime blockers, but the human
readable output did not explain whether the blocker came from missing CLI
binaries or missing provider accounts.

The formatter now keeps the JSON contract unchanged and only appends the
runtime diagnostic summary to each human-readable runtime gap:

```text
cli=yes account_total=0 account_source=readyz
```

This makes the AWS state explicit:

- provider CLI binaries are installed and visible to the supervised service
  environment;
- AWS still has zero provider accounts;
- start-session remains blocked by `missing_provider_account:<provider>`.

## Real AWS Readback

Command:

```text
node bin/ai-home.js fabric nodes aws-current-node
```

Result:

```text
AIH Fabric nodes
  profile: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527 (cp-51hq70)
  endpoint: http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527
  http: unauth=401 auth=200
  registry: nodes=2 relay_nodes=2 projects=2 runtimes=4 transports=3
  node: AWS Current Node (aws-current-node)
  roles: node, relay-node
  capabilities: server=no relay=yes project_host=yes runtime_host=no ssh=no measured=yes
  transports: relay, webrtc (online)
  runtimes: none
  runtime_gaps:
    - codex: missing_provider_account:codex (cli=yes account_total=0 account_source=readyz)
    - claude: missing_provider_account:claude (cli=yes account_total=0 account_source=readyz)
    - agy: missing_provider_account:agy (cli=yes account_total=0 account_source=readyz)
    - opencode: missing_provider_account:opencode (cli=yes account_total=0 account_source=readyz)
  actions:
    - open-project: pending (m4_project_action_pending)
    - start-session:codex: blocked (missing_provider_account:codex)
    - start-session:claude: blocked (missing_provider_account:claude)
    - start-session:agy: blocked (missing_provider_account:agy)
    - start-session:opencode: blocked (missing_provider_account:opencode)
    - configure-ssh: blocked (missing_ssh_bootstrap_transport)
  result: pass
```

## AWS Ready Check

Command:

```text
ssh -i "/Users/model/.ssh/aws.pem" ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  'curl --noproxy "*" -fsS http://127.0.0.1:9527/readyz'
```

Result:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": false,
  "accounts": {
    "codex": 0,
    "gemini": 0,
    "claude": 0,
    "agy": 0,
    "opencode": 0
  }
}
```

`ready=false` is expected because AWS has no provider accounts.

## AWS Process Set

Command:

```text
ssh -i "/Users/model/.ssh/aws.pem" ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com \
  'ps -eo pid,ppid,cmd | grep -E "ai-home.js server serve|fabric registry agent|node relay connect" | grep -v grep'
```

Result:

```text
267786 62606 node /home/ubuntu/aih-fabric-current/bin/ai-home.js fabric registry agent http://127.0.0.1:9527 ... --runtime-diagnostics --interval-ms 30000
268188 1     node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
268219 62606 node /home/ubuntu/aih-fabric-current/bin/ai-home.js node relay connect http://127.0.0.1:9527 --node-id aws-current-node
```

## Transport Readiness Recheck

Command:

```text
node bin/ai-home.js fabric transport readiness --node-id aws-current-node --timeout-ms 20000 --json
```

Result summary:

```text
ok=true
profile.id=cp-51hq70
profile.authState=paired
unauthenticatedStatus=401
authorizedStatus=200
summary.nodes=1
summary.defaultTransport=relay
summary.fallbackReady=true
summary.promotionReady=false
summary.promotedTransports=[]
summary.blockers=webrtc:webrtc_not_promoted,webrtc:turn_relay_gate_not_ready,webtransport:webtransport_endpoint_not_configured,webtransport:webtransport_not_promoted,omr:openmptcprouter_not_detected,mptcp:mptcp_data_plane_not_promoted
```

Advanced transport promotion is still correctly blocked by external
prerequisites. Relay remains the default transport.

## Session Start Guard Recheck

Commands:

```text
node bin/ai-home.js fabric session start aws-current-node --provider codex --prompt AIH_AWS_RUNTIME_ACCOUNT_GUARD_CODEX_RECHECK --json
node bin/ai-home.js fabric session start aws-current-node --provider claude --prompt AIH_AWS_RUNTIME_ACCOUNT_GUARD_CLAUDE_RECHECK --json
node bin/ai-home.js fabric session start aws-current-node --provider agy --prompt AIH_AWS_RUNTIME_ACCOUNT_GUARD_AGY_RECHECK --json
node bin/ai-home.js fabric session start aws-current-node --provider opencode --prompt AIH_AWS_RUNTIME_ACCOUNT_GUARD_OPENCODE_RECHECK --json
```

Result:

```text
codex: status=1 blocked=true blockers=missing_provider_account:codex registryAuthorizedStatus=200 sessionStartStatus=0
claude: status=1 blocked=true blockers=missing_provider_account:claude registryAuthorizedStatus=200 sessionStartStatus=0
agy: status=1 blocked=true blockers=missing_provider_account:agy registryAuthorizedStatus=200 sessionStartStatus=0
opencode: status=1 blocked=true blockers=missing_provider_account:opencode registryAuthorizedStatus=200 sessionStartStatus=0
```

The client performed a real authorized registry read and did not post a fake
session start.

## Verification

```text
node --check lib/cli/services/fabric/nodes-client.js
node --test test/fabric-nodes-client.test.js
npm test
```

Results:

```text
node --check: pass
test/fabric-nodes-client.test.js: 4/4 pass
npm test: 2684/2684 pass
```

## AWS Source Sync

After commit `4fdf221`, a clean `git archive HEAD` artifact was used to update
the AWS current source tree. The deploy did not use the dirty local worktree.

Artifact:

```text
/tmp/aih-fabric-4fdf221.tar.gz
sha256=4cdb874af7a31edc31d08e315c14bdeae7bf926251e70a86f6857e665677a4e7
size=3.0M
remote=/home/ubuntu/aih-fabric-current/source-4fdf221.tar.gz
```

Remote sync command class:

```text
scp clean archive to AWS current
ssh cd /home/ubuntu/aih-fabric-current
sha256sum source-4fdf221.tar.gz
tar -xzf source-4fdf221.tar.gz -C /home/ubuntu/aih-fabric-current
```

Remote verification:

```text
node --check lib/cli/services/fabric/nodes-client.js
node --check bin/ai-home.js
node --test test/fabric-nodes-client.test.js
```

Results:

```text
node --check: pass
AWS test/fabric-nodes-client.test.js: 4/4 pass
```

AWS default `9527` remained healthy after source sync:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": false,
  "accounts": {
    "codex": 0,
    "gemini": 0,
    "claude": 0,
    "agy": 0,
    "opencode": 0
  }
}
```

The server was not restarted because this change is a CLI formatter change and
does not affect the running server request path. Keeping the process stable also
avoided unnecessary relay churn on the small AWS host.

## Conclusion

AWS current is now visibly classified as:

- node;
- relay node;
- project host;
- WebRTC candidate carrier;
- runtime-CLI-capable node;
- not a provider runtime host until provider accounts are explicitly imported.

The remaining AWS runtime blocker is intentionally:

```text
missing_provider_account:<provider>
```
