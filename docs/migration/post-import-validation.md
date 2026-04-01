# Post-Import Validation (Non-Interactive)

`lib/migration/post-import-verify.js` 提供导入后可编排的账号可用性校验，目标是快速判断“导入后能否立即使用”。

## 校验目标

- 账号目录是否存在。
- 账号是否处于可认证状态（`configured`）。
- 可选的轻量启动探测（`startupProbe`）。

## API

### `verifyImportedAccounts(options)`

输入：

- `accounts`: `{ tool, id }[]`
- `getProfileDir(tool, id)`: 返回账号目录路径
- `checkStatus(tool, profileDir)`: 返回 `{ configured, accountName }`
- `startupProbe(tool, profileDir, account)`（可选）: 返回 `boolean` 或 `{ ok, reason }`

输出：

- `total / passed / failed / passRate`
- `entries[]`:
  - `status`: `pass | fail`
  - `reasons`: 失败原因列表（如 `profile_missing`、`not_authenticated`、`startup_probe_failed:*`）

### `formatPostImportValidationReport(report)`

把校验结果转换为可读文本，适合在 CLI 中直接打印。

## 与冲突策略的关系

- 对于 `skip/overwrite/report` 三种导入冲突策略，导入阶段只负责写入决策与冲突报告。
- 导入后由本模块统一输出“可运行性”报告，避免把可用性判断散落在导入流程中。
