# 2026-06-28 AWS Host Home Repair

## Scope

修复 AWS current default `9527` 上 server 与 Fabric registry agent 使用不同 data root 的问题。

约束：

- 只使用 AWS current：`ubuntu@ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com`。
- 只使用默认端口 `9527`。
- 不触碰旧服务器。
- 不导入 Mac 的 provider accounts 到 AWS。
- 不记录 device token、invite code 或 secret。

## Problem

本机重新读取 AWS Fabric registry 时出现真实失败：

```json
{
  "profile": {
    "state": "degraded",
    "authState": "paired",
    "lastError": "fabric_registry_http_401",
    "hasDeviceToken": true
  }
}
```

重新配对后 registry 曾返回 `counts=0`。这不是 AWS node 不存在，而是当前 public server process 没有 `AIH_HOST_HOME`：

```text
pid=223645
PWD=/home/ubuntu/aih-fabric-current
HOME=/home/ubuntu
AIH_HOST_HOME=<missing>
```

因此 server 读写的是 `/home/ubuntu/.ai_home`，而长期运行的 Fabric registry agent 使用的是项目内 host home：

```text
pid=140408
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
```

这导致 pairing/device token 和 registry 数据不在同一个 store。

## Repair

只重启 AWS 上默认 `9527` server，保留 registry agent 不动。

```text
old_pids=223645
new_pid=225598
```

新 server process：

```text
225598 /home/ubuntu/aih-fabric-current/.node-runtime/node-v22.16.0-linux-x64/bin/node bin/ai-home.js server serve --host 0.0.0.0 --port 9527
```

新 process environment：

```text
PWD=/home/ubuntu/aih-fabric-current
HOME=/home/ubuntu
AIH_HOST_HOME=/home/ubuntu/aih-fabric-current/.aih-host-home
```

Port check：

```text
9527 /readyz: HTTP 200
9528 /readyz: timeout / unreachable
```

## Real Re-Pair

因为修复前的一次 pairing 写入了错误 data root，修复后重新执行真实 Server Setup pairing：

1. AWS `POST /v0/webui/control-plane/devices/invites`
2. AWS `POST /v0/fabric/device-pair`
3. Local `POST /v0/webui/control-plane/profiles`
4. AWS `GET /v0/fabric/registry` with bearer device token

Sanitized result：

```json
{
  "ok": true,
  "pairedDeviceId": "local-mac-fabric-client",
  "savedProfile": {
    "id": "cp-51hq70",
    "endpoint": "http://ec2-43-207-102-163.ap-northeast-1.compute.amazonaws.com:9527",
    "state": "paired",
    "authState": "paired",
    "lastError": "",
    "hasDeviceToken": true
  },
  "counts": {
    "nodes": 2,
    "relayNodes": 2,
    "transports": 2,
    "projects": 2,
    "runtimes": 4
  }
}
```

## Runtime Interpretation

AWS current node is connected and useful as a Fabric node, but it is not a provider runtime host:

```json
{
  "id": "aws-current-node",
  "runtimeHost": false,
  "projectHost": true,
  "relayNode": true,
  "relayState": "online",
  "runtimeProviders": [],
  "runtimeCount": 0,
  "projectCount": 1,
  "transportKinds": ["relay"],
  "startSessionBlockers": [
    "missing_provider_runtime:codex",
    "missing_provider_runtime:claude",
    "missing_provider_runtime:agy",
    "missing_provider_runtime:opencode"
  ]
}
```

The paired local Mac node is the provider runtime host in the current registry:

```json
{
  "id": "local-mac-remote-node",
  "runtimeHost": true,
  "projectHost": true,
  "relayNode": true,
  "relayState": "online",
  "runtimeProviders": ["agy", "claude", "codex", "opencode"],
  "runtimeCount": 4,
  "projectCount": 1
}
```

## Conclusion

The AWS current node is again visible through the local paired server profile and authorized Fabric registry read.

`missing_provider_runtime:*` on AWS means that AWS has no provider account/runtime snapshots of its own. It can still act as control plane, broker, relay-capable node, SSH development machine, and project host. It cannot directly start Codex/Claude/AGY/OpenCode sessions for its own project until provider accounts/runtime snapshots are intentionally imported or configured on AWS.

## Preflight Hardening

After the repair, `scripts/fabric-m3-daemon-preflight.js` was hardened so future checks verify the running server process `AIH_HOST_HOME` through `/proc/<pid>/environ`.

It now separates expected long-running supervised processes from unexpected residue:

- `supervisedProcesses`: installed relay and registry agent processes for the current node.
- `residue`: unexpected smoke, transport echo, broker, or fabric-real helper processes.

Local focused test:

```text
node --test test/fabric-m3-daemon-preflight.test.js
tests 13
pass 13
fail 0
```

Real AWS preflight after hardening:

```json
{
  "ok": true,
  "verdict": "ready_for_confirmed_7_3_execution",
  "server": {
    "readyzHttp": 200,
    "processCount": 1,
    "expectedHostHome": "/home/ubuntu/aih-fabric-current/.aih-host-home",
    "hostHomes": [
      {
        "pid": 225598,
        "hostHome": "/home/ubuntu/aih-fabric-current/.aih-host-home",
        "ok": true
      }
    ]
  },
  "serviceStatus": {
    "managementKeyConfigured": true,
    "supervisorReady": true,
    "relay": {
      "running": true
    },
    "registryAgent": {
      "running": true
    }
  },
  "residue": [],
  "remainingGate": []
}
```
