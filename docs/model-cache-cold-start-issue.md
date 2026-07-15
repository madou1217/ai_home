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

## 剩余边界

- `triggerWebUiModelRefreshSoon` 已提供 750ms-2.5s 的刷新 nudge，但尚未接入所有非 WebUI 请求入口；当前正确性不依赖它，仅影响缓存恢复速度。
- 持久化缓存只能代表上次成功探测结果，账号凭据失效、模型下线等变化仍需由后台探测和真实上游响应纠正。
- 请求热路径不得同步遍历多个账号刷新模型目录；需要刷新时应继续走后台调度器。

## 关键文件

- `lib/server/webui-model-cache.js`：持久化加载与失败保旧合并。
- `lib/server/webui-model-refresh-scheduler.js`：渐进探测与 nudge。
- `lib/server/model-account-index.js`：O(1) 倒排查询和增量更新。
- `lib/server/server.js`：启动时先加载缓存，再构建索引。
- `test/server.model-account-index.test.js`：索引生命周期、路由元数据和移除行为。
