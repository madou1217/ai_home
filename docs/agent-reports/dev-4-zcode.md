# dev-4-zcode：删除 http-utils 的 zcode 兜底分支

日期：2026-11-05
范围：`lib/server/http-utils.js` → `fetchModelsForAccount` 的 `if (provider === 'zcode')` 兜底。
约束：只改这一个实现文件（另新增一个测试文件）；**未 git commit**。

## 交付物

- 修改：`lib/server/http-utils.js`（+6 / −15）
- 新增：`test/model-discovery-zcode-fallback.test.js`（4 个用例）
- 报告：本文件

## 0. 改动前状态核对

按要求先确认主 agent 已完成的第 1 步：

```
$ git log --oneline -1
a6c25ea1 refactor(node): 删除 http-utils 里的死代码（零行为）

$ git show a6c25ea1 --stat
 lib/server/http-utils.js | 7 -------
```

该提交删掉了 `claudeAuthTokenProxy`（原 :726）与 `isClaudeAuthTokenAccount` / `isApiCredentialAccount` / `KNOWN_CLINE_MODELS` 三个导入。改动前 `git diff -- lib/server/http-utils.js` 为空 —— 工作区是该文件的干净 HEAD 版本，zcode 分支位于 706–719 行。

## 1. 改动内容

```diff
-const { createZcodeJwtMissingError, fetchZcodePlanBalanceModels, fetchZcodePaasModels, isZcodeRoutableModelId } = require('./http-utils-zcode');
+const { fetchZcodePaasModels, isZcodeRoutableModelId } = require('./http-utils-zcode');

-  if (
-    provider === 'zcode'
-    && !(account && account.apiKeyMode === true)
-    && String(account && account.authType || '').trim().toLowerCase() !== 'api-key'
-  ) {
-    const planModels = await fetchZcodePlanBalanceModels(requestOptions, account, timeoutMs);
-    if (planModels) return planModels;
-    // …（无 jwt 不回退 paas、不落通用探测的说明）
-    throw createZcodeJwtMissingError();
-  }
+  // zcode 这里没有兜底分支：zcode-plan-models 策略命中后要么返回目录，要么抛
+  // zcode_jwt_missing_relogin（terminal），门面不会再下探别的策略，所以「无 jwt 时
+  // 不回退 paas、也不落到通用探测」的语义由描述符链保证，不必在这里按 provider 名再判一次。
+  // 注意：登录态「有 jwt 但目录为空」会走到下方通用探测 —— 行为变化与后续修法见
+  // docs/agent-reports/dev-4-zcode.md。
```

两个导入因为失去唯一使用点而一并移除（`fetchZcodePaasModels` / `isZcodeRoutableModelId` 本来就是死导入，本次不动，见 §5）。

## 2. 行为是否变化

**结论：四个场景里三个完全不变，只有「登录态 + 有 jwt + 目录为空」这一种会变。**

| 场景 | 改动前 | 改动后 | 变化 |
| --- | --- | --- | --- |
| 登录态，无 `zcodeJwtToken` | 链上 `zcode-plan-models` 抛 `zcode_jwt_missing_relogin`（`terminal:true`）→ 直接上抛，走不到兜底 | 同一条链、同一个错误 | **无** |
| 登录态，有 jwt，目录非空 | 链上返回目录，`687` 提前 return | 同 | **无** |
| 登录态，有 jwt，目录为空 | 链上记 `empty_catalog` → CLI null → 兜底**再探一次** → `[]` 是 truthy → **返回 `[]`** | 链上记 `empty_catalog` → CLI null → 落到 `fetchGenericModelsProbe` | **有** |
| API Key 账号 | 链上 `zcode-generic-models`，兜底条件为假 | 同 | **无** |

### 2.1 唯一变化的细节

`fetchZcodePlanBalanceModels` 在 balance 没有模型时会走 `fetchZcodePreviewModels`，而 preview 的 `catch` 返回 `[]`（`http-utils-zcode.js:154,175-177`）。所以「上游 preview 失败」也会表现为空目录。

- 改动前：这个空数组被兜底当成有效结果返回 → 账号进 `byAccount = []`、`setAccountMetadata('empty')`，**不记错误**。
- 改动后：落到通用探测，按账号的 `openaiBaseUrl`（OAuth 账号是推理端点 `…/zcode-plan/anthropic`）拼候选 URL。该端点不提供 `/v1/models` 时抛错 → `byAccount = []`、`errorsByAccount` 记 `request_failed`、元数据 `error`。

**路由结果相同**（两种情况下该账号都没有可用模型），差别在诊断面：从「空目录」变成「探测失败」，并会进入 `failuresByAccount`。如果上游恰好对推理端点返回 200 + data 数组，则会得到一份来自推理端点的目录 —— 这是改动前不可能出现的结果。

### 2.2 为什么没有在本次修掉

修法是在策略上声明「空目录是权威结果」（`emptyAuthoritative`），让门面直接返回 `[]`、不再下探。这需要改 `lib/providers/defs/zcode.js` 或 `lib/server/model-discovery/index.js`，超出「只改 http-utils.js」的边界。已按计划文档 §3.2 ② 的 Z2 记录为后续项。

## 3. 验证

### 3.1 守卫测试先红后绿

新增 `test/model-discovery-zcode-fallback.test.js`。做法：在 require `http-utils` **之前**替换 `http-utils-zcode.fetchZcodePlanBalanceModels` 与 `generic-models-probe.fetchGenericModelsProbe` 两个导出（`http-utils` 在 load 时解构，顺序决定生效），派发链保持真实。

用 `git worktree add /tmp/aih-baseline-zcode HEAD` 建了一份未改动的基线（不动共享工作区），同一份测试：

```
# 改动前（HEAD a6c25ea1）
ok 1 - 登录态没有 zcodeJwtToken：仍抛 zcode_jwt_missing_relogin（terminal 语义不变）
ok 2 - 登录态目录可用：原样返回，且只探测一次
not ok 3 - 登录态目录为空：不再返回 []，落到通用探测（删除带来的唯一行为变化）
ok 4 - API Key 账号：只走通用 /models，不碰 plan 目录
# pass 3 / fail 1
```

```
# 改动后
ok 1 / ok 2 / ok 3 / ok 4
# tests 4 / pass 4 / fail 0
```

即：守卫在旧代码上**只因行为变化而红**，新代码全绿；另三条语义（terminal 抛错、单次探测、api-key 隔离）两边都成立。

### 3.2 命令与结果

```bash
# 语法
node --check lib/server/http-utils.js

# 本次新增的守卫
node --test test/model-discovery-zcode-fallback.test.js
# → 4/4 pass

# 模型目录 / 别名相关（15 个文件）
node --test \
  test/model-catalog-invalidation.test.js \
  test/model-alias-gemini-path.test.js \
  test/model-alias-protocol-choice.test.js \
  test/model-alias-protocol-gateway.test.js \
  test/model-alias-routes.test.js \
  test/model-route-source-scheduler.test.js \
  test/gateway-model-cache.test.js \
  test/go-model-catalog-projection.test.js \
  test/go-model-policy-sync.test.js \
  test/chat-harness-model-reader.test.js \
  test/codebuddy-model-catalog-share.test.js \
  test/codebuddy-family-switch-model.test.js \
  test/session-model-alias.test.js \
  test/session-model-alias-launch.test.js \
  test/harness-current-model.test.js
# → tests 128 / pass 128 / fail 0

# zcode 全量 + 本次守卫
node --test test/zcode-*.test.js test/model-discovery-zcode-fallback.test.js
# → tests 138 / pass 138 / fail 0
```

## 4. 相邻发现（超出本次范围，未改）

### 4.1 `generic-models-probe` handler 的返回形状与门面不匹配

`http-handlers.js` 里：

```js
'generic-models-probe': (deps) => ({
  discover: (account, timeoutMs) => fetchGenericModelsProbe({ ... })   // 返回裸数组
})
```

而 `model-discovery/index.js` 按 `{ models }` 读取：

```js
const models = Array.isArray(result && result.models) ? ... : null;
```

实测（stub 返回 `['model-a','model-b']`，走真实链）：

```json
{"models":null,"attempts":[{"strategyId":"claude-http-models","error":"empty_catalog"}],"error":"empty_catalog"}
```

**这条策略永远不会成功**，所以所有 API Key 账号的目录实际上都来自 `http-utils.js:737` 的尾部调用。

这对本计划的影响：计划文档 §0 把 737 描述成「重复探测」并不准确 —— 它是通用探测**唯一可用**的路径。删除 737 之前必须先修 handler 的返回形状，否则 claude / codex(api-key) / zcode(api-key) / gemini(api-key) 等会全部失去目录。建议下次修订计划文档时更正。

### 4.2 `http-utils.js` 仍有两个死导入

`fetchZcodePaasModels`、`isZcodeRoutableModelId` 只出现在 `http-utils.js:64` 的 import 行，全文件无使用点。属于既有问题，本次未动。

## 5. 未做 / 边界

1. 未实现 `emptyAuthoritative`（需描述符或门面改动），见 §2.2。
2. 未修 `generic-models-probe` 的返回形状（见 §4.1），影响面远超本次范围。
3. 未做真机探测：本机 zcode 账号的目录/额度验证受风控与额度限制，本次只跑单测。
4. 未提交。
5. `/tmp/aih-baseline-zcode` 是验证用的临时 worktree，清理命令被权限拦截，仍残留；`git worktree list` 会看到它。

## 6. 改动清单

```
 M lib/server/http-utils.js
?? test/model-discovery-zcode-fallback.test.js
```

其余 `M` 项来自其它并行任务，未触碰。
