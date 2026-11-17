# Legacy public management → Go direct acceptance

时间：2026-11-18 03:24 Asia/Shanghai。Owner：原监督 `01a1df63`。这是已落源码与隔离真实操作的窄门禁，不是全 R0/R6/R8 或 Node 退役完成。

## 工程与交付边界

- source：`901be7391648b7abdbd2eac3ec2e9ab56545368b`，唯一生产路径 `internal/host/aihserver/webui_management_ops_routes.go`，15+/2-。固定源码 SHA-256 `df213fe47122cf36ce1d6b997f4f23ffead4fa445841cd1d62378a3255f9e1cd`。
- push：本文写入时尚未为此 checkpoint 新取远端确认；后续单独回报实际 push/ls-remote，不以 tracking ref 代证。
- artifact：固定 archive + 唯一已审路由覆盖，见下；不等同于包含并行 Desktop/remote 提交的整仓新发布。
- loaded：只运行私有标准 Go CLI 与私有 production-host operational bootstrap；未替换标准 binary、未重启 9527。
- realaccept：标准 CLI 的精确公共路由/鉴权/动态 job；另列 OS 严格禁止 Node/fork/出站的真实 canonical 副本状态写入与 SSE。
- Node 停用/删除：本轮不删 Node management-router、plugins、CLI client 或共享宿主；其他真实 caller 尚有各自门禁。

## 为什么不是挂整棵 public 子树

原 Go 已有 canonical `/v1/management/webui/management/*` 和 browser `/v0/webui/management/*`，但历史 `/v0/management/*`（除 restart）仍落 Node fallback。真实调用者包括 `lib/cli/services/server/state-index-client.js`：四项写动作把请求发到 `/v0/management/state-index/*`，Node management-router 再转同一 Go handler。

本次由已有 canonical route 列表派生 **28 条精确、保留 method 的 public 别名**，沿用同一个 handler、鉴权、前缀正规化、job PathValue、state/SSE 服务；既有 public restart 保留且不重复注册。不新增根路径或 subtree catchall：插件实际 public 命名空间 `/v0/plugins/*` 仍是另一 owner 的真实遗留入口，不能用新的广泛 404 截断它，也不能据此宣布插件已 Go-only。独立 review 未发现 Important/Critical 问题，绑定上述源码 hash；它只审 source，不替代运行证据。

## 不可变输入与构件

- committed base：`bf992b3c20ab75ef44cc8fb0573d445eec7dec1e`。
- git archive SHA-256：`e360e76081e43c0a23b98d4fd9ee4663272d1513547eda1cbbd06994337f9770`；从 archive 解压后只覆盖唯一 owner path，无 shared dirty 源码混入。
- baseline 标准 `./cmd/aih-server`：`0d73558dc4de3fd0c9c074b890f0925f1636c67e021009513e97d7ceeab0fc0a`。
- candidate 标准 `./cmd/aih-server`：`3d0835e053c8e679772af808ecbe51c142026bb8042e6cfc311933a5259bfceb`。
- strict operational host：`e3e25996d538fda1f7f7a3594b3df99cc01964b35ea8bec448ac6c428faf1e3c`。
- 私有 bootstrap 源码：`07241c4516a77ccd58b933a5108e472cb647664bc3c0db9dd9deff59606c035c`，只调用未改动的 production `aihserver.New/Serve/Close`，不复制 handler/业务函数、不 mock、不构造账号或响应。
- 三次 `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 GOWORK=off go build -mod=readonly` 均 exit0；focused `go vet ./internal/host/aihserver ./internal/transport/http/webuimanagementapi` exit0。未新增测试用例/fixture/分支/worktree。

## 标准 Go CLI 实际路径（空私有 HOME/DB）

无 `--front-door`、`--supervise-node` 或 Node base 参数，管理密钥仅放私有进程环境，不记录正文。

| 真实操作 | 结果 |
| --- | --- |
| 未改 baseline public status / state-index upsert | 均 404；同 baseline canonical status 200 |
| candidate public status/metrics/accounts 与 usage stats/models/sessions/requests | 各 200 |
| 缺 Bearer、错 Bearer | 各 401，未因 loopback 绕过已配密钥 |
| 不支持的方法（POST status / GET upsert） | 404；没有执行 mutation |
| public state-index 坏 JSON | 400 |
| public usage dashboard query create / 动态 ID GET / DELETE | 202 / 200 / 200，真实异步 job，未伪造 jobId |
| canonical plugin inventory | 200；public plugin 在无 Node 候选下仍 404，不算插件迁移通过 |
| 标准 CLI 未配 management key | 启动 exit1，未监听；这是既有 options 安全门，不冒充 no-key loopback HTTP 验收 |
| 观察的各标准私有 CLI 结束 | 均 exit0；无共享服务操作 |

标准 CLI 此轮仅作短窗口 PID/PPID/完整 argv 采样，未观察 Node child **不等于 OS 证明零 Node**，更不挪用此前 terminal 94 秒验收中两个未分类 Node PID。保留完整私有 argv；分类不用可能截断的 `ps comm` 列。

## 真实 canonical 数据与严格 production host

原 canonical `aih.db` 与封存 `app-state.db` 均以 SQLite `mode=ro` + `query_only` + read transaction + online backup 得一致私有快照，quick_check=ok。用于实际 state 写入的是 **canonical aih.db**，不是因旧注释仍写 app-state 而另造第二库；两输入快照完整 SHA 在矩阵窗口结束（03:19:58）前后相同；该核查早于后续旧 client 汇总（03:21:39），不外推为覆盖后续所有操作。不宣称 live 全库/其他 owner 并发数据冻结。

- canonical input：975486976 bytes，SHA `561596b6eca3a34052a2cc6fd024f5fd3d684bc12ec2b427d67b447f9dfd3f22`；真实 accounts34、account_state32。
- sealed legacy input：914698240 bytes，SHA `f6afbcb244d1e4fcbc410d1170880e1d7445d3ff73913ec6c2f5f07ce4554862`，只用于来源/未变边界，不写回原库。
- 对已有真实 CodeBuddy account_state 行原字段重放；不新造账号/ref/pattern/token/业务样本。raw ref/显示数据只在受限私有根，低敏证据保存 ref hash。
- Seatbelt 禁 `process-fork`、绝对 Node exec、出站 network，以及真实 AIH 根/仓库读写。Node 绝对执行实际 EPERM exit71、真实 shell fork exit128，向已监听 private host 的出站连接失败；不是无监听造成的假绿。
- 这是 production host operational bootstrap，不含标准 macOS CLI identity publisher；不把它当标准 CLI OS-noexec。既有 `/bin/ps` 受限问题未扩改。

| 真实 public 操作 | DB/HTTP 结果 |
| --- | --- |
| upsert 原 canonical 行 | 200/updated=true，七个展示/状态字段与原值相同 |
| operational-status 改为相反真实状态 | 200，canonical SQL 读回实际变更 |
| runtime-state 清空并恢复原 base | 200，状态恢复；不宣称本轮封住其内部所有错误传播语义 |
| prune 保留 provider 所有真实 refs | 200/removed0 |
| private prune 缺该真实 ref | 200/removed1，SQL 行实际消失 |
| 再 upsert 完整原行 | 200，SQL 行恢复；只修改私有副本 |
| 私有 accounts/account_credentials/account_profiles 三表 | 本操作窗口 HMAC 前后完全相同；非 live 不变宣称 |
| public watch 与 canonical watch 同时订阅 | 各收到 connected + snapshot |
| public POST watch/snapshot | 202/broadcasted=true，两流都收到新 snapshot，复用同一 Go hub |
| 两 SSE disconnect 后普通 status | 200；host 自身退出0 |

### 真实旧客户端而非手造 fetch

单独启动**操作侧** Node client，调用 archive 内实际 `createStateIndexClient`，其 fetchImpl 只包原生 `fetch` 做响应观察，没有模拟 response/transport。upsert / setOperationalStatus / clearRuntimeState / pruneMissing 四次实际 `/v0/management/state-index/*` fetch 均 200，最后 canonical 原字段仍在。服务端使用同一生产 Go host 实现及 OS 禁 fork/Node/出站约束，但不是矩阵的同一进程：矩阵 PID56017，后续 client 验证 PID58912；均无 AIH Node server/backend。这条证据证明现有 Node CLI client 不再需要 **Node server 代理**，不冒充 client 自身已去 Node。caller/host 均正常退出0。

## 失败、清理与剩余门禁

首轮 driver 尝试未配密钥标准 CLI，在 options 校验 exit1；已保留 attempt1 结果及私有 log，没有放宽产品源。第二轮完整矩阵与单独旧 client 实跑完成。所有已观察自有 PID 的退出后核查为空；SSE 均关闭，未 kill/restart 共享服务或动 Edge/用户终端/草稿。敏感快照/私有 logs/key 尚保留在受限目录，未获单独许可前不做大范围删除；不将 chmod 等同安全擦除。

03:24 共享只读仍 Go `84956` → 第一方 Node `85251`，runtime/disk `9916c2222ab53916a694e9f9602fc30f9a6a9d591698278dc26dd9ee6951cbf1`，stamp binary hash匹配、source `d0f4cab51000f484768b145fdfad6aed8aa8df87`。仍以 `--front-door --supervise-node` 运行，本轮源码没有加载。stamp 匹配也不能替代完整构建闭包/批准或 Node 退出。

以下保持 OPEN：插件 public caller/JS host，Node CLI state client 本体，剩余 Node management consumers及旧代理的调用归零/删除，state/runtime 内部错误语义，tokenRefresh/401装配、usage_ledger→看板权威读模型、host观察/run收养/NodeOwner 与 TCP/UDP 合同，以及最终匹配构件批准/发布/真实业务 Node-off。短 SSE 共享 hub 验收不是90秒失活/背压/多 viewer 或 Edge 最终验收。

## 证据定位

- root：`/var/folders/nj/0mx5gymd41x8f64xcfm635440000gn/T/aih-management-go-alias-20261118-ifoq4qys`；pointer：`/tmp/aih-management-go-alias-latest-20261118.txt`。
- `evidence/build-manifest.json`、`snapshot-manifest.json`、`result.json`、`real-existing-state-client.json`。
- `evidence/attempt1-result.json`、`source-review.json`、`source-commit-receipt.json`、`post-run-pid-audit.json`、`shared-runtime-readonly.json`。
- raw 数据在本 root 的受限敏感/私有 runtime 目录，不提交凭据、token、原库或配置正文。


## 05:06 增量：Go 用量事实与管理投影同事务，退出该 Node 持久写者

工程源码 **`60b80f3214d3a4ec2b0a6272eb26afa94d186f79`**，10 生产路径、285增/33删；父版本 `549387601` 的 token/HTTP401 接线完整保留，物理 `composition.go` 的 peer ContextWindows hunk 未夹带。一次性私有 archive commit-view + 临时 index + 显式 pathspec，主索引原字节 SHA256 `3a7c9357…` 及全部 entry digest `925cc5b3…` 前后不变。没有同步/重置他人74项旧暂存差异。

旧必要链为 Go `usage_ledger` → 易失 event ring → Node 两秒 poll → `model_usage_records` → dashboard。现在 Go `AppendUsageRecordWithProjection` 在同一 SQLite transaction 插入事实、赋 `go-ledger:v1:<usage_id>`、投影同一事实并 commit；失败两边 rollback。既有价格/归属 normalizer 在事务前准备；canonical 的缓存/推理子集转换为管理表互斥列，总数不叠加。RequestID 仍空，不能伪造关联。现有 Node poll/shutdown pull **只通知、不再持久化**，旧 Go 能力缺失显式失败、不回落 Node writer；新 Go 对没有配套 `usage_projection=go-ledger-v1` 的旧客户端直接409，避免按 boot/seq 再写另一条记录。其余 Node 来源的记账没有冒删。

### 固定输入、构件与真正操作

- base `549387601872535d222d48eb0909961dabc33dad`；最终10路径 manifest SHA256 `88eafc387ce368435b0ac08b62268d422427099f7870d3e4bade914ae2ab76de`，逐路径已独立绑定，无 peer 未交 hunk。
- 最终私有标准 Go server SHA256 `c23f7d128f226d1af9751652899ef0062ff3b9aa7fa12d6f44564f5d29d1069e`，build、focused vet、3个 JS syntax 均 exit0。
- 输入是既有只读 online canonical snapshot，SHA256 `561596b6eca3a34052a2cc6fd024f5fd3d684bc12ec2b427d67b447f9dfd3f22`；未改 live DB，未造账号、token、usage fixture 或新的测试用例。
- 最终执行 `python3 -u <root>/run-real-integrated-complete.py`。私有标准 Go CLI 不带 front-door/supervise-node，PATH 无 node；并非 OS-noexec。真实静态 Claude 账号经 DeepSeek flash 返回 `USAGE_GO_LEDGER_OK`：**input40/output18/total58**，真实计算费用 `0.0000168`。ledger/projection 各新增1行，事件键 `go-ledger:v1:275991`，session 保留、RequestID空。
- 预先读 stats 后等既有5秒 cache TTL，public `/v0/management/usage/stats` 与 dashboard 均为 **58**；models/sessions 读200。requests200但仍筛掉空 RequestID，**不计该页面业务验收**。
- 实际 `createGoManagementClient.listAccountUsageEvents` → `createGoUsageEventFeed` 首拉1、次拉0、通知 callback1；poll及stop pull 后 ledger/projection 计数均不变。callback 是操作侧 collector，**不是实际 UI emitter 或 DOM 验收**。
- 同私有 home 重启后投影仍1行，stats响应 hash与58-token结果一致。自有 Go PID9862/10506 均 exit0；输入快照 SHA不变，未动9527。

### 严格端口反例、早期失败与保留边界

另以真实生产 Store/UsageStore exported ports + 现存真实 cache/reasoning fact 操作私有副本，空PATH、OS禁 network/fork/foreign exec：互斥输入245、输出645、cache读89088、写0、reasoning213、总90191；同事实重复投影不增长，冲突明确 `usage_ledger_projection_identity_conflict`，投影事实不匹配及预取消均使两表无新增。它是运行端口真操作，不是 HTTP/provider 端到端或产品自动历史回填。最终严格运行没有成功 ps 采样，不能声称该次进程树证据；前两次 sandbox 路径拼写失败完整保留。

最终集成前一次遗漏了已审 JS client query，真实客户端被409拒绝，未回写；更正为原审同字节 client 后才取得上面的通过。另一次 max_tokens40 被上游思考消耗只返回 `US`，driver 断言失败；raw限私有保留，未改产品，最终真实请求上限128后成功。最早 stats0 是既有5秒cache，不掩盖为从未失败。

这里只退出 **Go-source usage 的 Node 持久写者/通知丢失导致看板丢账依赖**。warmup 仍见 Node 工具与未分类 `(node)`，不报 whole-zero-Node；source_kind 与现有反向导入 skip 保持，但扫描器/其它 proxy 去重没有本轮端到端全验。3条现存非identity Node↔Go link（cline/opencode）归属差异尚未验，不能把已验 identity Claude 外推。ledgerID是事实标识，不是上游 attempt exactly-once。回写失败虽两表rollback，但成功推理仍可能未记账；没有发明 durable retry/backfill。通知 ring 重启不持久，既有通知语义未抬高。

独立 Galileo 原reviewer最终 **NO BLOCKING / SOURCE INTEGRATION APPROVE**，重新核10文件SHA并核低敏 operations/result/processes；其结论不代表 DB重放、实际UI/平台/正式发布。push、共享 loaded、用户正式 Node-off 和全量迁移均另列，**本节不授权发布/重启**。

证据 root pointer `/tmp/aih-usage-ledger-projection-latest-20261118.txt`。`evidence/integrated-source-manifest-final.json`、`integrated-final-complete/{operations,result,observed-processes}.json`、`port-operations.json`、`integrated-paired-client-correction.json`、`physical-land-receipt.json`、`commit-receipt.json`；低敏review回执 `final-independent-source-review.json`。所有私有敏感快照/log/key继续受限保存，未做未经单独批准的清理。

交付补记（05:08）：命令级 SSH-W relay `git push origin main` exit0，fresh `ls-remote origin refs/heads/main` 为 `5cb6476f7e4a9020787b5f6c71bc56f7f24ea4d2`；逐祖先验证包含 `7ee554693`、`549387601`、本节 `60b80f321` 和 Desktop `5cb6476f7`。没有改全局 SSH/git 配置，没有共享加载/重启。


## 05:52 增量：插件 browser inventory 直接由 Go 应答，退出该 Node GET caller

源码 **`747c0c9ab4064c0751a9faf171c1c576522a2b6a`**：精确5生产路径、169增/134删。`/v0/plugins` 与原 `/v1/management/plugins` 共用生产 `InventoryHandler`、SQLite reader、Go registry 及 `BuildInventory`，只增加旧浏览器DTO适配；没有HTTP反代理、第二状态源或poller。`BearerAuthorizer`只增加只读配置能力，不改既有`Authorized`。Node仅删除对应GET分派及独占mapper，其他trust/control/doctor保持；不是删整个plugins模块。

### 固定输入与构件

- 私有`git archive`基点`b73f9683fb11dba56ee9ae8f72e2003852aa2a9c`，archive SHA256 `326e06305e08193a9d18a96ad3cae5acd0bd60412fba82af64864edbf78ec69e`，叠加本人5路径。final manifest SHA256 `c3598a4998cdbb75eafc33d2ae7ed7543e1254718ea24e42f9637a4e063fceda`，标准Go构件`72983df0ff7c5dd845544e8995319252fbf7f95855a1cb80179085e7eb166f6c`；这是固定base+5overlay，**不是完整747c树构建**。
- 复用同一真实sealed canonical输入`561596b6eca3a34052a2cc6fd024f5fd3d684bc12ec2b427d67b447f9dfd3f22`，本次前后全SHA相等。输入与05:33本机只读结果均未找到`plugins.control.v1`键；此时点keyAbsent只支持空清单，**不推断从未安装或真实发布插件已验**，不构造插件/账号/token/fixture。
- `go build -mod=readonly -trimpath`、两个相关包`go vet`、Node语法均exit0。私有operational程序只调用生产exported handler+真实reader+NewRegistry，无mock/复制业务；标准server CLI本身要求配置key，所以不能拿它证明未配key可启动。

### 真实正反/重启与旧caller退休

标准私有Go未带frontdoor/superviseNode，PATH无node，**非OS-noexec**。最终29条记录中：browser200逐字段等于在同canonical响应上执行的原生产Node mapper；空数组/null合同保持；未鉴权/坏key在GET/POST/PUT/DELETE均401，先于方法/读取；已鉴权POST404、PUT/DELETE405；非法1byte/超限262145byte POST均原400领域码；canonical POST仍405。真实private父目录禁读触发503`plugin_state_unavailable`，恢复权限后200，不回成功空清单。

另起真正第一方NodeCLI **25834**（独立空HOME/同privateGo外部URL）：inventory GET405、未鉴权401，原trusted sibling200；只停ownNode exit0后同Go **25818**仍200。同HOME再起Go **25935**响应一致。三个自有服务全部exit0，实际观察集合残余0；不是计量所有动态`getPluginInventory`消费者为0，也没有触碰共享服务。

未配key的严格门禁另列：生产handler/reader/registry私有HTTP operational构件`dcdac420163f52082d6e62026022ab14322de40890605a009fef8f5868012036`，OS禁止fork/外部exec/出站/全部写入。两进程 **25959/25961** 共20次真实HTTP，缺key九次503、配置key后401/200/404/405与原canonical行为保持；两次采样无子进程、均exit0。**这不是标准CLI全路径或全服务全程OS-noexec结论。**

首轮仅chmod DB000未满足预期503，未捕精确响应；该失败记录保留，不补造状态/原因。改父目录门禁后通过，无产品修复来迎合测试。另self-review保留旧POST先parse后404语义，最终新hash已独立复审、全矩阵重跑。

### 审查、交付与硬边界

Galileo独立核最终5SHA、两个构件、实际operations/result/operational JSON，**NO BLOCKING**；审查没有重跑服务。旧V1与原final index、原review均保留；首失败说明收紧后单独以`evidence-index-note-drift-receipt.json`记录note哈希漂移，新不可变`acceptance-index-final-v2.json`绑定当前note，其他三份operations/result叶子不变，不借旧hash背书。提交采用一次性临时index+普通私有commit-view+显式pathspec，pre cachedstat/post showstat exact5；主index字节`0f1991d4…`与全entry digest`db99316d…`前后不变，未同步他人89项旧暂存差异；router原remoteWebUI hunk保留且不作为本人新增改动夹带。

**仍OPEN：**真实非空installed/contributions映射、正式插件包/receipt/来源/许可与允许业务输入、JS/Cordis ABI及HostClient+Invoker两接缝、第一方Node plugin host、Edge DOM、共享artifact/loaded/批准与最终默认Go单宿主。只读发布来源审计在`/tmp/aih-r8-source-audit-latest-20261118.txt`指向root；其真实DB metadata仅选installed字段、不读配置/信任正文，未fetch/install/demo/trust写。

证据pointer `/tmp/aih-plugin-inventory-go-latest-20261118.txt`；root `/private/tmp/aih-plugin-inventory-go-20261118-b57a7b9f`，`evidence/{source-manifest-final,inventory-operations,inventory-result,operational-auth-result,independent-final-review,source-commit-receipt,physical-land-receipt,acceptance-index-final-v2}.json`。敏感副本/log仍受限保存，未获单独许可不删。05:46只读9527仍Go84956，非本次构件loaded；本节不授权发布/重启。
