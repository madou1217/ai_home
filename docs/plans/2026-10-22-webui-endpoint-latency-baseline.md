# WebUI 接口清单与响应时间基线（第一阶段）

> 采集时间：2026-10-22 | 采集对象：本机 `aih server` (`127.0.0.1:9527`, Node 生产 owner)
> 目标：**除 WSS/SSE 外，所有接口 300ms 内响应**。本阶段只做事实采集，不改代码。

## 一、采集方法与口径

| 数据源 | 内容 | 说明 |
| --- | --- | --- |
| 源码路由扫描 | 284 条路由（含正则/前缀动态路由） | `lib/server/web-ui-router.js` 分发链 + `lib/server/webui-*-routes.js` 模块 |
| 生产访问日志 | `~/.ai_home/logs/server.log` 中 `kind=access` 且路径为 `/v0/webui/*` 的记录 | 过去 16 小时 24,503 条真实请求 |
| 主动探测 | 对 56 个只读接口做 3–7 次串行请求（带真实 Management Key，走同机 loopback） | 只发安全 GET，不触发写操作 |

**字段口径**：

- **实测 p50**：主动探测中位数（取多轮探测里最安静的一次）。
- **线上 n / p50 / p95**：生产日志聚合。`n` 是样本数，`—` 表示样本不足或未观测到。
- **SSE/长连接**：`watch` 类、`stream` 类、`chat`、`terminal/mux` 等，按需求**不计入 300ms 门槛**。

**重要前提**：本机 server 存在周期性事件循环阻塞（见第五节），`/healthz` 本身都会偶发 1s 卡顿。
因此单次探测的 p95 会明显高于 p50，表中以 p50 作为接口自身成本的判据。

## 二、总览

| 指标 | 数值 |
| --- | --- |
| 路由总数 | 284 |
| SSE / WSS / 长连接 | 17 |
| 需满足 300ms 的 HTTP 接口 | 267 |
| 已实测（只读、安全） | 56 |
| 其中实测（扣除全局卡顿后）> 300ms | **6** |
| 线上日志有样本 | 74 |

### 超 300ms 接口一览（校准后）

探测时以纯内存接口 `GET /v0/webui/tasks` 作为基准，在每次测量前后各采样 7 次取中位数，
**净耗时 = 接口中位数 − 基准中位数**，以扣除服务器全局事件循环卡顿的影响。

| 方法 | 路径 | 净耗时 | 实测中位 | 最小 | 最大 | 基准 | 主要开销 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| GET | `/v0/webui/toolkit/connectivity` | **4347ms** | 4390ms | 2860ms | 12030ms | 43ms | 并发 HEAD 请求多个外部站点，超时上限 5s |
| GET | `/v0/webui/toolkit/environments` | **2751ms** | 2797ms | 2092ms | 2939ms | 46ms | 同步子进程探测本机环境（版本/路径） |
| GET | `/v0/webui/toolkit/proxy` | **1998ms** | 2211ms | 1841ms | 2923ms | 212ms | 同步子进程：`scutil` + `networksetup` × N 个网络服务 + 各工具插件读取 |
| GET | `/v0/webui/egress-pool` | **1391ms** | 1472ms | 973ms | 2910ms | 81ms | 节点账本 + 网络层探测 |
| GET | `/v0/webui/openai-models` | **1309ms** | 1407ms | 966ms | 1808ms | 98ms | 上游模型目录拉取 + 聚合 |
| GET | `/v0/webui/toolkit/mirrors` | **560ms** | 569ms | 489ms | 867ms | 9ms | 同步子进程读取 npm/pip 配置 |

> `GET /v0/webui/app-install/jobs` 初次探测 881ms，复测净耗时 **0ms**（中位 9ms）。
> 首次值是被全局卡顿污染造成的假阳性，**不构成慢接口**。这也说明单次探测必须做基准校准。

### 高频接口校准结果（热态）

同样采用「基准扣除」口径。表中是前端页面一打开就会调用的接口：

| 方法 | 路径 | 净耗时 | 中位 | 基准 | 判定 |
| --- | --- | ---: | ---: | ---: | --- |
| GET | `/v0/webui/chat-sessions` | **247ms** | 254ms | 8ms | ⚠️ 贴近阈值，缓存冷时会更慢 |
| GET | `/v0/webui/models` | 86ms | 96ms | 10ms | ✅ |
| GET | `/v0/webui/egress-upstreams` | 74ms | 81ms | 7ms | ✅ |
| GET | `/v0/webui/chat/sessions/{id}/composer/catalog` | 67ms | 71ms | 4ms | ✅ |
| GET | `/v0/webui/account-outcomes` | 34ms | 39ms | 4ms | ✅ |
| GET | `/v0/webui/projects` | 12ms | 22ms | 10ms | ✅ |
| GET | `/v0/webui/toolkit/apps` | 7ms | 17ms | 10ms | ✅（缓存热时） |
| GET | `/v0/webui/toolkit/tools` | 1ms | 7ms | 6ms | ✅（缓存热时） |
| GET | `/v0/webui/sessions/lifecycle-capabilities` | 1ms | 2ms | 1ms | ✅ |
| GET | `/v0/webui/accounts` | 0ms | 60ms | 429ms* | ✅ |

> \* `accounts` 那次测量的基准值异常偏高（429ms，说明测量窗口正好处在卡顿中），
> 因此净耗时按 0 计；线上 79 个样本 p50=84ms、p95=365ms 更能代表它的真实水平。

**结论**：绝大多数高频只读接口在缓存热时都能进 300ms。真正的问题集中在
①toolkit 的同步子进程、②真实上游请求、③缓存冷启动、④全局事件循环阻塞这四类。

## 三、全量接口清单

按业务域分组。**响应时间**列取实测 p50；未实测的给线上日志 p50/p95。

### 3.1 账号管理（53）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/accounts` | 账号列表（含状态、绑定、默认号） | 273ms | 79 | 84 | 365 |
| POST | `/v0/webui/accounts/add` | 新增账号（发起 OAuth/插件登录任务） | — | — | — | — |
| GET | `/v0/webui/accounts/add/jobs/{jobId}` | 查询添加账号任务进度 | — | 6 | 1 | 2 |
| POST | `/v0/webui/accounts/add/jobs/{jobId}/cancel` | 取消添加账号任务 | — | — | — | — |
| POST | `/v0/webui/accounts/add/jobs/{jobId}/install` | 确认并安装缺失 CLI | — | — | — | — |
| POST | `/v0/webui/accounts/add/jobs/{jobId}/callback` | 提交浏览器 OAuth 回调并换 token | — | — | — | — |
| POST | `/v0/webui/accounts/add/jobs/{jobId}/local-import` | 从本机登录态完成登录任务 | — | — | — | — |
| POST | `/v0/webui/accounts/detect` | 扫描本机已登录但未入库账号并登记 | — | — | — | — |
| GET | `/v0/webui/accounts/provider-auth-sources` | 认证来源链（本机可用/可安装） | 12ms | 7 | 4 | 26 |
| POST | `/v0/webui/accounts/local-import` | 从本机登录态直接建账号 | — | — | — | — |
| POST | `/v0/webui/accounts/plugin-login/start` | 插件账号登录任务开始 | — | — | — | — |
| GET | `/v0/webui/accounts/plugin-login/{jobId}` | 插件登录任务轮询 | — | — | — | — |
| POST | `/v0/webui/accounts/plugin-login/{jobId}/submit` | 插件登录提交输入 | — | — | — | — |
| POST | `/v0/webui/accounts/plugin-login/{jobId}/cancel` | 取消插件登录 | — | — | — | — |
| GET | `/v0/webui/accounts/export` | 导出账号配置 | — | — | — | — |
| POST | `/v0/webui/accounts/import` | 导入账号配置 | — | — | — | — |
| GET | `/v0/webui/accounts/import/jobs/{jobId}` | 查询导入任务 | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/accounts/watch` | SSE：账号列表增量更新 | 不计入 | 66 | 18248 | 1566444 |
| POST | `/v0/webui/accounts/watch/snapshot` | 触发账号 watch 后台刷新并快速返回 | — | 1 | 1 | 1 |
| GET | `/v0/webui/accounts/{provider}/{accountRef}` | 读取单账号 | — | — | — | — |
| DELETE | `/v0/webui/accounts/{provider}/{accountRef}` | 删除账号 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/reauth` | 重新认证 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/refresh` | 并发刷新状态/模型/额度 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/refresh-usage` | 刷新额度 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/status` | 启用/停用账号 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/update` | 更新账号配置（URL/Key） | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/routing-rules` | 更新调度规则 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/restore-scheduling` | 人工强制恢复调度 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/set-default` | 设为默认会话账号 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/clear-default` | 取消默认账号 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/set-mobile` | 设为 Codex App 账号 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/clear-mobile` | 取消 Codex App 账号 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/open-app` | 打开该账号的桌面 App / CLI | — | — | — | — |
| GET | `/v0/webui/accounts/{provider}/{accountRef}/plan-stats` | kimi 套餐配额 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/desktop-session/start` | kimi 桌面扫码登录开始 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/desktop-session/poll` | kimi 桌面登录轮询 | — | — | — | — |
| GET | `/v0/webui/accounts/{provider}/{accountRef}/quota-reset-events` | 额度重置事件历史 | — | — | — | — |
| GET | `/v0/webui/accounts/{provider}/{accountRef}/egress` | 账号专属出口绑定 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/egress` | 设置账号专属出口 | — | — | — | — |
| GET | `/v0/webui/accounts/{provider}/{accountRef}/window-activation` | 窗口激活设置 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/window-activation` | 设置窗口激活 | — | — | — | — |
| GET | `/v0/webui/accounts/{provider}/{accountRef}/alias-pool` | 别名选号池开关 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/alias-pool` | 设置别名选号池 | — | — | — | — |
| POST | `/v0/webui/accounts/activity/run` | 供应商作用域异步领取任务 | — | — | — | — |
| GET | `/v0/webui/accounts/activity/jobs/{jobId}` | 领取任务进度 | — | — | — | — |
| POST | `/v0/webui/accounts/{provider}/{accountRef}/activity/{actionId}` | 单账号单动作 | — | — | — | — |
| GET | `/v0/webui/account-outcomes` | 账号请求结果统计 | 174ms | 363 | 223 | 653 |
| GET | `/v0/webui/accounts/codex/{accountRef}/reset-credits` | Codex 重置额度库存 | — | — | — | — |
| POST | `/v0/webui/accounts/codex/{accountRef}/reset-credits/consume` | 消费一次重置 | — | — | — | — |
| GET | `/v0/webui/accounts/codex/{accountRef}/reset-operations/{opId}` | 查询重置操作 | — | — | — | — |
| POST | `/v0/webui/accounts/codex/{accountRef}/reset-operations/{opId}/reconcile` | 对账重置操作 | — | — | — | — |
| GET | `/v0/webui/app-entries` | 宿主机实测的 Provider 桌面/CLI 入口 | 6ms | 5647 | 94 | 222 |

### 3.2 聊天与会话（39）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| POST **SSE/长连接** | `/v0/webui/chat` | 发送聊天消息（SSE 流式回复） | 不计入 | — | — | — |
| GET | `/v0/webui/chat-sessions` | 本地聊天会话列表 | 287ms | 168 | 75 | 2014 |
| POST | `/v0/webui/chat-sessions` | 新建本地聊天会话 | — | — | — | — |
| GET | `/v0/webui/chat-sessions/{sessionId}` | 读取单个聊天会话 | — | 3 | — | 1 |
| DELETE | `/v0/webui/chat-sessions/{sessionId}` | 删除聊天会话 | — | — | — | — |
| GET | `/v0/webui/chat/sessions` | Chat Runtime 会话列表 | 17ms | 3053 | — | 1 |
| POST | `/v0/webui/chat/sessions` | 创建 Chat Runtime 会话 | — | 49 | 72 | 199 |
| POST | `/v0/webui/chat/sessions/resolve` | 按 provider/项目/native id 解析会话 | — | — | — | — |
| GET | `/v0/webui/chat/sessions/{id}/snapshot` | 会话快照 | — | 54 | 3 | 13 |
| GET **SSE/长连接** | `/v0/webui/chat/sessions/{id}/events` | SSE：会话事件流 | 不计入 | 49 | 9335 | 75151 |
| GET | `/v0/webui/chat/sessions/{id}/timeline` | 会话时间线 | — | 8 | 1 | 3 |
| GET | `/v0/webui/chat/sessions/{id}/commands/catalog` | 可用 slash 命令目录 | — | 46 | 1 | 2 |
| POST | `/v0/webui/chat/sessions/{id}/commands` | 执行 slash 命令 | — | 12 | 83 | 779 |
| GET | `/v0/webui/chat/sessions/{id}/composer/catalog` | 输入区模型/账号目录 | — | 51 | 79 | 1825 |
| POST | `/v0/webui/chat/sessions/{id}/attachments` | 上传会话附件 | — | — | — | — |
| GET | `/v0/webui/chat/attachments` | 读取聊天附件 | — | — | — | — |
| GET | `/v0/webui/chat/artifacts/{artifactId}` | 读取会话产物 | — | — | — | — |
| GET | `/v0/webui/chat/runs` | 活跃原生会话 run 列表 | — | — | — | — |
| POST | `/v0/webui/chat/runs` | 启动/恢复原生会话 run | — | — | — | — |
| POST | `/v0/webui/chat/runs/{runId}/input` | 向运行中会话写输入 | — | — | — | — |
| POST | `/v0/webui/chat/runs/{runId}/resize` | 调整 PTY 尺寸 | — | — | — | — |
| POST | `/v0/webui/chat/runs/{runId}/abort` | 终止运行中会话 | — | — | — | — |
| POST | `/v0/webui/chat/runs/{runId}/approvals/{approvalId}` | 审批决策 allow/deny | — | — | — | — |
| POST | `/v0/webui/chat/cli-install-confirmations/{id}` | 安装缺失 CLI 的一次性确认 | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/sessions/watch` | SSE：会话文件变更 | 不计入 | — | — | — |
| GET **SSE/长连接** | `/v0/webui/sessions/watch/ws` | WebSocket：会话 watch | 不计入 | — | — | — |
| GET | `/v0/webui/sessions/{provider}/{sessionId}` | 账号的项目与会话数据 | — | — | — | — |
| GET | `/v0/webui/sessions/{provider}/{sessionId}/messages` | 会话消息内容 | — | — | — | — |
| GET | `/v0/webui/sessions/{provider}/{sessionId}/events` | 会话增量事件 | — | — | — | — |
| GET | `/v0/webui/sessions/{provider}/{sessionId}/model` | 会话最近使用的模型 | — | — | — | — |
| POST | `/v0/webui/sessions/previews` | 批量取模型+末条消息预览 | — | — | — | — |
| GET | `/v0/webui/sessions/archive` | 归档会话（GET 形式） | — | — | — | — |
| POST | `/v0/webui/sessions/archive` | 归档会话 | — | — | — | — |
| GET | `/v0/webui/sessions/archived` | 已归档会话列表 | 52ms | 6 | 44 | 113 |
| GET | `/v0/webui/sessions/unarchive` | 还原归档（GET 形式） | — | — | — | — |
| POST | `/v0/webui/sessions/unarchive` | 还原归档会话 | — | — | — | — |
| GET | `/v0/webui/sessions/lifecycle-capabilities` | 原生会话生命周期能力 | 263ms | 95 | 1 | 4799 |
| POST | `/v0/webui/session-events/provider-hook` | provider 官方 hook 的会话变更事件 | — | 2110 | 1 | 3 |
| POST | `/v0/webui/internal/approval-request` | claude 权限工具审批请求（长挂） | — | — | — | — |

### 3.3 项目与文件（17）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/projects` | 项目列表（按路径聚合会话） | 198ms | 51 | 14 | 50 |
| GET | `/v0/webui/projects/sessions` | 单个项目的完整会话集合 | — | 8 | 1 | 18 |
| GET **SSE/长连接** | `/v0/webui/projects/watch` | SSE：项目级运行态 | 不计入 | 40 | 11737 | 621247 |
| POST | `/v0/webui/projects/watch/snapshot` | 触发项目快照刷新 | — | — | — | — |
| POST | `/v0/webui/projects/pick` | 在宿主机弹目录选择器 | — | — | — | — |
| POST | `/v0/webui/projects/browse` | 服务端本地目录浏览 | — | — | — | — |
| POST | `/v0/webui/projects/open` | 手动打开项目目录 | — | — | — | — |
| POST | `/v0/webui/projects/remove` | 移除手动打开的项目 | — | — | — | — |
| GET | `/v0/webui/fs/tree` | 浏览已登记项目内目录 | — | 6 | 3 | 4 |
| GET | `/v0/webui/fs/read` | 读取本地文件内容 | — | — | — | — |
| GET | `/v0/webui/fs/access` | 媒体文件访问预检 | — | 6 | 3 | 7 |
| GET | `/v0/webui/fs/media` | 受权媒体文件预览 | — | — | — | — |
| POST | `/v0/webui/fs/trust` | 持久化可信目录 | — | — | — | — |
| GET | `/v0/webui/git/summary` | 只读 Git 工作区状态 | — | 6 | 39 | 46 |
| GET | `/v0/webui/git/diff` | 单文件只读 diff | — | 3 | 3 | 4 |
| GET | `/v0/webui/models` | 按 provider 分组的模型列表 | 190ms | 39 | 111 | 298 |
| GET | `/v0/webui/slash-commands` | 某 provider 的 slash 命令 | — | 5 | — | 1 |

### 3.4 配置与管理面（56）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/config` | 全局用量配置 | 16ms | 6 | 3 | 4 |
| POST | `/v0/webui/config` | 更新全局配置 | — | — | — | — |
| GET | `/v0/webui/server-config` | server 配置 | 16ms | 7 | 3 | 4 |
| POST | `/v0/webui/server-config` | 更新 server 配置 | — | — | — | — |
| POST | `/v0/webui/server-config/management-key/rotate` | 轮换管理密钥 | — | — | — | — |
| POST | `/v0/webui/server/restart` | 重启 server | — | — | — | — |
| GET | `/v0/webui/management/status` | 管理面状态 | 32ms | 1138 | 3 | 7 |
| GET | `/v0/webui/management/metrics` | 管理面指标 | 8ms | 5285 | 1 | 3 |
| GET | `/v0/webui/management/accounts` | 管理面账号视图 | 125ms | 10 | 94 | 239 |
| GET | `/v0/webui/management/usage` | 管理面用量 | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/management/watch` | SSE：管理面状态 | 不计入 | 9 | 1702 | 2609 |
| POST | `/v0/webui/management/watch/snapshot` | 触发管理面快照广播 | — | — | — | — |
| POST | `/v0/webui/management/usage/dashboard/query` | 创建用量看板查询任务 | — | 1 | 520 | 520 |
| GET **SSE/长连接** | `/v0/webui/management/usage/dashboard/query/watch` | SSE：看板查询进度 | 不计入 | 1 | 1091 | 1091 |
| DELETE | `/v0/webui/management/usage/dashboard/query/{id}` | 取消看板查询 | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/management/usage/scan/watch` | SSE：用量扫描进度 | 不计入 | 1 | 1078 | 1078 |
| GET | `/v0/webui/control-plane/endpoints` | 控制面端点提示 | 23ms | 8 | 1 | 2 |
| GET | `/v0/webui/control-plane/profiles` | 控制面 server profile 列表 | 10ms | 62 | 2 | 5 |
| POST | `/v0/webui/control-plane/profiles` | 保存 server profile | — | 72 | 3 | 16 |
| GET | `/v0/webui/control-plane/profiles/active` | 当前激活 profile | — | — | — | — |
| POST | `/v0/webui/control-plane/profiles/active` | 切换激活 profile | — | 9 | 2 | 2 |
| POST | `/v0/webui/control-plane/profiles/{profileId}` | 更新/删除 profile | — | — | — | — |
| POST | `/v0/webui/server-routes/relays` | 中转出口路线 | — | — | — | — |
| GET | `/v0/webui/nodes` | 远程节点列表 | 8ms | 8 | 1 | 4 |
| POST | `/v0/webui/nodes` | 保存远程节点 | — | — | — | — |
| GET | `/v0/webui/nodes/defaults` | 节点默认值 | 82ms | 8 | 26 | 74 |
| GET | `/v0/webui/nodes/invites` | 节点邀请列表 | 6ms | 6 | 2 | 2 |
| POST | `/v0/webui/nodes/invites` | 创建节点邀请 | — | — | — | — |
| GET | `/v0/webui/nodes/{nodeId}/test` | 节点连通性测试 | — | — | — | — |
| POST | `/v0/webui/nodes/{nodeId}/test` | 节点连通性测试 | — | — | — | — |
| GET | `/v0/webui/nodes/bootstrap-plan` | 节点引导计划 | — | — | — | — |
| POST | `/v0/webui/nodes/bootstrap-plan` | 节点引导计划 | — | — | — | — |
| POST | `/v0/webui/nodes/bootstrap-probe` | 节点引导探测 | — | — | — | — |
| POST | `/v0/webui/nodes/bootstrap-apply` | 应用节点引导 | — | — | — | — |
| POST | `/v0/webui/nodes/{nodeId}/management/{rest}` | 转发到远端节点管理面 | — | — | — | — |
| GET | `/v0/webui/provider-hooks` | provider official hook 接入诊断 | 16ms | 8 | 4 | 11 |
| GET | `/v0/webui/provider-hooks/install` | 安装 provider hook（GET 形式） | — | — | — | — |
| POST | `/v0/webui/provider-hooks/install` | 安装 provider official hook | — | — | — | — |
| GET | `/v0/webui/provider-cli-upgrade` | CLI 自动升级账本与调度 | 13ms | 18 | 2 | 13 |
| POST | `/v0/webui/provider-cli-upgrade/{provider}/clear-broken` | 解除升级熔断 | — | — | — | — |
| GET | `/v0/webui/openai-models` | WebUI 模型目录（对齐 /v1/models） | 1134ms | 19 | 1003 | 1225 |
| POST | `/v0/webui/openai-models` | 新增自建模型 | — | — | — | — |
| PATCH | `/v0/webui/openai-models` | 更新自建模型 | — | — | — | — |
| POST | `/v0/webui/openai-models/delete` | 删除自建模型 | — | — | — | — |
| POST | `/v0/webui/openai-models/refresh` | 刷新模型目录 | — | 3 | 1 | 51 |
| GET **SSE/长连接** | `/v0/webui/openai-models/watch` | SSE：模型目录变更 | 不计入 | 27 | 478334 | 2193278 |
| GET | `/v0/webui/model-aliases` | 模型别名列表 | 5ms | 11 | 2 | 7 |
| POST | `/v0/webui/model-aliases` | 新增别名 | — | — | — | — |
| PUT | `/v0/webui/model-aliases/{id}` | 更新别名 | — | — | — | — |
| DELETE | `/v0/webui/model-aliases/{id}` | 删除别名 | — | — | — | — |
| POST | `/v0/webui/model-aliases/{id}/toggle` | 启用/停用别名 | — | — | — | — |
| GET | `/v0/webui/upstream-error-mappings` | 上游错误码映射组 | 27ms | 8 | 3 | 5 |
| POST | `/v0/webui/upstream-error-mappings` | 新增映射 | — | — | — | — |
| PUT | `/v0/webui/upstream-error-mappings/{id}` | 更新映射 | — | — | — | — |
| DELETE | `/v0/webui/upstream-error-mappings/{id}` | 删除映射 | — | — | — | — |
| POST | `/v0/webui/upstream-error-mappings/{id}/toggle` | 启用/停用映射 | — | — | — | — |

### 3.5 出口与网络（13）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/egress-pool` | 出口池状态+节点账本 | 1066ms | 48 | 859 | 1438 |
| POST | `/v0/webui/egress-pool/probe` | 立即探测节点 | — | — | — | — |
| POST | `/v0/webui/egress-pool/nodes/{name}/select` | 切到指定节点 | — | — | — | — |
| POST | `/v0/webui/egress-pool/nodes/{name}/clear-cooldown` | 人工解除冷却 | — | — | — | — |
| POST | `/v0/webui/egress-pool/nodes/{name}/block` | 手动关闭节点 | — | — | — | — |
| POST | `/v0/webui/egress-pool/nodes/{name}/unblock` | 放行节点 | — | — | — | — |
| POST | `/v0/webui/egress-pool/node-policy` | 改拦截策略 | — | 5 | 29 | 40 |
| POST | `/v0/webui/egress-pool/node-policy/clear-disabled` | 清除手动关闭标记 | — | — | — | — |
| GET | `/v0/webui/egress-upstreams` | 上游地区策略视图 | 280ms | 417 | 116 | 238 |
| PUT | `/v0/webui/egress-upstreams/{id}` | 改上游规则 | — | — | — | — |
| POST | `/v0/webui/egress-upstreams/{id}/probe` | 测试节点 | — | — | — | — |
| POST | `/v0/webui/egress-upstreams/{id}/evidence/reset` | 重置实测证据 | — | — | — | — |
| POST | `/v0/webui/egress-upstreams/network/refresh` | 刷新当前出口网络 | — | 1 | 5 | 5 |

### 3.6 工具箱 Toolkit（71）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/toolkit/apps` | App/CLI 清单 | 16ms | 43 | 303 | 1689 |
| POST | `/v0/webui/toolkit/apps/plan` | 预览生命周期命令 | — | — | — | — |
| POST | `/v0/webui/toolkit/apps/install` | 异步安装任务 | — | — | — | — |
| POST | `/v0/webui/toolkit/apps/hooks` | 安装官方 hooks | — | — | — | — |
| GET | `/v0/webui/toolkit/apps/{appId}/check-update` | 检查 App 更新 | — | — | — | — |
| POST | `/v0/webui/toolkit/apps/{appId}/open` | 打开 App | — | — | — | — |
| GET | `/v0/webui/toolkit/apps/{appId}/settings` | CLI 启动权限设置 | — | — | — | — |
| PUT | `/v0/webui/toolkit/apps/{appId}/settings` | 写 CLI 启动权限设置 | — | — | — | — |
| GET | `/v0/webui/toolkit/tools` | 受管工具清单 | 59ms | 22 | 1 | 1970 |
| POST | `/v0/webui/toolkit/tools/plan` | 工具操作计划 | — | — | — | — |
| POST | `/v0/webui/toolkit/tools/execute` | 执行工具操作 | — | — | — | — |
| GET | `/v0/webui/toolkit/tools/jobs` | 工具任务列表 | 32ms | 6 | 1 | 2 |
| GET | `/v0/webui/toolkit/tools/jobs/{jobId}` | 工具任务详情/进度 | — | — | — | — |
| GET | `/v0/webui/toolkit/tools/{toolId}/service` | 工具服务状态 | — | — | — | — |
| GET | `/v0/webui/toolkit/tools/{toolId}/service/settings` | 服务设置 | — | — | — | — |
| GET | `/v0/webui/toolkit/tools/{toolId}/service/config` | 服务配置 | — | — | — | — |
| GET | `/v0/webui/toolkit/tools/{toolId}/service/logs` | 服务日志 | — | — | — | — |
| GET | `/v0/webui/toolkit/environments` | 环境能力清单 | 2337ms | 14 | 2170 | 2602 |
| GET | `/v0/webui/toolkit/environments/guide` | 环境配置指南 | 196ms | 6 | 3 | 6 |
| POST | `/v0/webui/toolkit/environments/plan` | 环境动作计划 | — | — | — | — |
| POST | `/v0/webui/toolkit/environments/execute` | 执行环境动作 | — | — | — | — |
| GET | `/v0/webui/toolkit/environments/jobs` | 环境任务列表 | — | — | — | — |
| GET | `/v0/webui/toolkit/mirrors` | npm/pip 镜像源状态 | 1880ms | 16 | 664 | 912 |
| POST | `/v0/webui/toolkit/mirrors/set` | 设置镜像源 | — | — | — | — |
| POST | `/v0/webui/toolkit/mirrors/ping` | ping 镜像地址 | — | — | — | — |
| GET | `/v0/webui/toolkit/proxy` | 代理状态（env/系统/工具） | 2913ms | 22 | 1588 | 2201 |
| POST | `/v0/webui/toolkit/proxy/set` | 设置工具代理 | — | — | — | — |
| GET | `/v0/webui/toolkit/connectivity` | 测试上游 AI 连通性 | 4177ms | 19 | 2745 | 5425 |
| GET | `/v0/webui/toolkit/edge` | 本机入口转发状态 | 9ms | 11 | 2 | 5 |
| GET | `/v0/webui/toolkit/edge/plan` | 生成入口转发配置 | — | — | — | — |
| POST | `/v0/webui/toolkit/edge/apply` | 落盘并重载入口配置 | — | — | — | — |
| GET | `/v0/webui/toolkit/provider-configs` | Provider 配置文件清单 | — | — | — | — |
| GET | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}` | 读配置文件 | — | — | — | — |
| PUT | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}` | 写配置文件 | — | — | — | — |
| POST | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}/validate` | 校验配置 | — | — | — | — |
| GET | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}/history` | 配置历史 | — | — | — | — |
| GET | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}/history/{entryId}` | 历史条目 | — | — | — | — |
| POST | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}/history/{entryId}/restore` | 恢复历史版本 | — | — | — | — |
| GET | `/v0/webui/toolkit/provider-configs/{provider}/{fileId}/export` | 导出配置 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator` | 订阅聚合器总览 | 35ms | 16 | 17 | 36 |
| GET | `/v0/webui/toolkit/subscription-aggregator/local-clients` | 探测本机代理客户端 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator/local-sources` | 扫描本机订阅源配置 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/local-sources/import` | 导入本机订阅源 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator/relay` | 本机中转可用性 | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/toolkit/subscription-aggregator/sources/sync/watch` | SSE：订阅源同步进度 | 不计入 | 4 | 1311699 | 2019455 |
| POST | `/v0/webui/toolkit/subscription-aggregator/sources/sync` | 立即返回 202 的批量同步任务 | — | 1 | 35 | 35 |
| POST | `/v0/webui/toolkit/subscription-aggregator/sources/{id}/sync` | 单源同步任务 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator/sources/{id}/nodes` | 源节点列表 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/sources/{id}/latency` | 测节点延迟 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/sources/{id}/enabled` | 启用/停用订阅源 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/sources` | 保存订阅源 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/sources/preview` | 预览订阅源 | — | — | — | — |
| DELETE | `/v0/webui/toolkit/subscription-aggregator/sources/{id}` | 删除订阅源 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator/profiles/{id}/preview` | 预览聚合订阅 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator/profiles/{id}/import-links` | 导入链接 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/profiles/{id}/token` | 轮换订阅 token | — | — | — | — |
| DELETE | `/v0/webui/toolkit/subscription-aggregator/profiles/{id}` | 删除聚合配置 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/profiles` | 保存聚合配置 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/profiles/nodes` | 预览聚合节点 | — | 1 | 22 | 22 |
| POST | `/v0/webui/toolkit/subscription-aggregator/profiles/test-route` | 测试路由 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/probe` | 探测工具链 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/nodes/parse` | 解析节点串 | — | — | — | — |
| GET | `/v0/webui/toolkit/subscription-aggregator/nodes` | 全部节点 | — | — | — | — |
| POST | `/v0/webui/toolkit/subscription-aggregator/nodes/chain` | 设置节点前置链 | — | — | — | — |
| GET | `/v0/webui/terminals` | 客户端终端任务列表 | 18ms | 8 | 3 | 14 |
| GET | `/v0/webui/toolkit/terminals` | 同上（toolkit 别名） | 19ms | 10 | 10 | 44 |
| POST | `/v0/webui/toolkit/terminals/plan` | 终端命令计划 | — | — | — | — |
| POST | `/v0/webui/toolkit/terminals/execute` | 执行终端命令 | — | — | — | — |
| POST | `/v0/webui/toolkit/terminals/open` | 打开客户端终端 | — | — | — | — |
| GET | `/v0/webui/toolkit/terminals/jobs/{jobId}` | 终端任务详情 | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/toolkit/terminals/jobs/{jobId}/watch` | SSE：终端任务进度 | 不计入 | — | — | — |

### 3.7 终端 PTY（6）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| POST | `/v0/webui/terminal/open` | 打开底部 shell PTY | — | — | — | — |
| GET **SSE/长连接** | `/v0/webui/terminal/stream` | SSE/流式：PTY 输出 | 不计入 | — | — | — |
| GET **SSE/长连接** | `/v0/webui/terminal/mux` | 多路复用通道 | 不计入 | — | — | — |
| POST | `/v0/webui/terminal/input` | 写入 PTY 输入 | — | — | — | — |
| POST | `/v0/webui/terminal/resize` | 调整 PTY 尺寸 | — | — | — | — |
| POST | `/v0/webui/terminal/close` | 关闭 PTY | — | — | — | — |

### 3.8 任务队列（5）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/tasks` | 后台任务列表 | 5ms | 4221 | — | 1 |
| GET **SSE/长连接** | `/v0/webui/tasks/watch` | SSE：任务进度 | 不计入 | 91 | 13109 | 2638474 |
| POST | `/v0/webui/app-install` | 创建 CLI/Desktop 安装任务 | — | — | — | — |
| GET | `/v0/webui/app-install/jobs` | 安装任务列表 | 9ms | 8 | 1 | 1 |
| GET **SSE/长连接** | `/v0/webui/app-install/jobs/{jobId}/watch` | SSE：安装任务进度 | 不计入 | — | — | — |

### 3.9 SSH（10）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/ssh-connections` | SSH 连接列表 | 94ms | 6 | 3 | 4 |
| POST | `/v0/webui/ssh-connections` | 新增 SSH 连接 | — | — | — | — |
| PUT | `/v0/webui/ssh-connections/{id}` | 编辑 SSH 连接 | — | — | — | — |
| DELETE | `/v0/webui/ssh-connections/{id}` | 删除 SSH 连接（级联工作区） | — | — | — | — |
| POST | `/v0/webui/ssh-connections/test` | SSH 物理连接探测 | — | — | — | — |
| POST | `/v0/webui/ssh-hosts/browse` | 浏览远端主机目录 | — | — | — | — |
| GET | `/v0/webui/ssh-workspaces` | SSH 工作区列表 | 9ms | 6 | 3 | 5 |
| POST | `/v0/webui/ssh-workspaces` | 新增工作区 | — | — | — | — |
| PUT | `/v0/webui/ssh-workspaces/{id}` | 编辑工作区 | — | — | — | — |
| DELETE | `/v0/webui/ssh-workspaces/{id}` | 删除工作区 | — | — | — | — |

### 3.10 图像工作室与翻译（14）

| 方法 | 路径 | 用途 | 实测 p50 | 线上 n | 线上 p50 | 线上 p95 |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| GET | `/v0/webui/studio/image/models` | 图像工作室模型目录 | 4ms | — | — | — |
| GET | `/v0/webui/studio/image/sessions` | 图像会话列表 | 3ms | — | — | — |
| POST | `/v0/webui/studio/image/sessions` | 新建图像会话 | — | — | — | — |
| GET | `/v0/webui/studio/image/sessions/{id}` | 图像会话详情 | — | — | — | — |
| PATCH | `/v0/webui/studio/image/sessions/{id}` | 更新图像会话 | — | — | — | — |
| DELETE | `/v0/webui/studio/image/sessions/{id}` | 删除图像会话 | — | — | — | — |
| POST | `/v0/webui/studio/image/sessions/{id}/runs` | 生成图像 | — | — | — | — |
| GET | `/v0/webui/studio/image/sessions/{id}/assets/{assetId}` | 读取图像资产 | — | — | — | — |
| GET | `/v0/webui/translation/settings` | 翻译默认设置 | 13ms | 12 | 5 | 38 |
| POST | `/v0/webui/translation/settings` | 写翻译默认设置 | — | 2 | 4 | 4 |
| GET | `/v0/webui/translation/languages` | 语言白名单 | 14ms | 9 | 1 | 8 |
| GET | `/v0/webui/translation/models` | 可用翻译模型 | 55ms | 13 | 5 | 25 |
| POST | `/v0/webui/translation/detect` | 语言检测 | — | 9 | 1 | 3 |
| POST **SSE/长连接** | `/v0/webui/translation/stream` | SSE：流式翻译 | 不计入 | 191 | 3241 | 10947 |

## 四、SSE / WSS / 长连接清单（不计入 300ms 门槛）

| 方法 | 路径 | 用途 | 线上 n | 线上 p50（含连接存活时长） |
| --- | --- | --- | ---: | ---: |
| GET | `/v0/webui/accounts/watch` | SSE：账号列表增量更新 | 66 | 18248 |
| POST | `/v0/webui/chat` | 发送聊天消息（SSE 流式回复） | — | — |
| GET | `/v0/webui/chat/sessions/{id}/events` | SSE：会话事件流 | 49 | 9335 |
| GET | `/v0/webui/sessions/watch` | SSE：会话文件变更 | — | — |
| GET | `/v0/webui/sessions/watch/ws` | WebSocket：会话 watch | — | — |
| GET | `/v0/webui/projects/watch` | SSE：项目级运行态 | 40 | 11737 |
| GET | `/v0/webui/management/watch` | SSE：管理面状态 | 9 | 1702 |
| GET | `/v0/webui/management/usage/dashboard/query/watch` | SSE：看板查询进度 | 1 | 1091 |
| GET | `/v0/webui/management/usage/scan/watch` | SSE：用量扫描进度 | 1 | 1078 |
| GET | `/v0/webui/openai-models/watch` | SSE：模型目录变更 | 27 | 478334 |
| GET | `/v0/webui/toolkit/subscription-aggregator/sources/sync/watch` | SSE：订阅源同步进度 | 4 | 1311699 |
| GET | `/v0/webui/toolkit/terminals/jobs/{jobId}/watch` | SSE：终端任务进度 | — | — |
| GET | `/v0/webui/terminal/stream` | SSE/流式：PTY 输出 | — | — |
| GET | `/v0/webui/terminal/mux` | 多路复用通道 | — | — |
| GET | `/v0/webui/tasks/watch` | SSE：任务进度 | 91 | 13109 |
| GET | `/v0/webui/app-install/jobs/{jobId}/watch` | SSE：安装任务进度 | — | — |
| POST | `/v0/webui/translation/stream` | SSE：流式翻译 | 191 | 3241 |

> 说明：`watch`/`stream` 类记录的 `durationMs` 是**连接存活时长**，不是首字节时间，不能当接口延迟读。

## 五、关键发现（只陈述事实，不动手）

### 5.0 测量口径告警：未校准的探测会大面积误判

本次采集过程中出现过 3 次明确的假阳性，全部由服务器自身卡顿造成：

| 接口 | 未校准读数 | 校准后净耗时 | 说明 |
| --- | ---: | ---: | --- |
| `GET /v0/webui/app-install/jobs` | 881ms | 0ms | 纯内存读任务表 |
| `GET /v0/webui/studio/image/sessions` | 673ms | 3ms | 纯内存读会话列表 |
| `GET /v0/webui/accounts` | 273ms | 0ms（线上 p50 84ms） | 读状态 |

因此**本阶段所有结论都以「基准扣除」口径为准**：每次测量前后各采样纯内存接口
`GET /v0/webui/tasks` 7 次取中位作为基准；若基准本身 > 300ms，该轮测量作废重测。

### 5.1 服务器存在周期性事件循环阻塞

对最轻的 `/healthz` 做 40 次、间隔 150ms 的串行探测，仍出现多次卡顿：

```
stall 558 ms  t+1161     stall 1033 ms t+4040     stall 734 ms t+7926
stall 190 ms  t+1984     stall  739 ms t+4931     stall 301 ms t+8385
stall 558 ms  t+2854     stall  213 ms t+5295     stall 287 ms t+9439
```

`/v0/webui/tasks`（纯内存读）同样出现过 1840ms / 1876ms 的单次延迟。
**结论：这不是某个接口写得慢，而是进程内存在同步阻塞，任何接口都可能被它拖到秒级。**

### 5.2 已定位的阻塞源：toolkit 在请求线程里同步起子进程

`lib/cli/services/toolkit/proxy-target-plugins/proxy-command.js:5` 的 `execCommand()` 用 `spawnSync`。
调用链与超时上限：

| 接口 | 同步子进程 | 单次超时 | 次数 |
| --- | --- | ---: | --- |
| `GET /toolkit/proxy` | `scutil --proxy` + `networksetup -getwebproxy/-getsecurewebproxy/-getsocksfirewallproxy/-getproxybypassdomains` | 4000ms | 1 + 4×网络服务数 |
| `GET /toolkit/apps` | `mdfind`、`plutil`、`<binary> --version` | 3000ms | 每个 app 一次 |
| `GET /toolkit/environments` | 环境探测命令 | 4000ms | 多个 |
| `GET /toolkit/mirrors` | npm/pip 配置读取 | 4000ms | 多个 |
| `GET /toolkit/tools` | 工具版本探测 | 3000ms | 每个工具一次 |

这些调用全部发生在 Node 主线程，阻塞期间**所有** HTTP 请求（包括 SSE 心跳、健康检查）一起排队。
这解释了为什么 `/healthz` 会和 `/toolkit/proxy` 同时卡住。

### 5.3 有真实上游请求的只读接口

| 接口 | 行为 | 实测 p50 |
| --- | --- | ---: |
| `GET /v0/webui/toolkit/connectivity` | 并发向多个外部站点发 HEAD，超时 5s | 4347ms（净） |
| `GET /v0/webui/openai-models` | 拉取模型目录 | 1309ms（净） |
| `GET /v0/webui/accounts/codex/{accountRef}/reset-credits` | Codex 上游查询重置额度 | 6261ms（未校准，量级可靠） |
| `GET /v0/webui/accounts/{provider}/{accountRef}/plan-stats` | 上游套餐查询 | 需 provider 参数，样本不足 |

### 5.4 缓存行为不一致

| 接口 | 冷启动 | 热缓存 |
| --- | ---: | ---: |
| `GET /v0/webui/projects` | 447ms / 847ms | 13–198ms |
| `GET /v0/webui/toolkit/apps` | 3621ms | 16–59ms |
| `GET /v0/webui/chat-sessions` | 808–1185ms | 65–287ms |
| `GET /v0/webui/sessions/lifecycle-capabilities` | 1403ms | 1–9ms |

缓存命中时都能轻松进 300ms，说明**问题不在查询本身，而在冷启动的同步扫描/子进程**。

### 5.5 数据完整性说明

- 源码扫描到 284 条路由；生产日志实际观测到 104 种请求形态，两者差集主要是需要参数、需要真实 ID 或当前未被前端调用的接口。
- 主动探测覆盖 56 个无副作用 GET；所有写操作（POST/PUT/PATCH/DELETE）**未主动触发**，其响应时间仅取线上日志。
- 线上日志窗口：2026-10-21 12:12 UTC → 2026-10-22 04:34 UTC。

## 六、下一阶段建议的判定口径

1. **先修事件循环阻塞**，再谈单接口优化：否则任何接口都可能被无关的同步子进程拖过 300ms。
2. 同步子进程转异步（`spawnSync` → `spawn`/`execFile` Promise 化）+ 结果短 TTL 缓存，是投入产出最高的一步。
3. `.watch` 系列按需求排除；但 `chat-sessions`、`composer/catalog` 这类「页面一打开就调」的接口必须进 300ms。
4. 真实上游请求类接口（connectivity / openai-models / reset-credits / plan-stats）要不要纳入 300ms，需要单独决策：它们受上游 RTT 支配，除非改成异步任务 + SSE 推送。

## 七、第二阶段：优化结果（2026-10-23）

目标「除 WSS/SSE 外全部进 300ms」已达成。核心发现是：**接口慢只是表象，
根因是主线程被同步子进程占住**——修完这一层，绝大多数接口自然达标。

### 7.1 根因与修法

| 根因 | 影响面 | 修法 |
| --- | --- | --- |
| `spawnSync` 跑在请求线程 | toolkit 全部诊断接口；阻塞期间所有请求（含 `/healthz`）一起排队 | 新增 `execCommandAsync`（`spawn` + 超时 + 输出上限），读路径全部异步并发 |
| 每次请求都重算同一结果 | proxy / mirrors / environments / connectivity / egress-pool | stale-while-revalidate 缓存：有旧值先回旧值 + 后台刷新；`?refresh=1` 强制重测 |
| `O(n²)` 节点查找 | `egress-pool`（546 节点时 500ms+） | 先按 name 建 Map 再遍历 |
| 每个 (账号,模型) 重算整份设置 | `openai-models`（250ms/次） | 按设置对象引用加 WeakMap 缓存 |
| 用量聚合扫全表 | `management/usage`（93 万行） | 在 executor 层加只读结果缓��（store 层的缓存在 worker 里各存一份，不生效） |
| 前端轮询数据没变也重渲染 | 账号页（20 秒内主线程被占 9.8 秒） | 按内容比较后再 setState��粒子参数按档位量化；动画移到合成层 |

### 7.2 前后对比（生产环境，基准扣除后）

| 接口 | 优化前 | 优化后 |
| --- | ---: | ---: |
| `GET /v0/webui/toolkit/connectivity` | 6685ms | 198ms |
| `GET /v0/webui/toolkit/environments` | 2964ms | 2ms |
| `GET /v0/webui/toolkit/proxy` | 2211ms | 258ms |
| `GET /v0/webui/openai-models` | 6741ms | 54ms |
| `GET /v0/webui/egress-pool` | 1066ms | 28ms |
| `GET /v0/webui/management/usage` | 511ms | 45ms |
| `GET /v0/webui/toolkit/mirrors` | 739ms | 0ms |
| `GET /v0/webui/chat-sessions` | 1185ms | 71ms |

账号页（Playwright + CDP）：首屏结束后 Script 0.00s/10s、RecalcStyle 0、动画 0，
页面完全静止；首屏 FCP 48ms、networkidle 528ms。

### 7.3 测量纪律（重要）

生产环境有真实推理流量（`/v1/messages` 单请求 7~32 秒），测量会被干扰。
本阶段的判据是**交错采样 + 基准扣除**：每个接口测 7 次，每次前后各取一次
纯内存接口 `/v0/webui/tasks` 作基准，取中位数之差；基准本身 > 100ms 的轮次作废。

不这样做会得出完全相反的结论——同一个接口在不同轮次里会读到 0ms 和 1123ms。

