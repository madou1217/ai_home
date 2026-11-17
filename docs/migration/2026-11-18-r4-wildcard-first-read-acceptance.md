# R4：既有 Go wildcard 首迁实现的真实 Node-off 副本验收

日期：2026-11-18（Asia/Shanghai）。原 owner `01a1da1b-02c2-7b02-83f7-9a27cac2bdb4`。
监督范围：`pm-e9381955`；本轮只新增本低敏验收文档，**生产源码新增修改 0**，不新增测试用例、账号/model/alias fixture、分支或 worktree，不写真实库、不重启/部署共享服务。

## 1. 当前源码事实与结论边界

- `963a5f7b3f5091e37c61acf487487f9e74430ba6` 已于 2026-11-17 18:58 接入 Go `aliasdisplay.List`，并加入带版本/hash 的内嵌 SDK 展示源。本轮没有重新实现来源，也不把该已有提交归为本轮工程成果。
- **原先“真实 wildcard、canonical 空/gen0 因缺 Go display source 而无法启动”的当前实现阻碍，已用真实副本验证不再出现**：生产 Store、生产 CLI 和直接生产 Host 都可首迁到 generation1，持久化 1 条真实旧 alias 与 10 个展示名，无 Node 播种。
- 真实旧 alias 为 disabled；首迁保留 disabled，不伪改 enabled 或目标以凑 accepted 数。它的 HTTP `accepted_ids=0` 不是正向路由验收。
- 当前 canonical 的另一份真实配置为 enabled：独立生产 CLI 副本 HTTP 三轮均 `generation=applied_generation=43`、`accepted_ids` 长度 1。这只证明**真实编译接受**，没有调用付费/外部上游，也不等于推理请求执行成功。
- **整个 R4 及全量 Node 服务退役仍未完成/不可据此放行**：当前 canonical 的 displayModels 为 0，Go CRUD 尚未接展示源；Node 的 enabled/default/model-policy 定时业务写者仍在。后续工程 scope 请求为 `pm-58281360`，不是本轮已获写权限。

## 2. 来源、版本与首次启动时序

唯一展示权威是与既有 Node 展开规则同源的固定 SDK snapshot，不是账号可用模型列表、可执行路由列表或新造名单。

| 项 | 固定来源 |
| --- | --- |
| Package / SDK | `@opencode-ai/models` / `0.0.109` |
| SDK generatedAt | `2026-10-19T05:32:55.764Z`；不声称是“最新 SDK” |
| sourceHash（snapshot.models） | `80c88099d3b27408ac89bce5e7bd10a84e3c38215c9c5165a6a128d24026bab6` |
| 原 SDK 模块 SHA256 | `c82750b32953f5645c0e5ee94e9492b231b8ecb633776c25c6b5723ddb407083` |
| 内嵌 payload hash | `b0e602551387d01c377c14df3ad4142b5d52df8b3745d8234d5f3b44ffa2c943` |
| 内嵌 JSON 完整 SHA256 | `f9b2f46084b28c8c203d016a590073f6ba371042954968296c9c33d93b27bed4` |
| 策略 / 顺序 | policy1；Node localeCompare 预存顺序；433 rows、118 families；沿用一年内、family 每组最多 3 代、排除日期后缀等现有规则 |

只读构建时校验 `node --check scripts/gen-alias-display.js` 与 `node scripts/gen-alias-display.js --check` 均 exit0；这属于固定构件的生成一致性校验，不是运行 AIH Node 宿主。

真实启动时序：Go 打开 canonical Store → `modelalias.Store.Restore` → 若 canonical 空且 generation0，在同一连接 `BEGIN IMMEDIATE` 内重查并读只读 legacy → `aliasdisplay.List` 验 SDK/source/payload → canonical 行与 generation 原子提交 → `builder.WithAliasStore` → 首次 catalog refresh。Node 兼容 `pushModelAliases` 只 GET 已应用状态，不读取旧表/PUT 补种。非空或正 generation 不回旧副本；合法空 tombstone 不复活。

## 3. 不可变构件与操作入口

- 本轮 main archive 基点：`162207bdb3b81c86c99f4391c235814c977bda8d`。共享 main 在并行推进，本轮构建不读取共享未提交代码或暂存区。
- archive 完整 SHA256：`bc8d2f4988b7f975050c0e0293185547cae1694e6e8c0258c23eac753c44be1e`。
- Go：`go1.27.3 darwin/arm64`，`GOTOOLCHAIN=local GOPROXY=off GOSUMDB=off GOTELEMETRY=off`；三个 `go build -buildvcs=false` 均 exit0。
- 操作 bootstrap 原样复用上一轮 `cmd/r4-inspect/main.go`：SHA256 `0c3402226a1dd40e4ff52e68f34e60a227394226a50e57482c2aa01b0a87a040`，没有复制迁移、解析或路由算法；只委托生产 `sqliteaccount.Open` / Store.Restore / Replace / `aihserver.New` / Serve。

| 构件 | SHA256 | 用途 |
| --- | --- | --- |
| 实际 `cmd/aih-server` | `aa21853b31f3670c891dbd841271a30e8bfff1f60584de673988ba3b9cfc368c` | 真实 CLI 系统 PATH 无 Node 的 HTTP 证据 |
| 原样 operational bootstrap | `759c5fa32a7b20dad1527fc96bc17448ca43c71f8ac773ce3e216c78a838adb0` | 生产库/Host 的 OS noexec/无网络证据 |
| bad-source bootstrap | `d151e23ea6023d3e53b8fda61969177c17abbb1fb5b581c16a7b8116ed824a38` | 仅私有 go build overlay 替换内嵌 JSON payloadHash 第一个 hex 字节；独立故障构件，**不是生产产物** |

构建命令：`go build -buildvcs=false -o <private>/binaries/aih-server ./cmd/aih-server`；bootstrap 同理构建 `./cmd/r4-inspect`；坏源另加 `-overlay <private>/overlay/build-overlay.json`。完整 Go build info、各源码完整 digest 见低敏 evidence。

## 4. 数据安全与真实输入

私有根：`/private/tmp/aih-r4-wildcard-firstread-20261118-TjmicL`（本轮独立新根，不复用旧 cleanup 许可）。根权限 0700，敏感数据只在 sensitive 子目录，私有 HOME/AIH_HOME_DIR/PATH/锁和临时端口，不复制共享锁 inode。

真实 `/Users/model/.ai_home/aih.db` 通过 SQLite URI `mode=ro`、query_only、显式读事务和 online backup 取得一致快照。OS 拒绝快照进程写真实 HOME。输入 generation43，legacy/canonical 各1条，legacy 无真实 non-wildcard。canonical 的 alias pattern 与 legacy 相同，但 target、targetProvider、enabled 不同，不把两个配置冒充同一业务状态。

- 权威快照：975486976 bytes；online backup 1.424776 秒。
- 完整 SHA256：`572ead40c00351dcc052ab7cc79ce60de134daa977d57563625711826029ca38`；操作后再次全文件 hash 相同。
- 两个 alias 表、meta、`account_credentials`、`compat_account_credentials` 的全行 HMAC 与同一输入读事务一致。只输出摘要，不输出 token/native auth/账号标识或原始业务行。
- 所有变体从该快照的私有 APFS clone 产生；仅改变 canonical 的存储状态（清空/代次），不造账号、模型或 alias，不改旧 alias 的字段/启用意图。
- 第一次 backup 实际完成，但该完成副本以普通 `mode=ro` 重开报 `unable to open database file`，保留此失败及副本。第二次完整重做 online backup，先保存输入摘要，关闭目的连接且确认无 WAL 后仅对**静止私有快照**用 `mode=ro&immutable=1` 读验。真实在线库从未用 immutable，未忽略 live WAL；不抹掉第一次失败。

## 5. 11 项生产 Store 操作矩阵

以下入口是原样 bootstrap 委托真实生产 Store，OS 禁网络、fork、foreign exec，拒绝读取真实 HOME/仓库/.codex；PATH 无 Node。敏感 stdout/stderr 私存，表比较为全行 HMAC。

| 编号 / 真实操作 | 实际结果 | 数据边界 |
| --- | --- | --- |
| 01 canonical 非空保护 | exit0，alias1/display0/gen43 | 三 alias 表不变 |
| 02 bad-source 构件读 canonical | exit0，alias1/display0/gen43 | 不访问首迁展示源；三表不变 |
| 03 真实 wildcard、canonical0/gen0 首迁 | exit0，alias1/display10/gen1 | legacy 全行不变，canonical 与代次一次提交 |
| 04 新进程重启 | exit0，alias1/display10/gen1 | 三表/记录摘要不变，不再次推进代次 |
| 05 生产 Replace 显式清空 | exit0，alias0/display0/gen2 | legacy 不变，合法 tombstone |
| 06 清空后新进程重启 | exit0，alias0/display0/gen2 | 三表不变，不复活 |
| 07 清空后 bad-source 构件重启 | exit0，alias0/display0/gen2 | tombstone 不读旧源，三表不变 |
| 08 坏 payload 首迁 | exit1，`model_alias_legacy_display_source_required: alias_display_source_invalid: payload checksum mismatch` | canonical0/gen0；三 alias 表全同 |
| 09 同一失败副本换 good 构件 | exit0，alias1/display10/gen1 | source 错误不永久推进代次 |
| 10 Open 完成后真 writer 持锁 | 持有私有 `BEGIN IMMEDIATE` 5.084708秒，exit1 / SQLITE_BUSY | 确认在 alias BEGIN 阶段失败；canonical0/gen0、三表全同 |
| 11 持锁者 rollback/退出后重试 | exit0，alias1/display10/gen1 | 真实旧行首迁，legacy 不变 |

坏源失败在 insert 前；持锁失败在 BEGIN 阶段。**没有把它们说成 insert 后故障回滚，也没有两进程同时越过 precheck 的证明。**

## 6. 真实 CLI/HTTP 与严格 Host 两级证据

本轮仅在私有 HOME 的独立进程运行；随机本地管理密钥仅用于隔离鉴权，不是伪造上游 token/account fixture。没有 `--supervise-node`、frontdoor 或 NodeBaseURL，未使用第一方 Node 宿主/RPC。

| 编号 | 入口/隔离 | 实际 HTTP / 退出 |
| --- | --- | --- |
| 12 当前 canonical（PID 91743） | 实际 production CLI；PATH=/usr/bin:/bin:/usr/sbin:/sbin，无可执行 Node | GET aliases 三轮200，gen/applied43/43、accepted1；models200/232；health200；exit0；三 alias 表不变 |
| 13 真实旧 wildcard/gen0（PID 91761） | 同一实际 CLI，真实 disabled 旧 alias | GET aliases 三轮200，gen/applied1/1、accepted0；数据库 display10；models200/232；health200；exit0；legacy 不变 |
| 14 真实旧 wildcard/gen0（PID 91779） | production aihserver.New/Serve，OS 禁 fork/foreignexec/出站网络；仅 loopback bind/inbound | GET aliases 三轮200，gen/applied1/1、accepted0；数据库 display10；models200/232；health200；exit0；legacy 不变 |

每一进程保存三次实际 PID/PPID/可执行路径子树采样，未见 Node。严格 Host 的 OS 规则提供更强约束；CLI 只声称本次受控 PATH/配置/子树观察，不夸大为 OS 永久禁止任意 Node。

实际 `/bin/ps` 在 Seatbelt 即使只禁止真实 HOME 写入仍 EPERM（exit71），失败原样留存。所以未伪造 ps、未改产品 identity、未去 setuid 配合验收，也不把 CLI 描述成 strict OS noexec。

## 7. 原库对比、资源与 evidence

2026-11-18 02:59 复核：真实源三 alias 表及两 credentials 表全行 HMAC 均与02:50输入读事务相同；只在该窗口/这些表层面成立，**不宣称整个共享业务库永远不变或证明其他会话没有写入**。本轮此前旧 checkpoint 的 credentials 变化未归因边界仍成立，不能用本轮相等倒推旧变化原因。

所有本轮 Go 子进程已退出；`lsof -nP +D <private-root>` exit1/无 stdout，未观察到私有打开句柄。低敏 `process-and-handle-check.json` 记录实际时点，不替未来操作提供永久保证。

低敏 evidence 主要为：`build-source.json`、`binaries.json`、三个 build info、`snapshot.json`、`store-matrix.json`、`http-matrix.json`、`original-source-after.json`、`real-alias-route-input-summary.json`、`residual-writer-ledger.json`、`process-and-handle-check.json`。37项低敏文件索引 `evidence/evidence-index.json` 的完整 SHA256：`d2a590c01a1565f98ba16aef8cf8a9377a9be5e8aef5b66a2714493b469494bf`。原始 DB/sidecar/原日志/操作密钥留在新根，**尚未声称清理**；待后续已批准工程是否复用输入明确后，逐项 manifest、进程/句柄/realpath 复核，再申请本新根的独立 cleanup 许可。绝不沿用旧根许可或宽泛删根。

## 8. 未闭项与交付状态

1. `application/modelalias/service.go` 的 Create/ReplaceGroup 不填 displayModels，Update 改 pattern 仍可能沿用旧名单，Store/SQLite 没有自动补齐。当前 canonical gen43/display0 是真实观察，与静态缺口一致，但**未追溯它由谁/哪条请求造成**。不能借首迁覆盖正代次配置。
2. 下一工程建议：应用层展示来源端口 + 现有 Go aliasdisplay 的 Host 注入 + CRUD 写前派生 + Context 传至原子 Save；等待监督精确4path确认，避让 composition 的 peer hunk。本轮文档不是这部分代码交付。
3. Node 业务写者仍为 `lib/server/go-account-sync.js:888` setEnabled → PATCH accounts、`:922` setProviderDefault → PUT account-defaults、`:625` setModelPolicy → PATCH account models；不是已经退役的只读 proxy，未改动/认领该更大策略域。
4. 只有一个真实 wildcard pattern，不能伪造另一 pattern、non-wildcard 或启用旧 alias。缺真实改 pattern/非 wildcard 正向与 insert 后中途 rollback 样本仍明确保留。
5. 独立文档审查/显式 pathspec checkpoint 在真正完成前保持 pending；review 结论须绑定本文件的确切 SHA，不能沿用旧 review。新增 commit/push、loaded、部署、公开调用方迁移与 Node 退役必须分开报告。**本轮仅当前 Go core 有限验收，不是整个 R4 或项目迁移完成。**


## 9. 后续 Go CRUD 工程（pm-72220794，新阶段；不覆盖前述零源码验收时点）

以下是首迁验收后的**新增原 R4 窄工程**，不把前107行第一阶段的“生产零修改”挪为本工程结论；仍只有本份新增验收文档。应用层3path已实际改动，Host来源装配在私有 archive overlay 通过；共享 composition 仍受 R6 物理 writer 顺序锁，未释放前不写/代 stage。部署、loaded、公开 Node 退役未授权。

### 工程边界与固定 source

- 新 `application/modelalias/display_source.go` 定义应用内向来源端口，源错/nil/cancel 显式拒绝，成功空结果保留既有 Node 合同，拷贝来源名单；应用不导入 adapter。
- `service.go` 的 Create/Update/ReplaceGroup 在整组持久化前统一派生 display；每次从新 pattern 重算，非 wildcard 明确清旧名单，不把 pattern 旧展示沿用。
- `store.go` 的 ReplaceContext 传递原请求 ctx 到已有事务 Save，保留 persist-before-publish。旧 Replace 兼容 Background。没有扩 Delete、target、策略/OAuth 或重写 repository。
- composition 仅在 aliasService 装配后注入 `aliasdisplay.List(pattern,time.Now().UTC())`，通过应用端口调用同一现有 Go SDK权威；无第二业务或 Node 回退。
- 原始构建基点 `441a527c37f86e26501ea63598a8d2f379fe6641`、archive SHA `cbd8d494217cb4052664e811664a3df3c1e5f11ad1cf59bd12f4a67251ff3c76`。源3SHA：`display_source.go=5282e973ac88d8244de82b53448dc8b083cbea58d558767174242a5da51054d0`；`service.go=d45d03122894598c1c707727b4b442e76c6575a3a7463e9efb5dd968c3da5b36`；`store.go=9f8873edad5549a045cfa9ddfe21fd1f15a6f34c68e1831e3e8cbc22e15428b4`。私有 composition overlay SHA `0ecd1de02875bb798655b2b50189b33d56e58ed9c5db2f4686d037ac934e4ee2`（不等于已落共享production文件）。
- 独立静态 source review `pm-832a88ca` 只绑定这3SHA及该 overlay；PASS 不替代 runtime/整个R4或最终装配 blob 审核。

### 真实公开 Go HTTP 操作

全部操作是新私有 HOME 内的真实 production aihserver.New/Serve，OS 禁 foreignexec/出站网，无 Node host/RPC。输入只重放该在线快照已有 canonical 的原业务配置（alias/target/provider/targetProvider/priority/enabled/description），不造新 pattern、模型或账号。Create/ReplaceGroup的新 id 是产品自身生成，原输入私存，不进文档。

| 真实操作 | 实际结果 | 原子边界 |
| --- | --- | --- |
| 原记录 Update，同一真实配置 | HTTP200，gen43→44，display0→10 | 原 legacy 不变 |
| 先 Delete，再 Create 同一真实配置 | HTTP200，gen45→46，display10 | 不造数据，原 legacy 不变 |
| ReplaceGroup 同一真实配置/被替换 id | HTTP200，removed1，gen47/display10 | 整组替换，旧legacy不变 |
| 真 private BEGIN IMMEDIATE 持锁 | 5.093183s，Update HTTP500 | 三alias表/内存摘要均不变；释放后可写 |
| 完整 PUT 发送后0.35s关闭 client，再0.35s释放writer | 新实现不推进代次；DB/内存不变 | 未 instrument 服务端ctx到达具体阶段，不夸大为所有取消竞态证明 |
| 相同门禁/原未改 binary 反证 | 已关闭的client请求仍把gen43推进44 | 原构件SHA `759c5fa32a7b20dad1527fc96bc17448ca43c71f8ac773ce3e216c78a838adb0`；不是 mock |
| 取消后正常 Update 重试 | HTTP200，gen48/display10 | 系统恢复可写 |
| 新进程重启 | gen/applied48/48，accepted1、display10；原业务字段全相等 | 持久化与内存恢复一致 |
| bad-source 正代次启动后 Update | HTTP500 / model_aliases_failed | 三表/内存均不变 |
| 同 bad-source ReplaceGroup | HTTP500 | 不删旧组，不留下半组，三表/内存不变 |
| Delete 后 bad-source Create 原真实配置 | HTTP500 | 保持已删除状态，三表/内存不变，不复活 |

严格 Host 各进程真实 exit0。另实际 cmd/aih-server 在无Node可执行PATH重启读取：WebUI aliases GET200显示10，management aliases GET200 gen/applied48/48、accepted1，health200，exit0、三alias表不变。命令行级别仍不冒称 OS noexec。

- 新CLI二进制 SHA `2f4ff75acb6b68b4a867c3159c012f04461a921243b526938028f721ba6c1144`。
- operational host SHA `4ed3e638dd71da81dc4adb3cb72a9bd7ea68831044db0fdc1edec33dceac9f6f`。
- 私有 bad-source overlay host SHA `6d2a9c901f97183e23daf8bb58bc12a80e80f2edc6ea69cdcacde202ea810baa`；仅故障验收用，不是生产构件。
- 公开CRUD矩阵实际完成时点2026-11-18 03:07:23（+08:00），实际CLI回读03:07:56。早先peer pm-cad9074a的“03:12”是笔误，已单独向监督更正；结果、source与binary摘要不变。
- 低敏 `crud/evidence/http-crud-matrix.json`、`14-actual-production-cli-restart-readback.json`、全部 source/buildinfo。baseline进程条目的通用source文字曾误写成overlay来源，后按真实binarySHA显式provenanceTextCorrection更正为未改基点；不把旧baseline说成新构件。

### 本工程保留的缺口

- 只有一个真实 wildcard pattern；合法更换成另一 pattern、wildcard→nonwildcard清旧名单、nonwildcard正向与合法空展开结果，没有真实业务样本。不制造fixture，所以这些分支目前只有代码/静态review，不能称真实操作全矩阵等价。
- 故障证明是源派生失败、BEGIN/DELETE持锁、客户端取消门禁；没有 insert之后中途故障回滚或所有取消竞态的证明。
- Node enabled/default/model-policy 定时写者仍独立OPEN，不因本工程关闭；没有请求外部上游 inference，无计费/端到端执行验收。
- 共享 composition 写入/最终sourcehash/独立review/精确checkpoint/清理许可仍应由后续实际证据更新，不提前填写完成。


### 最终装配、重新校准和本人 checkpoint（覆盖前述工程 pending 状态）

- 首轮107行已独立审查 `pm-66c3e169`（doc SHA `a7a72faeaea18b5414298161eabdb9d809dee9b6f827c5511dcf3b2ec67d8452`），2026-11-18 03:25 本人仅该doc显式 pathspec 提交 `23a4c95b8dee2b5b2ef871f1546d29dd6aefecb1`；原内容保留不改，不将该review自动移给追加内容。
- R6 通过 `pm-ebcbb7bb` 正式释放 composition 的新HEAD `5052144db6c6b6d74bd0b7775d09c3cea844b479`；监督 `pm-037b1397`/`pm-6e854965` 批准后，本人只物理插入 aliasdisplay import 与 SetDisplaySource closure。共享 ContextWindows peer8+/7- 原样保留，不代提交，不再把私人 overlay 称为尚未落盘。
- 最终4path source审查 `pm-820ae824`：应用3SHA未变，**提交候选 composition SHA `aedf3aa8150b4a3b26fcc81e4c73185128383a0795a7125244801a3132faef28`**；基于5052144仅本人2hunk，不含共享文件另一个 ContextWindows hunk。静态PASS不替代runtime。
- 重新用不可变5052144 archive（完整SHA `7dc7128efce51d807a171731dc9ef218326383de7202e0c560e9d85a1ba8edc1`）加最终本人4源构建，正常构件不再用composition overlay；最终生产源逐byte等后来提交blob。`go build`三个构件与 `go vet ./application/modelalias ./internal/host/aihserver` 均exit0，gofmt/空白检查通过。普通非git archive里一条git diff检查因无.git失败，已在static-verification记录并另用格式/空白检查，不用失败命令冒充通过。
- 最终新二进制：CLI `36a3777ff24ed0e9f86de83cc6b5ef4012cf33b6f6d20adac4ee6977fe973f9a`；严格Host `b4f731a5134f2880cafc74fd77871e1fe2da6c29fa55bee320b77f6e39e3e72a`；坏payload独立Host `7e3ef74d3e35168f3431bc49a6cd105731434e96351735387bb049e4a5b46aa0`。不把上一轮private composition overlay的runtime挪给该新source。
- 最终构件完整重跑公开Go CRUD、取消/原binary对照、源错误、重启、实际CLI。结果一致：Update gen44/display10，原配置Create gen46/display10，ReplaceGroup gen47/display10，取消后无写且正常重试gen48；坏源3入口各HTTP500、DB/内存不变；最终持锁5.091589秒HTTP500且无写。新进程与实际CLI重启均gen/applied48/48、accepted1/display10、exit0。精确操作仍用真实原配置，不造另一个pattern；严格Host无exec/网络与CLI系统PATH两等级分列。
- 本人源码checkpoint：`34e7dc196aa1d32c61501ee4dfa298693daa659c`，**仅获准4production path +83/-6**，无测试/账号/fixture，composition仅本人+7行；source blob与最终runtime构件来源4SHA全等。使用已批准的普通私有commit-view + `GIT_WORK_TREE` + 一次 `GIT_INDEX_FILE` 和显式4path提交，不创建git branch/worktree，提交前后核cached/stat/show。
- 两次提交前后共享index**文件字节与条目完全相等**：bytes SHA `fb2b7a5be55f0de911b635726a8bf57c494f3b9ecbbf00ecd517497f7396e0da`，entries SHA `d6b45a04ecfe39e8cbcfad4b0625c13701ea55aa6a80695d8a32bb6391ff656c`。cached stat随HEAD前进从35变43是旧主索引相对新HEAD显现的反向差异，不是本会话stage/撤回。依监督许可不强行sync主index；他人必须仍按显式pathspec，不能整体提交这些旧blob。
- 本轮03:25时点lsof无私有句柄、私有Go全部退出。**03:35:31最终真实源复核：三alias表HMAC仍与02:50相等，但两credentials表HMAC已经变化，未归因**。03:18前相等的窗口观察保留，但不能延伸成全程credentials不变，也不能归因其他会话/本轮私有操作。OS只读快照与真实HOME写禁令仍有记录；不宣称整个业务库不变。
- 最终低敏`final/evidence/http-final-matrix.json`、`14-actual-production-cli-restart-readback.json`、`source-commit-receipt.json`、`original-source-after-final.json`和索引（36项，SHA `4f50e5546bd11905f7d87d419526449f523af65d1db2d2a26e6ee78052beeea9`）保存源/构件/进程/错误/锁全部边界；继承脚本中的generic provenance文字已按实际binary/source显式纠正，非抹旧失败。
- 新根逐realpath/祖先非symlink清理清单 `final/evidence/sensitive-final-cleanup-manifest.json`：196项，完整SHA `b2961b174521387e5181e655ef25c028ab96686f40c8104390452895a97c417e`；仅本次自建DB/sidecar/私有raw输入/日志/keys，保留构件/source/低敏evidence/compiler缓存和全部私有lock inode、根。**目前尚未获得本新root独立删除许可、未删任何项**，不沿用旧R4/R5许可；后续独立清理回执才可更新这一状态。
- 源码commit完成不等于push/loaded/部署完成。本追加内容仍待确切新SHA独立文档审查和本人doc后续checkpoint；没有共享重启、公开调用方切换、上游推理请求或全R4/Node退役放行。


## 10. 已提交工程的真实改 pattern / concrete 补证与独立旧根清理

本节是2026-11-18 03:39之后新增实证，保留前170行当时的 pending/缺样本原文，不把新结论倒签给旧review。

- 170行终稿独立 `pm-44537f83` 为 PASS_WITH_OPEN_LIMITS，绑定 SHA `3f3e07c605947f1fa543b3724d98d86ba9c757f453a14d28478eea2b52dca2d9`、源码 `34e7dc196aa1d32c61501ee4dfa298693daa659c`、36项final index；本人 `2446378e68ad458458495f08fbda561e193fa160` 仅该doc追加63行，显式pathspec，非amend。该review不自动背书本节。
- **旧本轮私有根** `/private/tmp/aih-r4-wildcard-firstread-20261118-TjmicL` 已由监督新独立 `pm-f3492248` 授权清理196清单叶项（manifest SHA `b2961b174521387e5181e655ef25c028ab96686f40c8104390452895a97c417e`）。03:39:21执行前重新查全部自有Go退出/lsof无句柄、每项realpath与全部祖先无symlink、inode/dev/uid/nlink1/全SHA；随后仅逐叶unlink196项。root/source/archive/binary/evidence/review/compiler缓存与9个私有锁inode全部保留，未动共享路径。不声称安全擦除。完整receipt `final/evidence/sensitive-cleanup-receipt.json` SHA `562c3cda7c578db4c27f5a5f0d6771c47877e360914b5b473f4e7cb95fb323e0`，preflight及原manifest保留。

### 权威目录下的真实私有配置，不是伪造fixture

监督 `pm-75740f79` 明确批准用同一真实 provider/target 的私有配置，通过正式公开Go CRUD把 wildcard 改为现有SDK/catalog可核实的另一个真实family pattern，再改为真实concrete model id；不伪造provider/model/token/响应，不写live。此次**源码新增0**，复用上述已审已提交构件，不重跑旧锁/源错/取消矩阵。

新根 `/private/tmp/aih-r4-realpatterns-20261118-eGi7eZ` 与旧根授权独立。新真实canonical `mode=ro`、query_only、读事务/online backup，OS禁止真实HOME写入；snapshot975486976B，完整SHA `41ba50e6bb1550a47e6fea7d289a7a36536ded04f53d39839a6e3ff19daf6138`。构件仍是严格Host SHA `b4f731a5134f2880cafc74fd77871e1fe2da6c29fa55bee320b77f6e39e3e72a`，source `34e7dc196`；源码/构件来源原根保留且新根有provenance引用，不把共享main后续CLIhook或其它改动混进构件。

权威来源仍SDK0.0.109 / sourceHash `80c88099d3b27408ac89bce5e7bd10a84e3c38215c9c5165a6a128d24026bab6`、内嵌JSON SHA `f9b2f46084b28c8c203d016a590073f6ba371042954968296c9c33d93b27bed4`。选取SDK既有row `claude-sonnet-4-6`、family `claude-sonnet`，并确认该concrete id**实际存在于本私有生产Go `/v1/models` HTTP200列表**；于是pattern为 `claude-sonnet-*`，不同于原wildcard。生成器/过滤策略/产品响应未被篡改，实际选择及来源摘要见 `authority-selection.json`。同真实目标/provider/enabled保持，不接外部推理。

| 新实际公开Go操作 | HTTP / 持久化 / 重启结果 |
| --- | --- |
| PUT 原记录为 `claude-sonnet-*` | 200，gen/applied44/44、accepted1；display3为SDK实际 `claude-sonnet-5-5` / `claude-sonnet-5` / `claude-sonnet-4-6`，没有继承原10名单 |
| 新进程重启该pattern | 同3名字、gen44稳定；legacy摘要不变 |
| PUT 改concrete `claude-sonnet-4-6` | 200，gen/applied45/45、accepted1；display0，旧wildcard3名单清除 |
| 新进程重启concrete | display0/gen45稳定；不是仅内存清空 |
| PUT 恢复原真实wildcard业务字段 | 200，gen46/display10、accepted1；target/provider等全部保留 |
| ReplaceGroup 为上述真实family pattern | 200，gen47/display3、accepted1；产品自己生成id |
| Delete后Create上述真实concrete | 200，gen49/display0、accepted1；无新模型/账号fixture |
| PUT再次恢复原业务配置，再新进程重启 | gen50/display10、原业务7字段全相等；legacy不变 |

4个私有严格Host进程实际exit0，OS禁foreignexec/出站网，无Node host/RPC，保存真PID/PPID与进程检查。新根03:42:16输入/结束对比三alias表+两credentials表HMAC均相等，**只限新根这一输入窗口，不推翻旧根03:35 credentials变化未归因**。源3alias表从未作共享写；变更全在私有目的DB通过正式Go HTTP完成。

低敏9步矩阵 `evidence/real-pattern-matrix.json`、真实权威选取、4进程退出、source-after、snapshot/provenance等24文件索引SHA `9c32f38a93ce3598974271971cf775f841448a3956576d9c4a54002463ce4ce0`。新根清单40个敏感叶项 `evidence/sensitive-final-cleanup-manifest.json` SHA `dc9c9c3c34447c8ee3fcaae272872684a1f4cdfd028e7bff7e7b903b38e245ec`；03:42时点Go已退出/lsof为空。**新根这40项尚待独立cleanup许可，不复用旧根196许可**，未声称已经删除；保留源码/二进制/摘要/私有锁inode和root。

本补证关闭“已提交Go CRUD没有真实改pattern与wildcard→concrete清旧名单/重启证据”的窄缺口；**不补造non-wildcard legacy首迁记录，不声称insert之后故障回滚、所有取消竞态、合法空wildcard来源或上游推理成功**。Node enabled/default/model-policy定时写者仍OPEN；未做共享loaded/重启/部署/Node服务退役。Git远端验证因默认本地SSH代理关闭，以及临时绕代理直连443/22超时而未成功，未修改SSH配置，未force push；source/doc本地checkpoint与push状态明确分列。后续本节须独立新docSHAreview和本人doc-only提交。


### 独立review计数修正与新40项清理执行

- `pm-f5e26081` 已逐项核24/24证据及权威真实选择/9操作，但指出上文host计数错误：实际只有 initial-config/restart-pattern/restart-concrete/final-restore **4个PID**（96475/96484/96486/96509），没有第五进程。本轮只将该“5个”改单字为“4个”，不重跑/不回造第五日志，不改变真实矩阵；此前peer回执“五host”同属口误，以这4份实际PID/exit0记录为准。前170行保持原字节，新段中此处更正获独立review提醒，不沿用错误计数。
- 新根40清单获监督**独立**`pm-b4ef37c4`许可后，于2026-11-18 03:44:46先保存低敏来源/权威/全SHA/HMAC/9操作/进程证据，再即时重核全部自有Go退出/lsof无句柄，每叶realpath/所有祖先非symlink/inode/dev/uid/nlink1/完整SHA精确匹配。仅unlink已批准40项，逻辑975766960B，manifest全叶不存在；新根/root/binary/SDK/source来源/evidence和1个private锁inode保留，不碰共享路径，不声称安全擦除。
- 新根低敏 `evidence/sensitive-cleanup-receipt.json` 完整SHA `01400ce8bc21951ea312ef12a75a5baad720e20757a9a8a6cbe6f5444d476f9a`；cleanup-preflight与原40清单保留。上文24项index继续冻结，cleanup receipt是额外新文件，不把旧index悄然覆盖。旧root196清单/许可/receipt与新40清单严格分开。
- 本节修正与cleanup事实使上文“新40仍待批准”的历史状态过期；本次确已获准并完成，不把未读queue当许可。该新doc SHA须最终独立复核后本人显式doc-only checkpoint；源码无增量、composition已交还总控，下一Node三写者只读方案不等于已获工程scope。
