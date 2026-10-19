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

### 4.1 裸 HTTP 的边界（2026-10-19 实测）

“复刻固定头 + 裸 Bearer 打 `POST /model/v1/chat/completions`”只能证明到配额层：

- 有效 token → `402 {"code":116,"error":"quota exceeded"}`；
- 假 token → `401`。

`402/116` 只证明 token 被接受、请求到达了配额判定，不能证明普通 HTTP 能生成内容。
`POST /model/v1/chat/completions` 与根路径均 404；`gateway.qoder.com.cn`（CN）返回
503 ALB。因此不能让“裸 HTTP”进入每请求固定延迟的路径。

### 4.2 WASM 签名链路已打通（2026-10-19 真机）

从二进制内嵌的 298606 字节 wasm 与 wasm-bindgen glue 复刻调用后，
`prepareInferRequest` 可以离线生成完整的线上请求。关键事实：

- 构造：`EN(machineId, cosyVersion, userInfoJson, optionsJson?)`；`machineId` 来自
  `.auth/machine_id`，`cosyVersion` 是 CLI 版本，`userInfoJson` 是
  `{"uid","encrypt_user_info","key"}`（来自 `.auth/user` 解密后的 payload）。
  `optionsJson` 可省略（glue 会传 `(0,0)`）。
- 签名 URL 固定为
  `https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`。
- 返回 20 个 header（**没有独立 `Signature` 头**，签名在
  `Authorization: Bearer COSY.<jwt>` 里）：`Accept`、`Authorization`、
  `Cache-Control`、`Connection`、`Content-Type`、`Cosy-Business-Product`、
  `Cosy-Business-Type`、`Cosy-ClientType`、`Cosy-Data-Policy`、`Cosy-Date`、
  `Cosy-Key`、`Cosy-MachineId`、`Cosy-MachineToken`、`Cosy-MachineType`、
  `Cosy-Scene`、`Cosy-User`、`Cosy-Version`、`Login-Version`、`X-Model-Key`、
  `X-Model-Source`。
- `Cosy-MachineToken` / `Cosy-MachineType` 必须用 `umid-cache.json` 的
  `info.machineToken` / `info.machineType` 覆盖；`Authorization` 不能改成裸 token。
- **wasm-bindgen ABI 坑**：`__wbindgen_cast_0000000000000002(ptr,len)` 必须返回
  `addHeapObject(readString(ptr,len))`，不是裸字符串；`__wbg_set_...` 的实参是
  heap index，返回裸字符串会让 Map 变成 `[undefined, undefined]`，服务端判
  `{"code":"101","message":"Signature invalid"}`。`__wbg_getRandomValues_...` 的入参是
  `(ptr,len)`；`requestresult_url/body` 的返回值读取后要 `free`，而传给
  `qodercontext_new/prepareInferRequest` 的输入字符串不能释放（否则
  `RuntimeError: unreachable`）。
- **代理**：本机 DNS 对 `api3.qoder.sh` 返回 fake-ip（198.18.x.x），Node `fetch` 默认
  不走 `HTTPS_PROXY`，会挂到超时；必须显式用 `ProxyAgent`（或让 CLI 走系统代理）。
  curl 走系统代理时对该端点的 GET 返回 400，说明主机可达。
- 修复 ABI 后，签名请求返回 `200 text/event-stream`，首帧是业务错误：
  `[FAIL]node:agent_router msg:None flow nodes found for router agent_router`。
  这证明签名 / URL / body 加密全部有效；**当前唯一阻塞是 body 里缺少服务端
  agent flow**（`business` / `flow` 形状未证明）。不要靠猜字段继续打；正确做法是
  从真实 CLI 请求抓一份完整 body（MITM 或客户端日志），或在付费账号上验证是否
  同一约束。在这种证据出现前，P1 的 HTTP transport 不应进入请求路径。

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
- `prepareInferRequest` 的精确 URL、20 个 header、加密 body 与完整 ABI；
- 账户面 4 条路径与 Free 档字段；
- 有效 token 的裸请求到配额层返回 402/116，假 token 返回 401；
- warm CLI：`--input-format stream-json` 在 `result` 后继续等待下一条 user 消息。

未证明（必须保留在布局表的 `unproven` 里）：

- `agent_chat_generation` 要求的 `business` / `flow` body 形状；
- 推理链路（非 MCP）实际发送哪些身份头、`safetyTag` 与 `internalContext` 的取值；
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
4. **P2：warm CLI（已实现）**。同一会话复用
   `--print --input-format stream-json` 常驻进程：首轮 ~7.6-8.6s，同进程第二轮
   ~2.7-3.5s（1.1.73 实测）。只有 `sessionKey` + 消息前缀哈希完全匹配才复用；
   无 sessionKey、最后一条不是纯文本 user、池满或进程 busy 时自动走冷启动。
   idle TTL 5 分钟、最多 8 个进程、LRU 淘汰 idle；失败/超时/abort 一律杀进程。

## 8. warm CLI 协议（1.1.73 实测）

- 启动参数在冷启动参数上追加 `--input-format stream-json`；`--print` 保留。
- 输入是一行 JSON：
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}`。
- 首轮发完整 transcript（`buildQoderCliPrompt`）；后续轮只发最后一条 user 文本，
  CLI 自己保留历史。
- 输出仍是逐行 stream-json；`result` 之后进程不退出，继续等待下一条输入。
- 复用校验：上一次请求的 `messages` + 本轮 assistant 回答 与本次请求的前缀逐字
  哈希一致；不一致重建进程，绝不跨会话带上下文。
- 估算用量：`usage` 全零时用 `context_usage_ratio × 200000` + 输出文本估算，
  `sourceKind` 带 `_estimated` 后缀；有真实非零计数时优先真值。

## 9. 升级后如何重新取证

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
