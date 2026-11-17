# R4 / 原 W4–W5：Go alias 首读迁移工程 checkpoint

## 交付范围与发布硬门禁

监督 `pm-2026e474` 于 2026-11-17 11:23–11:24（Asia/Shanghai）确认 existing owner `01a1da1b-02c2-7b02-83f7-9a27cac2bdb4` 只承接旧 alias 空库首播种这一 slice。**本次有实际 Go/Node 工程修改，不是退出状态卡替代实现。** 不接管原 M 整包，不修改 Chat9、inferencecatalog builder、W0 bin hunk、M/Desktop、Terminal/协议、R6/R8、共享服务或 stamp；不新增测试或账号/alias fixture。

**可以 checkpoint，尚不可发布：**

- Go 已负责首次迁移、canonical 读取和持久化空集合门禁；Node 原 `pushModelAliases` 兼容名称现在仅 GET Go 的已应用状态，不读 legacy、不 PUT 播种。
- 现有 canonical 非空、代次大于 0、用户显式清空后的重启，以及真实读错/写锁忙分支已实际验证。
- **旧 wildcard-only、canonical 空且 generation=0 的首迁被明确阻断。** 真实旧表不含 displayModels；直接迁成空名单会丢可见性，保留 Node PUT 又违反唯一写者。本实现返回 `model_alias_legacy_display_source_required`，不迁行、不推进代次、不继续启动 inference。它既是保护，也是真实可用性缺口，不是首迁完成。
- 解除者：由监督指定 wildcard 来源 owner，提供有明确权威/版本/退出条件的 Go 可读展示名单或迁移合同，并批准必要最小接线。本 slice 不扩 wildcard 数据源、模型策略或 OAuth。
- 当前原库及 sealed legacy 的真实 alias 均只有同一条 wildcard；没有真实非 wildcard 正向迁移样本。未改造 alias 内容制造样本；普通记录插入分支只有源码/构建审查，没有声称真实正向验收。

## 四个生产路径

| 路径 | 实际变更 |
|---|---|
| 新 `internal/adapters/accounts/sqliteaccount/model_alias_legacy.go` | 同一 canonical DB 上，先单 SQL 读 count+generation；只在空且 generation=0 时进入 `BEGIN IMMEDIATE` 并重查。只读旧 `model_aliases`，按 created_at/id 保序，校验结构/上限后原子写 canonical+generation1。旧表不存在或确定为空也记录一次正代次；任意错误 rollback，缺失/负代次不当空。wildcard 缺名单显式 fail closed。 |
| `internal/adapters/accounts/sqliteaccount/model_alias_repository.go` | `Load` 先经过 Go 首迁边界，再读 canonical；错误不授权 fallback 或空投影。 |
| `internal/host/aihserver/inference.go` | 仅 alias Restore 接线：不再吞恢复错误或等待 Node 补种，返回启动错误。未改 builder。 |
| `lib/server/go-core-host.js` | 删除 legacy load/投影构造/PUT 播种；兼容方法只 GET `/v1/management/model-aliases`，验证 accepted_ids、generation、applied_generation 后更新接受集合。移除本 hunk 的旧依赖/注释，不扩 Node 业务。 |

canonical 有任意记录 **或** generation>0 时不触 legacy；已有 canonical rows/displayModels、用户清空 tombstone 均不会被旧表覆盖。事务内部重查覆盖其他进程在锁前已经写入的情况；本次不改现有 CRUD 并发/代次生成的其他路径。

## 构件与真实输入

共享 main 含其他 owner 的工作。验收用 `869a20a059a8432a5e990e8ca43f8b48b216d732` 的 `git archive`，只覆盖本人三 Go 文件构建，未包含共享 dirty 来源，未创建 branch/worktree。Node 兼容调用另用本人实际工作文件，非 mock。

```sh
# 在私有源码归档中执行；不修改共享产品入口。
GOWORK=off CGO_ENABLED=0 go build -trimpath -o "$PRIVATE/aih-server" ./cmd/aih-server
# 仓库内只进行已授权源的构建/静态校验，不新增测试。
go build ./internal/adapters/accounts/sqliteaccount ./internal/host/aihserver
go vet ./internal/adapters/accounts/sqliteaccount ./internal/host/aihserver
node --check lib/server/go-core-host.js
```

构建/vet/Node语法均 exit0。Go `go1.27.3 darwin/arm64`、CGO0；生产 `aih-server` SHA-256：

```text
85e62c99fb2a7331f67eeccd23a6701bd9927cef1b2f0b9d28b6a196e1819846
```

真实 canonical `aih.db` 以 SQLite `mode=ro`、query_only、读事务和 online backup API 取得一致私有快照，OS 禁止父进程写真实 AIH HOME。快照964255744 bytes，约1.008秒；真实 legacy/canonical alias 各1条，canonical generation41，持有10个 displayModels。私有变体只改变本地存储状态（清空/重命名列/移除 meta 行），不插入/改造账号、模型、alias 名称/目标或凭据。旧表在每项 Go 调用前后按全行摘要比较，没有被迁移写者改写。

## 两种 Node-off 证据不可混称

### A. 生产 CLI，系统 PATH 无 Node

真正的 `cmd/aih-server` 二进制以私有 HOME/AIH_HOME、`PATH=/usr/bin:/bin:/usr/sbin:/sbin`、随机私有端口启动；`which(node)` 不可用，不设置 Node supervisor/frontdoor。PID81582 实际 HTTP200 读 alias1/display10/generation41，canonical+legacy+meta 全行相同，最终 exit0，采样未见 Node。

**边界：这不是 OS 层禁止一切出站/绝对路径执行的证明。** Darwin 的产品 serveridentity 必须执行 setuid `/bin/ps`；Seatbelt 即使允许 literal 也 EPERM，去 setuid 私有字节相同 copy 被 OS kill。因此没有伪造 ps 或修改非 scope 的 identity 来让验收通过，也不把系统 PATH 证据叫强制 noexec。

### B. 真实生产库/host，OS 强制禁 Node、子进程和出站

私有 Go operational bootstrap 仅调用真实 exported `sqliteaccount.Open`、`modelalias.Store.Restore/Replace` 与 `aihserver.New/Serve`；没有复制业务函数、mock server/port、替代数据源或合成响应，源码只留私有归档，不加入仓库测试。空 PATH、私有 HOME，Seatbelt 禁止读取真实 AIH HOME/共享仓库/Codex HOME、禁止私有根外写入、deny process-fork/foreign exec/network-outbound。HTTP host 只开放本机入站和 bind，不允许 RPC/其他出站。

该 bootstrap 绕过的是生产 CLI 发布 process-identity 的外壳，不绕过 alias Restore 或 host composition；因此 **库/host强制 Node-off 与生产 CLI 完整入口分列**。

首轮 strict host PID81652 取得 HTTP200/10名单，但私有 bootstrap 同时在 context handler 与 defer 两次 Close 导致产品非幂等 Close panic，exit2。原始失败保留，未声称 clean shutdown。只把私有 bootstrap 生命周期改为一次 Shutdown、一次最终 Close，产品 Close 未改；重跑 PID84338，HTTP200/alias1/display10、4次采样单进程、exit0。该 clean-exit bootstrap binary SHA：

```text
97a84ee05a958937453ef22458f8bb3c6aec37ed48572c9ade5e8cd73c32c4d4
```

后续为真实锁验证仅在私有 operational bootstrap 增加 stdin 时序门：在生产 Store.Open 返回后才允许外部 writer 加锁，再调用原生产 Restore，不复制业务函数或吞错。最终 operational binary SHA：

```text
03fa354fcd62f073e0576d9fb73ef75c3e1784b1911d2ef98dfa76ea6d8278c6
```

## 真实私有副本矩阵（2026-11-17 11:33–11:45）

| 动作 | 观察 | 能证明/不能证明 |
|---|---|---|
| 原 canonical 非空，Go首读与重启 | alias1/display10/gen41，全行不变 | 不覆盖已有 canonical 及可见名单 |
| 非空但 gen0 | alias1/display10/gen0，不覆盖 | count 独立于代次也能保护 |
| 非空、legacy alias列损坏 | Go仍读 alias1/display10/gen41 | 权威已有时不访问坏旧源 |
| 真实 Go `Replace(nil)` 显式清空，再新进程重启 | alias0/gen42，旧表原1行仍在 | 清空不复活、不依赖 Node播种 |
| 私有源确定空，空gen0首读 | gen1、alias0；重启仍gen1 | 首次空也落一次完成门禁 |
| 两个真实 Go进程并发首读空源 | PID88088/88089均exit0/gen1，最终gen1 | 两进程幂等；Store.Open自身也有writer事务，不宣称两者同时越过precheck |
| Store.Open后外部真实 `BEGIN IMMEDIATE` 持锁，再Restore | PID91605，5.109秒后返回 migration-begin busy，exit1，alias0/gen0无写 | 忙错可见，不当空/不迟到写；释放后新进程成功gen1 |
| legacy坏列、canonical坏列、缺meta行 | 分别返回source-read/canonical-read错误；表/代次/旧源摘要相同 | 读错不当空，不fallback/部分迁移 |
| 真实旧 wildcard、Go空gen0 | `model_alias_legacy_display_source_required`，alias/meta/legacy不变 | failclosed可见保护；**不算成功首迁** |
| 上述wildcard缺口经production host.New与实际CLI | startup失败，未listen/serve，三alias表不变 | Restore错实际传播；**部署硬阻塞** |
| canonical坏列经production host.New | startup失败、未serve，alias事实不变 | 启动不再默默退空等Node |
| 实际 Node `createGoCoreHost` +真实management client只读握手两轮 | gen41两次，三表不变，exit0 | 兼容名退写/读Go承接；该隔离catalog accepted_ids=0，**不算alias路由已accept** |

所有错误用例只在私有副本，未锁共享库。坏列/缺meta以及wildcard失败发生在写入之前或事务rollback；没有真实非 wildcard样本触发insert后中途失败，故不宣称覆盖该回滚点。任意 auth 模式/OAuth轮换、wildcard来源、全路由语义、跨平台安装/升级和共享部署均不在本矩阵。

## 原库不变证据的精确边界

验收前后原库只读 HMAC 对照：`model_aliases`、`model_alias`、`model_alias_meta` 以及 `accounts` 一致；**live account_credentials HMAC发生变化（仍41行），来源未归因，不声称凭据/全库冻结或把变化归到其他owner。** 严格库/host进程被禁止访问真实 HOME，production CLI使用私有HOME但没有相同OS强制保证。这一差异保留在低敏 per-table 结果中，不追查/干预共享writer。

输入快照的 alias/account/credential 事实仍与原始只读快照相同；快照完整 SHA-256：

```text
81c58b06558c58515a27611707715927c8ac924e79c249619055fd616cb184ba
```

本次只声明原库alias三表未变和私有输入只读边界，不声称所有业务表/原库字节未变。

## 独立审查、残留与交付状态

现有 reviewer `01a1db81` 只读审查四生产路径，于11:39给 `NO BLOCKING FINDINGS`（`pm-7e81a0dc`）；11:41/11:42确认后续仅删除旧require注释及更新export旧注释，Go三源哈希稳定，Node最终`773cff9b…`，结论继续有效。审查者未读私有DB/日志/凭据，未改文件/index、未新会话、未代提交、未重跑runtime。**source no-blocking不是发布或整个R4退出放行。** reviewer于11:47另对本证据文档给 `NO BLOCKING FINDINGS`（`pm-1d0c7100`），仅文档边界检查，不把owner runtime结果记作其亲验；本处记录回执并按建议澄清commit尚待本人提交。

application/modelalias中“Node唯一owner”“空表generation=0”等旧注释已不精确；未获写scope，因此不扩大业务改动，作为窄文案跟进保留。

低敏证据、构件来源/哈希、原始进程采样在本人root `/private/tmp/aih-r4-alias-nodeoff-20261117-ure6vL/evidence`。临时DB/sidecar/log可能含凭据或ref，不上传、不放argv/终端/Git；副本和root访问限本人。敏感清理仅限另获批准的当次root，先保存摘要/完整SHA并确认进程/DB句柄退出及逐realpath无symlink越界；不借R5旧root许可扩大删除。

- 工程源码：仅上述四生产路径；本人附此证据文件。
- 构建/真实accept：仅按本文件两级和矩阵逐项成立；旧wildcard首次可用迁移与非wildcard正向样本未完成。
- loaded：只有私有短生命周期二进制；共享服务未加载/重启，无stamp变更。
- commit：本文写入时待本人显式pathspec checkpoint；提交前后核对cached范围/提交stat，他人原索引不动，真正提交后再单独回SHA。
- push：本slice未执行。
- Node退役：只停这一个legacy seed caller的读/PUT；其他Node caller、wildcard数据来源、R4其余策略/凭据/OAuth未退。**不是整个R4Node-off，也不是可部署完成。**
