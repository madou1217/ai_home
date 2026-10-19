# Qoder 客户端协议取证（版本化）

> 事实源：`lib/runtime/qoder-client-layouts.js`。本文解释表里的每个字段从哪来、
> 哪些已经证明、哪些仍是未证明。升级 qodercli / qoderclicn 后必须重新取证并更新
> 布局表，不能把旧版本的结论直接沿用。

## 1. 当前取证版本

| 项目 | 值 |
| --- | --- |
| provider | `qoder` |
| CLI | `qodercli 1.1.73` |
| 二进制 | `~/.qoder/bin/qodercli/qodercli-1.1.73` |
| size | `162892288` bytes |
| sha256 | `ec2180c0d8425d882acb991d756e6617a0343546574792836a1286164ccb3327` |
| 取证日期 | 2026-10-19 |

`qodercn` 当前未安装（`qoderclicn` 不在本机），因此布局表里的 CN 条目是
`status: unverified`：只保留此前证据中的端点，不冒充已对当前版本验证。

> 注意：`docs/providers/agent-cli-usage.md` 的生成快照仍写着 qoder 1.1.72。
> 那是上次生成时的版本；升级 CLI 后应重跑
> `npm run providers:usage -- --write`，不要把快照当实时事实。

## 2. 端点

来自客户端自己维护的端点缓存
`~/.qoder/.cache/qoder-client-endpoint-cache.json`（2026-10-19）：

| 用途 | 端点 |
| --- | --- |
| inference | `https://api3.qoder.sh` |
| securityInference | `https://api2.qoder.sh` |
| center | `https://center.qoder.sh` |
| openapi | `https://openapi.qoder.sh` |

端点会轮换，**不要把它写死成二进制常量**。布局表记录取证时的值；运行时优先读
客户端缓存/账号配置，读不到才回落布局表。

账户面路径（qoder 与 qodercn 形状相同，只有主机不同）：

| 用途 | 路径 |
| --- | --- |
| 套餐 | `GET /api/v2/user/plan` |
| 用户状态 | `GET /api/v3/user/status` |
| 额度 | `GET /api/v2/quota/usage` |
| 客户端用量展示 | `GET /sash/api/v2/me/usage` |

`/api/v2/me/usage` 是 404；`/sash/api/v2/me/usage` 才是客户端实际使用的展示端点。

## 3. 身份头

### 3.1 `t5e` 注入的 8 个名字

从二进制里直接读到的常量：

```js
var iae = 'X-Qoder-Model';
var sae = 'X-Qoder-Model-Safety-Tag';
var aae = 'X-Qoder-Session-Id';
var cae = 'x-internal-session-id';
var lae = 'x-internal-model-key';
var uae = 'x-internal-business-id';
var dae = 'X-Session-ID';
var gae = 'X-RequestSet-ID';
```

注入语义（`t5e`）：

1. 先把这 8 个名字从传入 headers 里全部删除；
2. `X-Qoder-Model` = `trim(displayName) || trim(key)`；
3. `X-Qoder-Session-Id` 与 `X-Session-ID` 写同一个 `sessionId`；
4. `X-RequestSet-ID` = `requestSetId`；
5. `X-Qoder-Model-Safety-Tag` = `safetyTag`；
6. `x-internal-*` **只有在 sessionId、modelKey、businessId 三者都非空时**才整组写；
7. 所有值先去掉非可打印 ASCII（`[^\x20-\x7E]`），再 `trim()`。

**边界**：`t5e` 是 MCP 工具调用的注入中间件。推理链路是否发送同一组头、
`safetyTag` / `internalContext` 的真实取值，当前**尚未证明**（见第 6 节）。

### 3.2 `ModelServerHttpRequest` 的固定头

模型服务请求构造处直接设置：

```js
headers: {
  ...t.requestHeaders,
  Accept: 'text/event-stream',
  'Content-Type': 'application/json',
  Authorization: `Bearer ${token}`,
  'X-Request-ID': t.requestId,
  'X-Session-ID': t.sessionId
}
```

另外客户端还有 `QoderRequestZstd`：请求体超过阈值时可能 zstd 压缩，压缩不可用时
回退 identity（`Content-Encoding` 由它管理）。复刻 HTTP 时不能假设请求体永远是
明文 JSON。

## 4. 推理链路：客户端 JSON 不是线上 body

`inference.remoteChat.stream` 的构造：

```js
m.builder()
  .operation('inference.remoteChat.stream')
  .endpoint('inference')
  .post('/')
  .body(JSON.stringify(body))
  .requestId(body.request_id)
  .stream()
  .withWasmInferSigningMeta({
    modelKey: body.model_config.key,
    modelSource: body.model_config.source
  })
  .build();
```

`withWasmInferSigningMeta` 最终调用内嵌 WASM 的：

```js
prepareInferRequest(endpoint, bodyJson, modelKey, modelSource)
// -> { url, headers, body }
```

也就是说：**url、headers、body 三者都会被 WASM 改写**。客户端 JSON 只是签名输入，
不能直接当成线上请求体。

这解释了为什么“复刻头 + 裸 Bearer 打 `POST /model/v1/chat/completions`”目前只能
证明到配额层：

- 有效 token → `402 {"code":116,"error":"quota exceeded"}`；
- 假 token → `401`。

`402/116` 证明 token 被接受、请求到达了配额判定，但**没有证明**普通 HTTP 能生成
内容，也没有证明付费账号可绕过 WASM 签名。P1 的 HTTP transport 必须把这条边界
写清楚：它可以作为付费账号的探测/首选策略，失败必须自动切 CLI，绝不能把
`402/116` 记成账号故障。

## 5. 免费额度事实

2026-10-19 对两个本机 Free 账号实测：

- `/api/v2/quota/usage`：`userQuota.total=0`、`used=0`、`remaining=0`，
  `isQuotaExceeded=true`，`expiresAt=253402214400000`（9999-12-31 哨兵）。
- `/api/v2/user/plan`：`plan_tier_name:"Free"`、`is_paid_plan:false`。
- `/api/v3/user/status`：`plan:"PLAN_TIER_FREE"`。
- `/sash/api/v2/me/usage`：同一份 `qoderUsage` 的展示投影。

结论：**Free 档的 `isQuotaExceeded=true` 不是“额度耗尽”**。账号仍能通过 CLI 跑
免费模型；把它映射成 `remainingPct=0` 会让 `account-availability` 把健康账号摘出
路由。当前探针返回 `notApplicable: true`（`qoder_no_consumable_credits`）是正确
语义。qodercn 的“等待采集”是另一条问题（探测失败/字段缺失），不能用这个结论
掩盖，需单独修。

免费档的“每日限制”不在 credits API 里；客户端 `/usage` 页自己写的是
“Usage limits span all sessions and reset daily”，属于客户端本地会话估算，不能
当作账号面额度。

## 6. 已证明 / 未证明

已证明：

- 1.1.73 的 8 个身份头名字、值清洗规则、model/session/requestSet 的写入逻辑；
- 模型服务请求的 5 个固定头与 Bearer 位置；
- 推理链路的 WASM 签名调用与“三处改写”；
- 账户面 4 条路径与 Free 档字段；
- 有效 token 的裸请求到配额层返回 402/116，假 token 返回 401。

未证明（必须保留在布局表的 `unproven` 里）：

- 推理链路（非 MCP）实际发送哪些身份头、`safetyTag` 与 `internalContext` 的取值；
- `prepareInferRequest` 之后的精确 URL / body / 签名头；
- 付费账号走普通 HTTP 能否生成；
- qodercn 当前版本的端点、注入与签名链路；
- qoder CLI 的精确 token 数（`usage` 字段恒为 0，只能从
  `credits` / `context_usage_ratio` / 文本估算）。

## 7. 后续工程顺序

1. **P0：共享 idle watchdog**。qoder CLI 用 `--include-partial-messages` 产生流事件；
   idle 120s 重置计时，单轮硬上限 30min，消费
   `stream_event` / `content_block_delta` / `message_delta`，不再用整轮 120s 墙钟。
2. **P1：HTTP → CLI 策略链**。HTTP transport 只发送已证明的固定头；身份头用
   `buildQoderIdentityHeaders` 组合，未知值留空而不是编造。失败（含 402/116）
   统一 `retry_next` 切 CLI，日志记录策略名、状态、延迟、是否 fallback。
3. **P1.5：用量闭环**。扫描 qoder 会话 JSONL 的 `credits` / `billable` /
   `context_usage_ratio`，用输出文本做透明估算，写入 model usage；原生 chat 完成后
   触发同会话扫描，避免只等后台定时器。
4. **P2：warm CLI**。在 P1 的策略日志证明 HTTP 不稳定或不可用时，再评估常驻
   CLI/预热进程；没有证据前不引入。

## 8. 升级后如何重新取证

```bash
# 1) 版本与二进制指纹
command -v qodercli
qodercli --version
shasum -a 256 "$(readlink -f "$(command -v qodercli)")"

# 2) 端点缓存
cat ~/.qoder/.cache/qoder-client-endpoint-cache.json

# 3) 头常量（在二进制里搜索 X-Qoder-Model 附近的 var 赋值）
node - <<'NODE'
const fs = require('node:fs');
const bin = process.argv[1];
const s = fs.readFileSync(bin).toString('latin1');
for (const key of ['X-Qoder-Model', 'X-RequestSet-ID', 'prepareInferRequest']) {
  const at = s.indexOf(key);
  console.log(key, at);
  console.log(s.slice(Math.max(0, at - 400), at + 800).replace(/[^\x20-\x7e]/g, ' '));
}
NODE "$(readlink -f "$(command -v qodercli)")"

# 4) 更新布局表并跑测试
node --test test/qoder-client-layouts.test.js
```

验收标准：布局表的 `cliVersion` / `binary.sha256` / `capturedAt` 与当前二进制一致；
新增或变更的头常量、端点、签名行为必须同步更新 `unproven` 列表；测试必须通过。
