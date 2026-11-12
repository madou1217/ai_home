# dev-3-reader：Go 模型目录读取适配器（Phase 1，未接线）

日期：2026-11-05
范围：新增 `lib/server/go-model-catalog-reader.js` 与 `test/go-model-catalog-reader.test.js`
约束：只新增这两个文件；未改 `webui-model-cache.js` / 组合根；未执行 `git commit`

## 交付物

- 新增：`lib/server/go-model-catalog-reader.js`
- 新增：`test/go-model-catalog-reader.test.js`（6 个用例）
- 报告：本文件

## 接口

```js
const reader = createGoModelCatalogReader({ call, now });
const result = await reader.read({ provider, accountRef, accountRefs, afterRef, limit });
```

- `call` 的约定与 `lib/account/go-bridge/go-management-client.js` 的内部 `call` 一致：
  `call('GET', path) -> { ok, status, data, body, errorCode }`；也兼容直接返回的
  `{ data: [...], generation, updated_at_ms }`。
- Management Key、baseUrl、超时、重试都由注入的 `call` 负责；本模块不读取环境变量，也不拼鉴权头。
- `now` 默认 `Date.now`，只用于 `updatedAt` 的最终回退。

## 映射规则

Go 端点每行：`{ account_ref, provider_id, last_source, last_error_message, last_attempt_at_ms, models: [...] }`。

- `byAccount[account_ref]`：`models[].model_id` 去重、排序；没有模型时写 `[]`（表示「已知为空」）。
- `accountSource[account_ref]`：优先 `error`，其次空目录 `empty`，再看 `last_source`（`remote/local`），缺省有模型时 `remote`。
- `updatedAt`：顶层 `updated_at_ms` > 模型 `updated_at_ms` 最大值 > `now()`。
- `models`：按 `provider_id` 汇总去重排序，供 `catalogResult.models` 的兜底分支使用。
- 额外保留：`errorsByAccount`、`accountProbedAt`、`firstError`、`scannedAccounts`、`source`、`sourceCount`、`generation`、`cached: true`、`labels: {}`。

注意：`byAccount` 的 key 是 Go 返回的 `account_ref` 原值。Node↔Go ref 映射（`go-account-sync:state.links`）不在本模块内，接线层负责；否则 5/43 的 ref 差异会丢账号。

## 失败语义

- `call` 抛错（网络失败）、返回 `null`、`ok:false`、`status >= 400`、或 payload 没有数组 `data`：返回 `null`，调用方回落 Node 探测缓存。
- `data: []` 是合法空结果，返回 `{ byAccount: {}, accountSource: {}, updatedAt: now, source: 'empty', ... }`，不是 `null`。

## 测试

```bash
node --test test/go-model-catalog-reader.test.js
# tests 6 / pass 6 / fail 0
```

覆盖：

1. 正常映射：`byAccount` 去重排序、`accountSource`（remote/local/error）、`updatedAt`、`errorsByAccount`、`accountProbedAt`、provider 并集。
2. 空数据：返回空结果而不是 `null`。
3. 直接 JSON 形状：`updatedAt` 回退到模型最大 `updated_at_ms`。
4. 503 / `ok:false` / 网络异常 / `null` 响应 / 缺少 `data`：全部返回 `null`。
5. provider/account 过滤参数透传：`provider`、重复 `account_ref` 去重、`after_ref`、`limit`。
6. 缺少 `last_source` 时按模型推导 source；`last_source=remote` 但目录为空时按 empty。

相邻回归：

```bash
node --test test/go-model-catalog-reader.test.js test/model-catalog-invalidation.test.js test/go-model-policy-sync.test.js
# tests 12 / pass 12 / fail 0
```

## 边界与后续

- 本模块**未接线**：没有改 `webui-openai-model-routes.js`、`webui-project-routes.js`、`webui-model-cache.js`、`server.js` 或组合根。
- 未处理 Node↔Go accountRef 映射；接线时先用 `goCoreSync.readGoRefsByNodeRef()` 建反向表。
- 未处理缓存/ETag/失效；接线层用 `read()` 的 `generation` 做条件 GET 或投影缓存键。
- `labels` 固定为空；接线层应复用 Node 的 `collectModelDisplayLabels(state)` 补展示名。
- `__private.buildRequestPath` / `__private.buildCatalogResult` 只用于直接单测和调试，不作为生产 API。

## 改动清单

```text
?? lib/server/go-model-catalog-reader.js
?? test/go-model-catalog-reader.test.js
?? docs/agent-reports/dev-3-reader.md
```

仓库中其余未提交改动来自其它并行任务，未触碰。