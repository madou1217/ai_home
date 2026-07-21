# M3 Supervised Daemon AWS Evidence

Date: 2026-06-28

Target:

- `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`
- Remote dir: `/home/ubuntu/aih-fabric-current`
- Default port: `9527`
- Node id: `aws-current-node`

## Result

7.3 is closed on AWS current.

- `node service status --control-url http://127.0.0.1:9527 --node-id aws-current-node --json`
  - `ok=true`
  - `supervisor.ready=true`
  - relay `running=true`
  - registryAgent `running=true`
  - `managementKeyConfigured=true`
- systemd user services are both active:
  - `com.clawdcodex.ai_home.node-relay.aws-current-node.service`
  - `com.clawdcodex.ai_home.fabric-registry-agent.aws-current-node.service`
- Registry measurement after service restart:
  - `nodes=2`
  - `relayNodes=2`
  - `transports=2`
  - `aws-current-node-relay.measurement.status=ws_echo_pass`
  - `sampleCount=20`
  - `successRate=1`
  - `rttMs.p95=1`
  - fresh readback age was about 19 seconds.

## Fixes Applied

- `fix(fabric): Pass AIH host home to supervised services`
  - systemd units now include `Environment="AIH_HOST_HOME=..."`.
  - service files still do not store raw tokens or management keys.
- `fix(server): Keep management secrets out of restart argv`
  - daemon/restart argv no longer includes `--api-key` or `--management-key`.
  - `server serve` reads sensitive config from `server-config.json` via the configured `AIH_HOST_HOME`.
  - source auto-restart strips legacy sensitive serve args before replaying restart.

## Real AWS Steps

- Generated AWS server management key through `aih server config set --generate-management-key --open-network --port 9527 --json`.
- Reinstalled supervised services through `aih node service install http://127.0.0.1:9527 ... --yes --json`.
- Found real relay failure:
  - first failure: service unit did not pass `AIH_HOST_HOME`.
  - second failure: `aws-current-node` remote-node secret was missing, causing relay WebSocket upgrade `401`.
- Created a real node invite through `/v0/webui/nodes/invites` and consumed it with `aih node join ... --transport relay --node-id aws-current-node`.
  - Invite code is intentionally not recorded.
  - Hash-only verification confirmed server config key and remote-node secret matched.
- Restarted AWS server with the argv fix applied.
  - New server process:
    - `server serve --host 0.0.0.0 --port 9527`
  - No `--management-key`, `--api-key`, `AIH_SERVER_MANAGEMENT_KEY`, or `managementKey` appeared in the checked server/relay/registry process argv.
- Restarted both user services and waited for a full registry heartbeat interval.

## Secret And Residue Checks

- Unit secret check:
  - `unit_no_sensitive_match`
- Exact PID process secret check:
  - `process_no_sensitive_match`
- Expected remaining processes only:
  - AWS server on default `9527`
  - `node relay connect http://127.0.0.1:9527 --node-id aws-current-node`
  - `fabric registry agent http://127.0.0.1:9527 --node-id aws-current-node ... --token-file ...`
- No smoke, browser, broker, or old isolated test process was present in the final process check.

## Local Verification

- `node --test test/node-relay-service.test.js test/fabric-registry-agent-service.test.js test/node-doctor.test.js`
  - `34/34` pass
- `node --test test/server-config-store.test.js test/server.command-fast-start.test.js test/server.source-auto-restart.test.js test/node-relay-service.test.js test/fabric-registry-agent-service.test.js test/node-doctor.test.js`
  - `64/64` pass
- `node --check` passed for:
  - `lib/cli/services/node/relay-service.js`
  - `lib/cli/services/fabric/registry-agent-service.js`
  - `lib/server/command-handler.js`
  - `lib/server/server-config-store.js`
  - `lib/server/source-auto-restart.js`
- Remote AWS `node --check` passed for:
  - `lib/server/command-handler.js`
  - `lib/server/server-config-store.js`
  - `lib/server/source-auto-restart.js`

## Remaining M3 Work

7.6 is next:

- Local browser must have a ready AWS server profile.
- Fabric Nodes must read AWS registry from an authorized server profile.
- AWS current must be added to local SSH dev machine management and pass a real connection test.
