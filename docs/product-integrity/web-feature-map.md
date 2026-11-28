# Web 功能入口与原行为合同（M0 静态总账）

盘点启动：2026-11-14；文档校对：2026-11-15（Asia/Shanghai）。范围：当前共享工作区的 `web/config/routes.ts`、`web/src/pages`、`web/src/features` 及其实际引用的组件、客户端服务。依据：[已批准计划](../superpowers/plans/2026-11-14-product-integrity-optimization.md) 的 M0；本文件不是 M4/M5 验收结论。

## 1. 边界、口径与证据等级

- **运行时统一状态：`not verified`（未验证）。** 本次仅阅读源码并编写本文件；未新增或执行测试，未构建、安装、启动应用，未调用生产/本地业务 API，未打开 GUI/浏览器，未操作 shell 集成、CLI 命令、账号、配置、任务或服务；未进行 Git 写操作、分支/worktree 操作或记忆更新。
- 唯一写入边界：`docs/product-integrity/web-feature-map.md`。shell 实现由主代理负责，CLI 映射由其他代理负责；此处只记 Web 按钮到客户端合同的交接，不重复盘点 shell/CLI 实现。
- **静态可证**分三层：路由声明；页面实际挂载/事件处理器；处理器引用的客户端方法/请求路径。API 列仅声明前端请求合同，不据此认定后端注册、持久化、上游能力、权限、计费或成功返回已经成立。
- “原行为不变量”来自当前源码中的明确约束与批准计划：是后续验证/修改必须保留的边界，**不是对全部历史产品意图的独立恢复，也不是已通过的保证**。未核验的历史决策、Provider/平台能力、失败恢复列为缺口。
- 动作表登记用户可观察的叶子操作及其参数/展示维度；读列表、刷新、创建、保存、删除、执行尽量分行。共享入口通过回链说明，不能把跨入口复用算成不同支持能力；同一路由的不同 query 模式有回链。
- 风险记号：`R` 读取；`L` 本浏览器状态/剪贴板；`W` 服务端或本机持久写；`X` 启动进程/安装/系统权限/网络探测；`$` 可能访问计费上游。记号是审查分流，不代表本次执行。
- 计数口径：正式 **23 条路由配置记录 = 18 个组件入口 + 4 个重定向 + 1 个分组**（17 个不同页面组件）；预览 **3 条 = 1 个组件入口 + 2 个重定向**；合计 **26 条**。`/studio` 的父分组和子重定向各算一条；两套路由的 `/`、`/accounts`、`*` 分别计数。**22/22 feature 目录**均在第 5 节回链；Toolkit 的 **14 个当前二级面板**均列入，目录数不是功能数、支持率或验收率。
- 子功能/动作表共 **258 条编号映射行**（含跨入口复用、同一业务的操作变体及 T57 汇总跳转；不是 258 个已验收的独立能力）。明确记录 **2 个高置信度静态合同缺口**；运行时验收 **0 项**。

### 路径与 API 缩写

源码：`P/` = `web/src/pages/`；`F/` = `web/src/features/`；`C/` = `web/src/components/`；`S/` = `web/src/services/`；`CR/` = `web/src/chat-runtime/`。表内扩展名保留；同单元格的不同文件用分号分隔。未重复目录的文件名相对该格首个文件的目录；只写 handler 名时相对该节已声明的主文件。

请求：`W` = `/v0/webui`；`K` = `/v0/webui/toolkit`；`A` = `/v0/webui/accounts/:provider/:accountRef`；`RUNTIME` = `/v0/webui/chat/sessions/:sessionId`；`V` = `/v1/management`。`:…` 是占位符，不是可直接调用的 URL。除特别列出的 feature API/Canonical API 外，方法定义见 `S/api.ts`。

`S/api.ts:146-179` 可证默认 `/v0` 前缀、Management Key 请求头与远端 `x-aih-server-id`；实际目标仍取决于 active Server/transport。Go 预览从 `S/account-management/preview.ts` 固定到独立 Web origin，经 preview transport 使用 `V`，不是正式页切换 Go 的证据。

<a id="routes"></a>
## 2. 全量路由账（以 routes.ts 为唯一枚举源）

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| R01 正式 `/` | 重定向 `/dashboard` | `web/config/routes.ts` | 导航，无独立 API | 保留首页默认目的地 | not verified：首次访问与 Server 门禁 |
| R02 `/dashboard` | [D01–D05 仪表盘](#dashboard) | `P/Dashboard.tsx` → `F/dashboard` | managementAPI / accountsAPI | 健康、请求、队列不同口径不混算 | not verified：真实指标与刷新 |
| R03 `/accounts` | [A01–A37 账号](#accounts) | `P/Accounts.tsx` → `F/accounts`、`F/account-status`、`F/egress-upstream` | Node accountsAPI | 正式路由不是 AccountsGoPreview | not verified：全部账号旅程 |
| R04 `/chat` | [C01–C38 会话/工作台](#chat) | `P/Chat.tsx` → `P/chat-page-state.tsx` | Canonical runtime + projects/history | Chat/Work 不等同两份协议实现 | not verified：流式、恢复、计费 |
| R05 `/chat/quick` | [C30 快捷外壳](#chat)，复用 C01–C38 中实际挂载动作 | `P/QuickChat.tsx`；`P/chat-quick-launch.ts` | 同一 ChatConversationContent/CanonicalChatRuntime | `hideInMenu`、`layout:false`；不套常规布局 | not verified：桌面宿主、主题、快捷唤起 |
| R06 `/usage` | [U01–U08 用量](#usage) | `P/ModelUsage.tsx` → `F/model-usage` | modelUsageAPI | 未归属数据不得猜账号 | not verified：全量账单/聚合口径 |
| R07 `/models` | [M01–M08 全局模型](#models) | `P/Models.tsx` → `F/models` | modelsAPI | 全局目录与账号模型身份分离 | not verified：上游目录和能力 |
| R08 `/scheduled-tasks` | [J01–J09 计划任务](#tasks) | `P/ScheduledTasks.tsx` | scheduled-tasks / accounts activity | 计划预览不等于已执行 | not verified：时区、重入、外部副作用 |
| R10 `/toolkit/install-guide` | [T58–T59 命令指南](#toolkit) | `P/ToolkitInstallGuide.tsx` | toolkitAPI.getEnvironmentGuide | 隐藏菜单；仅生成/复制，不自动执行 | not verified：平台指南与转义 |
| R11 `/toolkit` | [T01–T57 开发工具](#toolkit) | `P/Toolkit.tsx`；`P/toolkit-url-state.ts` | 14 个面板，见分表 | `panel` 驱动，旧 cli-upgrade → apps | not verified：每面板真实可达性 |
| R12 `/studio`（父） | 灵感工坊导航分组 | `web/config/routes.ts` | 无组件/API | 分组不是独立可用功能 | not verified：导航展示 |
| R13 `/studio`（子） | 重定向 `/studio/image` | `web/config/routes.ts` | 导航 | 默认进入生图而非翻译 | not verified：嵌套路由解析 |
| R14 `/studio/image` | [I01–I11 生图/修订](#image) | `P/StudioImage.tsx` → `F/image-studio/ImageStudioWorkspace.tsx` | imageStudioAPI | 页面导出实际工作区，不从目录名推断模型支持 | not verified：图片生成及资产 |
| R15 `/studio/translation` | [L01–L14 翻译](#translation) | `P/Translation.tsx` → `F/translation/TranslationWorkspace.tsx` | translationAPI | 引擎/目标策略独立于普通 Chat | not verified：翻译与系统权限 |
| R16 `/servers` | [H01–H06、H18 Server 管理](#servers) | `P/Servers.tsx` → `P/Settings.tsx(section=control-planes)` | control-plane services | 独立路由，非假定 settings Tab 可达 | not verified：授权/切换/同步 |
| R17 `/ssh-hosts` | [H09–H17 SSH](#servers) | `P/SshHosts.tsx` → `P/Settings.tsx(section=ssh-hosts)` → `P/SshHostsPanel.tsx` | sshHostsAPI | 连接与工作区两个领域实体 | not verified：真实 SSH 与远程路径 |
| R18 `/settings` | [S01–S15 设置](#settings) | `P/Settings.tsx`；`P/ModelAliases.tsx`；`P/UpstreamErrorMappings.tsx` | config/model-alias/error-mapping | 实际可见 Tab 是 basic、aliases、upstream-errors | not verified：保存/重启/旧链接 |
| R19 `/server-setup` | [H07–H08、H18 引导/补授权](#servers)，复用 H01–H05 | `P/ServerSetup.tsx` | control-plane-profile-connection / gate | 隐藏菜单，未 ready 不伪装已连接 | not verified：首次引导/密钥失效 |
| R20 `/translation` | 兼容重定向 `/studio/translation` | `web/config/routes.ts` | 导航，非第二套翻译实现 | 保留旧入口 | not verified：query/深链接保留 |
| R21 `/accounts/:provider/:accountRef/models` | [M01–M08 账号范围模型](#models) | `P/Models.tsx` + useParams | 同 modelsAPI，携带账号范围 | provider/accountRef 不得丢失或跨账号 | not verified：编码、失效引用与范围 |
| R22 `/accounts/:provider/:accountRef/quota` | [Q01–Q04 额度统计](#quota) | `P/AccountQuota.tsx` → `F/quota-stats` | accountsAPI.getQuotaStats | 窗口明细不可用时不能捏造窗口 | not verified：不同 Provider 额度口径 |
| R23 正式 `*` | 兜底重定向 `/dashboard` | `web/config/routes.ts` | 导航 | 未注册路径不是独立支持页面 | not verified：404 与门禁交互 |
| G01 预览 `/` | 重定向 `/accounts`，无布局 | `web/config/routes.ts` | preview 导航 | 仅 AIH_GO_ACCOUNTS_PREVIEW=1 选择该路由表 | not verified：预览进程环境 |
| G02 预览 `/accounts` | [P01–P12 Go 账号](#preview) | `P/AccountsGoPreview.tsx` → `S/account-management/preview.ts` | V/accounts 等 | 仅 Codex/Claude；不冒充正式全 Provider 能力 | not verified：含 SG01/SG02 静态缺口 |
| G03 预览 `*` | 兜底 `/accounts`，无布局 | `web/config/routes.ts` | preview 导航 | 预览没有正式模型/设置独立路由 | not verified：未知链接处理 |

<a id="dashboard"></a>
## 3. 用户叶子动作账

### 3.1 仪表盘

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| D01 `/dashboard` | R 查看网关状态、Provider 队列、路由计数、健康率、近期错误 | `P/Dashboard.tsx`；`F/dashboard/use-gateway-dashboard.ts`；`F/dashboard/dashboard-presentation.ts` | managementAPI.status/metrics/accounts/watch；accountsAPI.list | 持久账号健康分母与账号页一致；无请求不评健康成功率 | not verified：指标来源/边界与真实负载 |
| D02 `/dashboard` | R 主动刷新快照 | `F/dashboard/use-gateway-dashboard.ts` | managementAPI.requestSnapshot；失败时读取状态 | SSE 超时/出错有读取降级，不将旧值当新值 | not verified：断线、重连与节流 |
| D03 `/dashboard` | W 清空冷却 | 同上 handleClearCooldown | POST W/management/cooldown/clear | 明确用户动作，不随读取自动清除 | not verified：作用账号范围及调度恢复 |
| D04 `/dashboard` | L 复制错误详情 | `P/Dashboard.tsx` copyErrorText | 剪贴板 | 复制失败可见；请求模型与有效模型分开 | not verified：内容脱敏及剪贴板权限 |
| D05 `/dashboard` | L 由错误跳到项目/会话 | `F/dashboard/dashboard-presentation.ts` buildChatJumpPath | `/chat` 深链接 | projectPath/sessionId 保留 | not verified：错误关联会话实际存在 |

<a id="accounts"></a>
### 3.2 正式账号页

以下 A 系列均由 `/accounts` → `P/Accounts.tsx` 挂载；主要动作实现为 `F/accounts/use-account-actions.ts`，弹窗装配为 `F/accounts/AccountFlowModals.tsx`。按能力条件显示的动作，不代表每个 Provider 可执行。

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| A01 `/accounts` | R/L 账号列表、厂商家族/状态筛选、卡片/表格、定位账号 | `P/Accounts.tsx`；`F/accounts/useAccountsSnapshot.ts`；`F/accounts/account-view-model.ts` | GET W/accounts；W/accounts/watch / watch/snapshot | 稳定 accountRef；快照/增量/删除不重复投影 | not verified：大列表、重连、筛选定位 |
| A02 `/accounts` | R 账号健康详情、全局健康折叠、无数据状态 | `F/account-status/GlobalStatusPanel.tsx`；`F/account-status/AccountHealthIcon.tsx`；`F/account-status/useAccountOutcomes.ts` | accountOutcomesAPI.get → W/account-outcomes；accounts watch | 观测结果≠配置停用；无数据不推断健康 | not verified：窗口、事件归属、过期证据 |
| A03 `/accounts` | W 新增账号：选择认证方式并提交凭据/登录任务 | `F/accounts/AddAccountModal.tsx`；`F/accounts/use-account-actions.ts` handleAdd | accountsAPI.add → POST W/accounts/add | auth sources/Provider 能力决定入口；不把所有登录方式一概支持 | not verified：身份去重、凭据安全与真实登录 |
| A04 `/accounts` | W 完成 OAuth 回调 | `F/accounts/AuthProgressModal.tsx`；use-account-actions handleSubmitBrowserCallback | POST W/account-jobs/:jobId/callback | 回调绑定当前 job；关闭/成功状态区分 | not verified：过期、重复回调、账号归属 |
| A05 `/accounts` | W 取消登录任务 | `F/accounts/use-account-actions.ts` closeAuthProgress | accountsAPI.cancelAddJob / cancelPluginLoginJob | 仅关闭展示与取消任务不能混淆 | not verified：取消竞态与资源释放 |
| A06 `/accounts` | W 从本机认证来源直接导入或完成当前登录 | `F/accounts/use-account-actions.ts` handleAddLocalImport / handleLocalAuthImport | provider-auth-sources；W/accounts/local-import；account-jobs/:id/local-import | 需身份核验的来源仍走登录任务，不凭本地文件存在认定有效 | not verified：来源可用性与身份核验 |
| A07 `/accounts` | X 确认安装缺失认证客户端/CLI 后继续登录 | `F/accounts/AuthProgressModal.tsx`；use-account-actions | account-jobs/:id/install；toolkitAPI.executeAppAction；waitForAppInstallJob | 安装显式确认；成功安装不等于已登录 | not verified：平台、失败恢复、登录续接 |
| A08 `/accounts` | W 启动/提交插件登录，选择支持的社交设备登录 | `F/accounts/use-account-actions.ts` handleAddPluginLogin / handleSubmitPluginLogin / handleStartSocialDevice | W/accounts/plugin-login/start、:id/submit；accountsAPI.add | 浏览器消费公开 job 状态；来源能力限定 | not verified：插件协议及 Google/Github 条件 |
| A09 `/accounts` | W 扫描并登记本机已登录账号 | `P/Accounts.tsx` detectHostAccounts；use-account-actions handleScanHostAccounts | POST W/accounts/detect | 扫描/新增/更新/跳过分别呈现，不等于重新登录 | not verified：去重与本机扫描范围 |
| A10 `/accounts` | W 文件/多文件/粘贴导入并看任务结果 | `F/accounts/ImportAccountsModal.tsx`；`F/accounts/account-import-export.ts`；use-account-actions | POST W/accounts/import；GET W/accounts/import/jobs/:id；watch | imported/created/updated/skipped/invalid/failed 区分 | not verified：文件格式、二进制、大小与部分成功 |
| A11 `/accounts` | R/L 按全局/厂商/账号范围导出 | `F/accounts/account-import-export.ts`；use-account-actions handleExport | GET W/accounts/export，blob + disposition | 导出范围保留；凭据导出不写入本审计文档 | not verified：格式、敏感字段及文件下载 |
| A12 `/accounts` | W 编辑静态凭据/地址/异常规则引用 | `F/accounts/EditAccountModal.tsx`；use-account-actions handleEditSubmit | POST A/update | canEditAccountConfig/reauth guard；不将不同认证模式互换 | not verified：字段覆盖、留空语义、规则生效 |
| A13 `/accounts` | W 重新登录已有账号 | use-account-actions handleReauth；`F/accounts/AuthProgressModal.tsx` | POST A/reauth | 保持目标账号引用，不默默新建另一账号 | not verified：失效凭据恢复与并发 job |
| A14 `/accounts` | W 刷新账号状态/凭据/模型相关快照 | use-account-actions handleRefreshAccount | POST A/refresh；account-refresh job/watch | 与只刷新额度不同；进行中状态按账号隔离 | not verified：刷新完整副作用与失败恢复 |
| A15 `/accounts` | W 刷新额度/订阅确认 | use-account-actions handleRefreshUsage | POST A/refresh-usage | 不把余额刷新等同重新授权 | not verified：真实额度和订阅窗口 |
| A16 `/accounts` | W 启用/停用账号 | use-account-actions handleToggleStatus；`F/accounts/account-state.ts` | POST A/status {status:up/down} | 配置开关与运行错误分开 | not verified：停用后实际路由排除 |
| A17 `/accounts` | W 恢复调度 | use-account-actions handleRestoreScheduling | POST A/restore-scheduling | 仅适用状态显示并确认；不是重新登录替代品 | not verified：错误解除条件与重新入池 |
| A18 `/accounts` | W 设置/取消默认账号 | use-account-actions handleSetDefault | POST A/set-default / clear-default | 默认身份不等于某次路由一定命中 | not verified：Provider 范围与原生同步 |
| A19 `/accounts` | W 设置/取消 Codex App 对应账号角色 | `F/accounts/account-view-model.ts` getCodexAppAccountActionMeta；use-account-actions handleSetMobile | POST A/set-mobile / clear-mobile | 保留后端 mobile 字段与 UI Codex App 语义，不能泛化所有厂商 | not verified：App 身份投影 |
| A20 `/accounts` | W 删除账号（必要时处理占用/强制确认） | `F/accounts/account-deletion-confirm.tsx`；use-account-actions confirmDeleteAccount | DELETE A，显式 force 参数 | 普通删除不默认为强制；不删除旁路账号 | not verified：活跃进程/引用/文件清理 |
| A21 `/accounts` | R/L 复制账号身份 | use-account-actions copyAccountEmail；`F/accounts/account-state.ts` | 剪贴板，无新 API | 非邮箱/不可复制状态不捏造身份 | not verified：API-key 模式展示与复制 |
| A22 `/accounts` | X 打开/关闭/重开 Desktop | use-account-actions handleOpenApp；`F/accounts/use-account-app-entries.ts` | POST A/open-app kind=desktop；GET W/app-entries | Desktop 使用语义图标；关闭与换号需明确目标 | not verified：平台、应用存在与真实账号 |
| A23 `/accounts` | X 打开 CLI/网页终端并选终端、工作目录、harness、模型 | `F/accounts/CliPickerModal.tsx`；use-account-actions openCliFromPicker；`F/web-terminal/use-adopt-launched-terminal.ts` | POST A/open-app kind=cli；terminals/app-entries；projects/browse | 保留原生/网页 transport，server/sessionKey/cwd 不串用 | not verified：进程/终端生命周期；CLI 语义由另账负责 |
| A24 `/accounts` | X 缺应用时安装、重试并再次打开 | `F/accounts/AccountAppInstallModal.tsx`；`F/accounts/AccountAppInstallResultModal.tsx` | toolkitAPI.executeAppAction + app-install job/watch | 安装完成与应用已打开分别记录 | not verified：安装包、升级路径与失败恢复 |
| A25 `/accounts` | W Kimi Desktop 登录续接 | `F/accounts/KimiDesktopLoginModal.tsx` | POST A/desktop-session/start、poll；watchKimiDesktopSession（kimi） | 绑定 accountRef 与会话 code；不是通用 OAuth | not verified：外部应用实际完成 |
| A26 `/accounts` | R 进入账号模型管理 | use-account-actions openModelManagement | R21 → [M01–M08](#models) | provider/accountRef 编码后带入 | not verified：失效账号深链接 |
| A27 `/accounts` | R 进入账号额度统计 | use-account-actions openQuotaStats | R22 → [Q01–Q04](#quota) | 不能用目录存在代替额度能力 | not verified：各厂商统计能力 |
| A28 `/accounts` | R 查看配置文件/脱敏或原始模式 | `F/accounts/AccountConfigFilesModal.tsx` | GET A/config-files?mode=… | 账号范围与敏感模式明确；导出复用 A11 | not verified：脱敏、路径、读取权限 |
| A29 `/accounts` | W 保存账号出口选择/运行策略 | `F/accounts/AccountRuntimeSettingsModal.tsx` → `F/accounts/ZcodeEgressModal.tsx`；`F/accounts/AccountEgressRuntimePanel.tsx` | accountsAPI.getAccountEgress / saveAccountEgress / getAccountEgressRuntime | 绑定、运行选择、地区结论分别呈现 | not verified：真实出口、回退、账号隔离 |
| A30 `/accounts` | W 保存窗口激活策略 | `F/accounts/AccountWindowActivationModal.tsx` | GET/POST A/window-activation | 各 Provider 支持与窗口规则由响应决定 | not verified：定时触发、费用/额度影响 |
| A31 `/accounts` | W 设置是否参与别名选号 | `F/accounts/AccountAliasPoolModal.tsx` | GET/POST A/alias-pool | 参与池不等于默认账号，不改变手选语义 | not verified：路由实效与重载 |
| A32 `/accounts` | W 单账号/批量设置模型上下文窗口 | `F/accounts/AccountModelContextModal.tsx` | get/saveAccountModelContext；saveAccountModelContextBulk | 按 provider/account/model 定位；批量目标显式 | not verified：上下游 token 限额实际采用 |
| A33 `/accounts` | R 查看额度重置历史/可用重置次数 | `F/accounts/AccountResetModal.tsx`；`F/accounts/AccountQuotaResetHistoryPanel.tsx`；`F/accounts/CodexResetCreditsPanel.tsx` | A/quota-reset-events；codex reset-credits | 历史可看不代表可消费；eligibility guard | not verified：库存/窗口真实性 |
| A34 `/accounts` | W 消费重置额度及对账未决操作 | `F/accounts/CodexResetCreditsPanel.tsx` | reset-credits/consume {operationId,inventoryVersion}；reset-operations/:id/reconcile、watch | 同次操作幂等身份保留；未决不能冒充成功 | not verified：重复点击、库存冲突、真实扣减 |
| A35 `/accounts` | W/X 执行单账号/厂商批量活动，取参数/探测/看进度 | `P/Accounts.tsx` runOneReward/runProviderRewards；`F/accounts/AccountActivityModal.tsx`；`F/accounts/ActivityParamFields.tsx` | A/activity/:actionId；W/accounts/activity/params、probe、run、jobs/:id | 活动目录与参数来自服务端；任务完成不等于奖励到账 | not verified：活动资格、幂等、上游到账 |
| A36 `/accounts` | R 查看选号权重与命中概率诊断 | `C/account/RoutingWeightsDrawer.tsx` | routingAPI.weights → W/routing/weights | 诊断只读；显示概率不等于下一请求承诺命中 | not verified：真实路由权重与实际分布 |
| A37 `/accounts` | W 批量指定账号出口 | `F/egress-upstream/AccountEgressBulkPicker.tsx`；`F/egress-upstream/bulk-egress.ts` | accountsAPI.saveAccountEgressAssignment | 批量写入需保留逐账号结果；详见 E06 | not verified：部分失败与作用域 |

<a id="chat"></a>
### 3.3 会话、Work 工作台与快捷外壳

`/chat` → `P/chat-page-state.tsx` → `F/chat-runtime/CanonicalChatRuntime.tsx` → `SessionWorkspace` 是当前主链；**不能因为 `S/api.ts` 还存在旧 `chatAPI.sendStream` 就将其写成当前主发送链**。Canonical 请求实现见 `CR/api-client.ts`，命令实现见 `F/chat-runtime/session-runtime-actions.ts`。本节其他动作在 `/chat/quick` 的复用范围由布局/模式决定，见 C30。

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| C01 `/chat` | R/L 选择 Chat/Work、账号、项目、会话；刷新目录 | `P/chat-page-state.tsx`；`F/chat-workspace/use-project-catalog.ts`；`F/chat-runtime/use-canonical-session-directory.ts` | sessionsAPI projects/watch；Canonical listSessions；本地 selection/cache | Server、账号、原生/Canonical 会话身份分开；离线缓存有标记 | not verified：切换竞态、跨标签与缓存隔离 |
| C02 `/chat` | W 新建/解析会话与断线重试 | `F/chat-runtime/use-session-runtime.ts`；`F/chat-runtime/session-open-coordinator.ts` | POST W/chat/sessions、/resolve；snapshot | 创建后重试复用已创建会话，不制造空重复会话 | not verified：首快照失败、幂等/重试 |
| C03 `/chat` Work | R/W 浏览/选择/打开项目目录 | `F/chat-workspace/use-project-dialogs.tsx`；`F/chat-workspace/use-server-directory-picker.ts` | sessionsAPI.openProject / browseProjectDirectory | 服务端目录不是浏览器本地文件路径 | not verified：权限、空格/Unicode、远程目录 |
| C04 `/chat` Work | W 移除项目登记 | `C/chat/ProjectList.tsx` | POST W/projects/remove | 移除目录登记不应默认为删除项目文件 | not verified：服务器真实语义及会话引用 |
| C05 `/chat` | W 归档原生会话 | `C/chat/ProjectList.tsx` | POST W/sessions/archive；lifecycle-capabilities | 按 capability 执行，不从文件名推断可归档 | not verified：原生运行中会话限制 |
| C06 `/chat` | R/W 查看归档并恢复 | `C/chat/ProjectList.tsx` → `C/chat/ArchivedDrawer.tsx` | sessionsAPI.getArchivedSessions / unarchiveSession | 归档与删除不同；恢复维持身份 | not verified：历史兼容与恢复后可续聊 |
| C07 `/chat` Chat | W 删除纯聊天会话 | `C/chat/ProjectList.tsx` | DELETE W/chat-sessions/:sessionId | 不把删除 Chat 与原生归档合并 | not verified：历史/资产清理边界 |
| C08 `/chat` | R 阅读时间线、工具结果、计划、指标并加载历史 | `F/chat-runtime/ConversationTimeline.tsx`；`F/chat-runtime/TimelineItemView.tsx`；`F/chat-runtime/SessionMetrics.tsx` | RUNTIME/snapshot、timeline、events；CR DTO/parser | cursor/order/sessionId 校验；只读原生历史不可写 | not verified：事件去重、长历史、结构化渲染 |
| C09 `/chat` | W/$ 发送消息（含附件） | `F/chat-runtime/Composer.tsx`；`F/chat-runtime/use-composer-controller.ts` | POST RUNTIME/commands，turn.submit | commandId、模型、effort、附件 ID 同次提交；禁用态不改变 | not verified：真实上游响应、费用、失败草稿 |
| C10 `/chat` | L/W 附件选择/粘贴/移除、长粘贴折叠、文件引用 | `F/chat-runtime/use-composer-attachments.ts`；`F/chat-runtime/use-composer-file-references.ts`；`F/chat-runtime/composer-draft-store.ts` | RUNTIME/attachments；chatPasteSettingsAPI；文件引用策略 | 投递方式/能力限制；先上传后引用；不吞草稿 | not verified：格式/大小、IME、文件可读与清理 |
| C11 `/chat` | W 切模型/推理强度、账号与批准模式 | `F/chat-runtime/ComposerToolbar.tsx`；`F/chat-runtime/use-runtime-composer-catalog.ts` | RUNTIME/composer/catalog；session.policy.set；新会话选择 | 账号切换提示新建；effort 只按模型真实目录显示 | not verified：每 Provider 模型与权限合同 |
| C12 `/chat` | L/X 选择提示模板、语音听写、快捷命令面板 | `F/chat-runtime/ComposerToolbar.tsx`；`P/Chat.tsx` | 静态 PRESETS（C/chat/PromptPresetsCapsule.tsx）/ Dictation 控件 / GlobalCommandPalette | UI 挂载可证；听写供应商/音频传输未追溯完 | not verified：麦克风权限、听写数据流、模板内容与输入替换 |
| C13 `/chat` | W 执行 slash 命令 | `F/chat-runtime/use-composer-controller.ts`；session-runtime-actions executeSlash | slash.execute；RUNTIME/commands/catalog | 依命令目录，不把 UI 字符串当 Provider 原生命令支持 | not verified：命令语义/返回/可取消性 |
| C14 `/chat` | W 中断当前回合 | session-runtime-actions interrupt；`F/chat-runtime/ComposerToolbar.tsx` | turn.interrupt {reason:user_stop} | 仅中断当前目标，不吞后续队列 | not verified：上游停止、费用/终端清理 |
| C15 `/chat` | W 在当前回合补充或按边界排队 | session-runtime-actions deliver；ComposerToolbar | turn.intervene；queue.add after_tool_boundary/after_turn | 三种投递语义不可互换；附件限制保留 | not verified：工具边界、时序与重复投递 |
| C16 `/chat` | W 编辑排队消息 | `F/chat-runtime/QueueDock.tsx` | queue.edit | 以 queueId 定位，不修改已执行输入 | not verified：执行竞态与空内容 |
| C17 `/chat` | W 调整队列顺序 | 同上 | queue.move {queueId,beforeQueueId} | 不用列表下标冒充稳定身份 | not verified：并发排序 |
| C18 `/chat` | W 删除排队消息 | 同上 | queue.remove | 删除待执行项不是中断当前回合 | not verified：正在派发时的结果 |
| C19 `/chat` | W/$ 立即执行排队项 | 同上 | queue.dispatch | capability/可派发状态保留 | not verified：重复执行及费用 |
| C20 `/chat` | W 回答交互问题 | `F/chat-runtime/QuestionInteractionCard.tsx`；`F/chat-runtime/use-question-interaction-controller.ts` | interaction.answer | question/interactions 生命周期绑定，不将自动解答当用户点击 | not verified：多选/文本/取消、过期问题 |
| C21 `/chat` | W 接受/拒绝批准 | `F/chat-runtime/ApprovalInteractionCard.tsx`；`F/chat-runtime/approval-interaction-policy.ts` | approval.decide | 批准身份/权限模式/可用动作不扩权 | not verified：工具副作用与过期批准 |
| C22 `/chat` | W/$ 重试失败回合 | session-runtime-actions retry；`F/chat-runtime/TurnFeedback.tsx` | turn.retry，稳定 turn-retry:sourceTurnId | 丢确认/刷新继续复用操作，不重新收费猜测 | not verified：后端幂等、费用与失败恢复 |
| C23 `/chat` | W/$ 从消息分叉/重新生成；返回父会话 | `F/chat-runtime/message-operation.ts`；`F/chat-runtime/BranchParentLink.tsx` | session.fork / turn.regenerate | 按 catalog 允许；未确认命令保留 commandId | not verified：分叉数据完整性与父子归属 |
| C24 `/chat` Work | W/$ 在当前/新会话实施计划 | `F/chat-runtime/PlanImplementationPrompt.tsx`；`F/chat-runtime/plan-implementation-workflow.ts`；`F/chat-runtime/fresh-plan-implementation-workflow.ts` | canonical workflow / session commands | 原计划与新会话移交不混淆；先确认实施意图 | not verified：跨会话上下文、权限与重试 |
| C25 `/chat` Work | L 拖拽分栏、增删/切换面板标签 | `F/project-workbench/ProjectWorkbench.tsx`；`F/project-workbench/WorkbenchTabBar.tsx`；`F/project-workbench/workbench-persistence.ts` | 浏览器布局状态；WorkbenchPanelHost | 布局操作不删除实际会话/文件 | not verified：持久恢复与作用域 |
| C26 `/chat` Work | R 阅读项目文件与授权检查 | `F/project-workbench/files/FilesPanel.tsx` | fsAPI.tree / checkAccess / read → W/fs/* | 文件信任/项目范围边界保留；不是编辑器写文件能力 | not verified：路径穿越防护、大文件、权限 |
| C27 `/chat` Work | R 查看工作区/暂存 Git diff | `F/project-workbench/review/ReviewPanel.tsx` | gitReviewAPI.summary / diff → W/git/* | staged/unstaged 分开；看 diff 不自动提交 | not verified：二进制、重命名与并行变更 |
| C28 `/chat` Work | R/W 查看检查点、差异并确认恢复 | `F/project-workbench/review/CheckpointList.tsx` | workspaceCheckpointAPI.list / changes / restore | 恢复是破坏性工作区动作，不能与只读 review 混算 | not verified：备份、并行文件保护和回退 |
| C29 `/chat` Work | R/L/$ 打开/刷新开发预览，外部打开，整页翻译/停止/撤回 | `F/project-workbench/browser/BrowserPanel.tsx`；`F/project-workbench/browser/browser-url-policy.ts` | iframe / URL policy；translationAPI.stream operation=page | URL 限制、同源访问与撤回原文；尺寸预览不是移动端验收 | not verified：iframe/CSP/同源、翻译取消与撤回 |
| C30 `/chat/quick` | L 快捷启动、Chat/Work 切换、单/双/三栏、会话抽屉 | `P/QuickChat.tsx`；`P/chat-quick-launch.ts` | 同 useChatPageState/ChatConversationContent；mode/embed/theme/query | urlSelectionOnly；compact 不恢复另一页面隐式选择；workbench 仅 triple | not verified：桌面宿主窗口与全局布局差异 |
| C31 `/chat` Chat；quick 对应模式 | W 设置角色/systemPrompt | `F/chat-runtime/Composer.tsx` → `F/chat-runtime/ChatSessionSettings.tsx` | session.policy.set {key:systemPrompt} | 仅空闲时保存；会话级偏好不是全局 Provider 配置 | not verified：当前/后续回合实际采用 |
| C32 同上 | W 设置自动压缩阈值 | ChatSessionSettings | session.policy.set {key:autoCompactPercent} | 50–90% 选项；设置与真正完成压缩分开 | not verified：触发时机、token 口径 |
| C33 同上 | W 编辑会话目标及可选 token 预算 | `F/chat-runtime/SessionMetrics.tsx` GoalControl；session-runtime-actions | session.goal.set | capability 是 native/emulated 才显示；空闲可编辑 | not verified：预算实际约束、Provider 能力 |
| C34 同上 | W 清除会话目标 | SessionMetrics GoalControl | session.goal.clear | 清空目标不是删除会话/历史，空文本保存同清除 | not verified：运行态/界面更新一致 |
| C35 同上 | W/$ 手动压缩上下文 | `F/chat-runtime/Composer.tsx` compactContext；SessionMetrics | slash.execute {name:compact} | 空闲且未压缩才提供操作；失败/停止明确区分 | not verified：摘要完整性、费用和失败重试 |
| C36 `/chat` 会话列表；quick 会话列表 | L 置顶/取消置顶会话及跨标签同步 | `C/chat/ProjectList.tsx`；`C/chat/pin-session-state.ts`；`S/cross-tab-session-sync.ts` | 本地 pin 集合与 SESSION_PINNED 广播 | 置顶不修改远程会话内容/运行状态 | not verified：Server 范围、顺序与多标签 |
| C37 `/chat`、quick 消息文件引用/只读原生历史 | R 查看文件抽屉、切预览标签 | `F/chat-runtime/TimelineItemView.tsx` / `ReadOnlyNativeHistory.tsx` → `C/chat/MessageBubble.tsx` → `C/chat/FileDrawer.tsx` | fsAPI.checkAccess/read；FilePreviewPane/media URL | 看引用不自动扩大文件信任范围 | not verified：路径/图片/大文件、权限 |
| C38 同上文件拒绝态 | W 显式信任文件所在目录或父目录后重读 | `C/chat/FileDrawer.tsx` trustAndReload | fsAPI.trust → POST W/fs/trust {path,scope,source} | 信任 scope 由用户选择，不默许上级全盘访问 | not verified：后端路径校验、授权持久化/撤销 |

<a id="usage"></a>
### 3.4 用量

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| U01 `/usage` | R 按日期范围、Provider、模型查询统计与趋势 | `P/ModelUsage.tsx`；`F/model-usage/model-usage-query.ts` | modelUsageAPI.startDashboardQuery → W/management/usage/dashboard/query | 查询有 job 身份；新过滤器不被旧响应覆盖 | not verified：大数据、时区、费用精度 |
| U02 `/usage` | R 刷新当前统计 | `P/ModelUsage.tsx` handleRefreshUsage | 同查询入口，scan:false | 刷新查询不暗中扫描本地历史 | not verified：缓存与新鲜度 |
| U03 `/usage` | R 取消过时查询并跟随事件 | `P/ModelUsage.tsx`；S/api watchDashboardQueries | DELETE dashboard/query/:jobId；watch | 取消查询不是撤销已产生的模型用量 | not verified：断线与取消竞态 |
| U04 `/usage` | W 同步本地用量 | `P/ModelUsage.tsx` handleScan；`F/model-usage` 展示模块 | modelUsageAPI.scan / watchScan → W/management/usage/scan | canScanUsageProvider 限制；请求自动记账类不能假装可扫描 | not verified：导入去重、权限、历史格式 |
| U05 `/usage` | R 按模型/会话查看聚合表 | `P/ModelUsage.tsx`；`F/model-usage/model-usage-presentation.ts` | dashboard job 结果 | 输入/输出/缓存、归属/未归属分开 | not verified：聚合与原请求一致 |
| U06 `/usage` | R 打开模型/会话分解明细 | `P/ModelUsage.tsx` openBreakdown；`F/model-usage` 明细组件 | modelUsageAPI.breakdown → W/management/usage/breakdown | 按当前查询窗口和目标键 | not verified：跨账号/模型分解 |
| U07 `/usage` | R 查看请求明细 | `P/ModelUsage.tsx` | modelUsageAPI.requests → W/management/usage/requests | 限量结果不称完整账本 | not verified：分页上限与审计可追溯性 |
| U08 `/usage` | L 复制会话 ID | `P/ModelUsage.tsx` copySessionId | 剪贴板 | ID 与展示简称不混淆 | not verified：复制/跨页面关联 |

<a id="models"></a>
### 3.5 全局与账号模型（两条路由共用业务）

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| M01 `/models`；R21 | R 搜索、Provider/账号/状态/Go/Zen/Free 分组筛选 | `P/Models.tsx`；`F/models/model-catalog.ts` | modelsAPI.listOpenAICompatible → W/openai-models | accountScoped 锁定传入账号；未知状态不当启用 | not verified：各 Provider 目录与分组 |
| M02 同上 | W 刷新模型目录、查看探测状态 | `P/Models.tsx` refreshModels | POST W/openai-models/refresh；W/openai-models/watch | 探测任务与缓存目录区分；作用域一致 | not verified：部分失败、长探测与快照 |
| M03 同上 | W 手动添加模型 | `P/Models.tsx` submitManualModel；`F/models` 表单/策略 | POST W/openai-models | 必须选有效账号；可创建能力按账号限制 | not verified：ID 去重、上游真实可调用 |
| M04 同上 | W 删除手动模型 | `P/Models.tsx` deleteManualModel | POST W/openai-models/delete | 探测模型不提供删除，应使用停用 | not verified：刷新后持久性及 Chat 缓存 |
| M05 同上 | W 启用/停用模型 | `P/Models.tsx` updateModelEnabled | modelsAPI.updateModel → W/openai-models | 以 provider/accountRef/model 定位；通知目录变化 | not verified：实际路由排除与缓存失效 |
| M06 同上 | W 切换账号默认模型 | `P/Models.tsx` updateModelDefault | 同上 defaultModel:true | 每账号保留默认；不能取消唯一默认；需先启用 | not verified：默认模型在客户端实效 |
| M07 同上 | W 编辑模型价格/恢复 models.dev 原价 | `P/Models.tsx` submitModelPricing；`F/models/EditModelPricingModal.tsx` | modelsAPI.updateModel | 手工价与平台观测价不混算 | not verified：单位、精度、历史用量重算边界 |
| M08 同上 | L 复制模型 ID；账号页返回 | `P/Models.tsx` | 剪贴板；`/accounts` | 复制完整 ID；返回不修改模型 | not verified：账号上下文/剪贴板 |

<a id="quota"></a>
### 3.6 账号额度统计

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| Q01 R22 | R 查看账号额度摘要 | `P/AccountQuota.tsx`；`F/quota-stats/use-quota-stats.ts` | GET A/quota-stats | provider/accountRef 必需；不外推其他账号 | not verified：额度源与数据新鲜度 |
| Q02 R22 | R 切换窗口/日/周、范围、scope/额度维度 | 同上；`F/quota-stats/quota-stats-model.ts` | window、rangeDays、scope、granularity 查询参数 | 无窗口详情时禁用窗口；旧响应用序号丢弃 | not verified：窗口边界、时区和快速切换 |
| Q03 R22 | R 查看图表与窗口/桶明细 | `F/quota-stats/QuotaWindowChart.tsx`；`F/quota-stats/QuotaWindowTable.tsx`；`F/quota-stats/UsageBucketChart.tsx`；`F/quota-stats/UsageBucketTable.tsx` | 同响应；model-usage 格式化复用 | 使用量、额度百分比、估价不等同 | not verified：服务端分桶与图表一致 |
| Q04 R22 | R/L 主动刷新/返回账号 | `P/AccountQuota.tsx` | reload；`/accounts` | 切维度保留旧数据显示，不假称最新 | not verified：错误提示与返回上下文 |

<a id="tasks"></a>
### 3.7 计划任务

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| J01 `/scheduled-tasks` | R 读取/刷新任务与事件目录 | `P/ScheduledTasks.tsx` | listScheduledTasks → GET W/scheduled-tasks | 服务端 unavailable 事件不可当可执行 | not verified：任务目录与运行态 |
| J02 同上 | W 新建任务（命令/cwd 或活动参数） | 同上 openCreate/submitEditor；`F/accounts/ActivityParamFields.tsx` | saveScheduledTask → POST W/scheduled-tasks | 手动执行命令与账号活动不同事件；输入保持原义 | not verified：命令安全、权限与落盘 |
| J03 同上 | W 编辑任务 | 同上 openEdit/submitEditor | saveScheduledTask（既有 id） | 不默默新建重复任务 | not verified：并发编辑与历史保留 |
| J04 同上 | R 预览每天/每周/间隔/cron 下一次触发 | 同上 preview state | previewScheduledTaskSchedule → POST W/scheduled-tasks/preview | 预览只算时间，不执行事件 | not verified：时区/DST/无效表达式 |
| J05 同上 | X 探测活动参数/资格 | 同上 handleProbe | accountsAPI.listActivityParamOptions / probeAccountActivity | 探测与实际活动执行分开 | not verified：探测真实副作用边界 |
| J06 同上 | W/X 立即运行任务 | 同上 handleRun | POST W/scheduled-tasks/:id/run | 明确用户触发；接收不等于业务成功 | not verified：互斥、重试、最终结果 |
| J07 同上 | W 启用/停用任务 | 同上 handleToggle | POST :id/toggle | 停用未来触发不等于取消正在执行 | not verified：调度器实际状态 |
| J08 同上 | W 删除任务 | 同上 handleDelete | POST :id/delete | 二次确认；记录与任务生命周期区分 | not verified：运行中删除/历史处理 |
| J09 同上 | R 看全部/单任务记录、天数及分页 | 同上 records drawers/table | GET W/scheduled-tasks/records | records 的运行结论不能替代上游到账证据 | not verified：日志敏感性、分页、进程退出 |

<a id="inbox"></a>
### 3.9 开发工具：全部 14 个当前面板与隐藏指南

下面 `TK(panel)` 表示实际入口 `/toolkit?panel=panel`，并非新路由；对应 `P/Toolkit.tsx` 的 renderPanel 分支。所有安装、网络、服务和配置动作只做静态映射，**本次一个也未执行**。

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| T01 TK(apps) | R 应用清单、类别、版本/运行态及自动升级账本 | `C/toolkit/AppManagerPanel.tsx`；`C/toolkit/use-managed-apps.tsx`；`C/toolkit/use-provider-cli-upgrade.ts` | toolkitAPI.listApps；getProviderCliUpgradeStatus | 账本不等于上游最新版本；按当前主机能力显示 | not verified：真实安装/运行/版本状态 |
| T02 TK(apps) | X 安装应用 | `C/toolkit/use-managed-apps.tsx` runAppAction | toolkitAPI.planAppAction → executeAppAction，K/apps/plan、install | 先 plan/确认后执行，desktop/cli kind 不混 | not verified：下载、平台与任务完成 |
| T03 TK(apps) | X 检查更新并更新应用 | 同上 checkAppUpdate/runAppAction | K/apps/:id/check-update；plan/install action=update | 检查与执行分开；保留原生升级路径 | not verified：版本真实性与升级失败恢复 |
| T04 TK(apps) | X 卸载应用 | 同上 | plan/install action=uninstall | 危险确认，不扩大到账号数据删除 | not verified：卸载保留数据边界 |
| T05 TK(apps) | X 按账号/无账号打开或关闭应用 | `C/toolkit/ManagedAppAccountActions.tsx`；`C/task-queue/AppInstallTaskQueue.tsx` | toolkitAPI.openManagedApp → K/apps/:id/open | scope/accountRef/unscoped 显式；操作图标保留功能语义 | not verified：真实应用身份与进程 |
| T06 TK(apps) | W 清除自动升级 broken 标记 | `C/toolkit/AppManagerPanel.tsx` handleClearUpgradeBroken | POST W/provider-cli-upgrade/:provider/clear-broken | 解除标记不等于已修复/升级 | not verified：升级守护行为 |
| T07 TK(apps) → 高级设置 | W 保存启动权限 | `F/toolkit/AppAdvancedSettingsModal.tsx`；`F/toolkit/permission-catalog-view.ts` | get/saveAppPermissionSettings → K/apps/:id/settings | 使用 capability/catalog，不猜权限参数 | not verified：原生启动实际权限 |
| T08 同上 | W 安装/移除 CLI 会话 hooks | `F/toolkit/AppAdvancedSettingsModal.tsx`；`C/toolkit/use-managed-apps.tsx` | toolkitAPI.installHooks / uninstallHooks → K/apps/hooks | 只对支持 Provider 显示；不覆盖无关配置 | not verified：原生升级/会话采集兼容 |
| T09 同上 → 配置文件 | R 读取配置/字段解释与版本兼容提示 | `F/provider-config/ProviderConfigPanel.tsx`；`F/provider-config/ProviderConfigFieldInspector.tsx`；`F/provider-config/ProviderConfigFieldReference.tsx` | providerConfigAPI.list/get → K/provider-configs | provider/fileId 不等于任意路径；未支持字段不推断生效 | not verified：源文件与 schema 版本 |
| T10 同上 | W 编辑/格式化/验证并保存配置 | `F/provider-config/ProviderConfigPanel.tsx`；`C/toolkit/config-editor/ConfigCodeEditor.tsx` | providerConfigAPI.validate/save | dirty/冲突检查与版本标识保留；未保存不称生效 | not verified：冲突、校验、原生读取 |
| T11 同上 → 历史 | R/W 查看版本/差异并恢复 | `F/provider-config/ProviderConfigHistoryDrawer.tsx` | providerConfigAPI.history/historyEntry/restore | 恢复前确认；不能覆盖并行修改而不告知 | not verified：备份与恢复冲突 |
| T12 同上 → 导出 | R/L 导出/复制脱敏模板或原文件 | `F/provider-config/ProviderConfigExportModal.tsx` | providerConfigAPI.exportFile，mode=redacted/raw | 原文件可能含密钥，不将脱敏等同原始 | not verified：脱敏完整性与下载 |
| T13 TK(terminals) | R/X 列出终端并打开所选终端 | `C/toolkit/TerminalManagerPanel.tsx`；`C/toolkit/use-terminal-manager.tsx` | toolkitAPI.listTerminals/openTerminal | 当前 Server 主机与浏览器主机不同 | not verified：平台终端可达性 |
| T14 TK(terminals) | X 安装终端 | use-terminal-manager runAction | planTerminalAction/executeTerminalAction → K/terminals/plan、execute | plan/确认/任务状态分开 | not verified：包管理器与权限 |
| T15 TK(terminals) | X 更新终端 | 同上，action=update | 同上；getTerminalJob | 更新不自动切换用户默认终端 | not verified：版本/失败回退 |
| T16 TK(terminals) | X 卸载终端 | 同上，action=uninstall | 同上 | 危险确认保留 | not verified：占用处理与持久数据 |
| T17 TK(edge-forwarding) | R 读取 nginx/caddy/frp 可用性及既有转发 | `C/toolkit/edge-proxy/EdgeProxyPanel.tsx`；`C/toolkit/edge-proxy/edge-proxy-api.ts` | GET K/edge；toolkitAPI.listTools | 配置可读/可写/安装/运行分别判断 | not verified：真实主机探测 |
| T18 TK(edge-forwarding) | R 生成指定域名/模式/端口的转发计划 | `C/toolkit/edge-proxy/EdgePlanCard.tsx` | GET K/edge/plan | 生成不落盘；提供给 apply 的同一输入 | not verified：配置语法、端口与证书 |
| T19 TK(edge-forwarding) | W/X 应用转发配置 | 同上 | POST K/edge/apply {reload:true} | 声明备份/验证/重载/失败回滚合同；非已证事实 | not verified：真实回滚、reload 与权限 |
| T20 TK(session-runtimes) / TK(network-access) / TK(edge-forwarding) | R 看受管工具、tmux/psmux、接入工具能力 | `C/toolkit/ManagedToolsPanel.tsx`；`C/toolkit/use-managed-tools.tsx` | toolkitAPI.listTools → K/tools；category 过滤 | categories 是入口分类，不等于各 OS 都支持 | not verified：实际工具/版本 |
| T21 同 T20 | X 安装工具 | use-managed-tools runAction | planManagedToolAction/executeManagedToolAction | 先计划确认；工具 ID 范围固定 | not verified：平台、下载与权限 |
| T22 同 T20 | X 更新工具 | 同上 action=update | K/tools/plan、execute；jobs/:id | 受管任务与真实版本分开 | not verified：已有会话兼容 |
| T23 同 T20 | X 卸载工具 | 同上 action=uninstall | 同上 | 危险确认；不顺带结束无关会话 | not verified：进程/数据保留 |
| T24 同 T20 | W 配置文件编辑/保存 | `C/toolkit/ManagedToolConfigModal.tsx`；`C/toolkit/use-managed-tool-config.ts` | get/saveToolConfig → K/tools/:id/config | 只保存明确工具配置，不假称服务已重载 | not verified：语法、冲突与备份 |
| T25 TK(network-access) / TK(edge-forwarding) | X 启动/停止/重启工具服务 | `C/toolkit/ToolServiceControls.tsx`；`C/toolkit/use-tool-service.ts` | controlToolService → K/tools/:id/service | start/stop/restart 区分并按支持能力启用 | not verified：pid、端口、失败恢复 |
| T26 同上 | W 设置自启动/自动重启；生成初始配置 | `C/toolkit/use-tool-service.ts` | updateToolServiceSettings / createToolServiceConfig | 策略写入不是立即健康；新建不应覆盖旧配置 | not verified：系统服务注册与已有配置 |
| T27 同上 | R 查看服务日志 | `C/toolkit/ManagedToolLogsModal.tsx`；use-tool-service openLogs | getToolServiceLogs → K/tools/:id/service/logs | 日志读取不操作服务 | not verified：截断、敏感信息 |
| T28 TK(native-resources) | R 探测 Plugin/Skill/MCP 在 Provider/宿主的能力 | `C/toolkit/NativeResourcesPanel.tsx` | toolkitAPI.getNativeResources → K/native-resources | capability 决定动作；发现目录不等于资源可用 | not verified：原生发现/加载 |
| T29 TK(native-resources) | W/X 安装资源 | 同上 onAction('install') | toolkitAPI.operateNativeResource | 明确 provider/host/kind/capability | not verified：路径投影、版本/权限 |
| T30 TK(native-resources) | W 启用/停用资源 | 同上 enable/disable | 同上 | 不将宿主开关当所有 Provider 同步完成 | not verified：配置持久化与原生刷新 |
| T31 TK(native-resources) | W 移除资源 | 同上 remove | 同上 | 仅资源范围，保留非 AIH 内容 | not verified：删除边界 |
| T32 TK(native-resources) | X/$ 运行资源 test/demo | 同上 test/demo | 同上 | test/demo 是有副作用业务动作，不是本次验收已执行 | not verified：真实闭环与费用 |
| T33 TK(aih-plugins) | R 插件清单/权限/doctor | `C/toolkit/AihPluginPanel.tsx` | toolkitAPI.getAihPlugins/getAihPluginDoctor → **/v0/plugins**、/doctor | 这是 /v0/plugins，不错写为 K/plugins | not verified：签名、RPC/宿主健康 |
| T34 TK(aih-plugins) | W 启用/停用插件实例 | 同上 operate | POST /v0/plugins/enable、disable | instanceId 与 pluginId/version 分开 | not verified：权限撤销与进程状态 |
| T35 TK(aih-plugins) | W 卸载插件版本 | 同上 | POST /v0/plugins/uninstall | 指定 pluginId/version，不影响其他版本 | not verified：版本引用与清理 |
| T36 TK(aih-plugins) | X/$ 运行闭环 demo | 同上 runDemo | POST /v0/plugins/demo | 结果必须来自执行报告，不按按钮存在宣称完成 | not verified：真实副作用与清理 |
| T37 TK(environment) | R 选择本机/SSH target、语言运行时并探测 | `C/toolkit/EnvironmentPanel.tsx`；`C/toolkit/use-environment-resources.tsx`；`P/toolkit-url-state.ts` | getToolkitTargets/getEnvironments → K/environments、targets | target=ssh:conn_… 不得落到本机执行；未知 target 归一规则显式 | not verified：SSH 权限、探测超时 |
| T38 TK(environment) | X 安装运行时工具 | use-environment-resources runAction | planEnvironmentToolAction/executeEnvironmentToolAction，携带 target | plan 与 execute 的目标相同 | not verified：远程安装和进度 |
| T39 TK(environment) | X 更新运行时工具 | 同上 action=update | K/environments/plan、execute | 更新目标与版本来源可追溯 | not verified：已运行项目兼容 |
| T40 TK(environment) | X 卸载运行时工具 | 同上 action=uninstall | 同上 | 显式危险确认；不删除项目文件 | not verified：系统依赖与回退 |
| T41 TK(mirrors) | R/X 查看镜像并测试延迟 | `C/toolkit/MirrorManagerPanel.tsx`；`C/toolkit/use-mirror-manager.ts` | getMirrors / pingMirror → K/mirrors、ping | 测速是网络请求；实测与已配置分别展示 | not verified：Direct HEAD/TTFB、可达性 |
| T42 TK(mirrors) | W 设置所选软件源 | 同上 setMirror | POST K/mirrors/set | kind 与 URL 对应；说明不替代实际配置 | not verified：包管理器读取与恢复 |
| T43 TK(proxy-diagnostics) | R 读取系统/进程/网关代理配置 | `C/toolkit/ProxyDiagnosticsPanel.tsx`；`C/toolkit/use-proxy-diagnostics.ts` | toolkitAPI.getProxy → K/proxy | 探测值、手工配置、运行观察分开 | not verified：环境继承与真实配置 |
| T44 TK(proxy-diagnostics) | W 应用探测值/手输保存/清除代理 | 同上 saveProxy | POST K/proxy/set {target,value} | target 不混淆；清除为空值动作明确 | not verified：后续请求实际出口 |
| T45 TK(proxy-diagnostics) | X 按直连/网关代理重测端点 | 同上 testConnectivity | toolkitAPI.testConnectivity → K/connectivity | 无代理时不能把 direct 结果伪装代理 | not verified：真实出口/IP/错误归因 |
| T46 TK(subscription-aggregator) | W 新增/编辑订阅源、预览粘贴/文件、手动节点 | `C/toolkit/subscription-aggregator/SubscriptionAggregatorPanel.tsx`；`SourceEditorModal.tsx`；`ManualNodeModal.tsx` | 同目录 subscription-aggregator-api：K/subscription-aggregator/sources、sources/preview、nodes/parse | 订阅源/手动节点/聚合 profile 分开；URL 参数不泄露 | not verified：格式兼容、凭据与节点真实性 |
| T47 同上 | R/W 扫描本地客户端来源并选择导入 | `C/toolkit/subscription-aggregator/LocalClientScan.tsx`；`use-subscription-aggregator.ts` | local-sources；local-sources/import | 只导入明确选择 ID，不自动全机收集 | not verified：权限、去重、敏感内容 |
| T48 同上 | W 启停/删除订阅源 | `C/toolkit/subscription-aggregator/use-subscription-aggregator.ts` | sources/:id/enabled；DELETE sources/:id | 停用保留节点但不进入聚合/出口池；删除有确认 | not verified：被引用源的处理 |
| T49 同上 | X 同步单源/全部启用源并看进度 | `C/toolkit/subscription-aggregator/use-source-sync.ts` | sources/:id/sync、sources/sync、sync/watch | 停用源不参与批量；job 与最终节点分开 | not verified：网络失败、部分成功与 SSE |
| T50 同上 | R/X 看源节点、测延迟、设置链路 | `C/toolkit/subscription-aggregator/SourceNodesDrawer.tsx`；`NodeChainModal.tsx` | sources/:id/nodes、latency；nodes/chain | 节点稳定 ID、链路顺序保留 | not verified：实际节点可用性与链环 |
| T51 同上 | W 新建/编辑聚合 profile、分组/规则/用途 | `C/toolkit/subscription-aggregator/ProfileEditorDrawer.tsx`；`CustomGroupsEditor.tsx`；`CustomRulesEditor.tsx`；`GroupUsageEditor.tsx` | POST profiles；profiles/nodes | 草稿与已发布订阅分离；规则顺序不擅改 | not verified：客户端格式与分流语义 |
| T52 同上 | R/L 预览 profile、复制订阅/导入客户端 | `C/toolkit/subscription-aggregator/ProfilePreviewModal.tsx`；`ImportProfileModal.tsx`；`SubscriptionLinkField.tsx` | profiles/:id/preview、import-links；local-clients | 带 token 链接是敏感结果；不称客户端已成功导入 | not verified：外部 scheme 与真实拉取 |
| T53 同上 | W 重置订阅 token / 删除 profile | `C/toolkit/subscription-aggregator/SubscriptionAggregatorPanel.tsx` | POST profiles/:id/token；DELETE profiles/:id | 轮换使旧链接失效的风险需确认 | not verified：撤销、缓存与依赖客户端 |
| T54 同上 | X 测路由/端口连通，查看 relay/近期拉取 | `C/toolkit/subscription-aggregator/RouteTester.tsx`；`ProbePanel.tsx`；`RecentPulls.tsx` | profiles/test-route；probe；relay / overview | 配置选择与实测结果分别显示 | not verified：真实目标、超时与出口 |
| T55 TK(egress-pool) | R/X 分页筛选出口节点、探测单个/全池、选节点 | `F/egress-pool/EgressPoolPanel.tsx`；`F/egress-pool/egress-pool-api.ts` | W/egress-pool；/probe；/nodes/:node/select | version/304 复用旧快照；选择不等于可达 | not verified：大量节点、304、真实流量 |
| T56 TK(egress-pool) | W 清冷却、封禁/放行、清全部手动禁用、改延迟/不可达策略 | 同上 | nodes/:node/clear-cooldown、block/unblock；node-policy、clear-disabled | 手动禁用与自动冷却分开；业务 409 保留结构化原因 | not verified：重启持久化、策略对流量影响 |
| T57 TK(egress-upstreams)；TK(geo-resources) | 分别见 [E01–E09](#egress) 地区证据/账号批量绑定、Geo 数据安装 | `F/egress-upstream/EgressUpstreamPanel.tsx`；`F/geo-resource/GeoResourcePanel.tsx` | W/egress-upstreams；W/geo-resources | 两个实际 panel，不能只列目录 | not verified：地区判定、库新鲜度 |
| T58 `/toolkit/install-guide` | R 选平台/语言插件/工具，重新读取指南 | `P/ToolkitInstallGuide.tsx` | toolkitAPI.getEnvironmentGuide → K/environments/guide | 指南以返回目录为源，文件存在不是跨平台支持 | not verified：真实平台命令有效性 |
| T59 `/toolkit/install-guide`；TK(mirrors) | L 填参数、生成/复制任务命令 | `C/toolkit/GuidedCommandPanel.tsx`；`C/toolkit/guided-command.ts`；`C/toolkit/CopyableCommand.tsx` | 本地模板渲染/剪贴板 | 缺参禁用；只生成与复制，不执行环境变更 | not verified：引号/路径转义；CLI 语义另账 |

<a id="egress"></a>
### 3.10 上游地区策略、批量出口与 Geo 资源

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| E01 `/toolkit?panel=egress-upstreams` | R 选上游、筛节点、看地区证据与受影响账号 | `F/egress-upstream/EgressUpstreamPanel.tsx`；`F/egress-upstream/use-account-egress-summary.ts` | egressUpstreamAPI.view；watchEgressUpstreams | 规则/提示/实测、direct/pool 分开 | not verified：真实地区、证据 TTL |
| E02 同上 | W 保存允许/拒绝地区规则与证据有效期 | `F/egress-upstream/RegionRulesEditor.tsx`；EgressUpstreamPanel | PUT W/egress-upstreams/:id | 不把地区名猜测当实测；规则顺序/匹配字段保留 | not verified：边界、默认策略与生效 |
| E03 同上 | X 探测单节点/上游全部节点 | EgressUpstreamPanel；`F/egress-upstream/egress-upstream-api.ts` | POST :id/probe | 页面无凭据探测说明不等于所有模式不会用凭据 | not verified：出站请求与凭据边界 |
| E04 同上 | W 重置一条/全部实测证据 | 同上 | POST :id/evidence/reset | 清证据不是更改地区规则，也不是立即可用 | not verified：重新探测/回退 |
| E05 同上 | X 刷新本机出口位置 | 同上 | POST W/egress-upstreams/network/refresh | 当前 Server 的本机，不是浏览器机器 | not verified：公网 IP 与代理链 |
| E06 同上；`/accounts` 批量出口 | W 选账号并批量绑定出口/池范围 | `F/egress-upstream/BulkEgressModal.tsx`；`F/egress-upstream/AccountEgressBulkPicker.tsx`；`F/egress-upstream/PoolScopePicker.tsx`；`F/egress-upstream/bulk-egress.ts` | accountsAPI.saveAccountEgressAssignment | 逐账号成功/失败，不承诺跨账号事务；回链 A29/A37 | not verified：部分失败、范围与真实路由 |
| E07 `/toolkit?panel=geo-resources` | R 看国家/地区/城市/ASN 数据库能力与任务 | `F/geo-resource/GeoResourcePanel.tsx`；`F/geo-resource/geo-resource-api.ts` | GET W/geo-resources | installed/capabilities/provider availability 独立，不等于查询准确 | not verified：库版本、来源、查询 |
| E08 同上 | X 下载/更新/删除 Geo 数据资源 | GeoResourcePanel；geoResourceAPI.start | POST W/geo-resources/jobs {resourceId,action:install/update/uninstall} | 作业进度不冒充完整安装；删除有明确作用域 | not verified：网络、磁盘、损坏恢复 |
| E09 同上 | W 取消 Geo 作业 | geoResourceAPI.cancel | POST W/geo-resources/jobs/:id/cancel | 取消不等于已落盘文件回退 | not verified：取消清理与并发 |

<a id="image"></a>
### 3.11 AI 生图工作区

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| I01 `/studio/image` | R 读取模型路线/可用账号、会话列表及当前修订 | `F/image-studio/ImageStudioWorkspace.tsx`；`ImageStudioSessionRail.tsx` | imageStudioAPI.listModels/listSessions/getSession | availableAccountCount 不等于所有模型均可生成 | not verified：真实模型能力和账号 |
| I02 同上 | W 新建影像会话 | ImageStudioWorkspace handleCreateSession | POST W/studio/image/sessions | 与 Chat 会话领域分开；首次空列表会自动创建 | not verified：初始化副作用、重复创建 |
| I03 同上 | W 重命名会话 | handleRename | PATCH W/studio/image/sessions/:id | 会话 ID 不随名称变化 | not verified：名称长度、并发 |
| I04 同上 | W 删除会话 | handleDeleteSession | DELETE 同路径 | 删除当前会话后选其余或新建；资产归属不可串 | not verified：资源清理/恢复可能性 |
| I05 同上 | R/L 切换修订/新窗打开/主动刷新 | handleSelectSession / handleOpenWindow / handleRefreshCurrent；`ImageStudioRevisionStrip.tsx` | getSession/listSessions/listModels；URL session selection | 目标 session 与 active revision 分开 | not verified：深链接、异步竞态 |
| I06 同上 | L 选模型/生成或编辑、数量/尺寸/质量/背景/格式/压缩/moderation | `F/image-studio/ImageStudioComposer.tsx`；`image-studio-options.ts` | run 输入；模型 capabilities | unsupported 参数不凭控件名算支持 | not verified：各模型限制与错误返回 |
| I07 同上 | L 上传/移除源图、上传/清除遮罩 | ImageStudioWorkspace handleSourceFiles / handleMaskFile | 文件 data URL → run input | 源图数量/遮罩能力、类型/尺寸约束保留 | not verified：大文件、格式、遮罩坐标 |
| I08 同上 | W/$ 提交生成/编辑任务 | handleRun；`F/image-studio/image-studio-utils.ts` | POST W/studio/image/sessions/:id/runs | 结果归提交时 session；错误不吞输入 | not verified：真实生成、费用、超时恢复 |
| I09 同上 | L 从资产继续编辑 | handleContinueEdit | 存储 assetId → 下一次 run 的 source | 修订链与来源资产不丢失 | not verified：源资产存在/权限 |
| I10 同上 | L 复用历史修订参数/复制 prompt | handleReuseRevision / handleCopyPrompt | 本地输入/剪贴板 | 复用不是自动再次计费执行 | not verified：参数兼容与复制 |
| I11 同上 | R/L 查看/下载生成资产 | `F/image-studio/use-image-studio-assets.ts`；ImageStudioWorkspace handleDownload | GET W/studio/image/sessions/:id/assets/:assetId | blob 与 MIME、session 绑定；object URL 生命周期 | not verified：下载完整性、权限、资源释放 |

<a id="translation"></a>
### 3.12 翻译与全局选区浮层

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| L01 `/studio/translation`（旧 `/translation` 重定向） | R 读取语言/引擎/模型与偏好 | `F/translation/TranslationWorkspace.tsx`；`F/translation/use-translation.ts` | translationAPI.listLanguages/listModels/getSettings/listProviders | direct-provider 与 aih-server 可用语言/模型不混淆 | not verified：引擎可用性 |
| L02 同上 | L/W 源/目标语言、交换、模型、自动复制与目标策略设置 | TranslationWorkspace；`F/translation/translation-settings-store.ts` | translationAPI.saveSettings | 设置保存顺序与翻译请求一致，不能用旧路由 | not verified：保存竞争、重开恢复 |
| L03 同上 | X/$ 检测语言并翻译输入 | TranslationWorkspace handleTranslate；use-translation | POST W/translation/detect；W/translation/stream | auto/saved/targetPolicy 按意图；流完成与错误分开 | not verified：质量、流顺序、费用 |
| L04 同上 | L/X 停止翻译 | `F/translation/use-translation.ts` | AbortController / stream signal | 停止本地读取不保证上游未计费 | not verified：后端取消与资源释放 |
| L05 同上 | L 清空输入/结果、复制译文 | TranslationWorkspace handleClear/handleCopy | 本地状态/剪贴板 | 自动复制范围有明确 preference | not verified：剪贴板权限、取消期间清空 |
| L06 同上 | R/L 看历史、复制单条、删除单条、清空历史 | `F/translation/use-translation-history.ts`；`translation-history.ts` | 浏览器历史存储 | 本地历史不是服务端审计账；避免多记同一流 | not verified：隐私、容量与刷新一致 |
| L07 同上 → 引擎设置 | W 保存引擎字段/密钥 | `F/translation/TranslationProviderSettings.tsx` | translationAPI.saveProvider → W/translation/providers | secret 留空保留，普通字段有真实值 | not verified：存储脱敏/调用生效 |
| L08 同上 → 引擎设置 | W 清除指定密钥 | 同上 | saveProvider {secretField:''} | 显式清除不同于留空未填 | not verified：旧密钥撤销与错误反馈 |
| L09 同上 → 路由 | W 新增/编辑/启停/排序/移除翻译路由 | TranslationWorkspace handleAddRoute/handleRouteChange/handleMoveRoute | translationAPI.saveSettings routes；selection/batch/page/replace | 有序路由与 operation 限定保留 | not verified：回退、不同引擎参数兼容 |
| L10 同上 → 系统翻译 | X 启用/禁用系统翻译 | `F/translation/SystemTranslationControl.tsx` | getSystemStatus/setSystemEnabled → W/translation/system | 开关与系统权限、平台支持不同状态 | not verified：OS 服务/选区监听 |
| L11 同上 | X 请求系统权限 | SystemTranslationControl | translationAPI.requestSystemPermission | 必须明确用户触发；不能绕过平台授权 | not verified：权限对话/拒绝恢复 |
| L12 同上 | W 切执行目标和 Server | SystemTranslationControl | setSystemExecutionTarget / setSystemServerTarget | 本机/远端 Server/direct-provider 不混选或泄漏密钥 | not verified：真实路由和离线回退 |
| L13 常规 Web 布局选区浮层；`/studio/translation` 页面操作 | X/$ 选区/整页翻译、停止、保留原文/撤回 | `F/translation/TranslationFloatingPanel.tsx`；`page-translation.ts`；TranslationWorkspace | translationAPI.stream；DOM selection/page | 原始 DOM/选区可恢复；全局挂载受 data-plane gate 限制 | not verified：跨源/复杂 DOM/焦点与撤回 |
| L14 常规 Web 浮层 | L 拖动定位、复制结果、关闭浮层 | `F/translation/use-floating-panel-position.ts`；TranslationFloatingPanel | 浏览器状态 | 关闭浮层不能误改输入原文 | not verified：选区保留/快捷键冲突 |

<a id="settings"></a>
### 3.13 基础设置、模型别名与异常映射

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| S01 `/settings` basic | R 读取/重置为已存配置 | `P/Settings.tsx` loadConfig；`F/settings/settings-config.ts` | configAPI.get/getServer；serverProfilesAPI.listEndpointHints | 重置表单不是恢复出厂/删除服务配置 | not verified：默认值与失败部分响应 |
| S02 同上 | W 保存额度阈值/轮询周期 | handleSave；settings-config toUsageConfig | POST W/config | 百分比/秒单位及最小值边界保留 | not verified：后端实际刷新节奏 |
| S03 同上 | W 保存网络开放/host/port/API key/Management Key | `F/settings/save-server-config.ts`；`S/management-key-rotation.ts` | configAPI.updateServer / rotateManagementKey → W/server-config | server key 与管理授权分开；密钥轮换要同步本地授权 | not verified：绑定端口、掉线/轮换恢复 |
| S04 同上 | X 重启管理服务 | `F/settings/use-management-restart.ts` | managementAPI.restart → POST W/server/restart | 不是保存自动重启；重启就绪需实际观察 | not verified：进程重启、连接恢复 |
| S05 同上 | L 主题、CRT、声音反馈 | `F/settings/use-appearance-settings.ts`；`S/hud-preferences.ts` | theme/HUD 本地持久化 | 外观不影响业务/权限；浏览器状态与 Server 配置分开 | not verified：桌面视觉、主题恢复、音频限制 |
| S06 同上 | W 长粘贴阈值 | `F/chat-runtime/LargePasteSettingCard.tsx`；`use-large-paste-settings.ts` | chatPasteSettingsAPI → W/chat/paste-settings | 大段折叠不丢原文，不改普通发送语义 | not verified：粘贴/IME/跨会话同步 |
| S07 同上 | L 设置截图/录制格式、方式、预览设备、水印与格式开关 | `F/capture/CaptureSettingsCard.tsx`；`F/capture/capture-preferences.ts` | localStorage aih.capture；capability 检测 | 不支持格式不启用；同偏好供聊天预览消费 | not verified：浏览器编码能力和视觉；见 X05/X06 |
| S08 `/settings?tab=aliases` | R 模型别名分组与目标候选 | `P/ModelAliases.tsx`；`F/model-aliases/use-model-aliases.ts` | modelAliasesAPI.getAll/listTargets；modelsAPI.listCatalog | 多 target 存多记录，UI 可分组但不丢底层身份 | not verified：实际别名解析与目标可用性 |
| S09 同上 | W 新增别名/多个目标 | use-model-aliases；ModelAliases handleModalOk | POST W/model-aliases/replace，records | 同名目标不折叠成单条不可逆配置 | not verified：原子性、重名/优先级 |
| S10 同上 | W 编辑已有别名组 | 同上，replaceIds | 同上 | 仅替换明确 IDs；不改未选分组 | not verified：并发编辑与路由缓存 |
| S11 同上 | W 启停别名记录 | use-model-aliases | POST W/model-aliases/:id/toggle | 停用不是删除；组状态来自成员 | not verified：多目标回退语义 |
| S12 同上 | W 删除别名组 | ModelAliases；use-model-aliases | replace(ids,[]) | 确认会删除组内全部记录 | not verified：引用/路由同步 |
| S13 `/settings?tab=upstream-errors` | R 读取错误映射组与规则 | `P/UpstreamErrorMappings.tsx`；`F/accounts/UpstreamErrorRulesEditor.tsx` | GET W/upstream-error-mappings | Provider 范围/匹配条件与标准账号状态分开 | not verified：真实错误体命中 |
| S14 同上 | W 新建/编辑映射组 | UpstreamErrorMappings openCreate/openEdit/submit | upstreamErrorMappingsAPI.create/update | 规则不得任意扩大冻结/凭据失效判定 | not verified：规则优先级、HTTP 与 body 联合条件 |
| S15 同上 | W 启停/删除映射组 | UpstreamErrorMappings | :id/toggle；DELETE :id | 删除有确认；账号引用需保持一致 | not verified：引用完整性与调度效果 |

<a id="servers"></a>
### 3.14 Server 引导、切换与 SSH 开发机

`/servers`、`/ssh-hosts` 是 Settings 的独立 section 包装，不应凭 `Settings.tsx` 中存在 section 配置就声称 `/settings` 展示了所有 Tab。

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| H01 `/servers`；`/server-setup` | R 查看已保存 Server、候选 endpoints、授权/连接摘要 | `P/Settings.tsx`；`P/ServerSetup.tsx`；`S/control-plane-profiles.ts`；`S/server-route-presentation.ts` | shared profiles/bootstrap；W/control-plane/endpoints | configured/ready/authorizationPending 不混同 | not verified：真实节点/同步来源 |
| H02 同上 | W 添加或编辑/补充 Server URL、名称、Management Key | Settings handleSaveControlPlane；ServerSetup handleSaveServer；`S/control-plane-profile-connection.ts` | connectControlPlaneProfile + profile 保存/校验链 | key 不进 URL；Server 身份不能只由显示名称决定 | not verified：TLS/鉴权、保存与共享范围 |
| H03 同上 | R/X 同步当前/全部 Server 状态 | Settings handleRefreshControlPlane / handleRefreshAllControlPlanes | control-plane client / refresh profile | 单节点失败不伪装整组成功 | not verified：离线、超时、路由候选切换 |
| H04 同上 | L 切换 active Server | Settings handleSelectControlPlane；server selection services | active profile / route selection + 数据重载 | 各账号、会话、终端按 Server 隔离 | not verified：跨页请求/缓存/终端隔离 |
| H05 同上 | W/L 移除保存的 Server | Settings handleRemoveControlPlane；ServerSetup handleRemoveProfile | removeControlPlaneProfile | 移除连接资料不等于删除远程服务/账号 | not verified：active 删除后的门禁与回退 |
| H06 `/servers` | L 复制 Server endpoint | Settings handleCopyServerEndpoint | 剪贴板 | 复制 endpoint 不泄露 Management Key | not verified：真实内容与权限 |
| H07 `/server-setup` | W 完成强制补授权/首次引导 | `P/ServerSetup.tsx`；`S/server-setup-state.ts`；`S/server-profile-gate.ts` | connection + gate state | 无有效 profile 不强行进入数据平面 | not verified：401、过期 key、重复授权 |
| H08 `/server-setup` | L 进入工作台/转 Server 管理 | `P/ServerSetup.tsx` | `/`、`/servers` | readiness 决定能否进入；不是免鉴权旁路 | not verified：导航/深链接恢复 |
| H09 `/ssh-hosts` | R 查看连接和工作区、刷新隧道状态 | `P/SshHostsPanel.tsx`；`F/ssh-hosts/use-ssh-hosts.ts` | GET W/ssh-connections、ssh-workspaces；tunnels/watch | 连接、工作区、反向隧道分开 | not verified：SSH 和 tunnel 实际存活 |
| H10 同上 | W 新建/编辑 SSH 连接 | use-ssh-hosts saveConnection；`F/ssh-hosts/ssh-hosts-model.ts` | createConnection/updateConnection → W/ssh-connections | key/password/agent 等认证字段按表单合同处理 | not verified：凭据存储与 host-key 验证 |
| H11 同上 | X 测试连接 | use-ssh-hosts testConnection | POST W/ssh-connections/test | 测连接不是运行开发任务 | not verified：认证失败、超时、主机身份 |
| H12 同上 | W 删除 SSH 连接 | use-ssh-hosts deleteConnection | DELETE W/ssh-connections/:id | 不能把删除资料当远端销毁 | not verified：工作区依赖与活动隧道 |
| H13 同上 | R 浏览远程目录并选择根目录 | use-ssh-hosts useSshDirectoryBrowser；SshHostsPanel | GET W/ssh-hosts/browse | connectionId/subDir 作用域；不是本机目录 | not verified：路径、权限与符号链接 |
| H14 同上 | W 新建/编辑远程工作区 | use-ssh-hosts saveWorkspace | W/ssh-workspaces 创建/更新 | workspace 与 connection 绑定；根目录/同步字段保留 | not verified：远程路径真实存在 |
| H15 同上 | W 删除远程工作区登记 | use-ssh-hosts deleteWorkspace | DELETE W/ssh-workspaces/:id | 登记删除不承诺删除远程文件 | not verified：活动会话与文件保护 |
| H16 `/ssh-hosts` → 工具；`/chat` Work 远程列表 | R/L 进入 SSH 环境工具/选择工作区进入 Work | `C/settings/SshHostCardLists.tsx`；`F/ssh-hosts/RemoteWorkspacesPanel.tsx`；`P/toolkit-url-state.ts` | `/toolkit?panel=environment&target=ssh:…`；workspace session list | 保留目标 connection/workspace，不能悄然切本机 | not verified：远端工作台可用范围 |
| H17 `/chat` Work 远程列表；SSH 工作区操作 | X 打开远端 shell/Claude/Codex 终端、接回或本机原生窗口 | RemoteWorkspacesPanel；`F/web-terminal/use-open-remote-workspace-terminal.ts` | POST W/ssh-workspaces/:id/terminal，agent/native/fresh | Web attach 与 Server 本机原生窗口区分；存活标记不等于已接回 | not verified：真实 SSH/原生终端；CLI 内部语义另账 |
| H18 `/servers`、`/server-setup` 的 Management Key 表单 | L/X 扫描 Server 凭据二维码，填入待提交表单 | `C/control-plane/ManagementKeyInput.tsx` → `C/control-plane/ManagementKeyQrScanner.tsx`；`S/management-key-qr-reader.ts` | 浏览器扫码/QR 文档解析；onCredentials 不自动提交 | expectedEndpoint 校验；只填草稿，连接仍由 H02/H07 明确提交 | not verified：摄像头/图片来源、错误 endpoint、密钥隐私 |

<a id="preview"></a>
### 3.15 独立 Go 账号预览

只在 `AIH_GO_ACCOUNTS_PREVIEW=1` 的路由表下成立。入口 `/accounts` 与正式同名但组件、transport、API 合同不同。`P/AccountsGoPreview.tsx` 限定 `codex`、`claude`，不得外推全 Provider 或生产迁移完成。

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| P01 预览 `/accounts` | R/L 读列表、状态/厂商过滤、定位/复制账号、刷新 | `P/AccountsGoPreview.tsx`；`S/account-management/facade.ts`；`client.ts` | GET V/accounts，keyset 分页；facade watch coordinator | 不为每个账号额外刷新 usage/models；独立 preview origin | not verified：Go 服务运行、分页/状态投影 |
| P02 同上 | W 添加 Codex/Claude 静态凭据账号 | AccountsGoPreview handleAdd；facade.add；client.createStaticAccount | POST V/accounts | provider/auth 类型经 decoder 验证；不承诺 Device OAuth/Vertex | not verified：凭据验证与重复身份 |
| P03 同上 | W 启动 OAuth 或已有账号 reauth | handleAdd/handleReauth；client.startOAuthJob | POST V/account-auth-jobs，target_account_ref | 新增与续授权目标区分 | not verified：真实 Provider OAuth |
| P04 同上 | W 提交浏览器回调 | handleSubmitBrowserCallback；client.completeOAuthJob | POST V/account-auth-jobs/:id/callback | 非空/长度/控制字符检查；job 绑定 | not verified：回调重放/过期 |
| P05 同上 | W 取消 OAuth | closeAuthProgress；client.cancelOAuthJob | DELETE V/account-auth-jobs/:id | 不把取消展示当取消服务任务 | not verified：并发回调与取消 |
| P06 同上 | W 编辑凭据 | handleEditSubmit；client.rotateCredential | PUT V/accounts/:ref/credential | 仅支持合同内模式/字段；正式异常映射功能不自动迁入 | not verified：凭据轮换、留空与刷新 |
| P07 同上 | W 启停账号/设置或取消默认 | handleToggleStatus/handleSetDefault；client | PATCH V/accounts/:ref；PUT/DELETE V/account-defaults/:provider | configured 条件与 Provider 范围默认保留 | not verified：Go 调度实际采用 |
| P08 同上 | W 删除账号 | handleDelete；client.deleteAccount | DELETE V/accounts/:ref | 删除有确认；不引入正式页 force 语义 | not verified：运行中引用、持久化清理 |
| P09 同上 | W 按需刷新额度 | handleRefreshUsage；client.refreshUsage | POST V/accounts/:ref/usage/refresh | 同步响应是已持久快照，不伪装后台 Job | not verified：真实额度和错误字段 |
| P10 同上 → 模型弹窗 | R/W 查看/刷新模型、inherit/force_enable/force_disable 策略 | openModelManagement；client list/refreshAccountModels/setAccountModelPolicy | GET/POST V/accounts/:ref/models[/refresh]；PATCH /models {model_id,manual_policy} | 模型在弹窗而非正式 R21；人工策略不等于上游能力 | not verified：探测、策略与快照一致 |
| P11 同上 → 导入 | W UI 文件/粘贴迁移 JSON → façade 原生 artifact 导入 | AccountsGoPreview validateSub2APIContent/handleImportSubmit；`S/account-management/import-policy.ts` | 理论下游 POST V/account-imports；前端验证合同冲突，见 **SG01** | 应使用原生 artifact 合同；不恢复废弃格式来掩盖差异 | not verified：真实导入；当前 UI 模板不能证明可用 |
| P12 同上 → 导出 | R/L 菜单“导出迁移 JSON” | AccountsGoPreview buildAccountMenuItems/handleExportAccount；facade.exportAccount | **本地直接 unsupported，不发导出请求；见 SG02** | 可见按钮不是已支持导出；不能伪造下载成功 | not verified：运行时错误反馈；源码已证拒绝路径 |

<a id="global-web"></a>
## 4. 跨路由 Web 功能（只记挂载和用户入口，不盘点 shell 实现）

`web/src/app.tsx` rootContainer 挂载 WebTerminalManagerProvider/GlobalWebTerminalHost；常规 layout childrenRender 在 data-plane gate 可用时挂载任务队列、翻译浮层和 ChatMiniWindow。**`layout:false` 的 QuickChat/Go 预览不自动计为具备这些 layout 子项**，应按实际挂载逐项验证。

| 入口 | 子功能/动作 | 主源码 | API/领域映射（可证） | 原行为不变量 | 验证缺口 |
|---|---|---|---|---|---|
| X01 `/accounts`、`/toolkit` 安装/活动 → 常规 Web 任务队列 | R 查看任务、筛选安装/活动、翻页、复制日志、关闭结果 | `C/task-queue/AppInstallTaskQueue.tsx`；`F/app-install/app-install-presentation.ts`；`S/webui-task-queue.ts` | listActiveWebUiTasks/watchWebUiTasks；app-install job/watch | 任务 DONE/结果关闭不等于应用已打开/奖励到账 | not verified：重连、重复结果、敏感日志 |
| X02 同上 | X 重试允许重试的失败安装动作/安装后开应用 | AppInstallTaskQueue retryTask；`F/app-install/launch-required-action.ts` | executeTerminal/Environment/ManagedTool/AppAction 按任务类型派发 | canRetryWebUiTask gate；任务原目标/kind 应保留 | not verified：重试幂等、远端 target、最终启动 |
| X03 `/chat` 项目终端；`/accounts` CLI；TK(terminals)；H17 | X 打开/接回 Web terminal，输入、粘图、resize、关闭进程 | `F/web-terminal/use-open-project-terminal.ts`；`use-open-remote-workspace-terminal.ts`；`C/chat/ShellTerminalPanel.tsx` | terminalAPI open/attach/input/clipboard-image/resize/close；W/terminal/mux | serverId/sessionKey/termId/muxId 各自用途；认证走 header 不入 URL | not verified：PTY、真实 resize/粘贴、进程结束 |
| X04 上述终端全局宿主 | L 拖动/缩放/最小化、多标签切换/关闭与重开恢复 | `F/web-terminal/GlobalWebTerminalHost.tsx`；`web-terminal-context.tsx`；`use-terminal-window-gesture.ts` | 浏览器按 Server 保存 terminal layout；实际终端 API 见 X03 | UI 窗口隐藏/关闭 tab 与结束进程不能混为一谈 | not verified：跨路由恢复、Server 切换 |
| X05 `/chat`、`/chat/quick` HTML 消息 → 预览/代码视图 | L/R 独立预览窗口、代码复制、PNG 截图、代码美化截图 | `C/chat/HtmlCodeBlock.tsx`；`C/chat/capture-bridge.ts`；`F/capture/capture-controller.ts`；`F/capture/code-beautify.ts` | 浏览器渲染/Canvas/Blob；无独立后端 API 可证 | iframe/代码内容保真；预览设备是输出选项，不是移动端支持验收 | not verified：CSP、跨源资源、字体和下载 |
| X06 同上；`/settings` S07 | L 选格式/时长/设备、独立窗口录制并下载 | `C/chat/html-preview-window.ts`；`F/capture/RecordingSettingsModal.tsx`；`F/capture/format-availability.ts`；`F/capture/preview-encode-dispatch.ts` | encoder registry + 浏览器能力/本地偏好 | APNG/GIF/WebM 编码文件存在不等于当前浏览器支持；水印预览/产物规则保留 | not verified：编码、动画帧率、音视频/内存与取消 |
| X07 常规 Web 布局 | L 快捷键打开/关闭、固定/取消固定、拖动 Chat mini window | `F/chat-runtime/ChatMiniWindow.tsx`；`web/src/app.tsx` | createPortal 直接挂载 MiniRuntime，不是 QuickChat iframe | 与 layout:false 的 `/chat/quick` 是不同外壳；保留键位/关闭语义 | not verified：键位冲突、焦点、窗口定位 |
| X08 常规 Web Chat mini window | W/$ 恢复或新建临时会话、选择账号并使用聊天操作 | `F/chat-runtime/ChatMiniWindow.tsx` MiniRuntime → useSessionRuntime / SessionWorkspace | sessionsAPI.getChatSessions + Canonical API/commands | 原页面持有 persisted canonical 会话时避免双重写；打开时读取当前 selection | not verified：小窗/主页所有权、草稿、账号切换；不等同 QuickChat 路由验收 |

<a id="feature-coverage"></a>
## 5. 22 个 feature 目录的反向覆盖（不是目录即能力）

本表仅作“实际引用 → 可达入口 → 上述叶子行”索引；未计入路由数/动作数。没有独立路由不代表没有入口，存在文件也不代表所有导出都挂载。

| feature 目录 | 实际路由/宿主交叉链接 | 可证消费链与主文件 | 叶子行 | 尚待证明 |
|---|---|---|---|---|
| `account-status` | [/accounts](#accounts) | Accounts → useAccountOutcomes / GlobalStatusPanel / AccountHealthIcon | A02 | not verified：健康事件口径 |
| `accounts` | [/accounts](#accounts)、[预览 /accounts](#preview)、[计划任务](#tasks)、[异常映射](#settings) | Accounts hooks/FlowModals；preview 复用认证/状态片段；ScheduledTasks → ActivityParamFields；UpstreamErrorMappings → RulesEditor | A01–A37、P01–P12、J05、S13–S15 | not verified：共享片段不等于 Node/Go 合同一致 |
| `app-install` | [/accounts](#accounts)、[TK(apps/terminals/environment)](#toolkit)、[任务队列](#global-web) | launch-required-action / app-install-presentation 被启动与任务 UI 引用 | A24、T02–T04、X01–X02 | not verified：安装/重试/实际启动 |
| `capture` | [/settings](#settings)、[/chat 与 quick 消息预览](#global-web) | CaptureSettingsCard；HtmlCodeBlock → capture bridge/controller | S07、X05–X06 | not verified：浏览器编码/资源 |
| `chat-runtime` | [/chat、/chat/quick](#chat)、[常规布局 mini window](#global-web)、[/settings](#settings) | CanonicalChatRuntime/SessionWorkspace；ChatMiniWindow；LargePasteSettingCard | C02、C08–C24、C30–C35、C37–C38、S06、X07–X08 | not verified：canonical 协议/Provider 能力 |
| `chat-workspace` | [/chat、/chat/quick](#chat) | ChatWorkspaceLayout、useProjectCatalog、useProjectDialogs | C01–C07、C30、C36 | not verified：项目/会话恢复 |
| `dashboard` | [/dashboard](#dashboard) | Dashboard → useGatewayDashboard / presentation | D01–D05 | not verified：生产指标 |
| `egress-pool` | [TK(egress-pool)](#toolkit) | Toolkit renderPanel → EgressPoolPanel → egressPoolAPI | T55–T56 | not verified：池实际选择 |
| `egress-upstream` | [TK(egress-upstreams)](#egress)、[/accounts](#accounts) | EgressUpstreamPanel；AccountEgressBadge/BulkPicker；bulk-egress | E01–E06、A29、A37 | not verified：地区证据/批量赋值 |
| `geo-resource` | [TK(geo-resources)](#egress) | Toolkit → GeoResourcePanel → geoResourceAPI | E07–E09 | not verified：数据库和作业 |
| `image-studio` | [/studio/image](#image) | StudioImage → ImageStudioWorkspace/Composer/资产 hook | I01–I11 | not verified：上游图片生成 |
| `model-aliases` | [/settings?tab=aliases](#settings) | Settings → ModelAliases → useModelAliases | S08–S12 | not verified：路由解析 |
| `model-usage` | [/usage](#usage)、[R22 quota](#quota) | ModelUsage 查询/展示；AccountQuota 复用 formatCost/formatTokens | U01–U08、Q03 | not verified：口径/完整账本 |
| `models` | [/models、R21](#models) | Models → model-catalog/account-models/价格表单 | M01–M08 | not verified：模型可调用/价格 |
| `project-workbench` | [/chat Work；/chat/quick triple](#chat) | ChatConversationContent → ProjectWorkbench → panel host/files/review/browser | C25–C29 | not verified：文件信任/恢复/iframe |
| `provider-config` | [TK(apps) → 高级设置](#toolkit) | AppAdvancedSettingsModal → ProviderConfigPanel/History/Export/Inspector | T09–T12 | not verified：原生配置读取 |
| `quota-stats` | [R22 /accounts/:provider/:accountRef/quota](#quota) | AccountQuota → useQuotaStats/窗口和桶图表 | Q01–Q04 | not verified：Provider 统计能力 |
| `settings` | [/settings](#settings)、[/servers](#servers) 经 Settings | settings-config/save-server-config/use-appearance-settings/use-management-restart | S01–S05；H01–H06 宿主 | not verified：配置落盘/服务恢复 |
| `ssh-hosts` | [/ssh-hosts](#servers)、[/chat Work](#chat) | SshHostsPanel → useSshHosts；Chat → RemoteWorkspacesPanel | H09–H17 | not verified：真实 SSH |
| `toolkit` | [TK(apps) → 高级设置](#toolkit) | AppManagerPanel → AppAdvancedSettingsModal/permission-catalog-view | T07–T08 | not verified：原生权限与 hooks |
| `translation` | [/studio/translation 与 /translation](#translation)、[常规 Web 浮层](#translation)、[Work 浏览器](#chat) | TranslationWorkspace/FloatingPanel；BrowserPanel → page-translation | L01–L14、C29 | not verified：引擎/系统权限/DOM |
| `web-terminal` | [/accounts CLI](#accounts)、[/chat Work](#chat)、[TK(terminals)](#toolkit)、[SSH 工作区](#servers)、[rootContainer](#global-web) | use-adopt/open-project/open-remote；WebTerminalManagerProvider/GlobalWebTerminalHost | A23、T13、H17、X03–X04 | not verified：server-scoped PTY/持久窗口 |

<a id="static-gaps"></a>
## 6. 高置信度静态合同缺口（不改代码，不冒充复现）

| 编号 / 入口 | 静态证据链 | 可证结论 | 不能据此声称 | 后续真实验收缺口 |
|---|---|---|---|---|
| **SG01** 预览 `/accounts` → 导入（P11） | `P/AccountsGoPreview.tsx:136-158` 的 SUB2API_TEMPLATE / validateSub2APIContent 要求 `type=sub2api-data`；`:953-963` 提交前必调用该验证；`:2386-2423` 继续提示/填入 sub2api 模板。`S/account-management/facade.ts:314-324` 立即调用 decodeNativeImport；`S/account-management/import-policy.ts:15-22,45-75` 只接受 `provider_id=codex/claude` 与对象 artifacts | **UI 接受合同与 service 输入合同不一致。** 正常原生 artifact 文档在页面被拒；页面自带 sub2api 模板到 service 又不满足原生字段。即便人为构造兼带两种字段的对象可绕过两层条件，也不能称文档化流程一致 | 不声称真实后端导入失败率；不声称正式 Node 页也有相同问题；不恢复废弃格式 | not verified：错误实际呈现、正确原生文件/旧迁移文件真实旅程、导入后身份/模型快照 |
| **SG02** 预览 `/accounts` → 导出（P12） | `P/AccountsGoPreview.tsx:914-922` handleExportAccount 调 accountsAPI.exportAccount；`:1866-1875` 菜单常规提供“导出迁移 JSON”（只按 exporting busy 禁用）；`:1886` 点击分发。`S/account-management/facade.ts:308-311` 校验 ref 后无条件 unsupportedAccountOperation('account_management_export_unsupported') | **UI 仍暴露服务明确不支持的叶子动作。** 合法 ref 也不会产生导出 HTTP 请求；不是“还没查到后端所以猜测不支持” | 不声称所有导出都坏；正式 A11 走另一服务；不声称已观察用户错误提示 | not verified：菜单呈现/错误体验；原生导出目标合同需后续确认 |

以上只定为“静态合同缺口”；用户影响等级、当前部署是否包含、后端责任及修复方案均未批准/验证。没有执行这些动作，没有把发现缺口当作已修复。

## 7. 具体未证缺口与后续交接

| 缺口 | 关联入口/范围 | 当前证据边界 | 后续必须补齐（本次不执行） |
|---|---|---|---|
| G-RUNTIME | 所有 R/G 路由与动作 | 只到页面挂载、handler、client 请求合同 | **not verified**：真实桌面页面可达、加载/空/失败态，正向/失败/取消/重试及状态一致 |
| G-SERVER | `/servers`、`/server-setup`、所有远端请求 | active profile、Authorization/server-id 请求构造可读；未完成后端注册/鉴权/代理链审计 | **not verified**：错误 Server/旧 key/离线/多标签切换，确保不串账号、不把 key 带入 URL |
| G-CANONICAL | `/chat`、quick、Work、原生历史 | 当前 Canonical 主链已定位；旧 chatAPI 存在不算主链证据 | **not verified**：命令/事件协议、Provider catalog、幂等、断线恢复、计费、审批、附件与计划跨会话移交；听写供应商链未追完 |
| G-ACCOUNT | 正式账号、Go 预览、模型/额度页 | 来源/认证模式/状态守卫可见；SG01/SG02 源码已证 | **not verified**：真实 OAuth、去重、刷新、禁用调度、删除保护、reset 库存与最终额度；预览不等于生产已迁 Go |
| G-USAGE | `/usage`、R22 quota、Dashboard | 查询/扫描/展示分支可见 | **not verified**：完整请求→token→价格→归属账本，时区、扫描幂等、限量截断和窗口重置；绝不按默认账号猜未归属数据 |
| G-JOBS | ScheduledTasks、安装、活动、Geo、订阅同步 | job/watch/记录入口可证 | **not verified**：完成事件→真实进程/文件/奖励的最终结果，重复执行、取消、重启后恢复；任务绿灯不是业务闭环 |
| G-SIDE-EFFECT | Toolkit、SSH、Server 重启、检查点恢复、权限/配置 | 副作用入口与请求方法已登记，没执行 | **not verified**：安装/卸载/系统权限/端口/代理/远程主机/备份回滚；需明确后续风险授权，不能由本静态清单视为已批准运行 |
| G-NAV | Settings section、旧 Toolkit alias、翻译 redirect、quick layout=false | Settings getInitialSettingsTab 接受 control-planes/ssh-hosts，但常规 items 只保留 basic/aliases/upstream-errors；正确独立路径是 /servers、/ssh-hosts。暂未证明旧 query 链接兼容是产品承诺 | **not verified**：旧书签是否需迁移、query 保留、未知路径兜底；先确认合同，不把“存在 section”写成 Tab 已支持 |
| G-MEDIA | 生图、翻译、截图/录制、语音听写 | UI capability/文件/流入口可见 | **not verified**：模型输出和费用、资源授权/下载、OS 权限、浏览器编码/跨源/焦点；编码器/Provider 文件数不能当支持率 |
| G-UI | 所有正式/预览桌面页面及弹窗 | 无浏览器/GUI 验证；未把 CSS/组件存在视为视觉证据 | **not verified**：大块 Alert/装饰性粗左竖条是否出现、Desktop/CLI 功能图标、间距、禁用状态、真实内容溢出。无移动端适配/验收承诺 |
| G-INTENT | 所有原行为合同 | 当前源码与计划约束，不是全历史会话/提交恢复 | **not verified**：存在歧义的旧语义/隐藏入口原始意图；先由主代理确认再形成修复包 |

## 8. 本次静态交付核对

- 路由账覆盖 routes.ts 两个数组的每个 path 声明，包括重复 `/studio`、所有 redirect、隐藏菜单与 `layout:false`；不是只盘菜单项。
- 22 个 feature 目录均有实际消费链和用户入口回链；无独立路由的 `model-aliases` / `provider-config` / `capture` 等没有虚构新路径；`ModelAliases.tsx`、`UpstreamErrorMappings.tsx`、`SshHostsPanel.tsx` 作为嵌入页面登记。
- API 映射区分正式 Node `/v0/webui`、Canonical chat、Go preview `/v1/management`、插件 `/v0/plugins`、纯浏览器存储；未宣称后端端点已验通。
- 审查方式：**self_review + plan_check**，检查路由遗漏、feature 回链、API 前缀、共享入口与 SG01/SG02 两端源码。未调用独立 reviewer、未做高风险操作；本账不代表独立运行时审查通过。
- 文档编辑之外无实现变更、无测试/GUI/生产调用、无提交/推送/部署。M0 Web 子账交付不等于全项目 M0–M5 完成。
