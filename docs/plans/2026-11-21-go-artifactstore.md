# Go artifactstore：版本构件的单一执行点（2026-11-21）

> **状态（2026-11-21）**：迁移完成。执行点 `aih-go __artifacts-ensure`，Node 客户端
> `lib/runtime/artifact-service-client.js`；**唯一权威的剩余项清单见文末“遗留项清单”**
> （仅剩 rekey 运维脚本的链接动作未迁，其余差异都属策略层）。

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

CI 由 `.github/workflows/go-tests.yml` 承担：在 `windows-latest` 上跑
`go vet`（artifactstore + spacegc）、`go test ./internal/runtime/artifactstore/...`，
再编译 `cmd/aih` 与 `internal/host/aihserver`，确保"测试过"的产品入口在 Windows 上也能编过。

工作流**不做 workflow 级 `paths`/`paths-ignore` 过滤**：GitHub 文档明确写了，被路径过滤
跳过的 run 会让 required status check 一直停在 `Pending`，把不相关的 PR 卡死。改为 job 内
"改动范围门"（`git diff base..head` + 路径正则）：不相关时只跑一个几秒的 gate 步骤并成功，
相关时再跑 vet/test/build。判定拿不到 base（新建分支、force push）时按"跑全量"处理。

### 两个容易踩的 Go 语义（测试逼出来的）

1. **`filepath.EvalSymlinks` 不解析 junction**（Windows 挂载点），只解析符号链接。
   共享目录一律用 junction，所以凡是要判断"是否已链到投影外"的地方必须用
   `resolveRealPath`：先 `EvalSymlinks` 解析父目录链，再沿 `readlink` 跟叶子 junction。
   之前用标准库判断 workbuddy 共享目录会漏判，把宿主的共享 skills 当成了账号目录。
2. **junction 的 `Lstat` 可能报 `ModeIrregular` 而不是 `ModeSymlink`**，所以
   `linkTree` / `copyTree` / 去重遍历都改用"能 readlink 出目标即算链接"的判据，
   否则会跳过链接或把它当普通文件打开。

## kiro 私有 runtime 目录（2026-11-21 已迁移）

- `kiro-runtime-home` 的目录私有性校验（必须是真实目录、0700）、旧版"宿主链接"摘除、
  原生库相对文件链接，交给 Go 的 `runtimeHomes` 执行点；Node 只声明目录清单与链接目标。
- 错误码保持原样（`kiro_runtime_home_not_isolated` / `kiro_runtime_directory_not_private` /
  `kiro_native_database_path_conflict`），Node 侧抛出的 `Error.message` 与旧实现一致。
- 实测（合成用例，macOS 全部 5 例 + win32 分支）：Node/Go 的 summary、错误码、目录权限、
  链接相对路径逐项一致；本机没有 kiro 账号，未做真实账号回归。

## CodeBuddy 家族共享条目（2026-11-21 部分迁移）

`codebuddy-family-session-store` 按"是否需要搬迁"拆分：

- **Node 仍负责**：提示历史合并、会话产物目录的 rename 并集、CLI 共享配置合并、
  空 skills 目录里的迁移标记回收、孤儿配置回填、信任目录/桌面 settings 同步。
  这些会动到用户数据，且要求独占语义，不适合放进通用执行点。
- **Go 负责**（`familyLinks`）：已正确链接（unchanged）、链接指向别处（unresolved）、
  缺失但规范存储有实物（建链）、空目录（删空壳 + 补目标目录 + 建链）、
  空 `models.json` 外壳（换链）、真实内容（unresolved）。建链仍是
  "同目录临时链接 + rename"。
- Node 逐条分类后把"纯建链"条目一次性批量交给 Go；服务不可用或响应异常时原地回退本地实现。
- 实测（合成用例，Node/Go 对比）：5 类分支 + 采纳路径（history / file-history union）
  的 summary 集合与最终目录快照一致，二次运行幂等。唯一的差异是 `linked` 数组顺序
  （Node 接管项在前、Go 纯建链项在后），仅影响诊断输出。
- 未在真实 `~/.codebuddy*` 上跑：该函数会执行 rename 并集，属于"启动时"行为，
  不适合在会话中额外触发；等下次真实启动再观察一次即可。

## Windows CLI shim 硬链（2026-11-21 已迁移）

- `repairUnversionedShim` 的判断与文件操作（同文件则不动、否则删 shim 再硬链）
  交给 Go 的 `hardlinkRepairs`；版本发现与排序（`resolveVersionedWindowsExecutable`）
  仍留在 Node（策略层）。
- 真机 Windows 验证：版本选择、硬链同 File ID、二次调用不重建（birthtime 不变）、
  旧链重指、删除 shim 不影响目标、0 字节/非 exe 候选被忽略；执行点不可用时自动回退
  到本地实现（用错误架构的二进制验证过）。

### 委派请求必须带 `projectionRoot`

`__artifacts-ensure` 把 `projectionRoot` 当作请求锚点，缺失时整包直接返回
`ok:false`（不抛错）。最初 native-cli / kiro 的委派都没带这个字段，表现为"服务调用
成功但什么都没做"。现在：

- 所有委派都传 `projectionRoot`（hardlink 用 shim 所在目录、kiro 用 sandboxDir）；
- 调用方检查响应里是否真的有对应结果字段，字段缺失（`ok:false`）就回退本地实现，
  不再"发出去就当做过"。

## opencode 共享桥（2026-11-21 已迁移）

真实投影盘点（`run/auth-projections/opencode/<acct>`）与代码一致：

- `.local/share/opencode`：`auth.json` 是**真实文件**（私有），其余条目全是软链；
- `.config/opencode`：所有条目软链到宿主同名目录；
- `.local/share/aih-opencode-runtime/opencode`：`auth.json` 指向账号那份（auth bridge），
  其余条目软链到宿主共享数据。

### 三个投影根

| 名称 | source（沙箱） | target（宿主） | linkKnown |
|---|---|---|---|
| bridge-data | `<sandbox>/.local/share/aih-opencode-runtime/opencode` | `<host>/.local/share/opencode` | 是 |
| account-data | `<sandbox>/.local/share/opencode` | 同上 | 是 |
| config | `<sandbox>/.config/opencode` | `<host>/.config/opencode` | 否 |

source 为链接或不存在时整个投影跳过（避免顺着根链接把数据反迁回去）。

### `ensureSharedEntryLink` 状态机（与 familyLinks 不同）

| 现状 | 行为 | 计数 |
|---|---|---|
| 已是指向目标的链接 | 不动 | — |
| 链接指向别处 | **unlink + 重建** | `migrated` |
| 空目录 | rmdir + 重建 | `migrated` |
| 真实内容 | 原样不动 | `unresolved` |
| 缺失 + kind=dir | 先 `mkdir` 目标再建链 | `linked` |
| 缺失 + kind=file | **允许悬挂链接**（不检查目标） | `linked` |
| 建链失败 | 抛 `opencode_shared_bridge_failed` | — |

和 `familyLinks` 的三处关键差异：会替换错误链接、允许悬挂文件链接、成功计数叫
`migrated`。因此**不复用** familyLinks，单独做 primitive。

### auth bridge（2026-11-21 已迁到执行点）

`<bridge>/auth.json` → `<account>/.local/share/opencode/auth.json`（file 软链）。
建链前递归删除旧路径；失败抛 `opencode_auth_bridge_failed`（`RemoveAll` 已实测不跟随 junction）。

它作为 `bridgeLinks.authLink` 和共享条目建链**同批**下发：`prepare` 先确保账号目录存在
（否则它不会进入投影根枚举），再声明 auth 链接；`reconcileSharedData` 被 `session-store`
直接调用时不带这个字段，两条调用路径的语义保持不变。

### 策略留在 Node

- 私有名：`auth.json` 及 `auth.json.*`（`isProviderPrivateEntryName('opencode', …)`）；
- 三个根映射、`linkKnown` 标志、known dirs/files 清单；
- 显式 server profile 直接跳过（不建 bridge）；
- 网关覆盖、模型列表、env 清理、权限参数等均与文件系统无关。

### 已迁移（`bridgeLinks`）

Go 侧接收一次批量声明：

```json
{ "ensureDirs": ["…/host/.local/share/opencode"],
  "links": [{"linkPath":"…","targetPath":"…","kind":"dir|file","label":"account-data/bin"}] }
```

Node 负责 readdir + 私有过滤 + 三个根的编排（先 source 条目、再 target 条目、最后 known
列表），Go 负责"canonical 判定 / prepare（摘链接或空目录）/ mkdir / symlink|junction"，
失败返回 `{code, linkPath, targetPath}`，Node 原样还原成 `opencode_shared_bridge_failed`
或目录创建的 errno 错误。

**auth bridge 也在这一个请求里**（`authLink` 字段）：`prepare` 传声明，
`reconcileSharedData` 的其它调用方不传，两条路径语义不变；本地回退仍是
`applyAuthLinkLocally`（`rmSync` + file 软链）。

### 验证结果

1. 合成 fixture（三个投影根，含正确链接 / 错误链接 / 空目录 / 真实内容 / 缺失 / 私有
   `auth.json`）：Node 与 Go 的 `{migrated:2, linked:19, unresolved:[bridge-data/real,
   config/local.json]}` 与两端目录快照逐字一致，二次运行幂等。
2. 真实 3 个 opencode 账号：
   - 第一次 node 模式跑完，`acct_84c6…` 的 bridge 里补建了 4 条缺失链接（bin/repos/
     snapshot/storage）——这是模块本来的自愈行为；
   - 之后 node 与 go 两种模式对三个账号的结果**逐字段一致**（`migrated/linked` 均为 0，
     `unresolved` 只含该账号里真实存在的 `log`/`shell`/`opencode.db*`，且三遍枚举导致重复，
     与旧实现一致）。
3. Windows 分支沿用同一 `createBridgeLink`：目录走 junction、文件走 symlink。

## CLI 共享配置链接（2026-11-21 已迁移）

`linkSharedConfigForProjection`（登录/首启）拆成两段：

- Node：判断是否 CLI 配置根、把真实配置文件**合并**进规范存储（会写文件，属业务逻辑）、
  合并后删掉旧文件；
- Go（`fileLinks`）：对 `settings.json` / `statusline-command.sh` / `argv.json`
  建 file 软链；目标不存在则跳过（不建悬挂），位置已存在则跳过，失败静默（best-effort）。

实测：

- 合成 fixture（合并 + 缺失 + 已链接）：Node 与 Go 的 `{linked, merged}`、二次运行、目录快照一致；
- 真实 19 个 buddy 配置根：第一次（node）为每个账号补建了缺失的 3 条配置链接（模块本来的
  自愈行为，等同登录时执行），规范存储里三个文件的 mtime 未变（没有内容合并）；之后
  node/go 两次运行结果完全一致。

## 工具配置条目链接（2026-11-21 已迁移）

`session-store` 的条目建链拆成两段：

- **Node 保留数据语义**：非会话条目的真实内容仍由 `mergeEntryIntoStore` 合并/搬移；
  会话目录绝不迁移的判定（空目录可替换、有真实内容 fail-closed）、伪 HOME 别名、
  预建目录、哪些条目算会话存储，都在 Node 侧算成布尔位。
- **Go（`sessionEntryLinks`）执行文件系统动作**：摘掉指向别处的链接（Windows 上可能是
  junction，Node 的 `unlink` 对目录链接不可靠）、替换空目录、补目标目录、建 junction/软链
  （Windows 文件先试符号链接、无权限退回硬链接，与旧实现同口径）。
- 一次目录对账把条目攒成**一个**请求（`executeSessionEntryLinks`），首次开号不会逐条起
  进程；已链接条目在 Node 侧早退，稳定账号完全不调用执行点。
- 执行点在调度失败/响应字段缺失/注入 fs 替身时回退本地决策表，两端结果字段一致。

实测：

- 合成 fixture（空会话目录、真实会话文件、真实非会话内容、指向别处的链接、缺失条目、
  预建目录）在 node/go 两种后端下 summary 与完整目录快照逐字一致（含 walk 的
  `unresolved` 集合）；二次运行 `migrated=0`。
- 真实 codex 账号（已收敛）：两后端均为 `{migrated:0, linked:66}`，0 变更。
- 一轮对账的进程调用数从 16 降到 1；执行点不可用时逐条回退。

## 旧版 Library 链接（2026-11-21 已迁移）

旧版本把宿主的整个 `Library/Preferences` 链进每个账号投影；新版要求先把它复制成账号
私有快照（`<runtimeHome>/Library/Preferences`），再把投影改成指向这份快照。`Keychains`
不复制，只摘掉旧链接。

- Node 只判定"是不是 aih 建的旧链接"（读 readlink 比较宿主旧路径）、伪 HOME 下是否
  报 unresolved；两条声明合成一个请求。
- Go（`legacyLibraryLinks`）执行：复制快照（已存在条目**不覆盖**、符号链接按链接复制）、
  摘链、建链；`detach` 只摘链。复制语义与 `fse.copySync({overwrite:false,
  errorOnExist:false, dereference:false})` 对齐。
- 本地回退保留同样的复制+换链实现（注入 fs 替身/执行点不可用时）。

实测：

- 合成 fixture（Preferences 快照 + Keychains detach）：node/go 的 summary 与完整目录快照
  逐字一致；二次运行 `migrated=0`。
- 指向别处（非宿主旧路径）的链接：两后端都只报 `Library/Preferences` unresolved，不动文件。
- 真实 opencode 账号 `prepare`：两种后端都无任何变更（快照 before/after 相同）。

## 遗留项清单（2026-11-21 复核）

**已迁移模块的本地实现全部保留为 fallback**（执行点不可用/注入 fs 替身时使用），不是死代码；
每个导出的函数仍有真实调用方。仍在 Node 的链接动作只剩一处：

| 位置 | 动作 | 结论与理由（2026-11-21 复核） |
|---|---|---|
| `cli/services/account/rekey-journal.js` | rekey 的 `atomicWrite` / 链接交换 / rename / 恢复 | **暂不迁**。① 它是运维脚本 `scripts/oauth-identity-maintenance.js`（plan/apply/recover/rollback）里的 Saga 步骤，每一步之后都要写 journal checkpoint，恢复靠比对 before/after 状态；拆成第二个进程只多出超时、二进制缺失、版本不匹配三种失败面。② 只操作 file 符号链接与普通文件，没有 junction/共享目录/跨账号投影语义；Windows 在规划阶段就被 `rekey_metadata_platform_unsupported` 拒绝（POSIX-only）。③ `atomicWrite` 还要保 xattr/ACL 并回读核对 metadata，和链接原语不是一类动作。 |

**rekey 是可转换的**，但意味着把整套工具（19 个模块约 2.1k 行：inventory / plan /
SQLite 事务 / metadata 摘要 / 恢复矩阵）迁成一个 Go 命令，而不是搬 147 行 journal；
这属于独立项目，不在本次 artifactstore 迁移范围内。

会话条目的**内容合并**（`mergeEntryIntoStore` 的 rename 并集、同内容文件丢弃）也仍在 Node：
那是数据归属决策而非链接动作，执行点只负责"接回宿主存储"的最后一步。

策略层（不迁）：版本发现与排序、provider 私有名、三个投影根与 known 清单、模型/env/网关配置。

**之前文档里"codebuddy-shared-config 纯 JSON 合并、无文件系统动作"的说法是错的**：
它既会写文件（合并结果），也会建 file 软链（`linkSharedConfigForProjection`）。
