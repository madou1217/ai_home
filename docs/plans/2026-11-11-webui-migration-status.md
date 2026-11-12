# WebUI 迁移状态总表（2026-11-11）

> 口径：**Go** = 数据面/持久化在 Go，Node 只做参数预校验与代理；**Go+Node** = 数据在 Go，运行态/调度器视图仍由 Node 合并；**Node** = 主要实现仍在 Node。
> 统计只覆盖 WebUI 管理面（`/v0/webui/*` 与其 Go 对应 `/v1/management/webui/*`），不含推理前门。

## 1. 已完成（39 项，按提交时间倒序）

| # | 能力/接口 | 方法 | 归属 | 说明 | 提交 |
| --- | --- | --- | --- | --- | --- |
| 1 | 账号窗口激活 | GET | Go+Node | Go 返回设置/lastProbe/账本视图，Node 合并调度器 global | `80574e8c` |
| 2 | server 配置 | POST | Go | 立即事务合并 patch、sanitize 后整份落库 | `69655a2f` |
| 3 | 全局用量配置 | POST | Go | 规范化后整份写 `config:usage` | `37d7f582` |
| 4 | 会话框粘贴阈值 | POST | Go | 立即事务只合并 `largePasteChars` | `f8a6d51c` |
| 5 | 账号窗口激活 | POST | Go+Node | Go 写配置，Node 校验并读回合并 global | `29b7280d` |
| 6 | 别名池开关 | POST | Go+Node | Go 写 app_kv，Node 写后重载运行池 | `6b04c318` |
| 7 | 上下文窗口清空别名 | DELETE | Go | 与 POST `tokens:null` 同义 | `a635fd61` |
| 8 | 上下文窗口 | POST/bulk | Go | 覆盖表唯一写者，`BEGIN IMMEDIATE` | `42a6d0f8` |
| 9 | 上下文窗口 | GET | Go | 覆盖 > 探测快照 > models.dev 目录 | `f5078eac` |
| 10 | 账号配置文件查看 | GET | Go | 凭据记录 + 投影文件 + 脱敏 + SQLite 导出 | `d92b349a` |
| 11 | toolkit 执行目标 | GET | Go | 本机 + SSH 连接列表 | `f9bc94e1` |
| 12 | server 配置 | GET | Go | sanitize + 公开视图，夹具对拍 | `4d055cca` |
| 13 | SSH 工作区终端状态 | GET | Go | 终端会话状态 | `7d9192f8` |
| 14 | SSH 工作区列表 | GET | Go | 工作区列表 | `74b3bf35` |
| 15 | SSH 连接列表 | GET | Go | 连接列表 | `43ea861b` |
| 16 | 全局用量配置 | GET | Go | 规范化 `config:usage` | `c5a4d50b` |
| 17 | 会话框粘贴阈值 | GET | Go | 同键 `largePasteChars` | `abe53dba` |
| 18 | 插件启用/停用 | POST | Go | 候选原文 CAS | `489dedd3` / `447bf882` |
| 19 | 插件安装/卸载 | POST | Go | 制品校验、签名、清单 | `c42d2c02` |
| 20 | 插件信任根 | GET/POST | Go | 三路由代理 | `df9626ef` |
| 21 | 插件清单 | GET | Go | Node 本地清单已删 | `1d039b47` |
| 22 | WebUI 终端会话 | GET | Go | 管理密钥后反代 | `59311dfb` |
| 23 | 别名池设置 | GET | Go | app_kv 读取 | `62d65d0c` |
| 24 | 额度重置历史 | GET | Go | 分页读删除 | `fb601436` |
| 25 | 应用启动权限设置 | GET | Go | PUT 仍在 Node | `c3b88b7d` |
| 26 | 账号页读模型 | GET | Go | `/v1/management/webui/accounts` | `7f0fdafd` |
| 27 | 额度统计 | GET | Go | Node 第二套窗口算法已删 | `15917203` |
| 28 | 账号 token 用量 | GET | Go | day/week/month/total | `88953897` |
| 29 | 账号级错误规则 | CRUD | Go | 有效规则拼装收敛 Go | `3ebd4928` |
| 30 | 模型别名 | CRUD | Go | WebUI 契约 + 投影重建 | `56de9ae7` |
| 31 | 账号删除/清理 | DELETE | Go | 删除投影 + 宿主清理 | `d7c6f67b` / `6d095eb7` |
| 32 | 登录作业 | POST/轮询 | Go | codex/claude/opencode/zcode/agy/kiro 浏览器登录 | `58cc1311` 等 6 个提交 |
| 33 | 历史用量导入 | POST | Go | 幂等批量导入 | `d4921e1d` |

### 2026-11-11 追加（控制面，5 项）

| # | 接口/能力 | 方法 | 归属 | 说明 | 提交 |
| --- | --- | --- | --- | --- | --- |
| 34 | control-plane profiles 列表 | GET | Go | 归一化后返回 profiles/activeProfileId | `ca0b2290` |
| 35 | control-plane profile 保存 | POST | Go | 立即事务归一化落库 | `ca0b2290` |
| 36 | control-plane 激活 profile | POST | Go | activeProfileId 校验后落库 | `ca0b2290` |
| 37 | control-plane 删除 profile | DELETE | Go | 删除并清理 active | `ca0b2290` |
| 38 | control-plane 端点提示 | GET | Go | Node 传请求地址/绑定 host/端口，Go 枚举网卡 | `ca0b2290` |
| 39 | provider CLI 升级状态 | GET | Go+Node | Go 读账本投影，Node 合并 scheduler/lastTick | `dffe9562` |

### 2026-11-10 追加（宿主面 / 设置面，10 项）

> 归属口径为 **Go 已实现并挂载 `/v1/management/webui/*`**；Node 的 `/v0/webui/*` 入口尚未切到 Go 代理，见本节末尾说明。

| # | 接口/能力 | 方法 | 包 | 说明 |
| --- | --- | --- | --- | --- |
| 40 | `/git/summary` `/git/diff` | GET | `webuigitapi` | 直传参数调 git，8s 超时 + 2MB 预算，realpath 包含校验 |
| 41 | `/projects` | GET | `webuiprojectsapi` | claude/gemini 复用 sessionscan，codex 读 rollout；2 万条目 + 8s 预算 |
| 42 | `/slash-commands` | GET | `webuislashcommandsapi` | claude 内置 81 条 + 用户命令 frontmatter，指纹守卫 |
| 43 | `/app-entries` | GET | `webuiappentriesapi` | 桌面/CLI 探测，30s 缓存，单 provider 150ms 预算 |
| 44 | `/toolkit/environments` | GET | `webuitoolkitruntimeapi` | 15 个工具并发探测，单工具 1s 版本超时 |
| 45 | `/server-config/management-key/rotate` | POST | `webuimanagementkeyapi` | 立即事务写 `config:server`，常量时间比对，响应 no-store |
| 46 | `/provider-cli-upgrade/:p/clear-broken` | POST | `webuiproviderclearbrokenapi` | 可选验证后清熔断，写回账本 |
| 47 | `/openai-models/refresh` `/delete` | POST | `webuiopenaimodelswriteapi` | 立即事务改 model-catalog-settings，删除幂等 |
| 48 | `/sessions/previews` | POST | `webuisessionpreviewsapi` | 批量 200 上限、并发 8、8s 整批超时、逐条错误 |
| 49 | `/egress-pool` | GET | `webuiegresspoolapi` | 只读投影已实现，**未挂载**：Go 侧还没有出口池数据源 |
| 50 | `/sessions/lifecycle-capabilities` `/sessions/archive` | GET/POST | `webuisessionslifecycleapi` | claude/gemini 文件级归档 + codex app-server；重复归档幂等 |
| 51 | `/accounts/:p/:r` 会话列表 | GET | `webuisessionslistapi` | claude/codex/codebuddy 家族；其它 provider 501 而非空列表 |
| 52 | `/accounts/:p/:r/reauth` | POST | `webuiaccountreauthapi` | 复用 accountauth 作业服务，已有作业幂等返回 |
| 53 | `/toolkit/apps/:appId/settings` | PUT | `webuitoolappsettingswriteapi` | 立即事务合并，交叉约束在事务内判 |
| 54 | `/control-plane/bootstrap` | GET | `webuicontrolplanebootstrapapi` | 默认不回明文 Key，由 `RevealManagementKey` 端口决定 |
| 55 | `/accounts/provider-auth-sources` | GET | `webuiproviderauthsourcesapi` | 只判存在性；`installable`/`alreadyImported` 恒 false 已标注 |

**已实现但未挂载（缺运行时端口）**：`webuiopenappapi`（Launcher）、`webuiaccountrefreshapi`（三段 Refresher）、`webuiaccountrefreshusageapi`（QuotaProbe）、`webuisshhostbrowseapi`（Runner）。这四个包测试齐全，注入真实端口后即可注册；直接挂 nil 端口只会得到 501，所以先不占路由。

**契约分歧（切 Node 代理前必须处理）**：`refresh` / `refresh-usage` 在 Node 是 `202 + job + SSE`，Go 是同步 200 逐段结果；`tool-app settings` 的 PUT 响应缺 `capability`，需与 GET 读模型合并；`app-entries` 已切流并做形状合并。

**尚未切的 Node 入口**：上述 9 条已在 Go 注册并可直连，但 `lib/server/web-ui-router.js` 仍走 Node 实现。切换前必须逐条对齐形状，已知差异：

- `app-entries`：`installed→available`、`executablePath→path` 等改名，前端直读旧形状会空。
- `toolkit/environments`：Go 是精简投影，没有 `runtimes/environments/resources[].managedVersions/canInstall`。
- `slash-commands`：未知 provider 由 200+空清单改为 400。
- `sessions/previews`：Node 静默截 40 条、吞错误；Go 改为 400 / 逐条 error。
- `git`：Node 有 5s stale-while-revalidate 缓存，Go 每次起 git 子进程。

### 2026-11-11 refresh 契约决定

**公开契约不变**：`/v0/webui/accounts/:provider/:accountRef/refresh` 与 `refresh-usage` 仍是 **202 + job + SSE**（事件名仍是 `account-refresh-job`，job 形状仍是 `serializeAccountRefreshJob`），前端不需要改。

Go 侧把原来的同步执行器包成同样的异步作业语义，新增三条管理路由：

| 方法 | 路由 | 响应 |
| --- | --- | --- |
| POST | `/v1/management/webui/accounts/{provider}/{accountRef}/refresh` | 202 `{ok, accepted, alreadyRunning, job}`，job 初始 `status=queued` |
| POST | `/v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage` | 同形，`job.scope=usage` |
| GET | `/v1/management/webui/accounts/refresh-jobs/{jobId}` | 200 `{ok, job}` / 404 |

作业表语义：作业在 Go 进程内异步执行，内存表最多 200 条、终态保留 10 分钟；同一 `(provider, accountRef, scope)` 的活动作业复用并返回 `alreadyRunning=true`。job 字段与 Node 的 `serializeAccountRefreshJob` 逐字段一致（`finishedAt` 未完成时为 `null`，`failedBranches` 为空时省略，`branches` 只在 `scope=account` 时出现）。

**Node 现在是「Go 优先 + 本地回退」**：两条写入口都先调 Go，拿到 `data.job` 立刻回 202，再在后台每 300ms 调 `getRefreshJob`（最多 30s）把 queued/running/终态推成 SSE；终态成功后触发一次规范源刷新，让账号行跟上。

- `webui-account-refresh.js`：三段刷新走 `goCoreSync.refreshAccountWebUI`；Go 的快照映射进本地作业（保留本地 job id，202 与 SSE 仍按同一 id 去重），本地三段实现保留为回退。
- `webui-account-routes.js`：`handleRefreshAccountUsageRequest` 走 `goCoreSync.refreshAccountUsageWebUI`；API Key 账号的 400 前置校验仍在 Node。

只有 `go_core_unavailable` / `network_error` / `http_404` / `http_405` / `http_501` / `status===0` 才退回 Node 的本地实现；`timeout` **不回退**——Go 可能已经在探测上游，本地再探一次会重复打上游——直接落 `failed`「刷新超时」。

验证方法：

- `go test ./internal/transport/http/webuiaccountrefreshapi ./internal/transport/http/webuiaccountrefreshusageapi ./internal/transport/http/webuirefreshjobstore`（三条路由 + 作业表语义）
- `node --check lib/server/webui-account-routes.js`
- 真机：`HOME=/Users/model aih server restart` 后在账号页点刷新，确认 SSE 依次收到 queued → running → 终态，且列表里的额度随后更新。

**仍未切换的点**：Node 的模型目录缓存（`/openai-models` 读路径）仍由 Node 探测，Go 的 `models` 分支只把结果写进 `account_models`；切换前必须先确认模型选择器读的是 Go 的数据，否则会出现「Go 刷到了、界面看不到」。

## 2. 2026-11-10 运行态事故与约束

### 2.1 Go Core 启动即退出（已修）

现象：`aih-server 启动失败: 创建强制恢复调度接口失败: 运行态不支持 RestoreScheduling`，Go Core 反复重启，管理面全部回落到 Node。

根因：`outcomeRecordingRuntime` 是运行态装饰器，只内嵌了 `serverAccountRuntime` 接口。Go 的类型断言看**动态类型的方法集**，内层 `*inmemory.Runtime` 明明有 `RestoreScheduling`，装饰器没有转发方法就断言失败。而 `buildWebUIRoutes` 当时把它当致命错误，直接终止启动。

修法（两道）：
1. `account_outcomes.go` 增加 `RestoreScheduling` 透传——装饰器只做记账，不得收窄能力集。
2. `webuiroutes.go` 把强制恢复调度改成**可选路由**：运行态不提供就跳过挂载（Node 继续兜底），单个 WebUI 写接口不能再拖垮整个 Core。

守卫：`webui_routes_capability_test.go` 断言装饰后仍满足 `RuntimeRestorer`，且内层缺失时返回可识别错误而不是 panic。

### 2.2 旧二进制导致修复"没生效"（运维约束）

现象：`fix(codex-oauth): 回调允许 scope 参数`（`34b605e6`，11-10 16:59）合入后，真机 Codex 登录仍报 `invalid_callback（422）`。

根因：`bin/native/darwin-arm64/aih-server` 是 11-09 构建的（`source_sha=489dedd3`），比修复早一天。supervisor 的 build stamp 只校验 `route_manifest_sha256`，而这次修复没动路由表，摘要一致 → 旧二进制照样通过校验并运行。

约束：**改完 Go 代码必须 `npm run go:build` 再 `HOME=/Users/model aih server restart`**。只看 `git log` 会误判"已修复"。

## 3. 未完成（按优先级）

### P0 账号写路径（影响日常操作）

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 1 | `/accounts/:p/:r/status` | POST | Go+Node | Go 写 `accounts.enabled`，Node 展示投影与默认账号维护 |
| 2 | `/accounts/:p/:r/restore-scheduling` | POST | Node | 运行态门禁 `forceRecover` + 运行池重载 |
| 3 | `/accounts/:p/:r/routing-rules` | POST | Node | 规则校验、映射组、凭据 env 写、清阻塞 |
| 4 | `/accounts/:p/:r/set-default` / `clear-default` | POST | Node | 真实会话默认账号 + 运行池 |
| 5 | `/accounts/:p/:r/set-mobile` / `clear-mobile` | POST | Node | Codex App 账号校验与热同步 |
| 6 | `/accounts/:p/:r/update` | POST | Node | 凭据编辑、状态刷新、运行池重载 |
| 7 | `/accounts/:p/:r/refresh` / `refresh-usage` | POST | Node | 上游探测与额度快照 |
| 8 | `/accounts/:p/:r/reauth` | POST | Node | 重新认证作业 |
| 9 | `/accounts/:p/:r/activity/*` | POST/GET | Node | 本机 Chrome + 验证码，强风控 |
| 10 | `/accounts/detect`、`/accounts/add`、`/accounts/local-import` | POST | Node | 宿主扫描与登录作业框架 |
| 11 | `/accounts/add/jobs/:id` 等 | GET/POST | Node | 登录作业内存状态 |
| 12 | `/accounts/import`、`/accounts/import/jobs/:id` | POST/GET | Node | 导入作业与凭据写回 |
| 13 | `/accounts/export` | GET | Go 数据 + Node 路由 | 导出内容已来自 Go，Node 补文件名/node-only 计数 |
| 14 | `/accounts/kimi/:r/plan-stats` | GET | Node | Kimi 上游套餐探测 |
| 15 | `/accounts/kimi/:r/desktop-session/*` | POST | Node | 桌面版扫码登录 |
| 16 | `/accounts/:p/:r/open-app` | POST | Node | 宿主应用/终端启动 |
| 17 | `/accounts/provider-auth-sources` | GET | Node | 插件系统 + 宿主能力探测 |
| 18 | `/accounts/plugin-login/:provider` | GET | Node | 插件登录视图 |
| 19 | `/app-entries` | GET | Node | 宿主机桌面/CLI 实测 |
| 20 | `/accounts/watch`、`/accounts/watch/snapshot` | GET/POST | Node | SSE 与后台刷新 |

### P1 模型/诊断

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 21 | `/models` | GET | Node | 按 provider 组装模型目录 |
| 22 | `/openai-models`（含 refresh/delete/watch） | GET/POST/PATCH | Node | 模型缓存、元数据、自定义模型 |
| 23 | `/provider-cli-upgrade` | GET | Go+Node | 账本已 Go；Node 只合并 scheduler/lastTick |
| 24 | `/provider-cli-upgrade/:p/clear-broken` | POST | Node | 验证后解除熔断，响应复用 Go+Node 状态 |
| 25 | `/provider-hooks`、`/provider-hooks/install` | GET/POST | Node | 各 provider 官方 hook 适配器 |
| 26 | `/slash-commands` | GET | Node | 原生 CLI slash 命令发现 |

### P2 设置/运维/工具链

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 27 | `/server-config/management-key/rotate` | POST | Node | 安全敏感的即时轮换 |
| 28 | `/server/restart` | POST | Node | 进程生命周期 |
| 29 | `/control-plane/bootstrap` | GET | Node | 本机页面引导，需要回传当前 Management Key |
| 30 | `/egress-pool*`、`/egress-upstreams*`、`/egress-evidence*` | GET/POST | Node | 出口池运行态与证据 |
| 31 | `/accounts/:p/:r/egress` | GET/POST | Node | 账号出口绑定（不建议先做） |
| 32 | `/toolkit/environments`、`/guide`、`/jobs`、`/plan`、`/execute` | GET/POST | Node | 14 类工具与运行时探测 |
| 33 | `/toolkit/apps/:appId/settings` | PUT | Node | 写路径（GET 已 Go） |
| 34 | `/ssh-connections` 写、`/ssh-connections/tunnels`、`/ssh-hosts/browse` | POST/PUT/DELETE/GET | Node | SSH 连接写与隧道运行态 |
| 35 | `/ssh-workspaces/:id/terminal` 等会话写 | POST | Node | 远端 PTY |
| 36 | `/fs/trust` | POST | Node | 可信目录写入（读路径仍在 Node） |
| 37 | `/tasks`、`/scheduled-tasks/*` | GET/POST | Node | 未提交的 task-queue 线 |

### P3 会话/项目/聊天/宿主

| # | 接口 | 方法 | 现状 | 主要缺口 |
| --- | --- | --- | --- | --- |
| 38 | `/projects*` | GET/POST | Node | 宿主 HOME 扫描、目录选择器 |
| 39 | `/fs/tree` `/fs/read` `/fs/access` `/fs/media` | GET | Node | 宿主文件系统授权 |
| 40 | `/git/summary` `/git/diff` | GET | Node | 宿主 git |
| 41 | `/sessions/*`（含 archived/lifecycle/watch/messages/events） | GET/POST | Node | 原生会话扫描与生命周期 |
| 42 | `/chat*`、`/chat/runs/*`、`/chat/attachments` | GET/POST | Node | 聊天编排、PTY、审批 |
| 43 | `/session-events/provider-hook` | POST | Node | 官方 hook 事件入口 |
| 44 | `/internal/approval-request`、`/internal/remote-tools` | POST | Node | 内部会话通道 |
| 45 | `/studio/image/*` | GET/POST | Node | 图片工作室 |
| 46 | `/terminal/*`（主会话已 Go） | GET/POST | Go+Node | 终端会话数据 Go，宿主 PTY 仍在 Node |

## 4. Provider × 能力矩阵（2026-11-05 盘点，未逐格重审）

112 格：**go 32 / both 20 / node 48 / none 12**。明细见 `docs/plans/2026-11-05-migration-matrix.md`。

| 能力 | go | both | node | none | 结论 |
| --- | ---: | ---: | ---: | ---: | --- |
| 登录/OAuth 作业 | 0 | 2 | 14 | 0 | 后续已迁 codex/claude/opencode/zcode/agy/kiro 的浏览器登录，矩阵需重审 |
| 模型目录发现 | 14 | 2 | 0 | 0 | 16/16 由 Go 产出 |
| 额度采集 | 13 | 2 | 0 | 1 | 15/16 由 Go 产出 |
| 推理 relay | 5 | 10 | 1 | 0 | 仅 gemini 仍 node-only |
| 账号删除/宿主清理 | 0 | 2 | 14 | 0 | 删除投影已迁 Go，宿主清理仍 Node |
| 活动签到 | 0 | 0 | 5 | 11 | 强风控，短期不迁 |
| 会话/PTY/SSH | 0 | 2 | 14 | 0 | 宿主级能力，P3 最后做 |

## 5. 建议顺序

1. 账号写路径：`restore-scheduling` → `routing-rules` → `set-default/clear-default` → `update/refresh`。
2. 诊断读：`provider-cli-upgrade`（Go 拿账本，Node 补 scheduler）→ `provider-hooks`。
3. 设置：`server/restart`（最后，属进程控制）；`control-plane/bootstrap` 留在 Node。
4. 宿主面：SSH 写/隧道 → sessions/projects/fs/git/chat（放最后，收益低于风险）。
