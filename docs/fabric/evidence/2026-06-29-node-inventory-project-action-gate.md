# 2026-06-29 Node Inventory Project Action Gate

## Scope

This evidence records the cleanup of the stale `m4_project_action_pending`
blocker from the unified Node Inventory read model.

The action gate now reflects the real node state:

- `open-project` is enabled when the node has at least one project snapshot;
- `open-project` is blocked only by `missing_project_snapshot` when no project
  snapshot exists;
- provider session actions remain gated by provider runtime/account readiness.

## Local Verification

```text
node --check lib/server/fabric-node-inventory.js
node --test test/fabric-node-inventory.test.js test/fabric-role-registry.test.js test/fabric-registry-client.test.js test/fabric-nodes-client.test.js test/fabric-session-start-client.test.js
npm test
```

Results:

```text
node --check: pass
focused node inventory/registry/client/session tests: 19/19 pass
npm test: 2687/2687 pass
```

## AWS Source Sync

Commit `5926b4e` was synced with a clean `git archive HEAD` artifact. The dirty
local worktree was not used.

Artifact:

```text
/tmp/aih-fabric-5926b4e.tar.gz
sha256=c034daaf88ae3e443c7d9c64dee4fa0ca220a38fec106ab289c906a78512a8d1
remote=/home/ubuntu/aih-fabric-current/source-5926b4e.tar.gz
```

Remote verification:

```text
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/server/fabric-node-inventory.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-node-inventory.test.js test/fabric-nodes-client.test.js
```

Results:

```text
AWS node --check: pass
AWS focused tests: 6/6 pass
```

## AWS Restart

The default `9527` server was restarted with the existing `.aih-host-home`
server config and management key.

Runtime status:

```text
server pid: 276554
management_auth: enabled (Bearer key required)
registry-agent: active, pid=276850
relay-node: active, pid=276855
```

AWS `/readyz` remained reachable:

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

## Real Readback

`aih fabric nodes aws-current-node` returned:

```text
http: unauth=401 auth=200
registry: nodes=2 relay_nodes=2 projects=2 runtimes=4 transports=3
node: AWS Current Node (aws-current-node)
capabilities: server=no relay=yes project_host=yes runtime_host=no ssh=no measured=yes
runtime_gaps:
  - codex: missing_provider_account:codex (cli=yes account_total=0 account_source=readyz)
  - claude: missing_provider_account:claude (cli=yes account_total=0 account_source=readyz)
  - agy: missing_provider_account:agy (cli=yes account_total=0 account_source=readyz)
  - opencode: missing_provider_account:opencode (cli=yes account_total=0 account_source=readyz)
actions:
  - open-project: enabled
  - start-session:codex: blocked (missing_provider_account:codex)
  - start-session:claude: blocked (missing_provider_account:claude)
  - start-session:agy: blocked (missing_provider_account:agy)
  - start-session:opencode: blocked (missing_provider_account:opencode)
  - configure-ssh: blocked (missing_ssh_bootstrap_transport)
result: pass
```

`fabric session start aws-current-node --provider codex` still did not post a
session start request because the AWS node has no provider account:

```text
blocked=true
registryAuthorizedStatus=200
sessionStartStatus=0
blockers=missing_provider_account:codex
```

Transport readiness remained unchanged:

```text
defaultTransport=relay
fallbackReady=true
relayMeasurementPass=true
promotionReady=false
relay p95=2ms
```

## Conclusion

Node Inventory now tells the product truth:

- AWS is a project host, relay node, and measurable node;
- AWS can expose/open its registered project entry;
- AWS still cannot start provider sessions until provider accounts are
  explicitly imported or configured on that node;
- default transport remains relay until M6 external prerequisites are available.
