# 模型别名所有权：从 Node 迁到 Go

日期：2026-11-06
状态：方案（未实施）

## 1. 现状：谁是 owner

- **Node 是唯一 owner**：别名存在 Node 自己的 SQLite（lib/server/model-alias-store.js:70 的
  getModelAliasDbPath），增删改查、启停、通配展开都在 Node
  （lib/server/webui-model-alias-routes.js，309 行 / 6 类路由）。
- **Go 只是读者**：modelaliasapi 只有 GET/PUT，PUT 是 Node 推送的**整体投影**
  （internal/transport/http/modelaliasapi/handler.go:19-23）；application/modelalias.Store
  是内存快照（Replace/Snapshot/Generation），进程重启后靠 Node 再推一次。
- **路由编译**：Go 在目录构建时把投影编译成 alias 规则（inferencecatalog）。

结论：现在没有任何一方可以单独下线。Node 挂了 → 别名丢失；Go 重启 → 依赖 Node 推送。

## 2. 为什么不能「直接把 CRUD 搬过去」

WebUI 的 6 类路由里有三件 Node 独有能力：

1. **通配展开**：alias 以 * 结尾时，用 models.dev 快照算出 displayModels
   （lib/server/go-core-host.js:252-254）。Go 已有自己的 models.dev 索引
   （internal/adapters/modelmetadata/modelsdev），可以搬，但要先证明两边快照同版。
2. **generation 共识**：Node 记录 Go 已接受的代次（acceptedAliasIds），用于判断
   「推送是否生效」。owner 换人后这个握手方向要反过来。
3. **与账号/目录的联动**：别名变更后触发目录重建与路由刷新，现在由 Node 编排。

## 3. 三个切片

### A. Go 拥有持久化与 CRUD（不改任何现有行为）

进度（2026-11-06）：**存储 + 接线已完成**。
- schema v22：model_alias（带 position 保序）+ model_alias_meta（generation）。
- 仓储端口 modelalias.Repository（Load/Save），sqliteaccount 实现；Store 有仓储时
  先落库再发布内存，代次用仓储返回值（重启不从头计数）。
- Node 每次 PUT 投影都会落库；Go 启动时 Restore 从库恢复，不再依赖 Node 再推一次。
- 真机演练：用生产 aih.db 的**副本**跑 v21→v22，43 个账号原样保留、新表为空
  （AIH_REAL_DB=... go test -run TestUpgradeRealDatabaseCopy）。
- **真机已上线验证（2026-11-06）**：重建并重启 Go core 后，`user_version=22`、43 个账号
  原样保留，`model_alias` 里落下 2 条 Node 推送的别名（id 8 位十六进制、position 0/1、
  enabled 0/1 与 Node 一致）——推送 → 落库 → 保序整条链路在生产库上跑通。
CRUD 用例已完成：Service 的 Create/Update/Delete/SetEnabled，同作用域重名拒绝
（跨作用域允许同名），未知 Provider 归一到 all，全部走「读集合 → 改一条 → 整体替换」，
复用同一套校验与代次推进。
WebUI 契约接口已完成：Go 侧 /v1/management/webui/model-aliases（GET 列表 / POST 新建 /
PUT 更新 / DELETE 删除 / POST {id}/enabled 启停），错误映射 400/404/409，空列表返回 []
而不是 null。已挂进 Go 路由，用管理密钥可直接调用。
影子对账已就位：WebUI 列表路由在返回 Node 数据后，异步拉 Go 的副本做比较
（missing / extra / changed，按 (alias, provider) 对齐），结果交给可选的
onAliasShadowResult 观察者；不 await、不改变响应、Go 不可用时静默跳过。
目标候选已完成：Go 的 `/targets` 从当前已发布的路由目录按 Provider 聚合（去重 + 升序），
真机返回 8 个 Provider（claude 2 / cline 16 / codebuddy 26 / codex 18 / kiro 5 …）。
目录尚未构建时返回 503 而不是空表，让前端能区分「暂时没有」与「还没就绪」。

**切片 C 已实现（2026-11-06）**：Go Core 可用时，别名的列表与五个写操作全部走
lib/server/alias-go-owner.js（Node 只维护读投影，写成功后从 Go 拉一次列表写回本地库）；
/targets 仍由 Node 计算（基于能力索引，覆盖比 Go 的路由目录更广）。
翻转条件是「Go Core 已启用」而不是开关：写入口只有一份，Go 不可用时写请求 503、
读走本地投影（最后一次一致的数据），不会退回翻转前的旧事实。
**注意**：Node 进程重启后生效；回滚方式 = 停用 Go Core（写入会 503，需同步恢复 Node 写路径）。
剩余：真机六操作验收（重启 Node 后）与删除 Node 侧 store。

### C 的可执行清单（客户端已就绪）

1. Node 宿主已提供 `createModelAlias / updateModelAlias / deleteModelAlias /
   setModelAliasEnabled / replaceModelAliases`（门面已登记），路由翻转时直接调用。
2. 翻转顺序必须是：**先停 Node 的重推**，再切写路径。
   `notifyGoCoreProjection(ctx, 'modelAliases')` 是整体推送，切完后它会用 Node 的旧副本
   覆盖 Go 的新写入——真机上已经观察到探针别名被重启后的推送冲掉。
3. 停推之后，Node 的 state 改为「写完从 Go 拉一次列表」维持读投影；启动时同样从 Go 读。
4. Go 不可用时写请求返回 503，不做本地写（单写者原则）。
5. 验收：WebUI 六个操作逐个真机验证；重启 Node 后别名不丢；
   `git grep "notifyGoCoreProjection(ctx, 'modelAliases')"` 为空。

- 新增 internal/adapters/accounts/sqliteaccount/model_alias_store.go：在 aih.db 建表
  （model_alias：id/alias/target/provider/target_provider/priority/enabled/description/updated_at_ms），
  实现 List/Create/Update/Delete/Replace，并维护单调递增 generation。
- application/modelalias 从「内存快照」升级为「存储端口 + 快照缓存」：
  Replace 改成写库并 bump generation；新增 Create/Update/Delete 用例。
- 新的 WebUI 契约接口（Go 侧）：/v0/webui/model-aliases 系列，形状与现有 Node 路由一致
  （camelCase），由 Node 代理过来。**此时 Node 仍是 owner**，接口先只读灰度。
- 验收：Go 的 CRUD 与 Node 的存储双向对账脚本输出一致；Go 单测覆盖 id 生成、
  优先级排序、启停、替换目标。

### B. 双读写 + 漂移检测

取证工具（已完成）：`scripts/compare-model-aliases.js` 直接比两张表（不依赖 UI 访问），
退出码 0/2，可作为翻转闸门；真机当前 Node 2 条 / Go 2 条，aliases_in_sync。
- Node 每次写别名时同时 PUT 给 Go（复用现有投影推送）；Go 每次写也回推 Node。
- 加漂移检查：比较两边 (alias, target, enabled, priority) 集合，不一致就告警并以 Go
  为准重推。跑一晚无漂移才进入 C。
- 验收：构造并发写（Node 改、Go 改），30 秒内两边收敛；漂移计数为 0。

### C. 所有权翻转
- manifest 不改（WebUI 属于 node.webui_and_session_surface），但把
  webui-model-alias-routes.js 的实现换成「转发 Go + 契约映射」，删除本地 store 与
  通配展开（改由 Go 用同版 models.dev 快照计算）。
- Go 启动时不再等待 Node 推送，自己从库加载；Node 侧改为只读投影（保留 5 分钟缓存）。
- 验收：停掉 Node 后别名仍可读可写（走 Go 管理端口）；WebUI 六个操作逐个真机验证；
  git grep model-alias-store 只剩测试与迁移脚本。

## 4. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 两边 models.dev 版本不同 → 通配展开结果不同 | 切片 A 先跑 npm run models:check 对齐版本，并把版本写进快照 |
| generation 方向反转导致「推送成功但未生效」静默 | 切 C 前保留旧握手一个版本，双写阶段用漂移检测兜底 |
| WebUI 前端契约变化 | 契约映射集中在纯函数模块（同 quota-stats-go-contract.js 的做法），逐字段断言 |
| 别名影响路由编译 → 改错会打挂流量 | 切片 A/B 全程不动生产 owner；C 之前用 canary 灰度一个账号 |

## 5. 与既有约定的一致性

- 不新增 AIH_* 环境变量；开关走命令行/配置。
- 上游枚举（Provider、模型族）不写白名单，按规则归一后放行。
- 删除前先有替代路径：C 完成后才删 Node 的 store 与展开逻辑。

## 6. 当前状态与续做清单（2026-11-06 收尾）

已完成并在真机验证过的：Go 侧 schema v22/v23（含 display_models_json）、仓储与启动恢复、
CRUD 用例与格式/目标校验、WebUI 契约接口（列表/新建/更新/删除/启停/整组替换/目标候选）、
写入后触发目录重建；Node 侧影子对账、双库对账脚本、写入口切换、停推守卫。

激活方式（都需要重启 Node 进程，我没在运行中的服务上操作）：
1. 重启 aih server —— 写入口切换 + 停推守卫生效；
2. 之后跑 node scripts/compare-model-aliases.js，应仍为 aliases_in_sync；
3. WebUI 逐个点一遍新建/编辑/启停/删除，确认与翻转前一致。

回滚：停用 Go Core（写请求 503，读走 Node 本地投影）。

下一个大块（需要产品/运维决定）：给 Go 分配推理路由（AIH_GO_CORE_ROUTES），
让 usage_ledger 真正增长——这是 WebUI 用量/额度页切流的前置条件。
