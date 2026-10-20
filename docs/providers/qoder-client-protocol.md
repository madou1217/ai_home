# Qoder 客户端协议取证（版本化）

> 事实源：`lib/runtime/qoder-client-layouts.js`。本文解释表里的每个字段从哪来、
> 哪些已经证明、哪些仍是未证明。升级 qodercli / qoderclicn 后必须重新取证并更新
> 布局表，不能把旧版本的结论直接沿用。

## 1. 当前取证版本

| 项目 | qoder | qodercn |
| --- | --- | --- |
| CLI | `qodercli 1.1.73` | `qoderclicn 1.1.72` |
| 二进制 | `~/.qoder/bin/qodercli/qodercli-1.1.73` | `~/.qoder-cn/bin/qoderclicn/qoderclicn-1.1.72` |
| size | `162892288` bytes | `160807456` bytes |
| sha256 | `ec2180c0…ccb3327` | `2e55dab3…cdc65cb6` |
| inference | `https://api3.qoder.sh` | `https://gateway.qoder.com.cn` |
| 取证日期 | 2026-10-20 | 2026-10-20 |

两个客户端的 WASM 是**同一份字节**（magic 在二进制 offset `154,680,475`，298,606
字节），`prepareInferRequest` 的 URL / 头 / body 编码与 `session_type` 之外的 body
形状一致（`qodercli` vs `qoderclicn`）。CN 站经本机 `HTTPS_PROXY` 实测 200。

> 注意：`docs/providers/agent-cli-usage.md` 的生成快照可能落后于本机版本。
> 升级 CLI 后应重跑 `npm run providers:usage -- --write`，不要把快照当实时事实。

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

### 4.1 裸 HTTP 的边界（2026-10-19 历史结论，已被 4.3 修正）

“复刻固定头 + 裸 Bearer 打 `POST /model/v1/chat/completions`”只能证明到配额层：

- 有效 token → `402 {"code":116,"error":"quota exceeded"}`；
- 假 token → `401`。

`402/116` 只证明 token 被接受、请求到达了配额判定；`/model/v1/chat/completions`
与根路径均 404。**这个结论不代表 `agent_chat_generation` 不能走 HTTP**；它只说明
“裸头 + 明文 body”不是客户端的真实请求。

### 4.2 WASM 签名链路已打通（2026-10-19 真机）

从二进制内嵌的 298606 字节 wasm 与 wasm-bindgen glue 复刻调用后，
`prepareInferRequest` 可以离线生成完整的线上请求。关键事实：

- 构造：`EN(machineId, cosyVersion, userInfoJson, optionsJson?)`；`machineId` 来自
  `.auth/machine_id`，`cosyVersion` 是 CLI 版本，`userInfoJson` 是 `.auth/user`
  解密后的完整 payload（实测含 `uid` / `encrypt_user_info` / `key` 等字段；多传字段
  不影响签名）。`optionsJson` 可省略（glue 会传 `(0,0)`）。
- 签名 URL 固定为
  `<endpoint>/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`
  （`endpoint` 来自账号投影/宿主的端点缓存；qoder = `https://api3.qoder.sh`，
  qodercn = `https://gateway.qoder.com.cn`）。
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
  不走 `HTTPS_PROXY`，会挂到超时；transport 显式用 `undici.ProxyAgent` 走
  `HTTPS_PROXY`，代理不可用时按 4.4 的规则回落直连（只用客户端 DNS 缓存里的 IP）。
- 修复 ABI 后，签名请求返回 `200 text/event-stream`。

### 4.3 真实 body 已捕获，`agent_router` 不是 flow 缺失（2026-10-20 真机）

用 Bun 的 `BUN_OPTIONS=--preload` 钩子在 `fetch` 之前抓取明文 body（不采用 MITM），
得到 654,097 bytes 的客户端 JSON。逐字段核对后确认：

- 顶层**没有 `flow` 字段**；`task_id:"common"`、`session_type:"qodercli"`、
  `agent_id:"agent_common"`、`chat_task:"FREE_INPUT"`、`business.stage:"start"`、
  `model_key:"auto"`；
- `system` 是 2 个 `{type:"text",text}` 块；`messages` 是 system + user；
- `user.content` 是原始用户正文（不是角色标签拼接）；`business.name` 是该轮的
  简短用户文本；
- `tools` 是 OpenAI function 形状；`parameters={"max_tokens":32000}`；
- `model_config` 的 key 为 `auto`，`model` 为空串，`is_vl:true`，`max_input_tokens:200000`。

**结论：此前的 `agent_router msg:None flow nodes found` 是手工请求的字段错误，
不是真实 body 需要 flow。** 用真实 body（无 flow）签名后，上游返回正常 SSE。
最小合法 body（1,193 bytes 明文）也返回 200 与正文，证明 `flow` 不是必需字段。

### 4.4 HTTP transport 已进入请求路径（2026-10-20）

实现：`lib/server/qoder-http-transport.js`（协议）与
`lib/server/upstream-endpoints-transport-qoder-http.js`（Strategy）。链路：

1. `buildQoderHttpRequestBody` 复刻真实 body 形状：system + 一条展平的 user
   transcript、`agent_common` / `FREE_INPUT`、`business`、`tools`、`parameters`、
   `model_config`；**绝不写 `flow`**。多轮对话把 assistant/tool 历史展开成
   `Assistant:` / `Tool:` 文本，工具定义仍走 `tools`，模型可继续发起工具调用。
2. `createQoderAuthRuntime` 在 Node 内嵌 WASM 生成 URL / 20 头 / 编码 body；
   `Cosy-MachineToken` / `Cosy-MachineType` 用 `umid-cache.json` 覆盖。
3. body 用 `zlib.zstdCompressSync`（level 1）压缩，附 `Content-Encoding: zstd` 发送。
4. SSE 外层 `{headers, body, statusCodeValue, statusCode}` 解包成内层 OpenAI chunk，
   逐帧透传；`body:"[DONE]"` 是结束帧。结束前的 timing 帧
   （`firstTokenDuration` / `totalDuration` / `serverDuration`）与 usage 帧
   （`prompt_tokens` / `completion_tokens` / `*_details` / `credits` / `billable`）
   被记录到 attempt 注解与 model usage。
5. 策略链顺序：**HTTP 在前，CLI headless 兜底**。首字节之前失败（签名/认证/代理/
   HTTP 错误/空流/上游错误帧）只写一条 `qoder_http_failed` 请求日志并返回 `null`，
   不记账号失败，由 CLI 接手；首字节之后失败无法回落，按上游失败记账。
6. 首字节前代理失败且**只用了环境变量代理**时才允许直连回退（显式
   `--proxy-url` / 账号 egress 不绕过用户选择）；直连用客户端 DNS 缓存 IP，
   避免 fake-ip。代理首包预算 15s，直连/后续静默预算 120s，单轮 30min。

真机证据（2026-10-20）：

- qoder 最小 body：`200`、回答 `OK`、usage
  `prompt_tokens:22 / completion_tokens:91 / reasoning_tokens:87 / cached_tokens:20 /
  credits:0.02480124`、timing `792ms / 2079ms / 59ms`；
- qodercn 最小 body：`200`、回答 `OK`、usage
  `prompt_tokens:24 / completion_tokens:198 / reasoning_tokens:195 /
  credits:0.03626`、timing `3512ms / 6239ms / 91ms`；
- 流式：qodercn 250 个 chunk、正常 `[DONE]`、usage
  `prompt_tokens:27 / completion_tokens:812 / reasoning_tokens:741`；
- 工具：模型返回标准 `tool_calls`（`read_file`），把 assistant tool_calls + tool
  结果回传后模型给出最终正文。工具通道已闭环。
- 网关端到端（qodercn，`X-Account-Ref` 钉选 + WebUI 会话
  `session-ccdbf520-9d60-4bd1-afad-b4d38fd4f736`）：
  - 非流式：HTTP 200 / 930ms，精确 usage `26/1`，usage record
    `sourceKind=server_qoder_http_proxy` 且 `session_id` 归属目标会话；
  - 流式：HTTP 200 / 735ms / 4 个 chunk / `[DONE]`，首字节约 0.54s，
    `qoderHttpUsageExact=true`；
  - 强制首字节前失败（把账号投影端点缓存临时指向 `127.0.0.1:9`）：63ms 记录
    `qoder_http_failed`（`qoderHttpFallback=true`，不记账号失败），同一 requestId
    随后由 CLI 在 7.9s 返回 200，usage record 为
    `server_qoder_cli_proxy_estimated`；恢复缓存后 HTTP 立即恢复 200。

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

- qoder 1.1.73 / qodercn 1.1.72 的 8 个身份头名字、值清洗规则、model/session/
  requestSet 的写入逻辑；
- 模型服务请求的 5 个固定头与 Bearer 位置；
- 推理链路的 WASM 签名调用与“三处改写”；
- `prepareInferRequest` 的精确 URL、20 个 header、自定义编码 body 与完整 ABI；
- 真实客户端 body（无 `flow`）与 `agent_chat_generation` 的 200 SSE 响应；
- 最小 body 的成功路径（system + user + tools:[] + business/model_config）；
- 外层 envelope / 内层 OpenAI chunk / `[DONE]` / usage / timing 帧；
- 工具调用：标准 `tool_calls` 与 tool 结果回传后的最终回答；
- qodercn 1.1.72 的端点、WASM（与 qoder 同字节）、`session_type:qoderclicn`
  与经代理的 200 响应；
- HTTP 直连的精确 token usage（prompt/completion/cached/reasoning/credits）；
- 账户面 4 条路径与 Free 档字段；
- warm CLI：`--input-format stream-json` 在 `result` 后继续等待下一条 user 消息。

未证明（必须保留在布局表的 `unproven` 里）：

- 非 `auto` 模型键（如 `Qwen3.8-Max`）在 HTTP 直连下的上游行为；transport 会透传
  key，失败自动回落 CLI，不猜参数；
- 付费账号走普通 HTTP 能否生成（当前本机两个账号都是 Free；Free 已实测 200）；
- `t5e` 身份头在推理链路上的实际发送集合、`safetyTag` 与 `internalContext` 取值
  （HTTP transport 不发送这组头，只使用 WASM 返回的 20 个签名头）；
- qoder CLI 自身的 token 数（CLI `usage` 字段恒为 0；HTTP 通道有精确 usage，
  CLI 兜底仍按 `context_usage_ratio` / 文本估算并带 `_estimated`）。

## 7. 当前工程状态与后续

1. **P0：共享 idle watchdog（已实现）**。qoder CLI 用
   `--include-partial-messages` 产生流事件；idle 120s 重置计时，单轮硬上限
   30min，消费 `stream_event` / `content_block_delta` / `message_delta`。
2. **P1：HTTP → CLI 策略链（已实现，2026-10-20）**。
   `qoderHttpTransport` 在 `qoderCliTransport` 之前；首字节前失败只留
   `qoder_http_failed` 日志并交还 CLI，不记账号失败；首字节后失败按上游失败记账。
   日志字段见 `qoderHttp*` attempt 注解（egress / endpoint / firstToken /
   upstream timing / usage exact / cached / reasoning / credits / fallback）。
3. **P1.5：用量闭环（HTTP 已实现）**。HTTP 通道直接记录精确 usage，id 用
   `<provider>:message:<message.id>`，与会话 JSONL 扫描器共用幂等键；CLI 兜底
   继续用 `context_usage_ratio × 200000` + 输出文本估算，`sourceKind` 带
   `_estimated`。WebUI chat 的 `X-Session-Id` 会写入 usage record 的 `sessionId`。
4. **P2：warm CLI（已实现）**。同一会话复用
   `--print --input-format stream-json` 常驻进程：首轮 ~7.6-8.6s，同进程第二轮
   ~2.7-3.5s（1.1.73 实测）。只有 `sessionKey` + 消息前缀哈希完全匹配才复用；
   无 sessionKey、最后一条不是纯文本 user、池满或进程 busy 时自动走冷启动。
   idle TTL 5 分钟、最多 8 个进程、LRU 淘汰 idle；失败/超时/abort 一律杀进程。
5. **剩余验证**：付费账号 / 非 auto 模型键 / `t5e` 推理身份头。没有这些证据前
   不要把它们写成已证明；HTTP 失败一律由 CLI 兜底。

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
