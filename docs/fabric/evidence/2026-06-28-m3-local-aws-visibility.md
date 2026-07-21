# 2026-06-28 M3 Local AWS Visibility Evidence

## Scope

验证 M3 7.6：

```text
local browser has a ready AWS server profile
-> Fabric Nodes reads AWS current registry through that authorized profile
-> local SSH dev machine management contains AWS current
-> AWS SSH connection and remote workspace browse pass real checks
```

本轮只使用本机和 AWS current，不访问旧 `152/155/39.104` 服务器，不新增产品端口。AWS current 继续使用默认 `9527`。

## Environment

| item | value |
|---|---|
| Date | 2026-06-28 |
| Local cwd | `/Users/model/projects/feature/ai_home` |
| Local WebUI | `http://127.0.0.1:9527/ui` |
| AWS endpoint | `http://43.207.102.163:9527` |
| AWS SSH target | `ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com` |
| AWS SSH key | `/Users/model/.ssh/aws.pem` |
| AWS dir | `/home/ubuntu/aih-fabric-current` |
| Browser session | Playwright `aih-76` |
| Fabric Nodes screenshot | `.playwright-cli/page-2026-06-27T17-01-13-021Z.png` |

## AWS Endpoint Checks

Public AWS default port is reachable:

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

Interpretation: `ready=false` is the AWS account-pool readiness state after cleanup. It does not block Fabric server/profile usage. The Fabric descriptor on the same endpoint is valid:

```json
{
  "ok": true,
  "service": "aih-fabric",
  "server": {
    "endpoint": "http://43.207.102.163:9527",
    "port": 9527
  },
  "roles": ["server", "relay"],
  "auth": {
    "devicePairing": true,
    "managementKeyConfigured": true
  }
}
```

## Ready Server Profile

The real browser session is no longer in the `no ready server profile` state.

Sanitized browser localStorage/profile summary:

```json
{
  "url": "http://127.0.0.1:9527/ui/fabric/nodes",
  "profileEntryCount": 2,
  "hasAwsEndpoint": true,
  "hasDeviceToken": true,
  "activeServerText": "ACTIVE SERVER http://43.207.102.163:9527 ... PROFILE STATE PAIRED",
  "registryText": "nodes 2 relayNodes 2 projects 2 runtimes 4 transports 2"
}
```

No device token or invite code is recorded in this evidence. A previous exploratory browser dump exposed one test device token; that device was revoked before this final pairing and evidence pass. The final profile evidence only records token presence as `hasDeviceToken=true`.

## Fabric Nodes UI

Real browser path:

```text
http://127.0.0.1:9527/ui/fabric/nodes
active Fabric server: http://43.207.102.163:9527
profile state: paired
```

Registry summary visible in the UI:

| metric | value |
|---|---:|
| nodes | 2 |
| relayNodes | 2 |
| projects | 2 |
| runtimes | 4 |
| transports | 2 |

Visible node rows:

| node | status | platform | projects | runtimes | relay |
|---|---|---|---:|---:|---|
| `aws-current-node` | online | linux / x64 | 1 | 0 | online |
| `local-mac-remote-node` | online | darwin / arm64 | 1 | 4 | online |

AWS relay health visible in the UI:

```text
aws-current-node-relay
online
p95 1ms · 100% ok (20) · 4ms · ws_echo_pass
```

Browser console:

```text
Total messages: 0 (Errors: 0, Warnings: 0)
```

## SSH Dev Machine Management

Local WebUI SSH connection list now contains AWS current:

```json
{
  "id": "conn_d05358604a4ee45b",
  "label": "AWS Current Japan",
  "host": "ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com",
  "port": 22,
  "user": "ubuntu",
  "authType": "agent",
  "password": "",
  "privateKey": ""
}
```

Local WebUI SSH workspace list now contains the AWS current project:

```json
{
  "id": "ws_f12f21b6d90320e0",
  "connectionId": "conn_d05358604a4ee45b",
  "label": "AIH Fabric Current",
  "remoteRoot": "/home/ubuntu/aih-fabric-current"
}
```

Real SSH test through the product API:

```json
{
  "ok": true,
  "result": {
    "status": "reachable",
    "platform": "Linux",
    "arch": "x86_64",
    "commands": {
      "node": false,
      "npm": false,
      "git": true,
      "aih": false
    },
    "timedOut": false
  }
}
```

Real direct SSH check:

```text
/home/ubuntu
aih-fabric-current-ok
Linux
x86_64
```

Real browse API check:

```json
{
  "ok": true,
  "currentDir": "/home/ubuntu/aih-fabric-current",
  "parentDir": "/home/ubuntu",
  "directories": [
    ".aih-host-home",
    ".node-runtime",
    "docs",
    "lib",
    "scripts",
    "test",
    "web"
  ]
}
```

The full browse response also included other real directories under `/home/ubuntu/aih-fabric-current`, including `node_modules`, `bin`, `cli`, `assets`, `third_party`, and project-local hidden directories.

## 7.3 Current Sample Check

To make sure 7.6 is not relying on stale daemon evidence, AWS current was sampled again:

```json
{
  "ok": true,
  "supervisor": {
    "ready": true,
    "required": [
      { "key": "relay", "ready": true },
      { "key": "registry_agent", "ready": true }
    ],
    "issues": []
  },
  "services": {
    "relay": {
      "installed": true,
      "enabled": true,
      "active": true,
      "running": true
    },
    "registryAgent": {
      "installed": true,
      "enabled": true,
      "active": true,
      "running": true
    }
  }
}
```

There is one non-blocking hardening warning in the status output: the remote host does not expose a global `aih` command on PATH. The supervised services themselves are running through the bundled node runtime and `bin/ai-home.js`.

## Product Boundary

Current ready server profiles are browser-local profiles stored in the browser profile/localStorage, not a Mac-wide shared server-profile store. This evidence proves the product flow works in a real local browser session and through real local APIs. A different browser/user-data-dir still needs its own pairing/import until a shared local profile store is implemented.

## Verdict

pass

M3 subtask 7.6 is complete:

- local browser has a paired AWS server profile;
- Fabric Nodes reads AWS current registry from that authorized profile;
- AWS current appears in local SSH dev machine management;
- AWS SSH connection and workspace browse pass real checks;
- no mock data or fake endpoints were used.
