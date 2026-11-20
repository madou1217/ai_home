# Go artifactstore：版本构件的单一执行点（2026-11-21）

## 分层

- **Node（策略层）**：只负责发现"哪些路径算版本构件"（`listVersionArtifacts`）以及缓存链接；
  不再直接做 reflink/硬链接/账本。
- **Go（执行层）**：`aih-go __artifacts-ensure` 接收投影 + 构件清单 JSON，完成：
  reflink 探测、库内不可变树、原子替换、按内容刷新、账本写入、投影外共享识别。
- **账本互操作**：仍写 `artifact-store/ledger/<sha256(abs path)[:16]>.json`，`dev/ino`
  用字符串（Windows 64 位 File ID 不丢精度）；Node/Go 可互读，迁移期间两边都认。

## 切换与回退

- 默认 `AIH_ARTIFACT_BACKEND=auto`：`aih-go` 支持 `__artifacts-ensure --capabilities` 时走 Go，
  否则自动回退 Node 实现（旧安装包/未重建的 CLI）。
- 显式 `node` 可回退；`go` 强制 Go（失败仍回退并记录 `artifact_service` 错误）。
- `prepareProjectionArtifacts` 返回值新增 `backend: 'go' | 'node'`，便于诊断。

## 实测

- 本机 31 个真实账号：Go 后端 18 个账号、16 个 `shared-external`、16 个 `unchanged`，
  **0 变更 / 0 错误 / 0 磁盘增长**（直接读 Node 已写的账本）。
- Windows 11 NTFS：3 个账号 + 库同一 NTFS File ID（nlink=4、只读 444），二次 unchanged，
  模拟重装后重新硬链接，无 `.old` 残留。
- macOS 内容变更：安装器换成 25MB 新副本后，Go 刷新库内树（25MB）并重新 reflink，
  共享树里的程序输出新版本号。

## 尚未迁移

- 版本发现、缓存链接（`shared-host-caches`）、旧版本回收（`pruneVersions`）仍在 Node；
  `space-gc` 与 Go 账本已独立。后续可把回收也收进 Go，Node 只保留策略输入。
- Linux/Windows 的 Go 二进制已交叉编译；Linux 运行时尚未单独跑 Go 服务（Node 后端已实测）。
