# 模型缓存冷启动：根因、现状与剩余边界

## 原始现象

Server 重启后，模型缓存曾在后台调度器完成首个账号探测前保持为空，导致：

- 别名候选无法用真实模型目录做筛选；
- 请求只能走 unchecked 上游验证，增加一次无效调用的概率；
- 小账号池在冷却期间更容易把错误暴露给客户端。

## 根因

模型目录由后台调度器按账号渐进探测，但启动路径没有先把 `app-state.db` 中的持久化缓存载入 `state.webUiModelsCache`，倒排索引因此可能从空状态构建。调度参数本身不是根因，它只放大了空窗期：

| 参数 | 当前值 |
|------|--------|
| 活跃窗口最低间隔 | 45s |
| 空闲窗口最低间隔 | 5min |
| 每次探测账号数 | 1 |

## 已完成

1. `webui-models-snapshot.json` 的逻辑缓存已存入 `app-state.db`。
2. Server 在构建 `model-account-index` 前同步载入持久化缓存，重启后不再等待首次后台探测。
3. `mergeByAccountCache` 在账号探测失败时保留该账号的旧模型列表。
4. `mergeByProviderCache` 在整轮探测失败时保留 provider 旧目录。
5. 模型到账号、账号到模型使用内存倒排索引；探测成功后按 accountRef 增量更新。
6. 冷索引仍允许请求进入真实上游验证，避免缓存缺失直接制造 503。
7. 能力索引为空时同样按「未知」处理：别名预检不再把空目录当成「模型不存在」。
8. 临时冷却（限流/过载/网络抖动）不再作废模型目录，只有认证失效才作废。

## 空目录 ≠ 模型不存在

`modelHasAvailableProvider` 只返回真/假，于是两件事被压成同一个答案：目录里确实没有这个模型，
和我们压根没有目录。别名预检拿后者当前者用时，一个正常的别名会被判成 503
`alias_target_model_not_in_catalog`。

真实触发链（`gpt-*` → `claude-opus-5`，单账号池）：

1. 一次上游 429 按 (账号,模型) 打冷却；
2. 倒排索引快路径查不到可调度账号，落到能力索引慢路径；
3. 能力索引由 `state.webUiModelsCache` + `account.availableModels` 每次重建，
   缓存被失效过就是空的（`getWebUiModelsCache` 不带 `forceRefresh` 不会自己回填）；
4. `validateAliasTarget` 于是报「目标模型不在真实账号模型目录里」——模型明明在，账号也在。

现在的规则：

| 目录事实 | 判定 |
|----------|------|
| 该 provider 有账号，且已知至少一个模型，但目标不在其中 | 真正的否定，保持 503 |
| 该 provider 有账号，却一个模型都不知道 | 未知，按冷启动语义先试真实请求 |
| 该 provider 没有账号 | 不算未知，不放行（否则未配置的 provider 会让别名无条件通过） |

判定收敛在 `lib/server/model-catalog-knowledge.js`，只服务于运行时路由；
别名保存校验 (`validateAliasRecordForSave`) 仍保持严格，不共用这套宽松语义。

## 剩余边界

- `triggerWebUiModelRefreshSoon` 已提供 750ms-2.5s 的刷新 nudge，但尚未接入所有非 WebUI 请求入口；当前正确性不依赖它，仅影响缓存恢复速度。
- 持久化缓存只能代表上次成功探测结果，账号凭据失效、模型下线等变化仍需由后台探测和真实上游响应纠正。
- 请求热路径不得同步遍历多个账号刷新模型目录；需要刷新时应继续走后台调度器。

## 关键文件

- `lib/server/webui-model-cache.js`：持久化加载与失败保旧合并。
- `lib/server/webui-model-refresh-scheduler.js`：渐进探测与 nudge。
- `lib/server/model-account-index.js`：O(1) 倒排查询和增量更新。
- `lib/server/server.js`：启动时先加载缓存，再构建索引。
- `lib/server/model-catalog-knowledge.js`：区分「目录里没有」和「没有目录」。
- `lib/server/account-runtime-event-listeners.js`：只有认证失效才作废模型目录。
- `test/server.model-account-index.test.js`：索引生命周期、路由元数据和移除行为。
- `test/model-catalog-knowledge.test.js`：目录未知/已知的判定边界。
