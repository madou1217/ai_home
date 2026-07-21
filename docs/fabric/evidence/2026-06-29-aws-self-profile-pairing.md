# 2026-06-29 AWS self server profile pairing

This evidence closes the AWS-side self-audit gap where `aih fabric closure audit`
could only return `ready_server_profile_missing` on the server itself.

No Mac server profile data was copied to AWS. The AWS host created and consumed
its own real device-pair invite against the existing default `9527` listener.

## Changed files

- `lib/cli/services/fabric/profile-pairing.js`
- `lib/cli/commands/fabric-router.js`
- `test/fabric-profile-pairing.test.js`
- `docs/fabric/evidence/2026-06-29-aws-self-profile-pairing.md`
- `docs/fabric/06-implementation-plan.md`
- `docs/fabric/08-current-status.md`

## Local verification

```sh
node --check lib/cli/services/fabric/profile-pairing.js
node --check lib/cli/commands/fabric-router.js
node --test test/fabric-profile-pairing.test.js test/fabric-closure-audit.test.js test/fabric-nodes-client.test.js test/fabric-real-transport-readiness-client-smoke.test.js
```

Result:

- syntax checks: pass
- focused/adjacent tests: 23/23 pass

The new focused test uses a real local HTTP server for:

1. `POST /v0/webui/control-plane/devices/invites`
2. `POST /v0/fabric/device-pair`
3. `GET /v0/fabric/descriptor`
4. local profile-store persistence

It also asserts CLI output does not include the raw device token or pair code.

## AWS remote verification

Remote deploy target:

```text
ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current
```

Remote focused checks:

```sh
NODE=.node-runtime/node-v22.16.0-linux-x64/bin/node
$NODE --check lib/cli/services/fabric/profile-pairing.js
$NODE --check lib/cli/commands/fabric-router.js
$NODE --test test/fabric-profile-pairing.test.js test/fabric-closure-audit.test.js
```

Result:

- syntax checks: pass
- remote focused tests: 12/12 pass

Before pairing, AWS self profile store was empty:

```json
{
  "version": 1,
  "activeProfileId": "",
  "profiles": []
}
```

AWS default listener was ready:

```json
{
  "ok": true,
  "service": "aih-server",
  "ready": true,
  "accounts": {
    "codex": 1,
    "gemini": 0,
    "claude": 4,
    "agy": 7,
    "opencode": 1
  }
}
```

Self pairing command:

```sh
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
$NODE bin/ai-home.js fabric profile pair-self \
  --endpoint http://127.0.0.1:9527 \
  --device-id aws-current-self-cli \
  --device-name 'AWS Current Self CLI' \
  --platform linux \
  --json
```

Result summary:

- `ok=true`
- action: `pair-self`
- endpoint: `http://127.0.0.1:9527`
- profile: `cp-1punknr`
- authState: `paired`
- deviceTokenPresent: `true`
- descriptor service: `aih-fabric`
- expected loopback warning was present
- raw token was not printed

AWS self profile store after pairing:

```json
{
  "activeProfileId": "cp-1punknr",
  "profiles": [
    {
      "id": "cp-1punknr",
      "endpoint": "http://127.0.0.1:9527",
      "state": "paired",
      "authState": "paired",
      "deviceTokenPresent": true,
      "descriptorService": "aih-fabric"
    }
  ]
}
```

## AWS self closure audit

Self audit without session proof:

```sh
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
$NODE bin/ai-home.js fabric closure audit \
  --endpoint http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --provider opencode \
  --skip-session \
  --skip-cloud-edge \
  --json
```

Result summary:

- `exitOk=true`
- `status=usable_with_blockers`
- `coreReady=true`
- `nodeReady=true`
- `transportReady=true`
- `targetProviderReady=true`
- `startableProviders=["opencode"]`
- `selectedTransportKind=webrtc`
- `ready_server_profile_missing` is no longer present
- registry read: unauthenticated `401`, authorized `200`

Self audit with real session proof:

```sh
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home \
$NODE bin/ai-home.js fabric closure audit \
  --endpoint http://127.0.0.1:9527 \
  --node-id aws-current-node \
  --provider opencode \
  --session-marker AIH_AWS_SELF_PROFILE_CLOSURE_OK_20260629_1702 \
  --event-timeout-ms 60000 \
  --session-timeout-ms 120000 \
  --skip-cloud-edge \
  --diagnostics-file /tmp/aih-aws-self-profile-closure-20260629-1702.json
```

Result:

```text
AIH Fabric closure audit
  endpoint: http://127.0.0.1:9527
  node_id: aws-current-node
  provider: opencode
  status: usable_with_blockers
  core_ready: yes
  selected_transport: relay
  fallback_used: yes
  startable_providers: opencode
  can_use_ssh: no
  can_open_project: yes
  session_proof: pass run=870db4c4-f5ab-4d43-8278-442359d4abe2 marker=yes done=yes events=5
  milestones:
    - M3: pass (node=aws-current-node relay=true project_host=true)
    - M3.5: pass (actions=8 runtime_gaps=3 ssh=false)
    - M4: pass (run=870db4c4-f5ab-4d43-8278-442359d4abe2 marker=true)
    - M5: pass (events=5 done=true cursor=5)
    - M6: pass (default=webrtc fallback=true advanced=true)
    - runtime: pass (opencode: start=true)
  result: pass
```

## Post-clean-deploy regression

After committing the change, a clean `git archive HEAD` artifact was deployed to
AWS current and the following remote regressions were run against the deployed
source.

Remote focused tests after clean deploy:

```sh
$NODE --test test/fabric-profile-pairing.test.js test/fabric-closure-audit.test.js
```

Result:

- 12/12 pass

Self audit after clean deploy without session proof:

- `exitOk=true`
- `coreReady=true`
- `nodeReady=true`
- `transportReady=true`
- `targetProviderReady=true`
- `selectedTransportKind=webrtc`
- `ready_server_profile_missing` absent

Self audit after clean deploy with real session proof:

```text
AIH Fabric closure audit
  endpoint: http://127.0.0.1:9527
  node_id: aws-current-node
  provider: opencode
  status: usable_with_blockers
  core_ready: yes
  selected_transport: webrtc
  fallback_used: no
  startable_providers: opencode
  can_use_ssh: no
  can_open_project: yes
  session_proof: pass run=86ce8d84-e837-4b78-bec2-378e8cf1c43a marker=yes done=yes events=5
  result: pass
```

Remaining blockers are unchanged and real:

- Codex: `auth_invalid:upstream_401`
- Claude: `auth_invalid:claude_not_logged_in`
- AGY: `auth_invalid:agy_not_signed_in`
- WebTransport: no HTTPS/H3 endpoint configured
- Multipath: no OpenMPTCPRouter/MPTCP data-plane promotion

## Conclusion

AWS current can now self-bootstrap a ready server profile through the product
pairing flow and run closure audit from its own host-home. The previous
`ready_server_profile_missing` blocker is closed without copying local Mac
profile data or provider credentials.
