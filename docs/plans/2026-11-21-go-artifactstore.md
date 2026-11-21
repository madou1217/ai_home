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

## 共享会话存储（2026-11-21 已迁移）

- `shared-store-linker` 保留 provider 策略与 `adopt` 钩子（cline 的 SQLite 合并是 provider 逻辑），
  建链/丢弃真实残留/悬挂链接清理交给 Go：
  - 目录 → junction（Windows）或符号链接；文件 → 文件符号链接；
  - `-wal`/`-shm` 保持悬挂（SQLite 通过链接创建共享目标）；
  - 空目录可安全替换；有内容的真实数据只有 `discardRealEntries` 才丢，否则 `unresolved`；
  - `prune` 只删「指向共享根且目标已消失」的一级链接。
- 注入 `fs`/`path`（测试替身）时仍走本地实现；生产默认走 Go，失败自动回退。
- 实测：macOS 与 Windows 上 Node/Go 两侧 summary 逐项一致；adopt 返回 `ok:false` 时
  `deferred` 且整体不建链（fail-closed）；真实 zcode/cline 账号悬挂链接清理 0 错误。

## Windows junction 与平台标识（2026-11-21 修复）

- 用 `FSCTL_SET_REPARSE_POINT` 直接建挂载点重解析，不再依赖 `mklink /J`（外部进程、PATH
  依赖）或 `os.Symlink`（需要开发者模式/管理员）。重解析缓冲按挂载点格式构造（没有
  `Flags` 字段），标签 `0xA0000003`。
- junction 在 Go 里可能报 `ModeIrregular`（不是 `ModeSymlink`），链接判定统一改为
  "能 `readlink` 出目标即算链接"，否则悬挂 junction 会被当成真实数据（`discardReal` 会
  误删、`prune` 会漏删）。
- 平台判定修正：请求里是 Node 的 `win32`，旧代码只比 `"windows"`，导致 Windows 上
  所有目录链接退化成需要特权的 `os.Symlink`、reflink 探测还会去调用不存在的 `cp`。

## 技能视图（2026-11-21 已迁移）

- `codebuddy-skills-links` 保留策略（共享库里哪些技能、账号禁用/启用集合），文件系统动作交给 Go：
  - 账号目录里逐技能建链接（Windows 优先 junction）、清掉禁用/失效的链接；
  - 账号自己的真实目录不动，记 `unresolved`；
  - 旧布局（账号 skills 目录本身是整目录链接）先摘链接再重建。
- **投影外跳过**：如果账号 skills 目录的真实路径落在投影之外（workbuddy 的 `.workbuddy-ai`
  整体链到宿主 runtime home），那份技能本来就是全机唯一一份；"按账号启用"只会改写共享目录、
  影响所有账号。此时返回 `skipped: ["shared-external"]` 且不做任何增删。
- 实测：macOS 与 Windows 上 Node/Go 结果一致（含禁用/启用、失效链接、旧整目录布局）；
  真实账号 20 个稳定、2 个 workbuddy 账号正确跳过；Windows junction 标签 `0xA0000003`。

## Windows junction 行为验证（2026-11-21 真机）

| 行为 | 结果 |
|---|---|
| 创建 | `FSCTL_SET_REPARSE_POINT`，标签 `0xA0000003`；不依赖 `mklink`/管理员 |
| `Lstat` / `Stat` | `ModeSymlink`（IsDir=false）/ `Stat` 认目录；`DirEntry.Type()` 也是 `L` |
| `EvalSymlinks` | 解析到 target |
| 读/写/列目录 | 全部穿透到 target，写入立刻在 target 可见 |
| `RemoveAll(链接)` | 只删链接，target 内容完好 |
| `RemoveAll(父目录)` | 不递归进链接，target 完好 |
| `RemoveAll(悬挂链接)` | 只删链接 |
| `Rename(链接, 新名)` | 仍是 junction，target 不受影响 |
| `Rename(目录, 已存在的 junction)` | **"Access is denied"**：不能原子替换 junction；安装流程必须先移走旧条目 |
| Node `fs.rmSync(recursive)` | 只删链接，target 完好 |
| 缓存链接复用 | 投影侧已是 junction 时判 `unchanged`，不会被替换 |

结论：junction 对"共享目录只读 + 账号侧可删"的用法是安全的；唯一限制是不能用一次
rename 覆盖它，现有安装/回收流程都是"先摘旧、再建新"。

### 自动化契约测试

`internal/runtime/artifactstore/junction_windows_test.go`（`//go:build windows`）把这套语义
固化成真实文件系统测试（不 mock），覆盖：创建/穿透读写、`RemoveAll` 链接与父目录不伤目标、
rename 语义（含"不能覆盖 junction"）、悬挂链接、技能链接、数据根链接、缓存链接复用。

在 macOS 上交叉编译后到 Windows 主机执行：

```bash
GOOS=windows GOARCH=amd64 go test -c -o /tmp/artifactstore.test.exe ./internal/runtime/artifactstore
# 复制到 Windows 后：
artifactstore.test.exe -test.v
```

### 两个容易踩的 Go 语义（测试逼出来的）

1. **`filepath.EvalSymlinks` 不解析 junction**（Windows 挂载点），只解析符号链接。
   共享目录一律用 junction，所以凡是要判断"是否已链到投影外"的地方必须用
   `resolveRealPath`：先 `EvalSymlinks` 解析父目录链，再沿 `readlink` 跟叶子 junction。
   之前用标准库判断 workbuddy 共享目录会漏判，把宿主的共享 skills 当成了账号目录。
2. **junction 的 `Lstat` 可能报 `ModeIrregular` 而不是 `ModeSymlink`**，所以
   `linkTree` / `copyTree` / 去重遍历都改用"能 readlink 出目标即算链接"的判据，
   否则会跳过链接或把它当普通文件打开。

## 尚未迁移

- 版本发现与缓存策略仍在 Node（这是策略层，不是文件系统执行点）。
- 仍在本地的零散链接动作：`kiro-runtime-home`、`native-cli-resolver`（shim 硬链）、
  `codebuddy-family-session-store`、`codebuddy-shared-config`、`opencode-strategy`；
  均为 provider 级单文件/单目录链接，迁移时需要逐个确认语义（尤其 config 文件的写入穿透）。
