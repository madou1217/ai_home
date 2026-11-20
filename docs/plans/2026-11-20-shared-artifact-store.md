# 共享构件库与自动回收（Shared Artifact Store & GC）— 设计

> 目标：账号投影、项目依赖、构建缓存不再各自复制一份；旧版本/日志/缓存自动回收。
> 归属：**aih 的启动职责**——任何拉起账号或项目的路径都必须先在同一个入口完成共享与回收，
> 不允许再由会话手工 `npm install` / `git archive` / 手工清理兜底。
> 2026-11-20 实测背景：`~/.ai_home` 121G，其中 `run/` 106G（59 个手工整树副本）、
> `auth-projections` 10G（33 个账号，3.1G 是跨账号完全相同的 CLI 安装）。
> 详见 `docs/plans/2026-11-20-account-projection-slimming.md`（实测明细）。

## 1. 现状与根因

| 现象 | 实测 | 根因 |
|---|---|---|
| 同一 CLI 版本每账号一份 | codebuddy 14 份 / 7 个版本（186M each）；claude 10 份 / 4 个版本（323M each） | 官方安装器以 `$HOME` 为界自装；aih 没有跨账号共享层 |
| 缓存每账号一份 | 某账号 `Library/Caches/Homebrew` 784M，另有十余个 38M | `sharedHostCaches` 已声明，但**只有桌面启动**调用 `linkSharedHostCaches`；纯 CLI 路径不调用 |
| 日志/追踪无限增长 | 单账号 traces 236M + logs 67M；全局约 2G | 没有任何保留策略 |
| 构建缓存每份一份 | 单棵副本树 `web/node_modules` 4.6G，其中 3.23G 是 webpack `.pack` | 每个副本各自 `npm ci` + webpack，缓存落在项目内 |
| 旧版本永不删除 | 每个账号保留全部历史版本 | `providercliupgrade` 只缓存发布时间表，不回收已装版本 |

关键分叉：**Go 的升级路径**（`internal/runtime/providercliupgrade`）与**Node 的启动路径**
（`lib/server/account-app-launcher.js`、`lib/cli/services/session-store.js`）各做各的，
后者里还留着"共享缓存交给桌面启动"的注释，导致 CLI-only 账号永远是各存一份。

## 2. 架构：一个服务，所有启动路径都是客户端

```
~/.ai_home/
  artifact-store/                    # 不可变构件库（Go 独占写）
    trees/<treeKey>/                 # 一个版本/构建树一份，内容不可变
    by-name/<provider>/<cli>/<ver> -> ../../trees/<treeKey>
    trash/<ts>/<id>/                 # GC 先 rename 到这里，宽限期后再 unlink
  shared-cache/                      # 可再生的共享缓存（多个账号/项目共用同一份）
    npm/ pnpm-store/ go-mod/ go-build/ pip/ uv/ composer/ cargo-registry/ cargo-git/
    homebrew/ webpack/<projectHash>/<configHash>/
  ledger.sqlite                      # trees、引用、租约、GC 历史、能力探测结果
  artifact-policy.json               # 策略（按 provider / 构件类别 / 平台）
  run/auth-projections/...           # 账号投影（保持现状）
```

**单一执行点**：Go 服务（`internal/runtime/artifactstore`）拥有 trees / ledger / GC；
Node 侧只声明意图并调用它。禁止任何路径再直接建链或删目录。

Go 模块划分：

| 模块 | 职责 |
|---|---|
| `artifactpolicy` | 策略结构、校验、平台/类别默认值 |
| `artifactprobe` | 卷能力探测（reflink / hardlink / symlink / junction），结果进 ledger 缓存 |
| `artifactstore` | 不可变树安装（暂存→校验→原子改名），按策略选共享方式 |
| `artifactlease` | 租约：进程 pid + 进程启动时间，防止 GC 删正在用的树 |
| `artifactgc` | 分阶段回收（缓存→构建缓存→日志→旧版本→trash），带紧急模式 |
| `artifactapi` | 本地接口（Unix socket / 127.0.0.1）：EnsureProjection / EnsureProject / ReleaseLease / GC / Status |

## 3. 共享方式按平台与构件类别做策略（不是写死 clonefile）

**能力探测优先，策略表决定回退链**。探测结果按 (卷, 类别) 缓存到 ledger，
每次启动只校验一次；探测失败不阻塞启动，退一级。

### 3.1 能力探测

| 能力 | macOS (APFS) | Linux (btrfs/xfs) | Linux (ext4) | Windows (NTFS) |
|---|---|---|---|---|
| reflink（共享块、独立文件身份） | `clonefile` / `cp -c` | `cp --reflink=auto`（btrfs/xfs） | 不支持 | 不支持（ReFS 块克隆需 Server 版） |
| hardlink（同一 inode） | 支持（同卷） | 支持（同卷） | 支持（同卷） | 支持（同卷，`mklink /H`） |
| symlink（目录） | 支持 | 支持 | 支持 | 需开发者模式/管理员；目录用 **junction** |
| symlink（文件） | 支持 | 支持 | 支持 | 需特权 → 一律避免，改 hardlink |
| 环境变量重定向 | 支持 | 支持 | 支持 | 支持 |

探测实现：在目标卷上建临时文件 → 尝试 `clonefile(2)`（macOS）/ `FICLONE` ioctl（Linux）→
失败则试 hardlink → 记结果。**探测本身只跑一次并落 ledger**，避免每次启动做系统调用实验。

### 3.2 回退链（按构件类别）

| 类别 | 首选 | 次选 | 末选 | 说明 |
|---|---|---|---|---|
| **CLI 版本树**（不可变） | `reflink` | `hardlink` | `symlink` | 已实测实现：reflink 优先（独立文件身份、共享块，安装器原地改写只影响自己）；卷不支持 reflink 时退只读硬链接 |
| **单个可执行文件版本**（如 claude `versions/<ver>`） | `symlink` | `hardlink`（NTFS/同卷） | `reflink` | Windows 无文件 symlink 特权时用 hardlink |
| **可再生缓存**（npm/go/pip/uv/composer/cargo/homebrew） | `env` 重定向 | `symlink` 到 `shared-cache/` | 各自一份 + GC | 应用若 `rm -rf` 掉链接，下次启动 reconcile 重建 |
| **构建缓存**（webpack `.pack`） | 显式 `cacheDirectory` 指向 `shared-cache/webpack/...` | — | — | 不走链接，直接改配置 |
| **项目依赖**（`node_modules`） | pnpm store + 隔离链接 | — | — | 见 §5 |
| **会话库 / 凭据** | **不共享** | — | — | 属于账号私有，绝不进共享层 |

`hardlink` 只在**确认安装器是"写新文件后 rename"**时启用；原地改写的安装器会污染其它账号
（并且会让二进制签名失效），这种 CLI 一律走 `symlink` 或各自一份。

### 3.3 为什么当前默认 reflink

- reflink 是"独立身份 + 共享块"：安装器原地改写只影响本账号，不会污染别的账号，也不需要
  依赖"安装器一定 unlink+rename"的假设。
- symlink 让 N 个账号真的只有一份，但任何 `realpath()` 依赖、原地写、权限检查都可能穿透到
  共享树；在逐 CLI 实测通过前不做全局默认。
- 因此策略表按 CLI 实测结果选择（当前：reflink → hardlink → symlink/junction），不是全局一刀切。

## 4. 算法

### 4.1 版本共享

```
EnsureVersion(provider, cli, ver, src):
  if isLinkToStoreByGivenStrategy(src): return
  key = H(provider, cli, ver, platform, fingerprint(src))
  if !exists(trees/key):
     tmp = store/tmp/<uuid>
     copyNoFollow(src, tmp); fsync; write manifest.json; chmod 只读
     atomicRename(tmp, trees/key)      # 已存在则丢弃 tmp
  strategy = policy.strategyFor(provider, cli, capability(volume))
  switch strategy:
    symlink : atomicSwap(src, symlink(by-name/...))        # 默认
    hardlink: 逐文件 link(tree/f, src/f)（删除原文件后建链）
    reflink : cloneTree(trees/key, src)
    copy    : 保留各一份，登记 ledger 待 GC
  ledger.ref(key, provider, cli, ver)
```

- 树不可变：安装后 `0555`/`0444`，升级只新增树，不原地改。
- **幂等必须靠账本，不能靠元数据**：reflink 克隆和普通复制在文件系统里都是"独立 inode +
  同样的只读位"，只看"目录只读 + 内容指纹相同"会把一份真实副本误判成已共享（实测 5 个账号
  仍占 5 份字节）。因此 `artifact-store/ledger/<hash(projectionPath)>.json` 记录每个
  `(cli,version)` 安装后的 `dev+ino`；inode 对不上（安装器重装/换目录）就重新铺。
- 运行中的进程：`atomicSwap` 使旧 inode 仍被打开的文件引用，不会崩溃；旧树由租约保护。
- 回滚：把 `src` 从符号链接替换回真实目录（从 `trees/key` 复制/克隆）。

### 4.2 回收

```
GC(mode):
  lock(gc.lock)
  leases = 校验租约（pid 存活 且 进程启动时间一致；过期租约清除）
  for 类别 in [缓存, 构建缓存, 日志/追踪, 旧版本, trash]:
     for obj in 候选:
        if obj 在租约中 或 inUse(obj): continue
        if mode==dryRun: 记录; continue
        rename(obj, trash/<ts>/<id>)   # 原子；ledger 标记
  if 磁盘使用率 > 紧急阈值: 收紧保留天数重跑一轮（仍跳过凭据/会话库）
  if 仍然爆满: 拒绝新建账号/项目并给出可执行提示，不删活数据
```

`inUse(obj)` 判定（保守，任一命中即视为占用）：

1. 租约引用 + pid 存活 + 启动时间匹配；
2. 进程 argv 含该树的 `by-name` / 投影路径（`ps -axo pid,args`；Windows 走 WMI）；
3. 打开的文件描述符落在该树下（`lsof -Fn` / `/proc/*/fd`）；
4. 探测失败 → 旧版本一律不删。

保留策略默认值（进 `artifact-policy.json`，可调）：

| 类别 | 保留 |
|---|---|
| CLI 版本 | 当前 + 上一版 + 所有在用；上限 3；超 30 天且不在用可删 |
| 日志 / 追踪 | 7–14 天；单账号上限 1–2G |
| 包缓存 | LRU 30 天；全局上限 10–20G |
| 构建缓存 | 每个项目/配置最近 2 份；7 天 |
| 会话库 | **永不自动删除** |

## 5. `node_modules` 与构建缓存

结论（2026-11-20 已落地）：**pnpm 解决"依赖重复"，共享 webpack 缓存解决"生成物重复"**，两者分开处理。

1. **依赖（web/ 已迁 pnpm 10.11）**：内容寻址 store 在宿主全局一份（本机 `~/Library/pnpm/store`），
   `node_modules` 里的真实文件是指向 store 的硬链接——同一依赖在所有 worktree/项目之间只占一份字节，
   新 worktree 安装只建链接。
   - pnpm 的严格布局会暴露"直接 import 传递依赖"：迁移时必须把 `highlight.js`、
     `@shikijs/langs`、`@shikijs/themes` 补进 `dependencies`（已补）。
   - 原生构建脚本用 `pnpm.onlyBuiltDependencies` 白名单（esbuild / @swc/core / core-js / unix-dgram），
     其余默认不执行。
   - 根目录 `package.json` 仍由 npm 管理（发行打包走 `npm ci`），本次只迁 `web/`；
     CI 的 `web-build` 改用 corepack + `pnpm install --frozen-lockfile`。
2. **webpack 持久缓存**：pnpm **不会**去重 `node_modules/.cache`。
   已改为显式配置 `cacheDirectory = <hostHome>/.ai_home/shared-cache/webpack/<projectKey>/`：
   - `projectKey` 用 git common-dir 计算 → 同一仓库的所有 worktree 共用一份（单份约 680M，旧布局
     累积到 2.9G）；
   - 构建排队锁与直接构建的互斥锁也放在该目录，跨 worktree 串行，避免并发写坏缓存；
   - 30 天未构建的项目缓存在下次构建时自动回收。
3. **其他语言包管理器**统一走环境变量重定向（Node 与 Go 共用同一份清单：`buildSharedCacheEnv` /
   `internal/runtime/sharedcache`）：

| 语言 | 变量 |
|---|---|
| Node/npm | `npm_config_cache` |
| pnpm | `pnpm config set store-dir` / `.npmrc` |
| Go | `GOMODCACHE`、`GOCACHE` |
| Python | `PIP_CACHE_DIR`、`UV_CACHE_DIR` |
| PHP | `COMPOSER_CACHE_DIR` |
| Rust | `CARGO_HOME`（但 `credentials`/`config` 必须留在账号私有目录，只共享 `registry/`+`git/`） |
| Homebrew | `HOMEBREW_CACHE` |

## 6. 实施状态（2026-11-20）

已落地（Node 启动路径，先解决实际占用）：

- `lib/runtime/version-artifacts.js`：版本构件事实层（哪些路径算版本、版本排序、解冻/可删目录）。
  新增 harness/CLI 只加一行：当前覆盖 codebuddy、claude、codebuddy-cn、workbuddy 自带的
  Node/Python 运行时、agent-browser 的 `chrome-<版本>` 浏览器包（版本匹配支持 4 段号）。
- `lib/runtime/projection-artifacts.js`：启动前统一准备（宿主缓存链接 + 版本树共享 + 节流回收），
  能力探测按卷缓存，策略 reflink → hardlink → symlink/junction，幂等（指纹一致不重铺）。
- `lib/runtime/artifact-gc.js`：旧版本 / 过期日志 / 库内无引用版本树回收，先 rename 进 trash，
  7 天宽限；在用判定 `ps` + `lsof`，探测失败按在用处理。
- 接线：`pty-runtime-spawn`（CLI）、`account-app-launcher`（桌面）、
  `native-session-launch-preparation` 的 `shared-artifacts` 步骤。
- `web/`：pnpm 10（store 全局一份）+ webpack 缓存移到 `shared-cache/webpack/<projectKey>`，
  `node_modules` 4.1G → 1.3G（其中真实字节都是 store 硬链接），本地缓存目录已删除；
  构建锁跨 worktree 串行。
- Go 启动链：`internal/runtime/sharedcache` 统一工具链缓存环境变量，桌面启动与原生 CLI 登录共用。
- 实测：33 个账号 `Library/Caches` 全部指向宿主；CLI 版本树按版本共享；auth-projections
  10G → 7.2G，artifact-store 2.1G（含各版本唯一副本）。
- **共享有效性复核（2026-11-21）**：改用 inode 账本后对 31 个账号重铺，追回 **702MB**
  此前被误判为 "unchanged" 的真实副本；N=5 对照实验（codebuddy 186M 树、claude 323M 单文件、
  codex 运行时 233M）每多一个账号的边际磁盘 ≈ 0，5 个账号合计 ≈ 1 份；把某个账号的版本换成
  新副本后下次启动会重新 reflink（严格性守卫）。

待落地：

- Go 侧 `artifactstore/artifactapi`（单一执行点 + ledger + 租约），Node 改为客户端。
- Go 桌面 provisioner 目前**保留**投影里已存在的真实缓存目录（数据安全优先），
  桌面-only 账号的缓存要靠下一次 CLI 启动或后续 Go GC 回收。
- Windows junction / Linux reflink 分支的真机验证。

## 7. 落地顺序（每阶段都能独立回滚）

| 阶段 | 内容 | 风险 | 验证 |
|---|---|---|---|
| 0 | 策略 + ledger + `Status()`；只观察不动作 | 无 | 输出与今天实测一致（3.1G 重复、缓存分布） |
| 1 | **修 CLI 路径分叉**：CLI 启动也走共享缓存链接；启动前 reconcile | 低 | 33 个账号启动后缓存都指向宿主；登录不失灵 |
| 2 | 版本树共享（先 codebuddy / claude 两个 CLI） | 中 | 边运行边升级、二进制仍可执；7 份→1 份 |
| 3 | GC（先 dryRun，再 trash 宽限 7 天）；含在用检测 | 中 | kill -9 / lsof / 磁盘打满演练 |
| 4 | `web/` pnpm + 共享 webpack 缓存 | 中 | 连续两次干净构建、umi 插件、node-pty 原生构建 |
| 5 | 扩到全部 provider/harness + Windows junction / Linux reflink 分支 | 较高 | 逐 provider 灰度 |

回滚开关：`artifact-policy.json` 的 `mode: observe` 立即停止建链与 GC；
版本符号链接可从 `trees/` 还原为真实目录；trash 保留 7 天可反悔。

## 8. 已有共享机制清单（新需求必须先复用，禁止再起第五套）

| 机制 | 负责什么 | 实现位置 |
|---|---|---|
| 投影构件库（本方案） | CLI 版本树、workbuddy 运行时、agent-browser 浏览器包、codex 桌面运行时（`generation-*`） | `lib/runtime/projection-artifacts.js` / `version-artifacts.js` |
| 宿主缓存链接 | 环境变量覆盖不到的固定缓存（`Library/Caches/*`、`.npm`、`go` 等） | `lib/runtime/shared-host-caches.js` + Go `accountprojection` |
| 应用内容逐文件硬链接 | 投影里与宿主同版本解压内容（kimi daimon bundle 等） | `lib/runtime/shared-host-dedupe.js` |
| 桌面 Chromium 缓存 | `Cache/Code Cache/GPUCache/DawnCache` 按 provider 共享 | Go `ensureDesktopSharedCaches`（`webuiopenappapi`） |
| ZCode 影子 App | 同一 fingerprint 只保留一份，跨卷时退回普通复制 | `webuiopenappapi/desktop_zcode.go`（`cp -c -R`） |
| 空间治理 | 过期临时目录/源码副本/快照回收 + 证据硬链接去重 | `internal/runtime/spacegc` |
| 旧版整目录链接 | buddy 家族把 `.local/share` / `.workbuddy-ai` 整体链到宿主 runtime home（历史遗留，仍生效） | 投影内符号链接 |

发现"整目录已经链到投影外"（`realpath(artifact.path)` 不在投影根下）时，启动准备只报告
`shared-external`，不再逐账号重铺：否则会对同一份共享路径反复 atomicReplace，制造 inode 抖动和
`.old` 残留。

新增共享需求时的判定顺序：先看能否挂到"投影构件库"（版本化、不可变 → reflink/硬链接/软链）；
缓存类挂"宿主缓存链接"；应用内容逐文件相同挂"内容硬链接"；桌面 profile 缓存只能走
`desktop-shared-caches`，不得直接把整个 `electron-user-data` 共享（里面有 Cookies/WebStorage）。

## 9. 跨平台验证状态（2026-11-21）

| 平台 / 文件系统 | 验证方式 | 结果 |
|---|---|---|
| macOS APFS | 真机，N=5 对照 | reflink；5 份 186M 树 → 1 份；二次启动全 unchanged |
| Linux ext4 | 本机 colima VM + Docker volume（非 AWS） | 硬链接回退路径；3 个账号 + 库同一 inode（nlink 4），5MB 树总占用 5MB |
| Linux btrfs | 本机 colima VM + 1G loopback btrfs（非 AWS） | reflink 分支命中：5 份 20MB（源+库+3 账号）逻辑 100MiB，`btrfs filesystem du` Exclusive 仅 **20MiB**；二次启动全 unchanged |
| Linux XFS | 未测 | 与 btrfs 同走 `cp --reflink=always`，探测失败退硬链接 |
| Windows NTFS | 仅交叉编译（spacegc / aihserver） | 未做运行时验证；策略为文件硬链接（目录真实、文件共享 inode），失败时逐文件退回复制 |

Linux 实测发现并修复了两个只在非 APFS 上暴露的问题：

1. `cpSync` 会保留库内 0555 目录权限，随后 `unlink+link` 因 EACCES 静默失败 → 改为直接
   `linkTree`（自建目录 + `linkSync`），不再依赖目录可写；
2. 内容指纹包含权限位，而库内树被冻结成 0555、安装器刚写的是 0755 → 每个账号都触发一次
   "库内刷新"，把先前账号的链接孤立；指纹改为只算路径+大小。

Windows 已知边界：Go `spacegc` 的 `ps/lsof` 在用判定不可用，只按空闲时长删除；NTFS 硬链接
跨卷会失败（逐文件退回复制）。这两点需要在真机上补验证。

## 10. 明确不做

- 不共享任何凭据、会话库、`config`、`state`（账号私有，必须留在投影里）。
- 不对会话库做自动删除或压缩（只提供只读统计）。
- 不用硬链接共享**可变**内容（缓存、日志、SQLite）；只有不可变的版本树可以考虑。
- 不再引入第二种"整树复制"作为隔离手段（隔离用 `git worktree`，见 `AGENTS.md`）。
