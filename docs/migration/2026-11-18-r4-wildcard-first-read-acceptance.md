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
