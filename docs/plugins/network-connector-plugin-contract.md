# 网络接入连接器插件契约

状态：v1（`network.connector@1`）
适用范围：Tailscale、WireGuard、Cloudflare Tunnel、FRP 以及后续独立发布的网络接入实现。
宿主方向：AIH 核心只提供插件生命周期、能力发现、调用、授权与展示；厂商实现必须以仓外插件接入。

## 1. 目标与边界

`network.connector` 是一个**能力贡献项**，不是 AIH 核心工具目录里的一个厂商枚举。插件可以独立发布、签名、升级和卸载，不需要把新厂商代码合并进 `internal/runtime/edgeproxy`、`internal/runtime/toolkit/tools` 或 WebUI 的厂商分支。

核心负责：

- 接受、校验、签名信任、启用、停用和卸载插件包；
- 在独立的 Node/process 插件宿主中调用连接器；
- 对返回值做大小、字段和敏感信息边界校验；
- 把连接器声明的操作和状态投影给 CLI/WebUI；
- 记录调用结果、失败原因和可验证的连通性证据。

插件负责：

- 探测或安装自身依赖的外部程序；
- 生成、备份、校验和应用厂商配置；
- 启动、停止、重启、启用和停用外部服务；
- 登录/授权、密钥或 credentials 的获取与持久化；
- 执行厂商自己的连通性探测，并如实报告路径类型。

**插件生命周期与连接器生命周期不能混淆：**

- 插件生命周期：`install/uninstall/enable/disable` 一个 `.aih-plugin` 制品和它的宿主实例；
- 连接器生命周期：插件内部声明的 `install/uninstall/enable/disable/configure/connect/disconnect/probe`，操作的是 Tailscale、WireGuard、cloudflared 等外部工具或网络配置；
- 卸载插件前，宿主必须先停用实例；连接器是否清理外部工具、配置和密钥由插件声明并在确认文案中明确，不能由核心猜测。

当前 process 插件没有 OS 级沙箱。安装并启用一个有网络连接器能力的插件，等同于允许其以 AIH 服务用户身份执行该插件进程。因此：只接受签名制品，要求用户明确接受 manifest 权限，并把高风险操作保持为显式确认；本契约不会把“按钮”伪装成安全隔离。

## 2. Manifest 能力声明

插件清单只声明能力，不写死厂商：

```json
{
  "manifestVersion": 1,
  "protocolVersion": 1,
  "pluginId": "network.tailscale",
  "version": "1.0.0",
  "engines": { "aih": ">=1.0.0" },
  "runtime": "process",
  "entry": "connector.py",
  "exec": { "argv": ["python3", "connector.py"] },
  "permissions": {
    "network": ["https://login.tailscale.com"],
    "filesystem": { "read": ["state"], "write": ["state"] },
    "secrets": ["tailscale-auth-key"],
    "environment": []
  },
  "contributes": [
    {
      "id": "network.tailscale.connector",
      "capability": "network.connector",
      "version": 1,
      "failurePolicy": "delegate"
    }
  ]
}
```

示例中的 `network.tailscale` 只是插件 ID 示例，不是核心内置实现。WireGuard、Cloudflare Tunnel 和后续实现应使用自己的仓外插件包和独立版本线。

## 3. RPC 操作

插件贡献项使用现有 process-runtime 的行分隔 JSON-RPC。所有请求带 `schemaVersion: 1` 和 `kind`。

### 3.1 `describe`

请求：

```json
{ "schemaVersion": 1, "kind": "describe" }
```

响应：

```json
{
  "schemaVersion": 1,
  "kind": "describe",
  "connector": {
    "id": "tailscale",
    "name": "Tailscale",
    "description": "Tailnet mesh connector",
    "transport": "mesh",
    "operations": [
      { "id": "install", "label": "安装依赖", "confirmation": "required", "inputKind": "none" },
      { "id": "uninstall", "label": "卸载依赖", "confirmation": "required", "inputKind": "none" },
      { "id": "enable", "label": "启用", "confirmation": "required", "inputKind": "none" },
      { "id": "disable", "label": "停用", "confirmation": "required", "inputKind": "none" },
      { "id": "configure", "label": "配置", "confirmation": "required", "inputKind": "secret" },
      { "id": "probe", "label": "探测连通性", "confirmation": "none", "inputKind": "none" }
    ],
    "config": {
      "schema": { "type": "object" },
      "secretFields": ["authKey"]
    },
    "connectivityModes": ["direct-p2p", "peer-relay", "derp-relay", "unavailable", "unknown"]
  }
}
```

`operations[].id` 只能是插件实现实际支持的动作。宿主/WebUI 不为未声明的动作生成按钮。

`inputKind` 可选值为 `none`、`custom`、`secret`，默认是 `none`。`none` 操作不会收到配置输入；`custom` 显示插件自定义文本/JSON 输入；`secret` 显示密码输入。若旧插件只声明了 `config.schema` 或 `secretFields`，WebUI 仅对 `configure` 做兼容推断，不把它当成完整 JSON Schema 表单。`install`、`uninstall`、`enable`、`disable`、`configure` 无论插件是否错误声明 `confirmation: "none"`，宿主都强制要求管理面明确确认。

### 3.2 `status`

请求：

```json
{ "schemaVersion": 1, "kind": "status" }
```

响应必须是脱敏的：

```json
{
  "schemaVersion": 1,
  "kind": "status",
  "status": {
    "installed": true,
    "enabled": true,
    "running": true,
    "state": "connected",
    "version": "1.80.0",
    "message": "connected",
    "connectivity": {
      "mode": "direct-p2p",
      "confidence": "observed",
      "observedAt": "2026-11-22T08:00:00Z",
      "peerId": "peer-redacted",
      "latencyMs": 34,
      "evidence": {
        "source": "tailscale status/tailscale ping",
        "path": "direct",
        "transport": "udp"
      }
    }
  }
}
```

禁止返回：私钥、auth key、access token、完整 credentials JSON、配置值、完整本地路径、未脱敏公网地址。可以返回版本、状态、延迟、脱敏 peer 标识和证明结论。

### 3.3 `operate`

请求：

```json
{
  "schemaVersion": 1,
  "kind": "operate",
  "action": "configure",
  "input": {
    "tailnet": "example.ts.net",
    "peer": "server-a"
  }
}
```

响应：

```json
{
  "schemaVersion": 1,
  "kind": "operate",
  "action": "configure",
  "ok": true,
  "changed": true,
  "message": "configuration applied",
  "status": { "state": "connecting" }
}
```

`input` 的 schema 和 secret 字段由 `describe` 声明；宿主只转发已声明的操作，不把 secret 回显到状态或审计文本中。带 `confirmation: "required"` 的操作必须由管理面在用户明确确认后携带 `confirmed: true` 才会执行；插件应该在写配置前备份、写入后校验，失败回滚，并把真实失败暴露给 UI。

## 4. P2P 与中继语义

连接器必须把“传输方式”和“连通性路径”分开报告。`connected` 只能表示连接建立，不等于直连 P2P。

| `connectivity.mode` | 含义 | UI 文案建议 |
| --- | --- | --- |
| `direct-p2p` | 已观察到两端直接路径，没有中继 | 直连 P2P |
| `peer-relay` | 通过同一网络中的对等中继节点 | 对等中继 |
| `derp-relay` | 通过 DERP 或厂商云中继 | DERP/云中继 |
| `outbound-tunnel` | 本机仅建立出站连接，由云端/远端入口转发 | 出站隧道 |
| `wireguard-tunnel` | WireGuard 加密隧道已握手；除非另有 path 证据，不自动称为直连 P2P | WireGuard 隧道 |
| `unavailable` | 未安装、未启用或探测失败 | 不可用 |
| `unknown` | 已连接但插件没有足够证据判断路径 | 已连接，路径未知 |

插件不得因为“有一个公网 endpoint”就声明 `direct-p2p`；必须带有可复核的 `evidence.source` 与 `evidence.path`。探测结果可能随 NAT、防火墙或网络变化而降级，宿主应允许状态从 direct 回到 relay/unknown。

## 5. Tailscale、WireGuard、Cloudflare 的建模建议

- **Tailscale**：建模为 `mesh`。插件负责登录、节点状态、`tailscale status`/`tailscale ping`/`tailscale netcheck` 探测，并把 direct、peer-relay、DERP 分开。它最适合“AIH 节点之间的远控/内网访问”。
- **WireGuard**：建模为 `wireguard`。插件负责 key、peer、AllowedIPs、endpoint、PersistentKeepalive 和服务生命周期。握手只证明 WireGuard 隧道有数据交换；若要声明直连 P2P，还要有 endpoint/path 证据。
- **Cloudflare Tunnel**：建模为 `outbound-tunnel`。它适合把本机 WebUI/HTTP 服务通过出站连接暴露到 Cloudflare 入口，不应被展示为两台 AIH 节点之间的直连 P2P。

这三类可以在同一个“网络连接器”面板中展示，但不共享配置表单、不共享状态枚举的解释，也不互相伪造能力。

## 6. 版本与独立仓库

外部插件仓库至少应维护：

- `plugin.json`/manifest、协议版本和最低 AIH 版本；
- 厂商 CLI/服务版本探测与平台支持矩阵；
- 配置迁移、备份/回滚和卸载清理说明；
- 真实连通性证据格式和失败诊断；
- 与 AIH 版本兼容的 `.aih-plugin` 签名发布物。

AIH 核心只依赖 `network.connector@1`。新增厂商、安装策略或 P2P 探测逻辑应在插件仓库独立更新；只有协议或宿主安全边界变化时才修改核心。
