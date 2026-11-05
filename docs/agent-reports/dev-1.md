# dev-1：Provider hooks 声明与装配逻辑单元测试

日期：2026-11-05
范围：`lib/providers/defs/*.js` 的 `capabilities.hooks` 声明、`lib/server/provider-session-hook-config.js` 的装配逻辑（只读引用）
约束：只新增 `test/provider-hooks.test.js`；未修改 `lib/` 下任何实现文件；未执行 git commit / checkout；未操作任何服务进程。

## 交付物

- 新增：`test/provider-hooks.test.js`（38 个用例）
- 报告：本文件

## 运行方式与结果

```bash
node --test test/provider-hooks.test.js
```

结果：**38 tests / 38 pass / 0 fail**（约 0.15–0.5s，纯内存，无网络、无真实 HOME 写入）。

## 覆盖矩阵

| 要求 | 用例位置 | 关键断言 |
| --- | --- | --- |
| 各 provider 描述符 hooks 字段 | `内置描述符全部通过契约校验，且 hooks 声明与预期逐字段一致` | 逐文件 `require` + `validateProviderDescriptor`；六个 hook provider 的 adapter/target/timeoutUnit/eventMatchers/featureFlag 与写死的预期表完全一致；无 hooks 声明的 provider 不得出现 `capabilities.hooks` |
| 合同与描述符一致性 | `合同 sessionSync 与描述符 hooks 对每个 provider 一致` | `manifest.sessionSync.mode === 'hook'` ⟺ 描述符有 hooks 能力；adapter 两边相等；非 hook provider 描述符不得声明 hooks |
| target 安全边界 | `hook 目标路径段都是 home 内的相对片段…` | 每段非空、非绝对路径、不含路径分隔符、不是 `..`/`.` |
| 单位与开关收敛 | `timeoutUnit 只用 seconds/ms；只有 gemini 用 ms，只有 codex 打开 featureFlag` | `ms` 仅 gemini；`featureFlag` 仅 codex；`eventMatchers` 仅 codex 非空 |
| 契约归一化 | `契约对 hooks 字段做归一化…` / `契约拒绝未知 adapter…` | 默认 `seconds`；target 去空不去重；matcher trim 后去空；`featureFlag` 只认布尔 true；未知 adapter/timeoutUnit、unsupported 缺 reason、缺 supported 均有明确错误码 |
| 档案合并 | `每个 hook provider 的档案字段来自描述符…` | `resolveProviderHookProfile` 的 supported/adapterId/targetKind/target/timeoutUnit/eventMatchers/featureFlag 全部来自「合同 + 描述符」，`capabilityMatches=true`，且对象冻结 |
| 非 hook 档案 fail-closed | `非 hook provider 的档案 fail-closed…` | polling/unavailable provider 一律 unsupported、空 target、默认秒、`capabilityMatches=false` |
| 名称归一化 | `provider 名大小写/空白归一化…` | `  CLAUDE  ` → claude；空/未知 provider 安全默认 |
| 可安装列表与默认事件 | `installable 列表 = 合同声明 hook 且有 adapter 的 provider…` | 列表从合同派生且等于六个 provider；`DEFAULT_EVENTS_BY_PROVIDER` 与合同事件逐项一致；opencode（插件桥）不进入 JSON 事件表 |
| 三态同步模式 | `isProviderSessionHookSupported / getProviderSessionSyncMode…` | hook / polling / unavailable 三态覆盖，未知 provider → unavailable |
| 适配器表 | `hook 适配器表…` | 三个 adapter 可解析且具备 targetPath/buildPatch/diagnose；opencode 为 raw patch 且有 install/uninstall；未知 id → null |
| 目标路径 | `json/named hooks 的目标路径…` / `opencode 插件路径…` | homeDir + target 拼接；unsupported → `''`；opencode 遵循 `OPENCODE_CONFIG_DIR` > `XDG_CONFIG_HOME` > `~/.config/opencode` |
| JSON hooks 装配 | `json_hooks：每个 provider 都生成托管 handler…` 等 5 个用例 | 每个默认事件一组一 handler；命令含 marker/provider/event/URL；seconds=10、gemini ms=10000；codex 仅 SessionStart 带 matcher；timeoutSeconds/timeoutMs 换算与 100ms 下限；保留用户 hook/其它键；旧托管 handler 被替换而非叠加；重复装配幂等；hooks 形状异常时安全落盘 |
| AGY 命名 hook | `agy_named_hooks：顶层具名对象…` 等 3 个用例 | 顶层 `aih-session-sync`、enabled=true；整个命名 hook 替换；保留其它命名 hook；Pre/PostToolUse 用 `matcher:'*'` 组；其它事件裸 handler；自定义 hookName 只覆盖该名字；重复装配幂等 |
| OpenCode 插件桥 | `opencode_plugin：返回原始插件源码…` 等 3 个用例 | 返回 raw source（无 config 键），含 `export default` / `ctx.event.subscribe` / `session.execution.started` 与 receiver URL；receiverUrl/port 选项生效；install/diagnose/uninstall 只碰 AIH 托管文件，用户插件不被删除 |
| codex 特性开关 | `codex featureFlag：install 同时修补 config.toml…` 等 3 个用例 | `config.toml` 的 `[features] hooks=false` 被 install 改为 true；dryRun 零写入；patch 本身不带 feature 副作用；非 codex 无 codexFeatures；诊断能报告 disabled |
| 诊断与卸载 | `json_hooks 诊断…` / `agy 诊断…` / `不支持 hook 的 provider…` / 两个卸载用例 | 缺失事件清单准确；agy enabled=false 视为 disabled；unsupported 三类操作均返回 `unsupported_provider`；卸载只摘托管内容、保留用户 hook/其它键；目标不存在时 changed=false |
| 命令构造 | receiver URL / sender 命令 / isManagedCommand / quote 用例 | 默认端点与查询参数；posix 引号、win32 无单引号且剥 URL query；marker + provider 精确识别（codex 不会误删 code）；引号转义 |

## 保护的关键不变量

1. **两层真值源必须同时改**：Go 合同 `sessionSync.adapter` 与描述符 `capabilities.hooks.adapter` 不一致时，测试直接失败（而不是运行时静默降级）。
2. **hook 支持集合收敛为六个**：codex / gemini / claude / agy / opencode / grok；新增 hook provider 必须显式更新预期表，防止「只加合同或只加描述符」的半接线状态。
3. **adapter 是唯一的格式派发键**：测试只通过 `resolveProviderHookProfile` + adapter 结果断言，没有按 provider 名写分支，符合现有 Strategy Table 设计。
4. **单位由描述符决定**：gemini 的毫秒 timeout 不靠 provider 名判断；改回按名字判断会立刻被 timeout 断言抓住。
5. **用户内容不可丢**：json hooks 只摘 `--aih-provider-session-hook` handler；agy 只替换 AIH 命名 hook；opencode 只删带 marker 的插件文件。

## 测试隔离

- 描述符测试使用独立 `createProvidersRegistry({ env: {}, aiHomeDir: <tmp 不存在目录>, skipLegacy: true })`，不读真实 HOME 的 `provider-defs`。
- 所有写路径使用内存 fs（`createMemoryFs`）或临时 home 字符串；`dryRun` 用例断言零写入。
- opencode 路径依赖环境变量，用例用 `withEnv` 临时改写并恢复 `OPENCODE_CONFIG_DIR` / `XDG_CONFIG_HOME`，不污染外部环境。

## 未覆盖 / 限制

- `resolveProviderHookProfile` 里「描述符 adapter 与合同不一致 → capabilityMatches=false、退回默认档案」的运行时分支，当前仓库数据无法自然触发；一致性用例已把这种漂移挡在数据层，故未通过 monkeypatch 强行构造。
- `install/uninstall` 的 `unsupported_hook_adapter` 分支同理（当前所有 hook provider 的 adapter 都能解析），未用打桩覆盖。
- 测试只读 `lib/server/provider-session-hook-config.js`，不验证真实文件系统权限、并发写或宿主进程实际加载 hook 的行为。

## 工作区说明

`git status` 中同时存在其它并行任务的文件（如 `test/status-journal-edge.test.js`、`docs/agent-reports/dev-2.md`），本任务未触碰；本任务新增的只有 `test/provider-hooks.test.js` 与本报告。
