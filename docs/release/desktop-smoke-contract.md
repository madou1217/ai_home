# Desktop packaged smoke 契约

## 原则

smoke 必须从安装后的应用可执行文件进入正常的 Rust `SecretStore` 和 native transport。React 伪造结果、Node 直接替应用请求 fixture、内存 Keyring、明文密钥文件都不满足契约。

测试 Management Key 只存在于 harness 和 packaged 应用的进程环境中：

- 不作为命令行参数。
- 不写入 ready 文件、安装清单、fixture 日志或 release evidence。
- 不输出到 stdout/stderr。
- 应用结果一旦包含该值，harness 会删除结果并失败。

## 应用启动环境

| 环境变量 | 含义 |
| --- | --- |
| `AIH_DESKTOP_SMOKE_MODE=1` | 进入非交互 packaged smoke driver；未设置时不得改变正常启动行为 |
| `AIH_DESKTOP_SMOKE_RUN_ID` | 本次随机 UUID；同时用于隔离 Keyring entry |
| `AIH_DESKTOP_SMOKE_SERVER_URL` | 只监听 `127.0.0.1` 随机端口的 fixture URL |
| `AIH_DESKTOP_SMOKE_MANAGEMENT_KEY` | 一次性测试 Management Key，只能写入 OS Keyring，不得持久化到应用 JSON/localStorage |
| `AIH_DESKTOP_SMOKE_RESULT_PATH` | 应用原子写入结果 JSON 的绝对路径 |

建议 test-driver 执行顺序：

1. 验证全部环境变量和 loopback URL。
2. 以 `runId` 派生一次性 profile/credential reference。
3. 经正常 `KeyringSecretStore` 写入 Management Key。
4. 经相同抽象读回并只比较相等性，不记录值。
5. 经正常 Rust HTTP/SSE/Blob transport 按 profile ID 请求三个 fixture endpoint；transport 自行从 Keyring 取 key 并添加 `Authorization`。
6. 删除 Keyring entry，再读取并确认不存在。
7. 原子写入结果 JSON，然后退出或等待 harness 终止。
8. 任何失败都写入不含秘密的失败结果或以非零状态退出；不得降级到明文 SecretStore。

## Fixture HTTP 接口

fixture 只绑定 `127.0.0.1`。除 health 外，所有接口都要求：

```http
Authorization: Bearer <Management Key>
```

认证失败统一返回 `401 {"error":"unauthorized"}`，不会回显 header。

### `GET /healthz`

无需认证，仅供 harness 诊断：

```json
{"ok":true,"schemaVersion":1}
```

### `GET /v0/desktop-smoke/json`

返回 `application/json`：

```json
{
  "ok": true,
  "runId": "<AIH_DESKTOP_SMOKE_RUN_ID>",
  "transport": "rust-native",
  "authorization": "management-key"
}
```

### `GET /v0/desktop-smoke/sse`

返回 `text/event-stream`，每个 `data` 都是 JSON。应用必须保序解析成：

```json
[
  {"event":"meta","data":{"runId":"<run-id>","sequence":0}},
  {"event":"delta","data":{"sequence":1,"text":"desktop-smoke"}},
  {"event":"delta","data":{"sequence":2,"text":"跨平台"}},
  {"event":"done","data":{"sequence":3}}
]
```

连接正常 EOF 后 `completed` 才能为 `true`。只验证首块或把 SSE 当普通 JSON 均不通过。

### `GET /v0/desktop-smoke/blob`

返回固定 `application/octet-stream` 二进制，包含 NUL、非 ASCII 字节和 UTF-8 文本。应用必须以原始字节计算 `bytes` 与 SHA256；不能经过字符串解码再编码。准确值由 `scripts/desktop/lib/smoke-contract.js` 作为唯一真相源提供。

- `bytes`: `48`
- `sha256`: `f4c13c09387bd2126111ec24cb18f5ee2dce45d17c26f14f445ae8ab43f85de5`

## 应用结果 JSON

应用必须向 `AIH_DESKTOP_SMOKE_RESULT_PATH` 原子写入以下结构，且不得增加任何密钥值：

```json
{
  "schemaVersion": 1,
  "runId": "<run-id>",
  "platform": "macos | windows | linux",
  "keyring": {
    "backend": "macos-keychain | windows-credential-manager | linux-secret-service",
    "stored": true,
    "readBack": true,
    "deleted": true,
    "missingAfterDelete": true
  },
  "http": {
    "json": {
      "status": 200,
      "body": {
        "ok": true,
        "runId": "<run-id>",
        "transport": "rust-native",
        "authorization": "management-key"
      }
    },
    "sse": {
      "status": 200,
      "events": [
        {"event":"meta","data":{"runId":"<run-id>","sequence":0}},
        {"event":"delta","data":{"sequence":1,"text":"desktop-smoke"}},
        {"event":"delta","data":{"sequence":2,"text":"跨平台"}},
        {"event":"done","data":{"sequence":3}}
      ],
      "completed": true
    },
    "blob": {
      "status": 200,
      "bytes": 48,
      "sha256": "f4c13c09387bd2126111ec24cb18f5ee2dce45d17c26f14f445ae8ab43f85de5"
    }
  }
}
```

后端名称是验收值，不是自由文本：

| `platform` | 必需 `keyring.backend` |
| --- | --- |
| `macos` | `macos-keychain` |
| `windows` | `windows-credential-manager` |
| `linux` | `linux-secret-service` |

harness 还会独立检查 fixture request ledger，要求 JSON、SSE、Blob 三个路径都至少收到一次成功认证的 `200` 请求。仅写一个看似正确的结果文件不能通过。
