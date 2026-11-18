# R5 / 原 W6：canonical backup 入口纯 Go、Node-off 真实验收

## 归属和结论

- 授权：监督 `01a1df63` 的 `pm-0cad4e01`，仅认领 R5 的 canonical backup Go 入口验收，不接管原 M 整包，不代表原 M 已恢复。
- 本验收 owner：`01a1da1b-02c2-7b02-83f7-9a27cac2bdb4`。时间：2026-11-17 10:31–10:41，Asia/Shanghai。
- 对应原计划：`2026-11-14-node-go-next-development-plan.md` 的 W6，“独立在 Go owner 下工作”和退出旧调用链的局部门禁；不是新增功能计划。
- **本次通过：** 已有 `aih-go __backup-accounts` → `internal/host/backupaccounts` 在没有可执行 Node、禁止子进程和网络/RPC的环境中，完成真实 canonical 数据的导出、dry-run、私有新目的导入、重复导入、写锁拒绝和锁释放恢复。
- **本次未完成：** 公开 backup caller 的默认切换、Node adapter/projection writer 退出、完整 R5、全 W6 或全项目 Node 退役。它们不能因这份入口证据被标记完成。
- 源码零修改；只新增本文件。无测试文件、fixture、伪造 token/账号、第一方 Node 调用、共享服务重启、原客户端恢复或原库写入。

## 构件和数据边界

验收源码固定为 `9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87`，包含原 canonical backup 实现 `8794a6d0f`。共享 main 当时含其他会话暂存/未暂存改动，因此最终验收二进制从该提交的 `git archive` 源码、assets 和 contracts 构建，不使用共享 dirty 内容，不创建 Git branch/worktree，也不复制 `.git` 或未提交文件。

```sh
# $PRIVATE 是本人新建的 mode 0700 临时验收目录，不是共享 HOME。
git archive 9c94b3ad9bfb4c9b8b99d44fd4ff4b5fcd757e87 \
  go.mod go.sum cmd application core internal assets contracts \
  | tar -xf - -C "$PRIVATE/source"
cd "$PRIVATE/source"
GOWORK=off CGO_ENABLED=0 go build -trimpath -o "$PRIVATE/aih-go" ./cmd/aih
```

最终构建 exit 0；Go `go1.27.3 darwin/arm64`、`CGO_ENABLED=0`。实际运行二进制 SHA-256：

```text
a82d263cb1926e29df3abbe004628aad6345d5d26094ecb6d0b7799e8ed3257b
```

真实数据来自现有 canonical `~/.ai_home/aih.db`，不是 legacy 导出或模拟账号库。验收父进程以 SQLite `mode=ro`、`PRAGMA query_only=ON`、读事务打开在线原库，调用 `sqlite3.Connection.backup` 取得同一读视图的私有一致快照；另有 OS 沙箱禁止向真实 AIH HOME 写入。未对原库执行 migration、checkpoint、VACUUM、flock 或写 SQL。

- 在线快照：964063232 bytes，backup API 1.099 秒，`PRAGMA quick_check=ok`。
- 真实账号 41 个、11 个 provider；源快照账号/凭据/档案及 portable supplement 的只读 HMAC 与读事务内原库相同。
- 原库实际 credential 分类：`api_key` 4、`api_key/native_auth_json` 1、`oauth/native_auth_json` 35、`vertex_ai` 1。只证明这些已有记录，不外推所有 provider/auth 组合。
- 后续所有 Go 命令只接触私有快照和私有新目的 HOME；目的库固定为该 HOME 下的 `aih.db`，锁为 `run/canonical-account-writer.lock`。
- 原始导出/导入 JSON 包含凭据，只通过私有文件/管道传递；未放进 argv、终端、Git 文档或共享 HOME。临时根和子目录 0700、证据/DB 0600。

## Node-off 不是只改 PATH

每个验收 Go 进程使用最小环境：私有 `HOME`、显式私有 `AIH_HOME_DIR`、私有 `TMPDIR`、空目录 `PATH`，无继承的宿主/RPC配置。通过 `/usr/bin/sandbox-exec` 启动，关键限制为：

```scheme
(version 1)
(allow default)
(deny network*)
(deny process-fork)
(deny process-exec)
(allow process-exec (literal "$PRIVATE/aih-go"))
(deny file-read* (subpath "$REAL_AIH_HOME")
                 (subpath "$SHARED_REPOSITORY")
                 (subpath "$REAL_CODEX_HOME"))
(deny file-write*)
(allow file-write* (subpath "$PRIVATE") (literal "/dev/null"))
```

这是说明性路径占位符；实际 profile 使用绝对路径。Node 即使使用绝对路径也不能执行；网络禁止包含到现存服务的 RPC，因此没有“私有 Go CLI 再委托 Node 宿主”的允许通道。真实对照：

- 在相同 backup profile 下执行绝对 `/usr/bin/true` 被拒绝，exit 71。
- 在同样 `deny network*` / `deny process-fork` 规则下，独立探针的 loopback connect 和 `fork` 均为 `EPERM`（errno 1），未向业务服务发请求。
- 空 PATH 目录中无任何可执行文件。未停止系统中其他会话的 Node；本结论只针对验收进程树和受强制限制的调用链。

## 实际操作与结果

所有导入输入均为本次 Go 导出得到的完整原始 `aih-accounts` v1 document，41 条，未删选/改造账号内容。每条命令均运行最终 SHA 的同一独立二进制，stdin/stdout 留在私有目录。

```sh
# 原始输入/输出必须重定向到私有文件；不运行 aih 的 Node wrapper。
# request.private.json 是从本次 export 结果提取的原样 document，不是 fixture。
umask 077
run_backup() {
  target="$1"; shift
  /usr/bin/env -i HOME="$PRIVATE/home" AIH_HOME_DIR="$target" \
    PATH="$PRIVATE/node-off-path" TMPDIR="$PRIVATE/tmp" LANG=C LC_ALL=C \
    /usr/bin/sandbox-exec -f "$PRIVATE/nodeoff.sb" \
    "$PRIVATE/aih-go" __backup-accounts "$@"
}
run_backup "$PRIVATE/snapshot" export > "$PRIVATE/evidence/export.private.json"
run_backup "$PRIVATE/dryrun-destination" import --dry-run \
  < "$PRIVATE/evidence/request.private.json" > "$PRIVATE/evidence/dryrun.private.json"
run_backup "$PRIVATE/destination" import \
  < "$PRIVATE/evidence/request.private.json" > "$PRIVATE/evidence/import.private.json"
run_backup "$PRIVATE/destination" export > "$PRIVATE/evidence/readback.private.json"
# import 的 document 通过 stdin 输入，不放 argv 或终端；不 cat 原始文件。
```

| 真实动作 | exit / 结果 | 目的地副作用和读回 |
|---|---|---|
| 私有在线快照 export | 0；`protocolVersion=1`、`ok=true`；41 账号、0 skipped | 41 条全部保留；没有 Node/RPC |
| 全量 import `--dry-run` 到空私有 HOME | 0；total 41、planned 41、invalid/failed/created 均 0 | HOME 前后为空，无 DB、run 目录或锁创建 |
| 父进程持有目的锁的 `LOCK_EX|LOCK_NB`，再 import | 1；stdout 空，stderr 33 bytes，仅通用 `backup_accounts_core_failed` | 未创建目的 DB，未替换锁 inode；未泄露凭据或原始错误 |
| 释放同一锁 inode 后 import | 0；created 41、failed/invalid 0 | 新 canonical DB 建立，全部账号有实际读回 |
| 同一输入重复 import | 0；unchanged 41，created/updated/failed/invalid 0 | accounts、account_credentials、account_profiles、app_kv 的全行内容相同，未新增重复身份或改凭据代次 |
| 目的库再次 export | 0；41 条、0 skipped | 按 accountRef 比较整个 portable entry，忽略数组顺序后与源完全一致：provider/ref/CLI alias/status/env/nativeAuth 都一致 |
| 真 stdin pipe 再验 dry-run、锁拒绝、重复导入 | 分别 0 / 1 / 0 | 仍为 planned 41 / 无 DB / unchanged 41；额外重复后上述四表仍相同 |

目的库 `PRAGMA quick_check=ok`。没有执行真实凭据的上游认证或刷新，不把“导入后读回一致”当作 OAuth 仍有效的验证。

### 真实进程树

父进程使用独立 `/bin/ps -axo pid=,ppid=,comm=` 采样，跟踪目标 PID 及递归后代，不读取其他会话 argv 或环境。Node-off 命令不启动 server。主要目标 PID：

| 操作 | PID | 样本数 | 观察 |
|---|---:|---:|---|
| export | 32030 | 12 | 单一 Go PID，无 child |
| 初次成功 import | 33061 | 3 | 单一 Go PID及退出态，无 child |
| repeat import | 33065 | 2 | 单一 Go PID及退出态，无 child |
| 目的 export | 33068 | 1 | 单一 Go PID，无 child |
| 真 pipe dry-run | 33772 | 1 | Go executable 已观察，无 child |
| 真 pipe lock reject | 33776 | 1 | Go executable 已观察，无 child |
| 真 pipe repeat | 33778 | 2 | Go executable 已观察，无 child |

证据修正：最初两个快速命令的 ps 只抓到同一 PID 的 `(sandbox-exec)` 退出态；另一次有 `<defunct>`。最初“名称必须全为 Go”的摘要断言因此失败，不是 backup 操作失败。原始样本保留，不把退出态重命名成 Go。随后真 pipe 输入在观察到 Go executable 后释放，重新执行 dry-run/锁拒绝/重复路径，取得上表 33772/33776/33778 的实际 Go PID证据。进程采样不是完整内核 exec 审计；短命 child 的禁止由 OS `deny process-fork/foreign exec` 强制补足，而不是靠采样无遗漏的假设。

## 原库与快照不变证据

- 验收前后分别只读计算 canonical account scope 的 HMAC-SHA256，随机 HMAC key只存私有目录；accounts 41、account_credentials 41、account_profiles 0、portable supplements 0，前后全行摘要相同。
- Go 入口完全被禁止读取真实 AIH HOME，更不能向其写入；在线原库仅被验收父进程只读快照/核对访问。
- 私有输入快照整文件 SHA-256 在 export 和全套导入之后相同：

```text
67cc3267493082439eab390a94d6c8e2e5cc9e6840365d23a2aac76d8f991ec5
```

这是“原库账号事实未被本验收改变 + 输入快照字节不变”的证据；共享服务仍可正常写其他业务，**不宣称在线原库全文件或所有表冻结**。没有为了取得证据锁住共享原库。

## 尚存 Node 调用、写者和下一退出门禁

本验收复用了现成 Go 分派，没有发现该 private canonical 入口必须借 Node 才能运行。下列既有 public 路径只读审计，未执行、未修改，也未据此扩建第二套业务：

| 现存调用 / 写者 | 当前责任 | 下一切换/停旧路/删除门禁 |
|---|---|---|
| `lib/account/backup/remote-backup-service.js:buildLocalBackupAccounts` | 先构建 Node native 导出，再调用 canonical export，并按 link/预测身份合并 | 原 R5 owner/监督需逐一证明 native-only 剩余数据由 Go 接管、没有丢失后，才能停 merge 旧来源；本次只证明 canonical 41 条 |
| `lib/account/backup/core-accounts.js` | 已验证 daemon 时走 `/v1/management/accounts/backup/*` RPC，否则使用 Go `__backup-accounts` pipe；仍是第一方 Node caller | 将 public entry/transport 分派归 Go，分别完成 daemon-live 与 offline 锁边界验收；本次禁网直达 pipe，不覆盖 daemon RPC |
| `lib/account/backup/core-mirror.js`，由 restore caller 调用 | canonical commit 后以版本核对写 compat account refs/aliases/credentials/state 投影 | 先确认下游 compat consumer 已迁走/由 Go 持有必要投影，再停 Node projection writer，验证恢复后可见性，最后删 adapter；本次没有调用或新增此写者 |
| Node remote repository transport / journal | 远端仓库策略与恢复仍有原 caller责任 | 完成真实远端 backup/restore/integrity/recovery 和授权 caller切换后再删；本次不是远端备份全链路验收 |

这些保留项是待退出责任，不是长期 Node/Go 双业务设计。本验收 owner只负责本文件及上述 canonical Node-off证据，不能替未恢复的原 M 承诺整包归属/完成日期或擅自删除旧代码。

未覆盖：Linux/Windows运行、GUI/Edge、公开命令/包安装/升级默认分派、Node-off共享服务、daemon-live导入路由发布、远端仓库/journal、provider native HOME投影、已有身份冲突/新凭据代次/取消与磁盘故障矩阵。无 fixture补造覆盖。

## 私有证据和交付阶段

低敏结果和原始 process samples 位于本人私有根 `/private/tmp/aih-r5-nodeoff-20261117-JlGzaQ/evidence`。原始导出/导入正文、快照及目的 DB含凭据，未上传、粘贴或纳入 Git；摘要只保留聚合、布尔、exit、PID、hash和错误码。监督 `pm-543bb426` 精确批准自有敏感资源清理后，先保存低敏摘要、各敏感副本完整 SHA、HMAC、9操作状态与进程/锁证据，再确认 `lsof +D` 无打开句柄、无存活私有 Go 进程，逐路径确认 realpath位于本人root且各级无symlink。共删除27个自有敏感文件（数据库及sidecar、正文、HMAC key及本地索引基线副本）；私有锁 inode、低敏证据、二进制、固定来源源码保留。`sensitive-cleanup.json` 记录范围/前置条件/文件hash及删除结果；没有清理共享目录或整根。删除不是安全擦除/APFS快照销毁的声明。

- 源码：零改；仅本证据文档。
- 构建：上述固定 source commit和二进制 SHA，已构建并实际执行。
- loaded：只加载到私有短生命周期 CLI 进程；没有加载/替换共享服务。
- real accept：本文件列出的 canonical offline入口矩阵通过；不是 public backup业务全链路通过。
- Node退出：该局部调用链 Node-off已验；公共 caller/compat writer/远端仓库Node未退出。
- commit/push：由本 owner按该单一文档 pathspec核验并单独汇报，不能把源实现提交归到本 owner。

审查：已向现有 `01a1e2ab` 会话请求仅文档/低敏摘要的只读审查（`pm-fd546597`），请求已读；截至本文件提交前尚未返回独立 verdict，不能写成独立审查通过。为遵守不新增 writer/会话的边界，未另启动 review会话。本次按仓库能力链降级执行 **self_review + plan_check，显式 doc-only review bypass**，仅限已获授权的本文件提交：逐项复核固定构件、9次状态、沙箱对照、锁/回读/进程/清理摘要、原W6与Node退出边界；并将真实导出中79个敏感字符串直接对照本文件，匹配0、账号ref匹配0，不输出值；secret形状/乱码扫描及单path staged diff检查通过。监督原任务及 `pm-543bb426` 均明确要求本人仅新doc提交；此bypass不是原M业务或共享发布的审查授权。若后续独立反馈需修正文档，以新的本人单path提交处理，不amend或重写并行历史。


## 2026-11-18 06:40 增量：公开 local export 的 Node 业务退出

本增量为监督 owner 本人交付 **`65c58b9801e0f898ff51141a542bf4e68e60d95e`**，不改上文2026-11-17 canonical core验收结论。实际父提交为 R4 文档 `5ea21cf5f`；物理落盘前观察值 `ff722f3bd` 不是最终parent，原commit receipt已正确记录，口头差异另有澄清receipt。

### 精确工程边界

仅六个production paths：`lib/cli/commands/backup/router.js`、`lib/account/backup/public-export.js`、`cmd/aih/backup_accounts.go`、`internal/host/backupaccounts/public_export.go`、`internal/adapters/accounts/nativeexportread/reader.go`、`internal/adapters/accounts/nativeexportread/selection.go`。公开 `aih export` / provider-scoped export 的既有兼容账号视图、选择器、filename、host/time和0600文件发布由Go唯一执行；Node仅fixed bundled Go能力探测、bounded pipe和低敏显示。原local import与remote backup改为延迟require但仍用原实现，未改canonical `__backup-accounts export/import`、Go运行入口或remote状态writer。缺/旧Go明确失败，绝不回落旧Node导出。

**没有偷换导出集合：**本次真实sealed快照 `561596b6eca3a34052a2cc6fd024f5fd3d684bc12ec2b427d67b447f9dfd3f22` 中 canonical34 / compatibility32，后者独有3、前者独有5。因此本caller继续原32条语义，不把canonical-only混入，也不静默丢compatibility-only。统一账号真相源/删除这些历史表另有门禁。reader仅 `appstate.OpenReadOnly`＋同一read transaction；缺表/坏对象JSON/读取失败现在显式失败，是对旧缺表默认值/坏JSON当空的收紧，不宣称异常路径完全等价。合法空对象、缺凭据行仍按原skip；真正新空HOME可产生空document，公开router照原语义exit1。

### 固定输入、构件和真实结果

- 固定source `40c5a795d9a590263ed8c7677b9a3c0c19976e6b` archive `7f15f13756e157913843be9ca41e4f9fa121a4359b158e16d83460c624ea25a6` ＋exact6overlay；非最终commit整树build。
- 最终source manifest `47e959a77141f401c572d9d2ffb3b6fadeb24bfdd7baa7df48ff68a6ed225a6d`；macOS实际Go CLI `9b4f009bae43337f6d461159b35d011445bfb5b1aeb2cb9d3f550f1a478af334`。build/vet/Node syntax均exit0；Windows仅cross-compile，不借为运行验收。
- 实际命令为私有原生产 `runBackupCommand`、fixed Go `__backup-accounts export-public`、新同caller/adapter及真正 `node <private-package>/bin/ai-home.js export <private-output>`。真实32条逐entry整体摘要均为 `a9f4bf550c6727e9dcbd37af14e7b2ffa0d2bf68664bd71badcd2d24da41ff1f`，kind/version/host相等，时间字段各自真实生成；原snapshot完整SHA不变，输出0600。
- 10组原/Go selector、provider-scoped与默认filename对比：8成功＋2拒绝，所记录账号entry与filename一致。真实root入口exit0同32条。V8证明旧transfer/remote模块未加载；Node account-reader模块被大app其他引用加载，但被观察的 `readNodeAccounts/openReadOnly/parseJsonObject` 函数count为0，不能写成零Node模块/进程。
- 实际拒绝leaf/ancestor symlink、缺表/坏对象、strict DTO、缺/旧Go；已有0644私有文件替换后0600，真实写权限拒绝保留原文件SHA。metadata超限原先审查发现发布后才拒的P2，已改成含默认JSON转义＋LF的64KiB写前准入；同32真实账号配70087-byte用户目标路径实际exit1 `public_export_output_limit` 且未创建目录。大量缺凭据账号分支仅静态审查，未造账号实跑。
- 最终构件空PATH＋OS禁fork/foreign exec/network，禁止读取live AIH/仓库，真实Go PID42723四次children0、导出32/exit0；输入未EOF实际5.026秒exit1，实际SIGTERM143/0.221秒；foreign `/usr/bin/true` control拒绝exit71。只证明本调用链，不是整机zero Node或所有短命进程无遗漏的内核审计。

### 证据修正、安全和交付分列

私有根 `/private/tmp/aih-public-export-go-20261118-bv7wnib_`（pointer `/tmp/aih-public-export-go-latest-20261118.txt`）。final3原始低敏运行leaf仍带旧manifest字符串，已由 `final3-binding-correction-receipt.json` / SHA `bf51c1c4b1e14445580a9d942af42e0806c2fd266437c506dc68c2c9c5237f72` 显式绑定最终六SHA/artifact，不覆盖旧leaf。原v1/v2、profile变动及v2 matrix profile路径笔误exit65保留，失败不算产品拒绝；随后fresh final3真实重跑。早期extra leaf为5项，不能称6项；旧lifecycle不升级为final3，最终另有 `final3-lifecycle-process.json`、`final3-write-denial.json`。所有正文/DB仅owner私有文件，不进Git/argv/peer，未授权清理则保管；不宣称敌手可写目录的race完全安全或Windows真实运行。

原Galileo对最终exact6＋允许低敏binding **APPROVE / NO BLOCKING**，唯一P2已闭；review不是其本人重跑export。源码pre-cachedstat/post-showstat、六blob和scope均核，one-use index＋显式pathspec，主index完整bytes/entries前后不变，没有同步或清理peer旧索引。source已本人checkpoint；push以实际relay receipt为准；artifact仅上述私有产物；**本机标准CLI仍旧缺新capability、未安装/共享加载或重启，不能把新源码当已可用发行版**。适用用户安装授权仍单独需要。Node bootstrap、import/remote/core-mirror、Desktop stop/cache、host收养、插件JS执行宿主与默认双后端均未因此退出；R5及42项＋7门禁/R0–R8仍未完成。

## 2026-11-18 09:28 增量：remote restore 兼容投影改由 Go 写入（source checkpoint）

本增量仅对应 `remote-backup-service.js` 的兼容视图写入边界，不把 canonical core 的既有矩阵、公开 local export、remote transport 或整个 R5 合并为完成。批准范围为原监督 `pm-7a82f427`、单目的实跑 `pm-b3259e20` / `pm-a1525452`、正常锁基础设施 `pm-cd960ff6`、追加真实 pipe consumer `pm-317c8adf` 和 source checkpoint `pm-c86c5a6a`。本段以前的证据及边界保持原样。

### 唯一 writer 与 exact4 工程边界

- `lib/account/backup/remote-backup-service.js`：仅 remote restore 在已有 Go import wire 上显式请求 `compatibilityProjection:true`；核对返回的版本、applied 数和未知结果标记。丢回复、旧 Go 无 marker 或投影不完整时明确失败，不回落 Node writer；dry-run 不要求投影 marker。
- 删除仅此实际 caller 使用的 `lib/account/backup/core-mirror.js`。保留原 remote strategy/传输 orchestration，未声称 remote Node 调度已经退出。
- `internal/host/backupaccounts/app.go`：canonical import/readback 后组合 adapter DTO，已有 CLI 与 daemon handler 共用；保留 canonical 已知提交与可能提交事实，readback 失败不能抹成“未写入”。非该显式 flag 的标准 import/dry-run 保持原路径。
- 新 `internal/adapters/accounts/sqliteaccount/backup_compatibility_projection.go`：只按 canonical readback 及同连接 `BEGIN IMMEDIATE` 内 provider/ref/alias、credential version 和有效 profile version 的 CAS，写原四表 `account_refs`、`account_cli_aliases`、`compat_account_credentials`、`account_state`。只允许既有精确 schema/索引/约束；不兼容即拒绝，绝不 DROP/重建/自愈。不会搬入旧 `createAccountStateIndex` 的全局 down 状态归一副作用。adapter 不向上依赖 host/runtime。

### 冻结来源及审查发现

固定 `68acc4db3c2183b84341137b007828f94947a2c4` 的 archive SHA `307ded6a61e8c307e2be854127e803965e4c060fbec9e3a106d4b858cefef476`；6187 个普通成员逐内容核对，私有工程仅上述 exact4 差异。不是从共享 dirty cwd 构建，也未叠加另一套 private helper/reader。

最终 v4 manifest SHA `5a6d78dc3c78369b57a2a19d2293ef87fc8fb014496cd8eb67523aaa37183c25`，patch SHA `0f233d08dd4c35292b2771fab87d564de83cc7f7b63ce4dcad3c239718d3d3c8`；darwin/arm64 CGO0 实际 Go CLI SHA `0e5ee04f348d3b1a3f6eb567cd9cad0a390c666efcaafe8711c5887209eb7700`，`go build -mod=readonly ./cmd/aih`、定点 `go vet`、Node syntax 均 exit0。

原 Galileo 定点独审先发现并修正：canonical readback 降级会抹除提交事实、额外 UNIQUE/冲突策略改变兼容写入语义、`idx_account_state_provider_updated` 必须含第三列 `account_ref`。最终 v4 source NO BLOCKING；这只指本 source gate。第五操作前的提案也曾因未明确 builder→import envelope 包装和失败 unknown 语义被 HOLD，修正后另审通过，保留旧记录，未抢跑或更改原输入。

### 单一私有目的、四步对照与一次实际 pipe consumer

唯一新增敏感目的：`/private/tmp/aih-backup-compat-go-20261118-cwot4uia/private/mirror/destination`。从已准真实 portable builder 输出 SHA `1382e92a94ecbd07fa46c25a00b4f8a5e1f0d8f18f46d9bf9ee992f917f6dd0d`（34 accounts / skipped0）走产品 import 填充；不复制 live/历史 DB，不造账号、token、冲突、规则或 schema 样本。HOME0700、DB/raw0600；产品正常维护协调库仅 `run/maintenance/access.sqlite` 的 lease/id1，另为原 canonical writer lock，非第二凭据库。

| 实际操作 | PID | 结果 |
| --- | --- | --- |
| Go import + projection | 48497 | exit0 / created34 / applied34 |
| Go repeat | 48532 | exit0 / unchanged34 / applied34 |
| 冻结旧 Node mirror，仅一次、同前步实际 Go Result/同 DB | 48561 | exit0 / records34 |
| Go after Node | 48574 | exit0 / unchanged34 / applied34 |
| 实际 `coreAccounts` pipe import，显式选择冻结 v4 Go | Node90884 → Go90886 | exit0 / protocol1 / unchanged34 / failed0 / invalid0，两项 count34 / applied34 |

Go 结果的 marker 均为 `canonicalStatus:committed / outcomeUnknown:false`。前三段和第五步前后的 30 张非兼容表全字段 HMAC 均保持；四兼容表完整业务语义 HMAC 相同。**不是零写入或 DB 字节不变**：`account_refs.updated_at`、`account_cli_aliases.updated_at`、`compat_account_credentials` 三个更新时间列及 `account_state.updated_at` 每步各34行变化，已逐项记录。四表各34行；canonical34、profiles0。本输入 profile version CAS 正例、自然 stale/conflict 不因此补齐。原输入及 sealed 源 `561596b6…` 全文件 SHA 前后不变。

三个直接 Go 步骤为空 PATH、OS 禁网络/fork/foreign exec，进程样本未见 child；一次旧 Node baseline 同样禁派生。追加 pipe 步骤为真实 Node→Go，必须允许 fork 且权限由 Go 继承，exec 只限这两个 image path、并不限制 argv/派生深度，**不能把第五步称 OS nofork 或无 Node 引导**。三匿名 pipe、从零 env、无 daemon identity 文件、OS deny 网络及共享读写；观测实际 Go 子 PID并等待自然退出。所有已观察私有 PID 退出，无 operator signal/retry/fallback/cleanup。

旧 mirror 模块 SHA `afd18c46…`，其67项静态相对 require 依赖均与原 archive 相同；绑定真实 operator 源码，不冒称动态 module-load trace。原独审仅重算 source/artifact/hash 及低敏记录一致性，未开 DB/raw/key 重新计算 HMAC；不得写成 reviewer 独立重跑整矩阵。

### 证据与保留门禁

证据根 `/private/tmp/aih-backup-compat-go-20261118-cwot4uia/evidence`：四操作 `mirror-real-four-operations-v4.json` SHA `153822a96b01ac05d393e900107b83f850c95f23e4bf8fa25f2a6edc8a3da152`；第五操作 `mirror-05-real-pipe-result.json` SHA `21b6af495c435b1772da0a697e587246114ae328dc578c5f9d73935784a49085`；各自 source gate、snapshot、原 Node 身份及 archive delta 均另有低敏绑定。raw/DB/key 不进入 Git或 peer，未获清理许可则精确保管。

仍 OPEN：既有 **Node-first schema** 的真实动态准入（Go 先建再 Node IF NOT EXISTS 不能证明此项）；自然 CAS mismatch/alias conflict/锁/partial/unknown 结果；带 profile version 的正例；旧 down/runtime 归一副作用；HTTP daemon 动态 consumer；默认 packaged binary resolver；真实 remote restore 下载/策略/取消恢复；共享 caller/loaded/正式构件及全 R5 Node 退役。新 Node caller 需要具备本 projection marker 的 Go，**旧 Go 将 fail-closed，必须按适用批准配对发布 Go+Node**；本 checkpoint 不授权安装或重启。

交付分列：source 为本 exact4＋既有 doc append checkpoint；push 只按真实远端收据，不拿 tracking ref 代证；artifact 为上述私有产物；loaded/accept 仅本私有有限操作，未安装或改变9527；Node 旧 mirror writer 的源码退出不等于 remote orchestration/全服务 Node-off。42项＋7门禁/R0–R8及默认双后端退出目标持续未完成。
