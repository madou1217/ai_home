# 2026-06-29 Node Local SSH Binding

## Scope

This evidence records closing the gap where AWS was already configured as a
local SSH development host, but `aih fabric nodes aws-current-node` still showed
`ssh=no` and kept `configure-ssh` blocked.

The fix is intentionally client-side:

- the remote AWS registry stays the source of node/project/runtime/relay truth;
- local SSH connections and workspaces stay local in `app-state.db`;
- the client only enriches the node read model when a local SSH workspace root
  matches a project path returned by the registry;
- private keys, passwords, bearer tokens, and raw device tokens are never copied
  into the Fabric nodes report.

## Local SSH Inventory

Local app-state contains a real AWS SSH connection and workspace:

```text
ssh_connections:
  label=AWS Current Japan
  target=ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com
  authType=agent

ssh_workspaces:
  label=AIH Fabric Current
  remoteRoot=/home/ubuntu/aih-fabric-current
```

## Verification

Commands:

```text
node --check lib/cli/services/fabric/local-ssh-node-bindings.js
node --check lib/cli/services/fabric/nodes-client.js
node --test test/fabric-nodes-client.test.js test/fabric-node-inventory.test.js
node --test test/fabric-nodes-client.test.js test/fabric-node-inventory.test.js test/fabric-registry-client.test.js test/fabric-role-registry.test.js
npm test
```

Results:

```text
node --check: pass
focused nodes tests: 8/8 pass
expanded Fabric registry tests: 17/17 pass
full npm test: 2692/2692 pass
```

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
  capabilities: server=no relay=yes project_host=yes runtime_host=no ssh=yes measured=yes
  transports: relay, webrtc (online)
  runtimes: none
  runtime_gaps:
    - codex: missing_provider_account:codex (cli=yes account_total=0 account_source=readyz)
    - claude: missing_provider_account:claude (cli=yes account_total=0 account_source=readyz)
    - agy: missing_provider_account:agy (cli=yes account_total=0 account_source=readyz)
    - opencode: missing_provider_account:opencode (cli=yes account_total=0 account_source=readyz)
  ssh_links:
    - AWS Current Japan -> AIH Fabric Current (ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:/home/ubuntu/aih-fabric-current)
  actions:
    - open-project: enabled
    - start-session:codex: blocked (missing_provider_account:codex)
    - start-session:claude: blocked (missing_provider_account:claude)
    - start-session:agy: blocked (missing_provider_account:agy)
    - start-session:opencode: blocked (missing_provider_account:opencode)
    - configure-ssh: enabled
  result: pass
```

JSON leak check:

```text
node bin/ai-home.js fabric nodes aws-current-node --json | rg -n "privateKey|password|SECRET|aws.pem|device-token|Bearer"
```

Result: no matches.

## AWS Source Sync

Commit `8f375dc` was synced with a clean `git archive HEAD` artifact. The dirty
local worktree was not used.

Artifact:

```text
/tmp/aih-fabric-8f375dc.tar.gz
sha256=0474dbd9bee8a08a17371b5effafdd3ce008008cfc996f8fe52a360bfd675e2b
remote=/home/ubuntu/aih-fabric-current/source-8f375dc.tar.gz
```

Remote verification:

```text
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/local-ssh-node-bindings.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --check lib/cli/services/fabric/nodes-client.js
/home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node --test test/fabric-nodes-client.test.js test/fabric-node-inventory.test.js
```

Results:

```text
AWS node --check: pass
AWS focused nodes tests: 8/8 pass
AWS /readyz: ok=true, ready=false, provider accounts all 0
```

## Conclusion

AWS now reads as one product node with:

- relay and project host capabilities from the AWS registry;
- SSH bootstrap capability from the local SSH workspace binding;
- provider session actions still blocked by real `missing_provider_account:*`
  diagnostics.

This makes the output match the product model: all reachable machines are nodes,
and each node exposes only the capabilities that are actually available.
