# 网关熔断/路由：普适「(账号,模型)」熔断原则 + 根因分析

> 触发样本（客户端收到的 503）：
>
> ```
> API Error: 503 {"ok":false,"error":"no_available_account",
>  "detail":"all accounts for claude-opus-4-6-thinking are temporarily rate-limited/cooling down
>   - agy: 1 account(s), 1 unavailable (model_cooldown);
>   tried targets: claude-opus-4-6-thinking(priority=100), opencode-go/glm-5.2(priority=0)",
>  "alias":{"matched":true,"requestedModel":"claude-opus-4-8",
>           "target":"claude-opus-4-6-thinking","effectiveProvider":"agy"}}
> ```

本文供反复查阅与分发。**两条结论分开看，别混为一谈：**

1. **普适原则（本次已落地）**：失败默认按 `(账号, 模型)` 熔断，**只有「凭据/身份」类失败**（鉴权失效、工作区停用、区域不支持）才升级为账号级。已把 `upstream-failure-policy.js` 里 `503/529/5xx/stream中断/超时/网络/未分类` 统一改为模型级。
2. **上面这条改动，并不能直接消除标题里那个 503**。看 `detail`：`1 unavailable (model_cooldown)`——那个模型**本来就走的是模型级熔断**（429/容量类一直是模型级）。这条 503 的真实根因是**结构性的**：agy 只有 1 个账号 → 其目标模型合法地进了冷却 → 唯一 fallback（opencode glm-5.2）也不可路由 → 客户端吃到错误。这要靠 P1/P2（热路径瘦身 + fallback 增强）解决，不是靠扩大 scope。

---

## 1. 三个症状

| # | 症状 | 用户原话 |
|---|------|---------|
| 1 | 首词回复很慢 | "首词回复很慢" |
| 2 | 错误经常打到客户端 | "错误经常打到客户端" |
| 3 | 经常报错 | "经常报错" |

核心原则（用户）：**「429 只是举例，所有错误是雷同的——账号的 a 模型用不了，不代表 b 模型用不了。这个规则对所有 provider 的所有模型做成普适性原则。」**

---

## 2. 判断粒度的唯一标准：这个失败是「谁」的属性

| 失败属于谁 | 例子 | 正确粒度 |
|---|---|---|
| 属于 **(账号, 模型)**——a 挂了 b 没事 | 429、配额耗尽、容量不足、空响应、**503、5xx、529、超时、网络抖动、未分类错误** | **模型级** ✅ |
| 属于 **账号本身（凭据/身份）**——钥匙坏了，所有模型一起死 | **401/403 鉴权失效、402 工作区停用、区域不支持** | **账号级**（唯一例外） |
| 不可重试、直接回吐 | 400 invalid_request、404 not_found | `none`（透传客户端） |

**为什么鉴权类必须账号级**：401 是「这个账号 token 坏了」，不是「某模型坏了」。若也做成模型级——a 模型 401 只冷却 (账号,a)，下个请求拿**同一坏 token** 打 b 模型又 401，逐个模型撞死 token 才冷却；且账号级 `authInvalidUntil` 不被置位 → 账号始终显示「健康」、**重新登录/熔断检测失效**（`deriveAccountRuntimeStatus` 读的就是账号级桶）。所以凭据类必须整号下线。

除此之外，`503/5xx/529/超时/网络` 本质是「上游/连通性」问题：模型级是更安全的默认——**永不误伤一个还能用的模型**，最坏只是真宕机时多探几次（有 `failureThreshold≥2` 的瞬态门 + 短冷却兜底，且这些类都 `shouldRetryAnotherAccount:true`，单请求内仍会立即换号）。

---

## 3. 现有机器（底层已正确，勿推翻）

`(账号, 模型)` 粒度熔断的机器**早已存在且正确**：

| 关注点 | 位置 |
|--------|------|
| 每账号 per-model 冷却表 `modelCooldowns`/`modelFailures`（持久化） | `lib/server/account-runtime-state.js` |
| 记模型级失败（只累加该 tuple，达阈值才冷却，不碰账号级 `cooldownUntil`） | `account-runtime-state.js:181` / `router.js:24`（`scope:'model'`） |
| 选号按模型跳过（仅对该模型不可选，其它模型仍可用） | `account-selector.js:107` |
| 不可用原因报 `model_cooldown:<model>` | `account-availability.js:71` |
| 模型成功只清自己的冷却 | `router.js:12` → `clearAccountModelState` |
| 策略分类输出 `scope`，`applyAccountFailurePolicy` 按 scope 分流（无 model 自动回退账号级） | `upstream-failure-policy.js` / `account-runtime-state.js:215` |

本次原则改动**只改 `scope` 标签**，记账/选号逻辑一行没动。

---

## 4. 本次已落地：scope 普适化

文件 `lib/server/upstream-failure-policy.js`，scope 由 `account` → `model`：

| 类别 | 状态码/触发 | 改后 |
|------|------|------|
| service_unavailable | 503 | model ✅ |
| service_unavailable | stream disconnected | model ✅ |
| overloaded | 529 | model ✅ |
| upstream_server_error | ≥500 | model ✅ |
| timeout | ETIMEDOUT/abort | model ✅（保留 `failureThreshold:2` + 30s 短冷却） |
| network_error | fetch failed/socket | model ✅（同上瞬态门） |
| unknown_error | 未分类 | model ✅（无 model 时回退账号级） |

保持不变：
- 模型级（本就正确）：429 `rate_limited`、`model_quota_exhausted`、`model_capacity_unavailable`、`empty_model_response`。
- 账号级（凭据/身份，唯一例外）：`auth_invalid`（401/403）、`deactivated_workspace`（402）、`location_unsupported`。
- `none`（透传）：400/404、`unknown_status`。

> 机制要点：scope 变模型级后，这些类别不再写 typed 桶（`serviceUnavailableUntil` 等）→ `deriveAccountRuntimeStatus` 不再据此判账号不健康；账号整体保持 `healthy`，仅该模型经 `modelCooldowns` 冷却。这正是「a 挂 b 仍可用」。
>
> 测试：`test/upstream-failure-policy.test.js`（断言各类 scope）、`test/account-model-cooldown.test.js`（端到端：503→模型 X 冷却、模型 Y 仍被 `chooseServerAccount` 选中）。测试数量会随仓库演进变化，以当前 `npm test` 结果为准。

---

## 5. 真实根因与剩余杠杆（标题那个 503 靠这些解决）

scope 普适化减少了「被连带熔断的账号」，但样本 503 是结构性的，需要：

### 根因 B（症状 1）：首字节前的同步网络调用
| 位置 | 调用 |
|------|------|
| `upstream-endpoints.js:903` | `getWebUiModelsCache(...)` |
| `upstream-endpoints.js:908` | `refreshStaleAgyUsageSnapshotsForPool(...)`（仅 agy） |
| `v1-router.js:225` | 候选全不可路由时 `refreshWebUiModelsCache({accountLimit:8})`，最坏叠加 8 账号探测 |
| 重试循环 | 每账号 `upstreamTimeoutMs` 串行，失败要等满超时才 failover |

→ 评估改为「命中旧缓存即走 + 后台异步刷新」，不阻塞首字节。**未验证假设：需在真实网关上确认这些是否可缓存/异步化。**

### 根因 C（症状 2）：小池 + fallback 不足 —— ✅ 已实现 last-resort 兜底
agy 单账号 + 单 fallback 均「软冷却」时，旧逻辑在 alias 预检（`v1-router.js` `selectAvailableAliasCandidate`）直接判定无候选 → `writeUnavailableAliasSelection` 回吐 503 `no_available_account`。

**已落地的修复**：当所有 alias 候选都只是**软冷却**（model_cooldown / rate_limited / 瞬态），而非硬下线（鉴权/区域）时，挑**最高优先级**的软冷却候选**真打一次**，而不是给客户端报错。冷却本是负载分摊提示，此刻模型大概率已恢复。

实现链路（`allowModelCooled` 标志贯穿）：
1. `model-alias-validation.js` 的 `modelHasAvailableProvider`（账号非硬下线）区分「软冷却」与「硬下线」。
2. `v1-router.js` `selectAvailableAliasCandidate`：无 routable 候选时，返回最高优先级的「有可用账号但被模型冷却」候选 + `lastResort:true`。
3. `allowModelCooled` 经 `createResolvedRouteInput` → `requestMetaWithSession` → 各选号入口
   （`upstream-endpoints.js` / `codex-adapter.js` 的 `runWithAccountAttempts` → `request-orchestrator.js`）。
4. `account-selector.js` `chooseServerAccount`：`allowModelCooled` 时**只跳过软的 per-model 冷却**，账号级硬冷却（鉴权/区域/quota=0）仍拦。

边界：硬下线账号**不**触发 last-resort（鉴权坏了真打也没用）；last-resort 失败则回退既有错误路径，不会比之前更糟。
测试：`test/server.v1-router.test.js`（软冷却→尝试而非 503；硬下线→仍不可用）、`test/account-model-cooldown.test.js`（`allowModelCooled` 单测 + 不越过账号级硬冷却）。

### 仍待做（症状 1，需真实网关验证）
根因 B 的首字节阻塞 I/O 尚未改——这需要在真实网关上确认那几个缓存调用能否「命中旧缓存即走 + 后台刷新」，不在本次范围。

---

## 6. 一句话总结

> **原则层（已做）**：除「凭据/身份」三类外，所有 provider 所有模型的失败一律按 `(账号,模型)` 熔断——这就是「a 模型挂了 b 模型仍可用」的普适化，底层机器早已就绪，本次只翻了 `scope` 标签 + 测试。
>
> **根因层**：标题那个 503 不是 scope 问题（该模型本就 model_cooldown），而是**小池 fallback 不足（错误打到客户端）+ 首字节前阻塞 I/O（首词慢）**。
> - 小池 fallback：**已修** —— last-resort 兜底，软冷却时真打一次而非 503（见 §5-C）。这条直接消除标题那个 `no_available_account`。
> - 首词慢：**待做** —— 需真实网关验证热路径缓存能否异步化（§5-B）。
