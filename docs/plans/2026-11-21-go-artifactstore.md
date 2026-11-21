# Go artifactstore：版本构件的单一执行点（2026-11-21）

## 分层

- **Node（策略层）**：只负责发现"哪些路径算版本构件"（`listVersionArtifacts`）以及缓存链接；
  不再直接做 reflink/硬链接/账本。
- **Go（执行层）**：`aih-go __artifacts-ensure` 接收投影 + 构件清单 JSON，完成：
  reflink 探测、库内不可变树、原子替换、按内容刷新、账本写入、投影外共享识别。
- **账本互操作**：仍写 `artifact-store/ledger/<sha256(abs path)[:16]>.json`，`dev/ino`
  用字符串（Windows 64 位 File ID 不丢精度）；Node/Go 可互读，迁移期间两边都认。
  inode 会被文件系统复用，所以"账本命中"还必须满足**投影仍是冻结的 0555 树**；
  可写副本（安装器重装）一律重新核对内容/重新共享。

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
- Linux ext4：Go 服务 3 账号 + 库同一 inode（nlink=4、只读 444），二次 unchanged；
  模拟重装（inode 被复用）仍返回 hardlinked，说明冻结态守卫生效。

## 旧版本回收（2026-11-21 已迁移）

- Node 只传保留策略（`keepVersions`、`trashDir`、`graceDays`）；Go 在 ensure 之后完成：
  按 CLI 分组/版本排序、在用判定（`spacegc.HeldPaths`）、只回收投影内路径（父目录是共享软链的
  外部版本不动）、移入回收站、按宽限期清空。
- Node 在 Go 成功处理后不再重复 `pruneVersions`；`pruneLogs`/库存树 GC 仍由 Node 执行。
- 实测：3 个版本的投影在 Go 后端下保留 2 个、最旧版本进 trash；把 trash 变旧后再跑一次，
  Go 清空 2 个条目。`AIH_ARTIFACT_BACKEND=node` 的本地回退也验证通过。

## 日志回收（2026-11-21 已迁移）

- Go 扫描 `projection/<parent>/<traces|logs>` 的直接子项，修改时间与访问时间取较新者；
  目录内任何子文件较新整目录保留；过期项移入同一个 trash。
- 回收站宽限期改为从**移入时间**起算（rename 会保留源目录旧 mtime，Node/Go 都修了），
  否则旧日志/旧版本会在同一次 GC 中被立即清掉。

## 缓存链接（2026-11-21 已迁移）

- Node 仍负责 `getProviderSharedHostCaches` 策略（哪些路径、exclude）；Go 执行
  `linkOne`：已链接 unchanged、投影真实副本 replaced、宿主缺失 adopted、缺失 skipped，
  Windows 用 junction，其余用 symlink。
- 真实账号复扫与 Node 结果一致（0 linked/replaced/adopted/failed）；合成用例验证
  replaced/adopted/skipped 与二次 unchanged。

## 库存树 GC（2026-11-21 已迁移）

- Node 传入仍被投影引用的版本 key；Go 按 provider/cli/platform 分组、保留最新 N、
  跳过引用/在用条目，移入 trash 并删除 fingerprint。
- 实测：3 棵未引用树保留 2 棵，最旧进 trash；引用 key 后不再回收。

## 数据根链接与应用内容去重（2026-11-21 已迁移）

- Node 仍声明策略（`sharedHostDataRoots` / `sharedHostDedupe`），Go 执行：
  - 数据根：投影空目录 + 宿主已有 → 建链（Windows 目录用 junction）；投影有真实数据 →
    整体移给宿主再建链（`adopted`）；两边都有真实数据 → `unresolved`（调用方拒绝启动）；
    两边都没有 → `skipped`，不在宿主凭空建目录。
  - 去重：版本戳一致时遍历两侧同版本文件，大小+内容一致才以"临时硬链接 + rename"替换；
    已同 inode 计入 `alreadyShared`；版本戳不同整目录跳过。
- Node 侧统一入口 `prepareProjectionLinks`（桌面启动、CLI 会话存储两条链共用），返回
  `backend: 'go' | 'node' | 'none'`（`none` = 该 provider 没有声明）。
- 实测：
  - macOS 合成用例与 Node 实现逐项一致（adopted/linked/unchanged/unresolved/skipped、
    文件型数据根、空目录、二次幂等）。
  - Windows NTFS：junction、adopted、unresolved 冲突保留、去重同 File ID、二次 unchanged。
  - 真实 31 账号：0 unresolved / 0 failed / 0 变更 / 0 磁盘增长。

## 尚未迁移

- 版本发现与缓存策略仍在 Node（这是策略层，不是文件系统执行点）。
- `shared-store-linker`（zcode/cline 会话存储逐条链接、含 provider adopt 钩子）仍在 Node；
  这是下一块可迁移的执行点，但 adopt 钩子是 provider 逻辑，需要按"Node 给动作、Go 做文件操作"拆分。
