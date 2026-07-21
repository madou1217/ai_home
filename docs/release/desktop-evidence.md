# Desktop 发布证据规范

## Evidence 组成

每个平台上传 `desktop-evidence/release-evidence.json`，其 `schemaVersion` 当前为 `1`。核心字段：

- `status`：只有全部条件满足时为 `passed`；否则为 `incomplete`。
- `platform`、`runtimePlatform`、`architecture`：runner 身份。
- `provenance`：GitHub repository/workflow/run/ref/commit，不含 Secret。
- `distributionSigning`：必须明确为 `signed` 或 `unsigned`，并给出原因。
- `requiredArtifacts`：该平台必须出现的 bundle 类型。
- `artifacts`：路径、字节数、SHA256、摘要模式、签名状态。
- `timings`：构建、安装、smoke 的起止时间、毫秒耗时、退出状态。
- `installs`：安装器类型、安装方法和真实 executable 路径。
- `smokes`：packaged app 结果、fixture request ledger、Keyring 与凭证泄漏检查。
- `secretLeakScan`：evidence 中不得出现 Bearer credential 或 Management Key value 字段。
- `errors`：不完整原因；不得包含秘密。

## SHA256 规则

普通文件（DMG、MSI、DEB、AppImage）直接对文件字节计算 SHA256，`digestMode=file`。

`.app` 是目录，使用 `digestMode=deterministic-tree-v1`：

1. 按规范化相对路径排序遍历。
2. 普通文件记录相对路径、Unix mode、大小和该文件 SHA256。
3. 目录记录相对路径和 Unix mode。
4. 符号链接记录相对路径、Unix mode 和 link target，不解引用。
5. 对上述规范化记录流计算最终 SHA256。

最终 gate 会从工作区重新计算全部摘要并与 evidence 比较。该 tree digest 是 `.app` 内容证据，不冒充 GitHub `upload-artifact` 生成的归档摘要。

## 计时规则

`scripts/desktop/measure-command.js` 包裹每个构建、安装、smoke 命令并写出：

```json
{
  "schemaVersion": 1,
  "label": "tauri-build",
  "status": "passed | failed",
  "startedAt": "ISO-8601",
  "finishedAt": "ISO-8601",
  "durationMs": 123,
  "exitCode": 0,
  "signal": null
}
```

失败命令也会留下计时 JSON。`release-evidence.json` 的 `totalMeasuredDurationMs` 是已出现的计时项总和；缺失计时项会被记录为错误，不能被当成零耗时成功。

## 失败时仍上传

Evidence 收集步骤使用 `if: always()`：

1. 前序失败时，收集器尽量扫描已生成制品与 JSON。
2. 缺失项进入 `errors`，总状态为 `incomplete`。
3. packages 和 evidence 随后仍由 `upload-artifact` 上传，便于诊断。
4. 最后的独立校验器拒绝 `incomplete`、缺制品、摘要不一致或 smoke 不完整。

这意味着“成功上传 artifact”不表示发布通过，必须以三个平台最终 evidence gate 的退出状态为准。

## 验收矩阵

| 平台 | Artifact gate | Install gate | Native transport gate | Keyring gate |
| --- | --- | --- | --- | --- |
| macOS | app + dmg SHA256 | DMG 挂载/复制/启动 | JSON + SSE + Blob | macOS Keychain |
| Windows | MSI SHA256 | msiexec/启动 | JSON + SSE + Blob | Windows Credential Manager |
| Linux | DEB + AppImage SHA256 | dpkg 与 AppImage 各启动 | 两个包各自 JSON + SSE + Blob | Secret Service，另有外部探针 |

任何一个格子缺少真实结果，都不能把整体桌面发布标记为完成。
