# 2026-06-28 M3 Preflight Registry Readback

## Scope

This evidence records a hardening change for `scripts/fabric-m3-daemon-preflight.js`.

Before this change, daemon preflight proved that AWS current had:

- one default `9527` server process,
- the expected isolated `AIH_HOST_HOME`,
- running supervised relay and registry-agent services,
- no unexpected residue processes.

It did not prove that the current AWS node was visible through Fabric registry readback. That gap can hide a product failure where processes are healthy but the local client still cannot see the AWS node.

## Code Change

Changed files:

```text
scripts/fabric-m3-daemon-preflight.js
test/fabric-m3-daemon-preflight.test.js
```

New read-only check:

- Uses the existing remote node token file.
- Sends a local AWS request to `http://127.0.0.1:9527/v0/fabric/registry`.
- Prints only sanitized registry counts, target node presence, runtime providers, and runtime gaps.
- Never prints token contents.
- Adds `registry_readback_failed` and `registry_target_node_missing` gates.

## Tests

```text
node --check scripts/fabric-m3-daemon-preflight.js
pass

node --test test/fabric-m3-daemon-preflight.test.js
tests 16
pass 16
fail 0
```

## Real AWS Verification

Command:

```bash
node scripts/fabric-m3-daemon-preflight.js --json
```

Sanitized result:

```json
{
  "ok": true,
  "target": {
    "ssh": "ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com",
    "remoteDir": "/home/ubuntu/aih-fabric-current",
    "nodeId": "aws-current-node",
    "port": 9527
  },
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "processes": [
      "238443 node bin/ai-home.js server serve --host 0.0.0.0 --port 9527"
    ]
  },
  "registry": {
    "ok": true,
    "http": 200,
    "counts": {
      "nodes": 2,
      "relayNodes": 2,
      "projects": 2,
      "runtimes": 4,
      "transports": 2,
      "nodeInventory": 2
    },
    "targetNode": {
      "id": "aws-current-node",
      "present": true,
      "runtimeHost": false,
      "runtimeProviders": [],
      "runtimeGaps": [
        "codex:missing_provider_runtime:codex",
        "claude:missing_provider_runtime:claude",
        "agy:missing_provider_runtime:agy",
        "opencode:missing_provider_runtime:opencode"
      ]
    },
    "error": ""
  },
  "residue": [],
  "remainingGate": []
}
```

## Interpretation

The AWS node is visible and healthy as a control plane / relay-capable node on default `9527`.

The AWS node is not a provider runtime host. `missing_provider_runtime:*` means AWS has no provider account/runtime snapshots of its own. It can still broker and relay sessions to a runtime-capable node such as `local-mac-remote-node`.
