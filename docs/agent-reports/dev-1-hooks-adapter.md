# dev-1：hooks.adapter 收敛（描述符退役第二步）

日期：2026-11-05
范围：`lib/server/provider-session-hook-config.js` 的 `resolveProviderHookProfile`
约束：只改这一个实现文件 + 新增一个测试文件；未修改任何描述符；未 git commit / checkout；未操作服务进程。

## 交付物

- 修改：`lib/server/provider-session-hook-config.js:63-84`
- 新增：`test/provider-hook-profile-guard.test.js`（8 个用例）
- 报告：本文件

## 改动内容

`resolveProviderHookProfile` 的 adapter 来源从「描述符 + 合同一致性比对」改为「Go 合同单一来源」：

| 项 | 改动前 | 改动后 |
| --- | --- | --- |
| adapter 真值 | `sync.adapter`，且要求 `capability.adapter === adapterId` | `sync.adapter`；合同缺失时回退 `capability.adapter` |
| 是否支持 hook | `sync.mode === 'hook' && sync.adapter` | `sync.mode === 'hook' && adapterId`（fallback 只作用于 hook 模式） |
| 描述符档案可用性 | `capability.supported && capability.adapter === adapterId` | `capability.supported`（adapter 不再参与门槛） |
| 非 hook provider | `adapterId = ''` | 不变：非 hook 模式不读取描述符 adapter，`adapterId = ''` |

代码要点（`lib/server/provider-session-hook-config.js:63`）：

```js
const isHookMode = Boolean(sync && sync.mode === 'hook');
const contractAdapterId = isHookMode ? normalizeText(sync.adapter) : '';
const descriptorAdapterId = isHookMode ? normalizeText(capability && capability.adapter) : '';
const adapterId = contractAdapterId || descriptorAdapterId;
const supported = Boolean(isHookMode && adapterId);
const matches = Boolean(supported && capability && capability.supported === true);
```

目标是把「用哪个 adapter 派发」交给 Go 合同，「这种格式写在哪 / 超时单位 / matcher / 特性开关」继续由描述符提供。描述符里的 `hooks.adapter` 从此不被读取，只作为合同缺失时的兼容回退，下一步可以安全删除。

## 验证

```bash
node --test test/provider-hook-profile-guard.test.js test/provider-hooks.test.js
```

结果：**46 tests / 46 pass / 0 fail**（新增 8 个 + 既有 38 个）。既有 `test/provider-hooks.test.js` 全部通过，说明六个 provider 的 profile 输出、安装/诊断/卸载行为未发生变化。

## 新增守卫覆盖

| 用例 | 关键断言 |
| --- | --- |
| `profile 守卫：六个 hook provider 的 adapter 来自 Go 合同，格式档案来自描述符` | 六个 provider 的 `profile.adapterId` 等于 `sessionSync.adapter` 与预期字面量；target/targetKind/timeoutUnit/eventMatchers/featureFlag 与描述符及预期表三方一致；profile 冻结 |
| `profile 守卫：非 hook provider 保持 fail-closed` | polling/unavailable 的 provider：supported=false、adapterId=''、target=[]、capabilityMatches=false |
| `描述符 hooks.adapter 缺失/清空时 profile 仍完整` | 六个 provider 的描述符能力去掉 adapter 后，profile 仍由 Go adapter 派发，格式档案完整；并实际跑通 codex 的 patch 生成与 diagnose（installed=true） |
| `Go sessionSync.adapter 缺失时回退描述符 adapter` | 合同 adapter 为空时 `adapterId` 回退 `json_hooks`，supported/matches/target/timeout/matcher/featureFlag 全部保持原值 |
| `Go 与描述符都缺 adapter 时仍然 fail-closed` | supported=false、adapterId=''、target=[]、默认档案 |
| `Go adapter 与描述符 adapter 冲突时以 Go 为准` | 描述符写 `decoy_hooks`，profile.adapterId 仍是 Go 的 `json_hooks`；capabilityMatches=true；target/featureFlag 仍来自描述符 |
| `合同不是 hook 模式时，描述符即使声明 hooks 也不接管` | 合成 qoder polling 场景：描述符 supported=true 也不得把 profile 翻开 |
| `描述符 supported=false 时不消费档案` | 合同 adapter 存在时 supported=true，但 capabilityMatches=false，target/eventMatchers/featureFlag 全部回默认值 |

## 风险与后续

- 六个描述符里的 `hooks.adapter` 仍在原处，本次刻意未删；现在它们已不参与派发，下一步删除是纯数据清理。
- 原有的「Go/描述符 adapter 漂移 → 退回默认档案」运行时保护被有意移除：单一来源后描述符 adapter 不再是真值，漂移不再应影响行为。守卫测试改为用 Go 合同 + 预期 profile 双向断言；如果 Go adapter 或 profile 结果漂移，测试会直接失败。
- `test/provider-hooks.test.js` 中仍有一条断言「描述符 hooks.adapter 与合同 sessionSync.adapter 相等」，以及逐 provider 的 adapter 字段断言。下一步真正删除 6 处 `adapter` 时需要同步调整这些既有断言（本次按约束未改）。
- 兼容回退只作用于 `sync.mode === 'hook'`；非 hook provider 即使描述符误声明 hooks，也保持 `adapterId=''` 的 fail-closed 行为。

## 工作区说明

`git status` 中同时存在其它并行任务的改动（`lib/server/http-utils.js`、`lib/cli/services/usage/*`、`docs/plans/*` 等），本任务未触碰。本任务相关改动只有：

- `M lib/server/provider-session-hook-config.js`
- `?? test/provider-hook-profile-guard.test.js`
- `?? docs/agent-reports/dev-1-hooks-adapter.md`
