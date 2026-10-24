# 设计模式与架构清单（aih）

> 本文是**唯一的设计模式清单**：现有代码哪里用了什么模式、哪里还在用 if/else 该改、改成什么、验收标准。
> 规则（AGENTS.md 同步）：**新增 provider 能力 / 采集面 / 协议分支，禁止写 `if (provider === '…')`**，
> 一律走「描述符声明 + 注册表倒排 + 策略链执行」。改动架构后必须回来更新本文。

## 0. 为什么（一句话）

provider 从 4 个长到 16 个、且还会加：**每加一个 provider，散落的 if/else 就多一份维护成本和漏改风险**。
2026-10-15 的两次事故都是这个结构问题：kiro 的额度/模型采集各自只有一条硬编码路径，没人回答过
「没装本地客户端时怎么办」，于是两个看似权限问题的报错（`kiro_identity_access_denied`、
`native_cli_model_discovery_cli_not_found`）其实是缺抽象。

## 1. 已落地的模式（现状）

| 模块 | 模式 | 作用 | 验证 |
| --- | --- | --- | --- |
| `lib/providers/contract.js` | **Contract / Schema 校验** | provider 描述符契约：能力必须显式回答（`supported` + `reason`/策略），transport↔clientDependent 自洽，只有客户端通道必须写 `clientFreeReason` | `test/provider-capability-registry.test.js`、`test/quota-provider-coverage.test.js` |
| `lib/providers/registry.js` | **Registry + 倒排索引** | 能力名 → provider 集合；`getProviderCapability(provider, face)` / `listProviders(face)`，消费方问能力不问 provider | 同上 |
| `lib/translation/{provider-contract,provider-registry,provider-facade,index}.js` | **Contract + Registry 倒排索引 + Facade** | 翻译引擎以声明式描述符提供操作、认证、配置和无客户端通道事实；注册表按操作倒排，消费者经门面查询，新增引擎无需派发分支 | Node 22 运行时冒烟：5 个内置描述符通过校验，操作索引与能力查询一致 |
| `lib/translation/{route-planner,route-runner}.js` + `lib/server/translation-gateway-executor.js` | **Chain of Responsibility + Adapter + Dependency Injection** | 按启用状态、操作与优先级规划翻译路由，经门面解析描述符；执行器由组合根注入，网关适配器复用既有 SSE runner，不复制 provider 派发。失败分类与 attempt 事件统一，已有译文或取消后停止换路 | Node 22 真实运行时冒烟：排序/过滤、503 换路、400 停止、部分输出停止、空结果换路、AbortSignal 取消及本机 HTTP SSE 的模型与亲和请求头 |
| `lib/translation/adapters/` + `lib/server/webui-translation-routes.js` | **Adapter + Factory Registry + Dependency Injection** | 官方翻译服务各自映射请求/完整响应；共享有界 HTTP、超时、取消和脱敏错误；组合根按工厂声明注册，配置解析器与 fetch 由上下文注入。内联术语表或语气不受支持时显式失败，可由路由链换路 | Node 22 本机真实 HTTP 冒烟：四种服务请求形状、55 次 HTTP 请求、完整响应后唯一 delta、401/403/429/456/500、无效/超大响应、超时和正文中断、缺配置与能力换路 |
| `lib/translation/replacement/transaction.js` | **Transaction + State Machine + Host Adapter** | 写作替换只保存一次性选区快照和版本号；宿主适配器负责真实写入/原生撤回，事务负责冲突检测、过期、逐步替换帧和幂等状态边界，不把编辑器或平台分支塞进翻译服务 | Node 22 真实内存宿主冒烟：逐步替换、成功撤回、外部编辑冲突、取消和 bounded TTL |
| `lib/desktop/translation/service.js` + `native/translation/TranslationPanel.swift` | **Target Adapter + Host Capability Boundary** | macOS 原生面板默认走内置 AIH Server，也可切换到已配置的其他 AIH Server；目标只携带 origin/label，provider 直连仍复用统一 descriptor/adapter 链，避免在 AppKit 里复制路由 | Swift strict typecheck、Node syntax、Web build；服务目标校验拒绝非 HTTP(S) 和未知 kind |
| `web/public/translation-extension/{background,content}.js` | **Browser Adapter + Bounded Scheduler + Command** | 浏览器右键菜单只是宿主适配器；选区/整页动作统一送到 AIH Server，内容脚本负责 DOM 分段、三路并发、旁注/替换和撤回，不复制 provider 路由 | Node syntax + Web build；Manifest V3 artifact includes selection/page commands and target-first settings |
| `lib/server/zcode-egress-resolver.js` + `lib/server/socks5-connector.js` | **Capability Table（消费方能力表）+ Adapter（协议适配）** | 出口代理的 scheme 白名单按**消费方能力**声明在 provider 描述符 `egress.proxySchemes`（契约只允许收窄、必须写 reason；解析器经门面查询，不持有 provider 名单）：网关/Go/Chromium 支持 socks5，ZCode 原生 `httpProxy` 与 Bun 运行时的 opencode 只收 HTTP(S)，因此同一份绑定在不同 provider 上结论不同 —— 收窄发生在**入口校验**（保存即报 `zcode_native_proxy_scheme_unsupported`），不是写进绑定后由消费方静默降级。`socks5-connector` 把 `socks5://` 适配成 undici `Agent` 的 `connect`（ProxyAgent 只收 http(s)），`socks5`/`socks5h` 分别实现（本地解析 vs 代理侧解析）。**硬约束：放行的 scheme 必须真能建隧道** —— 曾经 socks 被 `resolveProxyConfig` 静默丢弃成直连（fail-open、泄漏真实出口 IP），所以白名单与 dispatcher 分支必须成对修改 | `test/socks5-connector.test.js`（真实 SOCKS5 服务端 + 端到端隧道）、`test/zcode-egress-target-resolver.test.js`、`test/server.http-utils.test.js` |
| `lib/server/provider-session-state-store.js` + `lib/server/provider-hook-event-normalizer.js` + `lib/server/webui-session-event-routes.js` | **Revisioned State Store + Event Normalizer + Observer Adapter** | 官方 hook、Codex interaction/retry、PTY fallback 与 route facts 都写入同一份 provider-neutral snapshot；主键固定为 `(provider,nativeSessionId,projectPath)`，correlation 只是可持久化别名。事件按 `eventId` 去重，正 revision 单调接受，早于官方绑定的 correlation 事件进入有界 pending 队列并在绑定时排入目标会话；hook payload 只保留有界交互/状态栏/错误字段，持久化使用原子 rename；跨进程读取会刷新较新的 snapshot，标题侧只读快照，不接触 provider 文件或凭据 | `/tmp/aih-provider-session-state.test.js`、`/tmp/aih-provider-hook-events.test.js`、`/tmp/aih-correlation-restart.test.js`、`/tmp/aih-correlation-conflict-restart.test.js`、`/tmp/aih-cross-process-refresh.test.js`、`/tmp/aih-corrupt-correlation.test.js`、`/tmp/aih-pending-correlation.test.js`、`/tmp/aih-route-state.test.js`、`/tmp/aih-codex-session-state.test.js`、`/tmp/aih-title-state-source.test.js`（16 项通过）；真实 `aih server restart` 后 Claude Statusline + StopFailure 与 Codex SessionStart + Stop POST 均 HTTP 200，状态文件含 `contextPct:68`、`tokens:12000`、`error.message:network unavailable`，标题来源输出 `⚠ network unavailable` 与 `context 68% · 12000 tokens`；Cline 无官方 hook，保留 fallback 口径 |
| `lib/cli/services/pty/terminal-title/` | **Facade + Strategy + Factory + Registry** | 终端标题的两条轴各自抽象：**终端轴** `transports.js`（工厂，按 `supports()` 选通道：OSC 0 / null）与 **Provider 轴** `registry.js`（倒排 + priority 出帧）+ `sources/`（会话名 / 身份 / 路由 / 额度 / 账号 / interaction / retry / error / statusline）。契约 `contract.js` 要求每个来源只回答 `provide(ctx) -> string[]`（**轮播帧数组**），门面 `index.js` 独占三件横切事：抑制、轮播、去重与写；新增一种标题事实 = 注册一个来源；新增一种终端 = 加一个 transport 工厂；**派发代码里没有 provider 名**。网关模式的「当前路由到哪个账号」由 `lib/server/route-observer.js`（写入，挂两个 orchestrator 调用点）与 `lib/runtime/route-observation.js`（读回，fail-soft；统一状态 store 也可作为跨进程刷新来源）解耦送达，关联键经 relay profile 声明的 `sessionKeyTransport`（`session-key-delivery.js`）从 CLI 送进网关请求头 | 临时 title source 测试通过；真实 PTY/title 运行沿用 tmux-backed facade；实时 hook smoke 读取的 Claude frames 为 `Claude:1:gpt-6.1-sol`、`⚠ network unavailable`、`context 68% · 12000 tokens` |
| `lib/providers/loader.js` | **Plugin Loader** | 扫描 `defs/`、`AIH_PROVIDER_EXTENSION_DIRS` 的 `defs`、`<AIH_HOME>/provider-defs`，外部插件与内置同构 | `test/provider-capability-registry.test.js` |
| `lib/providers/defs/<id>.js` 的 `activity` + `lib/account/activity-claim/` + `lib/server/account-activity-job-manager.js` | **Capability Table + Handler Registry + Background Job Queue** | 账号福利（每日签到 / 领臭鸡蛋）声明成 provider 能力：描述符写 `activity.actions[]`（`id` / `label` / `handler`），执行器按倒排索引取 provider、按 handler id 取实现，未知 handler fail-closed；CLI `aih claim`、WebUI 账号快照与三条 HTTP 路由共用同一执行器，前端只渲染服务端下发的 `activityActions`，不写 provider 名单。批量入口**必须显式给出 `providers + actionId`**，任何 provider 未声明该动作即整体拒绝（Qoder / ZCode 不会混批）；POST 只入队并立即返回 job，后台全局串行执行、页面轮询进度，避免账号多时同步 HTTP 超时 | `test/provider-capability-registry.test.js`（坏声明拒绝 + 倒排）、`test/activity-claim.test.js`、`test/account-activity-job-manager.test.js`、`test/webui-account-activity-routes.test.js`、`test/web.account-activity-contract.test.js` |
| `lib/providers/index.js` | **Facade（门面）** | 消费方唯一入口：`getProviderCapability` / `listProviders` / `listQuotaStrategies` | 全仓只 import 这里 |
| `lib/usage/quota/strategies.js` | **Chain of Responsibility（策略链）** | 额度：`clientDependent=false` 优先、失败自动切下一条、`attempts` 可观察。结果可带**结论** `notApplicable + reason`（来源明确回答「没有可消耗的额度池」，先例 qoder Free；zcode 套餐到期走同一条，见 `test/usage.snapshot.test.js`），结论可携带**替代快照**（zcode 空结论快照）覆盖缓存里已失效的正数快照，且判定先于失败语义 | `test/quota-provider-coverage.test.js`、`test/usage.snapshot.test.js` |
| `lib/server/provider-model-strategies.js` | **Chain of Responsibility** | 模型发现策略链（同一套语义，避免两套行为） | `test/kiro-pure-api.test.js` |
| `lib/usage/quota/view.js` | **ViewModel + Adapter（形态驱动）** | 各家快照形态 → 统一 scope（label/category/顺序/单位），展示层不认 provider | `test/quota-view.test.js` |
| `lib/cli/services/usage/{window,credit}-format.js` | **Adapter（保输出兼容）** | 视图模型的 CLI 适配层，输出与历史逐字节一致 | `test/usage.window-format.test.js` |
| `lib/server/account-usage-view.js` | **Table-Driven Mapping** | 账号 payload 归一：账号字段用声明式字段表，条目交给视图模型 | `test/quota-view-provider-coverage.test.js` |
| `web/src/components/account/quota-scopes.ts` | **Single Source of Truth（跨端契约）** | WebUI 展示行唯一派生处，只镜像服务端契约，不镜像 provider 名单 | 同上 |
| `lib/account/native-auth-projection.js` | **Strategy（每 provider 一个投影策略）+ CAS** | 凭据投影/回写；`compareAndSwapAccountNativeAuth` 防并发覆盖。artifact 可声明 `liveStore`（原生客户端**原地续期**同一份文件，如 zcode 的 `v2/credentials.json`）：投影只在磁盘那份缺失/空/损坏/不比账号快照新时才写回，**绝不**用旧快照盖掉客户端刚续期出的活凭据；该判定由描述符驱动，不写 provider 名分支 | `test/cline-*`、`test/kiro-*` |
| `lib/account/host-account-sync/index.js` | **Observer Registry** | 宿主登录态观察者注册表；与删除墓碑集合互相守卫 | `test/host-account-sync-registry.test.js` |
| `lib/account/host-generic-detectors.js` + `lib/account/host-account-detectors.js` | **Registry Inversion** | 「扫描本机账号」覆盖面由声明倒排：认证来源 `scan` 钩子（`lib/providers/contract.js` 白名单登记，`host-auth-import` 默认注入）+ 凭据端口 `hostApiKeySlots`（provider 专属 API Key 落点）；不维护 provider 名单 | `test/host-account-detectors.test.js`、`test/auth-sources.test.js` |
| `lib/account/host-auth-scan.js` / `lib/account/host-api-key-scan.js` | **Template（insert-only 入库链）** | 宿主产物 → 临时登录目录 → `registerProviderAuthProjection({ respectDeletion, insertOnly })`；API Key 走 `buildApiKeyIdentity` 同源身份。只新增、尊重墓碑、比不出代际就不动库 | `test/host-generic-account-scan.test.js` |
| `lib/account/host-self-write-guard.js` | **Guard（自写回流守卫）** | aih 写到宿主的网关地址 / client key / management key / `x-account-ref` / `model_providers.aih_server` / `<aiHomeDir>` 内文件一律拒绝入库 | `test/host-generic-account-scan.test.js` |
| `lib/account/host-account-sync/generic-host-account-sync.js` | **Observer（stamp 门控）** | 通用检测器接进后台轮询：被观察文件 stamp 未变不重扫；覆盖 provider 全部进 `host-observed-providers.js` 墓碑集合 | `test/host-generic-account-scan.test.js`、`test/host-account-sync-registry.test.js` |
| `lib/runtime/provider-resume.js` | **Strategy Table** | 「恢复会话」策略表（各 provider 的 resume 参数） | `test/provider-resume.test.js` |
| `lib/runtime/host-capabilities.js` | **Facade + Adapter（宿主机能力门面）** | 「是不是桌面环境 / 某个应用装了吗 / 装不了能不能装」三问收敛到一处，组合既有 app-entries 探测器与安装器注册表，不重复实现探测 | `test/host-capabilities.test.js`、与 `isCliInstallSupported` 的交叉守卫 |
| `lib/account/auth-sources.js` | **Chain of Responsibility（认证来源链）** | 「这台机器上有哪些账号来源」= 描述符声明 + 宿主机能力 → 可用性排序（**可用优先 → 本机来源优先**，刻意与采集链的「不依赖客户端优先」相反）+ 已入库去重；不可用来源不给实现 | `test/auth-sources.test.js`、真机 `/v0/webui/accounts/provider-auth-sources` |
| `lib/account/host-auth-import.js` | **Adapter（宿主凭据 → 账号投影）** | 把宿主 CLI/IDE 的登录态物化进新账号 runtime dir，注册仍走既有 `registerProviderAuthProjection`；去重指纹两侧同源（`identitySeed`，对 token 轮换免疫） | `test/auth-sources-import.test.js`、真机 claude/gemini（可导入）与 codex/kimi（已入库不显示） |
| `lib/providers/loader.js` | **Convention over Configuration（默认注入）** | 有宿主凭据产物 + 认证方式含 `oauth-browser` 的 provider **自动**获得 `<provider>-host-local` 来源，显式声明优先；新增 provider 不必再抄声明 | 同上 |
| `lib/providers/config-files.js` + `lib/providers/config-schemas/` + `lib/cli/services/toolkit/provider-config-manager.js` | **Declarative Registry + Offline Schema Catalog + Facade** | Provider 配置文件的路径/格式/敏感级/schema 由注册表声明，字段说明是带 `sourceUrl`/`verifiedAt`/`verifiedCliVersion` 的离线快照；消费方（Facade 与 HTTP Adapter）按最长前缀匹配字段，不写 provider 名分支。新增 Provider = 加文件声明 + schema 数据，路由/前端不动 | `test/provider-config-manager.test.js`（路径解析 / 历史 / 恢复 / 脱敏 / 版本兼容 11 项）；真实宿主冒烟 16 Provider、31 文件、codex 306 字段；HTTP 冒烟 list/detail/save/history/restore/export；`web/src/features/provider-config/provider-config-outline.test.ts` 6 项 |
| `lib/server/account-runtime-gate.js` | **Facade / Mediator** | 账号运行态唯一门禁，六条臂统一记账，禁止旁路 | `test/account-runtime-gate-wiring.test.js` |
| `lib/account/runtime-target.js` | **Value Object（运行目标）** | 把「具体账号 / 网关作用域（`gateway:<provider>`）」统一成一个目标对象；调用方（codex app-server、原生会话、chat harness）不再各自判断账号形态 | `test/runtime-target.test.js` |
| `lib/server/chat-runtime/chat-session-coordinator.js` | **Rebind（会话换执行凭据）** | 同 provider 换账号 = 换执行凭据而非换会话：会话 id/时间线不变，harness 重绑 + history seed 回填 | `test/chat-runtime-composition.test.js` |
| `lib/server/chat-runtime/chat-harness-gateway.js` + `chat-harness-model-reader.js` | **Strategy（按运行作用域分流）** | 网关作用域：不写 `X-Account-Ref`（网关池化选号 + 别名回落）、模型目录取 provider 全池；账号作用域：钉选 + 单账号目录 | `test/chat-harness-gateway.test.js` |
| `web/src/features/chat-runtime/session-surface-policy.ts` | **Policy（纯函数决策）** | `resolveChatAccountChange`（ignore / retarget / new-session）与网关目标解析，渲染层只执行结论 | `web/src/features/chat-runtime/session-surface-policy.test.ts` |
| `scripts/provider-collection-audit.js` | **可观察性审计** | 把「有没有不依赖客户端的通道」变成可打印、可守卫的事实 | `npm run providers:audit` |
| `lib/server/window-activation/probe-specs.js` + `lib/server/webui-account-live.js` | **Registry + Capability Flag（能力位驱动入口）** | 账号级动作入口不在前端写 provider 清单：服务端下发 `account.windowActivationSupported = Boolean(getProbeSpec(provider))`（同 `customUpstream`），前端只消费结论；**新增 provider = 加一条探测 spec**，调度器/派发层/前端都不改 | `test/web.window-activation-contract.test.js`（源码守卫：前端不得出现 `provider === 'codex'`） |
| `lib/server/window-activation/window-ledger.js` + `window-activation-scheduler.js` | **Ledger（账本）+ Policy（纯判定）** | 「窗口现在开着没开」不能每次从快照现推：上游在窗口关闭无人使用时按「读取时刻 + 窗口时长」现算 reset（幻影），与真窗口形态一致。账本记录锚点/关窗时刻/来源，观察只把**更新的事实**合并进账本（`observeWindow` 用容差 + `lastProbeAt` 消歧幻影，`reconcileLedger` 拒绝更旧的观察、拒绝倒退）；判定是纯函数 `decideActivation`（开窗不探 / 关窗即续 / 幻影即补 / 观察不出按兜底间隔），触发名与账本字段落盘并在账号页可见 | `test/window-activation-ledger.test.js`（幻影/容差边界/不倒退）、`test/window-activation-scheduler.test.js`（判定矩阵 + runNow 账本落盘）、`test/webui-window-activation-routes.test.js`；取证与设计见 `docs/plans/2026-10-16-window-activation-redesign.md` |
| `lib/server/native-session-launch-profile.js` | **Facade over Descriptors（启动档案）** | 「这个 provider 的一轮怎么起」的唯一派生点：执行模式/prompt 投递取自 `native-session-chat-transport`，运行事实（抑制交互提示/透传 stdout/阶段完成/生图走网关/sessionIndex）取自 `chat-runner-profile`；模式→形态、投递通道→是否 PTY 都是表。消费方（canonical 驱动）不再写 `interactiveCli` 之类硬编码 | 真机：agy=pty-transcript+PTY、claude/opencode/cline/grok=非 PTY、cline 续聊=acp-session（ACP 协议帧、非 PTY；2026-10-16 起替换 typed→PTY） |
| `lib/server/native-session-launch-preparation.js` | **Registry + 声明式步骤序列（启动准备管线）** | 启动前/后的准备步骤由档案声明、实现由注册表按 id 提供（`session-store-links` / `session-index`）；未注册/端口不可用 → **诊断可观察**；fail-closed 步骤失败前先记诊断。补上了 CLI 路径有、canonical 缺的「账号投影会话链接对账」 | 诊断出口 `chat_native_preparation`；真机 agy 从 `provider_resource_reconcile_incomplete:cli.log` 前进到真实启动 |
| `lib/server/native-session-chat-failure.js` | **Rule Table（错误签名 → 结论）** | provider 专属错误签名声明成数据行（`all`/`any` 条件 + `kind=turn\|blocker` + 结论），首个命中胜出；新增签名 = 加一行，不动派发代码。首个 blocker 规则：agy 地区资格拒用 → `permission_denied` 路由阻塞 | 真机：被地区拒的 agy 账号 `runtimeStatus=permission_denied / blocked_by_runtime_status / reason=agy_region_not_eligible`；gemini/cline 既有规则行为不变 |
| `lib/server/server-config-schema.js` | **Descriptor Table（配置目录表）** | `aih server config` 的 20 个可持久化设置项声明成数据（key/旗标/清空旗标/类型/枚举值/默认值/env fallback/生效方式/一句话说明 + 解析器样例），`list`（表格 / `--one-line` / `--json` / 过滤）、`--help` 与测试全部从它派生——不再有「解析器 if 链 / usage 字符串 / 打印函数 / 文档」四处各自维护旗标名。新增字段 = 加一条描述符，测试锁「表 ↔ `DEFAULT_SERVER_CONFIG` ↔ 解析器」三者一致 | `test/server-config-schema.test.js`（20 条样本走真实解析器 + 表白值双向校验 + 三种输出覆盖 + secret 不外泄）、`test/server-config-relay-knobs.test.js` |
| `lib/server/desktop-launch/index.js` + `lib/server/desktop-launch/claude-strategy.js` | **Strategy + Registry** | Desktop 宿主级启动准备由 provider 策略注册表选择；Claude 的第三方模式、AIH Server 配置和默认启动标签封装在独立策略，应用管理器不新增 provider 分支 | 真实 Toolkit 启动 Claude Desktop；`Claude-3p/main.log` 记录 `custom-3p inference apiHost=http://127.0.0.1:9527` |
| `lib/cli/services/toolkit/tool-plugins/` + `tool-manager.js` | **Plugin Registry + Facade** | tmux / psmux / Herdr 的安装来源、配置目标、模板、格式校验与生命周期由插件声明，面板只消费统一工具模型；网络工具保留运行时发现的权威目标 | Node 22 真实清单探测；tmux 版本 / Homebrew 来源、Herdr 缺失配置模板和生命周期计划均可读 |
| `lib/cli/services/toolkit/config-editor.js` | **Atomic Create + Optimistic Concurrency** | 允许声明式模板创建缺失配置，使用硬链接 create-if-absent 处理并发，已有文件继续用 revision 校验和原子替换 | 真实临时 HOME 读取模板、创建配置、重复创建返回 `config_conflict` |
| `lib/runtime/multiplexer/drivers/herdr-driver.js` | **Capability Probe + Fail-Closed Adapter** | 安装检测与 AIH driver 协议能力分开；没有 legacy `spawn --session` 接口的 Herdr 0.9.x 不进入 auto 后台执行路径，保留 tmux 回退 | 官方 Herdr 0.9.5 `--help` / `session --help` 取证确认命令边界 |
| `lib/server/native-session-chat-transport.js` | **Descriptor + 派生消费（`tmuxRun`）** | 「非交互轮次用 tmux 化 run 还是 node-pty」按 provider 声明，`TMUX_RUN_PROVIDERS` 由声明派生（不再由调用方维护名单）。agy 的 `--print` 新会话在 node-pty 下挂住 → 声明 `tmuxRun` 后 14s 完成 | 真机 agy：`ok` 14s、`session.runtime.bound`、时间线 1 条 assistant 消息 |
| `lib/server/chat-runtime/native-session-event-bridge.js` | **State Machine（条目生命周期）** | 桥自己持有助手条目状态（started → delta → completed + `finalize()`）：首个 delta 前补 `timeline.item.started`，轮次收尾补 `completed`（引擎不发 `result` 的 provider 也不丢正文） | 真机 agy：`items=1`、`content="ok"`（含 ttft/duration）；cline/codebuddy/grok 回归 `items=1` |
| `lib/cli/services/session-store.js` | **Table + 语义修正（provider 本地别名）** | 声明的 provider 本地别名（`agy: cli.log`）允许落在宿主受管根**或投影自身**，且**容忍日志轮换导致的悬空目标**（realpath 优先、失败退回链接文本解析）；不再因一个被轮换的日志别名把整账号 fail-closed | `test/session-store.test.js`（70/70，含既有 agy 别名测试） |
| `lib/server/chat-runtime/native-approval-transports.js` | **Strategy Table（审批传输策略表）+ Spawner Registry** | 「confirm/plan 下权限请求怎么到达用户、决策怎么回到 CLI」按 provider/模式/账号类型声明成数据行（`http-callback` / `serve-permission` / `terminal-prompt`），执行器按 id 从注册表取；驱动只按解析结果派发，不出现 provider 分支；未声明/未接线一律 fail closed 且带声明原因 | `npm run chat:legacy-readiness` 的审批覆盖行；真机 claude 进程 argv 含 `--permission-prompt-tool mcp__aih__approve` + canonical runId |
| `lib/server/chat-runtime/native-approval-surface.js` | **Adapter / Mediator（传输无关审批面）** | 任意审批传输（MCP HTTP 回调、opencode serve 权限事件）→ canonical `interaction.requested` → `approval.decide` → 回填传输；交互 id/持久化/收尾走既有 `InteractionResolutionCoordinator`，新增 provider 不动此处 | 真机：ingress POST → `interaction.requested` 落库 → `approval.decide` → 长挂 HTTP 返回 `{behavior:'allow'|'deny'}`；事件序列 `requested → updated → resolved` |
| `lib/server/opencode-serve-api-layouts.js` + `opencode-serve-event-mappers.js` | **Layout Table（API 布局表）+ 形状适配器** | `opencode serve` 两代 API（v1 无前缀/无鉴权、v2 `/api/*` + Basic + `{data}` 信封）差异声明成数据：路由模板/鉴权/信封/作用域传递（v1 `?directory=` vs v2 create body `location`）/请求体形状（prompt `parts` vs `text`、权限规则字段名、回执 `reply` vs `decision`）/模型传递（随 prompt vs 会话级 `POST /api/session/:id/model`）/就绪探测谓词（v1 `{healthy}` vs v2 `/api/info` `{version,pid}`——v2 上旧路径返回 200 HTML，只看状态码必然误判）。事件流差异按 `eventShape` 选适配器（`properties` = v1 词汇 / `data` = v2 `session.text.*`/`session.tool.*`/`session.execution.*`），runner 只消费归一后的信号；未接入的新布局**立即**报明确原因（含实际版本），不让就绪探测空转到超时 | 真机 opencode 2.0.29：work(confirm) 全链路跑通（v2 复用 46802：建会话→PATCH `{permissions}`→切模型→`{text}` prompt→`permission.asked` 归一→审批 allow→`{decision:'once'}` 会话级回执→工具卡/正文/`session.execution.succeeded` 收尾，正文含命令输出）；`test/opencode-serve-api-layouts.test.js`（表契约 + 探测谓词互斥）、`test/opencode-serve-client.test.js`（v1 逐字节不变 + v2 真 http 往返）、`test/opencode-serve-runner.test.js`（v2 映射器/探测复用/未接入布局即报错） |
| `lib/runtime/opencode-run-layouts.js` | **Layout Table + 旗标探测（不按版本号）** | `opencode run` v1（显式 `--dir`）/ v2（无 `--dir`，目录走 cwd/PWD，且必须 `--standalone` 绕开按 channel 固定的后台 service 端口 0xC0DE=49374——多账号并发串台/挂死的根源）差异声明成数据；探测用 `run --help` 旗标、命中才缓存（键=路径+mtime/size）、探测不出默认 v2；逃生门 `AIH_OPENCODE_RUN_LAYOUT`、`source` 可观察（env/probe/cache/default） | 真机 v2.0.29：探测 55ms、缓存 1ms、`--standalone` 生效；`test/opencode-free-cli-transport.test.js` 13/13 |
| `lib/runtime/qoder-client-layouts.js` | **Layout Table（客户端协议版本表）+ 显式未证明清单** | Qoder 不是公开 OpenAI API：端点从客户端缓存解析、推理经内嵌 WASM `prepareInferRequest` 改写 url/headers/body，身份头由 `t5e` 注入。把 CLI 版本 / 二进制 sha256 / 端点 / 账户面路径 / 8 个身份头 / 5 个模型服务固定头声明成版本化数据；`unproven[]` 明确保留「推理链路实际发哪些身份头 / WASM 后精确 wire / 付费 HTTP / qodercn」，禁止把推测写成常量。额度探针消费同一张表的账户面路径 | `qodercli 1.1.73` 二进制取证（sha256 `ec2180c0…`）；`test/qoder-client-layouts.test.js` 8/8；`test/qoder-*.test.js` + `account-derived-state` 51/51；取证文档 `docs/providers/qoder-client-protocol.md` |
| `lib/runtime/acp-layouts.js` | **Layout Table（ACP 入口布局，公共层）** | 面向**所有支持 ACP 的 provider** 的 ACP 入口参数/外部适配器二进制声明表（opencode→`acp`、gemini→`--acp`、cline→`--acp`、codebuddy http-sse→`--serve`、claude→外部 `claude-code-acp` 二进制），门面 `buildAcpEntryArgs`/`getAcpExternalBinary`；**已登记为 provider 能力**（2026-10-16 两步登记完成：JS 描述符 `acp` + Go 合同 `acp_session` 同源；消费方走 `lib/providers` 门面倒排发现支持 ACP 的 provider，入口数据仍以本表为唯一源） | 守卫：`test/design-pattern-guard.test.js`「描述符 / 布局表 / Go 合同三份集合逐项一致 + 每个登记 provider 可解析出入口」；冒烟：providers 10 / verifiedOnly 5 / `opencode→["acp"]` / `gemini→["--acp"]` / `cline→["--acp"]` / `codebuddy http-sse→["--serve"]` / `claude→[]`+外部适配器 / 未知 provider→null / `grok→false` |
| `lib/server/acp-session-runner.js` + `native-session-chat.js` 的 ACP 接线 | **Adapter（协议子进程 → 引擎事件）+ 完成判定归位** | ACP 轮次的子进程适配器：握手（initialize→authenticate→session/load→session/prompt）、load 回放丢弃、delta/工具事件归一、权限回执（bypass 自动允许、优先 allow_always；非 bypass 无审批桥 → fail closed `native_session_approval_bridge_unavailable`，绝不静默放行）；入口参数来自 acp-layouts、认证方法来自启动策略 `resolveAcpAuthMethod`，runner 不感知 provider。**完成判定既不落在协议层、也不落在「transcript 首次追加」**：cline 的 transcript 是增量追加的（工具调用/工具结果各写一条），拿首次追加当完成会把工具轮截断成 `:::tool` 块——完成挂在 `session/prompt` 结算（stopReason = 整轮含工具循环结束）上，结算后仍走引擎既有 transcript 收尾（ACP 不流错误文案、只落会话库，权威正文以会话库为准） | `test/acp-session-runner.test.js`（5 协议场景：回放/权限/bypass/认证失败/进程死亡）、`test/cline-acp-resume.test.js`（引擎级真实子进程＋文件 transcript：工具轮保留最终答复与流式 delta；认证槽位正/负例）、真机 WebUI 续聊 18s 完成（此前 120s 超时）、工具轮含 tool_use→tool_result→最终答复完整落库 |
| `lib/sessions/opencode-db-layouts.js` | **Layout Table（会话库存储布局表）** | opencode 会话库两代表（`session_v2`/`session_message` vs `session`/`message`/`part`：角色在 `type` 列 vs `data.role`、内容内嵌 `data.content` vs `part` 表）声明成数据 + 存在性探测 + 跨布局同形查询构造。两代**两侧都有独有行**（真机 3931 条同 id、旧独有 76 条/7.71M tokens、新独有 1459 条），读取方扫全部存在的布局再按 id 合并；写入方写「当前活跃布局」（新代优先）。新增布局 = 加一条描述符 | `test/opencode-db-layouts.test.js`、`test/model-usage-opencode.test.js`（纯新库 / 双写合并 / 角色以新代为准） |
| `lib/server/opencode-zen-free-client.js` + `upstream-endpoints-transport-opencode-free-http.js` | **Gate Adapter（形状补足）+ Strategy Chain 首选 + Fail-open 交还** | 把 Zen 免费档门禁五条件固化进模块契约：离线铸造会话 id（`~(t*4096+counter)`，与官方 identifier.ts 逐位一致）、tools 缺 `read` 时补空描述垫片、`stream:true` 恒流式（非流式由 SSE 聚合器还原成 `chat.completion`）；吃到 403 门禁时 `run()` **返回 null 交还链上 CLI**（零记账 + `opencodeFreeZenGatedFallback` 注解留痕） | bisect 矩阵：`[read]`=200、`[todoread/READ/read_file]`=403、非流式=403、12 真工具/单 read 等价；冒烟 14/14（含 2 条真实网络腿）；真机 E2E 流式/非流式/带客户端工具三条全 200（回复 pong、零 tool_calls） |
| `lib/server/go-core-servable-providers.js` + `lib/server/go-core-route-deferral.js` | **Table（入口感知的推理通道表）+ Gate（带稳定原因合同的交还判定）** | 「Go 服务得了哪些 Provider 的推理」声明成两条通道表：canonical（codex/claude/agy，全入口）+ relay（家族四支，只在挂载透传的 chat completions；名单派生自 `FAMILY_PROVIDERS`，与 Go `FamilyProviders` 三方守卫）。交还判定同表驱动，**不写 provider 名分支**：池门只解禁「这个模型的承载者全为 relay 通道」（承载者 = 索引里真有该模型账号的 Provider，与 Node `getModelBindingScore` 同源正向证据），其余原因（别名 / Go 目录 / 规则投影）顺序固定，全部登记进 `/readyz` 的 `node_fallbacks` 原因表 | `test/go-core-servable-providers.test.js`（集合三方一致 + 入口感知 + 钉选硬证据 + 池门模型级矩阵）、`test/go-core-route-deferral.test.js`（原因表逐项）、`test/go-core-node-fallback-counters.test.js`；Go 侧 `family_relay_wiring_test.go`（钉选 + 未钉选端到端） |
| `lib/server/go-core-route-deferral.js` 的 custom-upstream gate | **Boundary Gate（上游所有权隔离）+ Capability Predicate** | 第三方或另一台 AIH gateway 的 API Key 账号不进入 Go native quota/failure runtime；HTTP/WS 统一交还 Node，由 Node 保留远端 pool、relay 头和错误范围语义。官方 API Key 仍走既有 Go canonical 路径，新增 fallback reason 进入 `/readyz` 合同 | `test/go-core-relay-boundary.test.js`：远端 custom upstream 钉选/未钉选、陈旧 Go quota overlay、官方 API Key 保持 Go 路径；`NODE_FALLBACK_REASONS` 稳定原因守卫 |
| `internal/host/aihserver/relay_providers.go` | **Single Source of Truth（声明倒排）** | Go 侧「由透传通道直接服务」的 Provider 集合只声明一处（家族四支 + cline/grok/kimi），推理目录构建（`inference.go` 的 `WithRelayProviders`）与模型刷新队列（`composition.go`）共同消费。两处各写一份曾造成真实故障：刷新队列登记了 cline/grok/kimi，目录构建未声明 → `buildRule` 因缺 Factory 硬失败 → 整份模型快照永不发布（`/v1/models` 5xx、路由判定拿不到可路由集合、未钉选请求全部交还 Node） | `internal/host/aihserver/relay_providers_test.go`（刷新队列 ⊆ canonical ∪ relay，且每个 relay 必须有刷新队列）；真机重启后 Go `/v1/models` 200、`appliedGeneration` 追平 |
| `lib/server/go-account-sync.js` | **Terminal-State Cache（按内容指纹的终态缓存）** | Node→Go 推送的拒绝分两类：内容永久无效（`invalid_native_artifacts`）与代际仲裁拒绝（`account_import_generation_unordered`，Go 已有同代或更新凭据）。两类都按「计划指纹 + Go 目标账号」缓存：同一份内容不再每 15s 重发，内容变化或 Go 账号消失才重新尝试。**循环是收敛机制（凭据回写/推送/启停/模型策略/删除/收养）本身，不是被缓存掉的东西**；被缓存的是「同一份内容再推一次结论也不会变」的请求 | `test/go-account-sync-rejections.test.js`（内容不变零请求、重启保持、内容变化/Go 账号删除即重试） |
| `lib/server/kiro-dialect.js` | **Adapter（上游方言适配器）** | kiro 的 CodeWhisperer 方言规则与 HTTP / 重试 / SSE 分离：`encodeKiroConversation` 编码 tools / toolUses / toolResults / images 并落实四条上游硬规则（description 非空、带工具历史必须带 tools、结果与紧邻调用一一对应、tool_choice 等价 auto），`createKiroFrameDecoder` 解码 `toolUseEvent` / `contextUsageEvent` / `meteringEvent`。方言规则可单测穷举，新增规则 = 改这一个文件 | `test/kiro-dialect.test.js` + 真机（Builder ID / Google social，haiku-4.5 / sonnet-4.5 / opus-5.5）工具轮跑通 |
| `lib/server/kiro-chat-transport.js` | **State Machine（流生命周期）+ Outcome（`completion`）** | 每个流恰好一个终止事件：首字节前失败（400/401/429/容量提示）返回 `completion` 交回策略链换号；首字节后失败发原生错误帧，绝不补一个「干净的 end_turn」；超时是「首事件 180s + 空闲 120s」而不是整轮墙钟；上游静默发保活；客户端主动中断不计失败 | `test/kiro-chat-transport.test.js`（19 条）、`test/kiro-transport-strategy.test.js`（4 条） |
| `lib/server/protocol-stream-errors.js` | **Table + Strategy（错误帧读 / 写两张表）** | canonical `{ type: 'stream_error', code, message, statusCode }` 的读、写各一张按客户端协议索引的表（Anthropic `event: error`、Responses `response.failed`、Chat / Gemini error 帧）；新增协议只加一行，parser 不再在 EOF 补 `message_stop` 伪装成功 | `test/protocol-stream-errors.test.js`、`test/protocol-conformance-matrix.test.js` |
| `lib/server/upstream-endpoints-transport-chain.js` | **Declared Capability + Strategy Chain（能力协商不静默降级）** | transport 声明 `capabilities: { clientTools: false }`；请求带工具却落到该通道时在 attempt 注解与响应头 `x-aih-capability-degraded: client_tools` 标出降级（不拒绝：WebUI chat harness 总带工具，纯文本作答仍有价值）。链上按声明派发，不写 provider 判断 | 全量测试；qoder CLI / opencode 免费 CLI 通道 |
| `lib/server/native-session-outcome-poller.js` | **Template Method（原生会话结果轮询模板）** | 「原生 CLI 每轮/每段结果 → 账号结果桶（健康统计）」的幂等游标、未归属不推进、去重键由模板持有；cline 与 kiro 只提供 `collect()`（`kiro-session-outcomes` 读 `usage_summary`，`cline-session-outcomes` 读会话记录 status） | `test/kiro-session-usage.test.js`、cline 回归用例 |
| `lib/usage/registry-scope-ownership.js` | **Single Source of Truth（共享会话库的账号作用域归属）** | cline / kiro 的会话写在宿主共享目录、文件本身没有账号边界：归属只来自持久会话注册表的「账号 × cwd × 时间窗」作用域；唯一命中才归属，否则记未归属、绝不猜。supervisor 托管的 pane 仍存活时作用域开放到现在（修复「运行中会话最近事件被判未归属」） | `test/kiro-session-usage.test.js`、`test/cline-session-outcomes.test.js` |
| `lib/usage/kiro-session-usage.js` | **Estimator（有来源的估算，绝不造数）** | kiro 会话只有 `contextUsage` 百分比与 credits，没有 token 字段：上下文 token = 百分比 × 模型 `maxInputTokens`、前缀重叠按 5 分钟 prompt-cache TTL 计缓存读、输出按字符估算，`sourceKind: native_kiro_session_estimated`；扫描按字节偏移增量、事件键去重 | `test/kiro-session-usage.test.js`；真实会话只读试跑（10-18 99 次、10-19 568 次请求全部正确归属） |
| `lib/server/codex-responses-ws-http-bridge.js` | **Adapter（WebSocket → HTTP 管线）** | 宿主 Codex 声明 `supports_websockets = true` 时，WS 通道过去只能转给 Codex 账号，别名 / 其它 provider 的模型首帧 503。桥把这类请求改走网关 HTTP `/v1/responses` 管线，结果再按 WS 帧返回；`previous_response_id` 展开成完整上下文；Codex 自己的模型不走桥 | `test/codex-responses-ws-http-bridge.test.js`（5 条，含端到端）、原有 WebSocket 与配额回退用例 |
| `lib/account/kiro-account-label.js` | **Information Expert（唯一推导点）** | kiro 的展示名与身份键只在这一处推导（登录方式 + `identityEvidence.subject`）；CLI 列表判重优先身份键、展示名兜底，服务端 `displayName` 同源，不再各自维护占位名（曾导致「同邮箱两个账号被误标重复」） | `aih kiro ls` 真机输出（`Kiro (AWS Builder ID)` / `Kiro (Google)`，无重复标记）、`test/profile.list.test.js` |
| `core/providers/builtins.go` 的 kiro `usage_scan` | **Descriptor-Driven Dispatch（描述符声明能力）** | 「kiro 支持原生会话用量扫描」声明进 Go 契约（`CapabilityUsageScan`）并重新生成 `contracts/providers/manifest.json`；扫描器按能力倒排发现，不写 provider 名单 | Go provider 测试、`npm run providers:check`、`test/provider-catalog.test.js` |
| `lib/runtime/egress-pool-node-policy.js` | **Specification（策略即数据）+ Single Source of Truth（判定唯一）** | 出口池的「哪些节点不许用」收敛成一份可存的策略（延迟阈值 / 连不上 / 手动关闭三个独立开关，app_kv 的 `egress:node-policy`）加一个纯函数判定 `decideNode`：账本的 `pickNext`（轮换）与规划器的车道 `allowed` 集合都调它，因此轮换、车道、面板三处结论必然一致，不会出现「面板说拦了、轮换还在用」。手动关闭按**出口身份**记（重启与节点重排后仍有效）；判定跟最近一次探测走而不按时间自动过期（10s 的节点不能过几分钟又被选中），防误伤靠 dueForProbe 重探自动放行；从未探测 = 未知而非不可用；策略读不出来时退化为「不拦截」而不是让池空掉 | `test/egress-pool-node-policy.test.js`（11 条：三开关互相独立、未知不拦、10s 持续被拦、手动优先且局部更新不丢、阈值钳制、探测超时随阈值放宽、pickNext 跳过与恢复、策略读失败降级）、`test/egress-pool-lanes.test.js`（被拦节点不进车道 + 全被拦的原因）、`test/egress-pool-node-health.test.js`（路由 block/unblock 与策略写入）；真机 517 节点账本：>3000ms 的 13 个被拦、手动关闭的节点 40 次轮换不再出现；浏览器经隔离 harness 验证开关/筛选/关闭-放行往返 |
| `lib/cli/services/toolkit/subscription-aggregator/source-sync-runner.js` | **Observer + Scheduler（任务化同步 + 全局并发槽 + 单飞）** | 「同步订阅源」从「请求里同步拉完所有源」改成任务：`start()` 立刻返回，每个源各自出结果，进度经 `onChange` 推给界面（路由层转 SSE）。并发上限是**全局**的（多个任务共用一条队列，点完全部同步再点单个源也不会把上游打满）；同一个源同时只拉一次（两个任务都含它时共享同一次拉取）。一个源失败（403/超时）只影响它自己那一行 | `test/subscription-aggregator-source-sync-runner.test.js`（7 条：立刻返回、单源失败不连坐、跨任务并发上限、同源单飞、抛异常不卡死、监听器异常不中断、过期清理）、`test/subscription-aggregator-routes.test.js`（202 + SSE 帧） |
| `lib/cli/services/toolkit/subscription-aggregator/local-clients/`（`index.js` + 每客户端一个插件） | **Plugin + Registry（本地客户端扫描）** | 「扫描本机客户端配置」按客户端声明成插件：插件只回答「配置在哪个目录、长什么样、订阅地址在哪」，`scanner-kit.js` 统一负责读盘上限、宽松解析、地址规范化与跨客户端去重，`local-client-config-scanner.js` 负责「与已有订阅源比对」。新增客户端 = 加一个插件文件 + 登记一行，扫描服务/路由/前端不动 | `test/subscription-aggregator-local-scanner.test.js`（8 条：Clash Verge 与 Surge 各自布局、每个看过的客户端都上报、跨客户端去重、已导入判定、无 name 用域名、Windows/Linux 目录、坏配置不连坐、只读不写）；真机扫描 Clash Verge 4 条 + Surge 4 条 |


## 2. 反模式清单（该改的地方）

扫描口径：`grep -rn "provider === \|provider !== \|normalizedProvider ===" lib/ --include='*.js'`（排除测试）。
**同一文件出现 2 处以上 provider 名比较 = 该文件需要一次策略化改造**（2026-10-15 扫描）。

| 优先级 | 文件 | 处数 | 现在在做什么 | 目标模式 |
| --- | --- | --- | --- | --- |
| P0 | `lib/server/http-utils.js` | 11 | 模型发现按 provider 名分支（opencode/zcode/codex/gemini/kimi/claude…） | **Handler Registry**：描述符声明 `models.strategies[].handler`，实现在 `lib/server/model-discovery/handlers/*.js`；http-utils 只做门面调用 |
| P0 | `lib/server/native-cli-model-discovery.js` | 中央表 | `NATIVE_CLI_MODEL_STRATEGIES` provider→CLI 参数表 | **策略表迁进描述符**（`cli: { args, format }`），该文件降级为执行器 |
| P1 | `lib/server/webui-account-live.js` | 26 | 账号视图按 provider 拼字段/行为 | **Descriptor-driven ViewModel**（`accountView` 能力） |
| P1 | `lib/server/webui-chat-routes.js` | 24 | 聊天/会话按 provider 分支 | **Adapter + Strategy**（`launch/attach/stream` 适配器接口） |
| P1 | `lib/server/webui-account-routes.js` | 22 | 账号操作按 provider 分支（登录/刷新/删除） | **Command Registry**（路由只做鉴权与派发） |
| P1 | `lib/server/native-session-chat.js` / `-command.js` | 21 / 15 | 原生会话命令按 provider 拼 argv | **Strategy Table**（同 `provider-resume.js`） |
| P2 | `lib/account/native-auth-projection.js` | 20 | 投影按 provider 特判 | **Strategy**：每 provider 一个 projection strategy 模块 |
| P2 | `lib/server/provider-session-hook-config.js` | 15 | hook 配置按 provider 分支 | **Descriptor**（`hooks` 能力） |
| P2 | `lib/usage/model-usage-store.js` | 10 | 用量读取按 provider 分支 | **Adapter**（`usage` 能力扩展） |
| P2 | `lib/server/upstream-endpoints-path.js` | 10 | 上游路径按 provider 分支 | **Strategy**（协议适配器表，与 `protocol-*.js` 合并） |
| P3 | `lib/account/credential-layout.js`、`lib/account/transfer-core.js`、`lib/sessions/session-reader.js`、`lib/server/models.js`、`lib/server/models-dev-metadata.js`、`lib/server/web-account-auth*.js`、`lib/server/webui-project-cache.js` | 6–10 | 凭据布局 / 导入导出 / 会话解析 / 模型元数据 | Strategy / Table / Adapter，随对应能力面迁移 |

需要消失或降级为「契约派生」的中央 provider 清单：`lib/server/providers.js`、`lib/server/accounts.js`、
`lib/server/protocol-fallback-bridge.js`、`lib/server/web-account-auth*.js`、`lib/server/webui-project-cache.js`、
`lib/server/provider-session-hook-config.js`、`lib/usage/codebuddy-*`、`lib/usage/model-usage-read-projection.js`、
`lib/server/native-cli-model-discovery.js`。

### 存储布局反模式（2026-10-16 · opencode 会话库两代并存）

opencode 2.0.29 起只写新代 `session_v2`/`session_message`，旧代表停在迁移时刻，且两代**两侧都有独有行**
（真机量化：3931 条同 id、旧独有 76 条/7.71M tokens、新独有 1459 条）——凡硬编码表名或「一侧为准」二选一的
实现都会丢另一侧数据。布局知识唯一来源：`lib/sessions/opencode-db-layouts.js`（Layout Table）。

| 优先级 | 文件 | 处数 | 现在在做什么 | 目标模式 |
| --- | --- | --- | --- | --- |
| P1 ✅ | `lib/sessions/session-reader-opencode.js` + `lib/sessions/session-reader.js`（`readOpenCodeSessionModel`） | 5 查询点 | 原 WebUI 会话历史只读旧表：新会话定位（`FROM session`）查不到 → 历史与列表整个缺新会话；消息渲染依赖 `part` 表 | 已消费同一张布局表（2026-10-16 完成，验证见 §3 Phase 3.5 第 13 条）：会话面两代并集（同 id 取更新更晚副本，归档/子会话过滤在合并之后）；消息面并集 + 按 `contentModel` 渲染（`inline` vs `parts`），同 id 新代优先、新代渲染为空不遮挡旧代 |
| P2 ✅ | `lib/sessions/opencode-session-store.js`（WebUI chat 代理） | 7 写入点 | 混合写：`session`/`message`/`part` 写死旧表，`session_message` 只写 switch 行；`assertRequiredTables` 要求旧表存在（纯新库直接报错）。真机后果比「新会话对 2.x 不可见」更重：`session_message.session_id` 有 FK → `session_v2(id)`（node:sqlite 默认强制），迁移后库上新会话创建直接 `FOREIGN KEY constraint failed` | 已消费同一张布局表（2026-10-16 完成，验证见 §3 Phase 3.5 第 14 条）：新会话写活跃布局（`detectOpenCodeWriteLayouts` 首个 = 新代优先）；已存在会话写自身布局（两代都有取新代、仅旧代保持旧代——消息不跨代分裂）；门禁按「至少一代完整可写」；switch 行删除（从未成功持久化过） |

### 残缺目录反模式（2026-10-21 · opencode 官方目录两腿并集）

opencode 官方模型目录是**两条上游腿的并集**：Go（`/zen/go/v1/models`，37 个订阅模型）∪
Zen（`/zen/v1/models`，86 个含**全部免费档**）。`opencode-server-client.js` 用
`Promise.allSettled` 并行探两条腿、**只在两条都失败时才报错** —— 单腿失败被静默吞掉
（2026-10-21 实测复现：只让 Zen 腿失败 → 返回 37 个模型、零错误信号）。

而 `model-pool-narrowing.js` 的 `excludeAccountsWithoutModel` 把「目录已知且不含」当**强证据**
否定账号。于是残缺目录被误当强证据：`opencode/<x>-free` 不在 37 个里 → 唯一 opencode 账号
被判「不支持该模型」→ 踢出候选池 → 免费模型请求恒定 **503 no_available_account**。
真机触发条件：后台刷新只有 2.5s 预算，Zen 腿偶发超时。

| 优先级 | 文件 | 处数 | 现在在做什么 | 目标模式 |
| --- | --- | --- | --- | --- |
| P0 ✅ | `lib/server/opencode-server-client.js`（`probeOpenCodeCatalog`） | 2 腿 | 单腿失败静默丢弃，残缺目录冒充完整目录 | **显式事实传递**（2026-10-21 完成，commit 111d0fad）：返回 `{models, incomplete, legErrors}`，残缺不再隐式 |
| P0 ✅ | `lib/server/http-utils.js`（`markCatalogCompleteness`）→ `model-discovery/index.js` → `provider-model-discovery.js` → `webui-model-cache.js` → `model-account-pool-selector.js` | 5 跳 | 目录质量在链路中途丢失 | 同一事实沿链路传递：`fetchModelsForAccount` 用**非枚举属性** `catalogIncomplete` 挂在返回数组上（返回值必须仍是数组，调用方大量按数组消费）；缓存落 `incompleteByAccount` 并按「本轮确实探过」合并（补探成功自动清标记） |
| P0 ✅ | `lib/server/model-pool-narrowing.js`（`excludeAccountsWithoutModel` / `isPoolCatalogComplete`） | 2 判定点 | 残缺目录参与否定排除与「没有账号能服务」终判 | **证据强度分级**：残缺目录降级为弱证据放行，与既有「目录未知 ≠ 账号不能服务」同源——残缺目录缺的是证据，不是能力 |

验证：`test/opencode-server-client.test.js`（单腿失败标 incomplete / 双腿齐全标 complete）、
`test/server.model-pool-narrowing.test.js`（残缺不排除 / 清标记后恢复强证据 / 池含残缺账号不下终判）；
真机：修复后目录 37 → 123（86 Zen + 37 Go），免费模型错误从网关合成的 `no_available_account`
变成真实上游 `429 FreeUsageLimitError`。

## 3. 改造路线（每步独立可验证、可回滚）

**Phase 1 — 采集面（额度 + 模型）彻底策略化**
1. ✅ 额度：16/16 provider 声明策略链，`clientDependent=false` 优先 + CLI 兜底（kiro 已实测纯 API）。
2. ✅ 模型：16/16 provider 显式回答（`models` 能力），CLI-only 必须写 `clientFreeReason`。
3. ✅ **Handler Registry**：`lib/server/model-discovery/{handler-registry,http-handlers,generic-models-probe}.js` + 门面；
   描述符声明 `handler: '<id>'`；通用探测已搬出 `http-utils.js`（provider 名分支逐面删除，等价性测试 71/71）。
4. ✅ CLI 模型表迁进描述符（`models.strategies[].cli = { args, format, configDirFlag, minTimeoutMs }`），
   `native-cli-model-discovery.js` 只留执行器，中央 provider→CLI 参数表已删除。
5. ✅ `local` transport 策略在出网解析之前执行（cline 的静态规范清单不再依赖出网配置）。

**Phase 2 — 账号视图与操作**
5. 🔄 `accountView`：**视图特例已收口**（`lib/server/account-view-hints.js` 注册 agy 的 OAuth 元数据/额度视图/不可调度、
   codex 的桌面端标记/auth.json 身份延迟/workspace 装饰、kimi 的手机号显示名；`lib/server/account-presence-probes.js`
   注册在场判定探针）。`webui-account-live.js` 的派发分支已 **25 → 0**。仍未做：把「字段清单」本身（badges/actions）也声明化。
   * 形状（设计已定）：`capabilities.accountView = { fields: ['planType','planName',…], badges: ['plan','subscription'], actions: ['refresh','relogin','delete','set-default'], desktop?: {…} }`
   * 迁移对象：`lib/server/webui-account-live.js`（25 处）→ 视图层只读 `accountView`，不再判 provider。
6. 🔄 账号操作：**已落地两张表**（`ACCOUNT_ROUTE_SCOPES` 路由作用域 + `ACCOUNT_LIFECYCLE` 生命周期钩子，
   含宿主直连授权回收 / 桌面端 runtime 重载 / agy 后台进程驱逐 / API Key 账号配置形状），
   `webui-account-routes.js` 派发分支 **22 → 0**。仍未做：把「登录/刷新/删除」收敛成统一 Command Registry。
   * 形状：`capabilities.actions = { refresh: 'handler-id', relogin: 'handler-id', … }`；路由只做鉴权 + `Facade.dispatchAction(provider, action)`。
   * 迁移对象：`lib/server/webui-account-routes.js`（22 处）。
7. ✅ 协议路径策略化：`upstream-endpoints-path.js` **24 → 0**（`UPSTREAM_BASE_URL_RULES` + `STRIP_V1_*` 两张表）。
   注：该文件原头部写「GENERATED … do not edit manually」，但拆分脚本是一次性工具且已跑完、母文件已不含这些函数
   —— 本文件现在是权威源（头部注释已纠正）。
   * 注意：该文件是 `upstream-endpoints-split` 脚本生成的（文件头写明 do not edit manually）——
     必须改**生成器 + 模板**，并新增 `capabilities.protocolPath = { resolve(account, reqUrl, upstreamBase) }`；
     claude 的 `/v1` 去重、codebuddy 家族的 `/v1→/v2` 抬升等规则随描述符走。
8. ✅ `hooks` 能力：`lib/server/provider-session-hook-config.js` 的 15 处 provider 名分支**清零**。
   形状：描述符声明**档案**（`adapter` / `target` 路径段 / `timeoutUnit` / `eventMatchers` / `featureFlag`），
   格式实现留在**适配器策略表**（`HOOK_ADAPTERS`：`json_hooks` / `agy_named_hooks` / `opencode_plugin`，
   与 Go 合同 `sessionSync.adapter` 同源）；派发处零 provider 名，targetKind 直接取合同字段
   （原 `HOOKS_JSON_TARGET_PROVIDERS` 手写集合已删除）。漂移由 `test/design-pattern-guard.test.js`
   的「描述符 ↔ 合同一致性」用例双向守住。
9. ✅ 复核结论：`lib/usage/model-usage-store.js` 的 10 处是 **`record.provider === 'kimi'` 这类记录字段过滤**，
   不是派发分支（守卫正则已收紧排除点号前缀）。**无需迁移**。

**本轮新增的注册表模块（模式清单补充）**

| 模块 | 模式 | 解决的问题 |
| --- | --- | --- |
| `lib/server/account-presence-probes.js` | Table-Driven + 每条目自带事实 | 凭据形态判法按 provider 注册（`selfDetermining` / `credentialPresence` / `credentialPresenceApiKeyMode`） |
| `lib/server/account-view-hints.js` | ViewModel Hints | agy/codex/kimi 的视图特例成数据；外部依赖由调用方注入（避免循环依赖） |
| `lib/server/account-credential-patch.js` | Strategy Registry | 凭据写入（env 键名映射 + Claude 认证方式信封切换） |
| `lib/server/chat-runner-profile.js` | Strategy Table | chat 运行方式（审批桥 runner / native 能力 / 生图通道 / 宿主同步 / 项目 hook） |
| `lib/providers/contract.js` 的 `hooks` 能力 | Contract/Schema + Facade | Hook 档案（adapter / 目标路径段 / 超时单位 / eventMatchers / featureFlag），与 Go 合同 `sessionSync.adapter` 双向一致由守卫强制 |

**Phase 3 — 会话与聊天**
10. 🔄 会话与聊天：`webui-chat-routes.js` **19 → 10**（`lib/server/chat-runner-profile.js`：API Key 能否走 native、
    抑制交互提示、生图走网关、审批桥 runner、宿主 provider 段同步、项目 hook 引导）。
    **仍未做**：`webui-chat-routes.js` 剩下的会话 id 处理 / api-proxy 请求形状（10 处），以及
    `native-session-chat.js`（20）+ `native-session-chat-command.js`（19）+ `-sessions.js`（8）——
    这三个文件正被另一会话改动，等其收工后按 `capabilities.sessionAdapter` 收敛。
    * 形状（设计已定）：每 provider 一个会话适配器 `{ launchArgs(ctx), resumeArgs(ctx), streamParser, sessionIdFrom(event) }`，
      由描述符 `capabilities.sessionAdapter` 声明；命令层只做「取适配器 → 拼 argv → 执行」。
    * 参照实现：`lib/runtime/provider-resume.js`（策略表）与 `lib/cli/services/ai-cli/launch-profile/*-strategy.js`（每 provider 一个策略模块）。

**Phase 3.5 — 存储布局（opencode 会话库两代并存，2026-10-16 新增）**
12. ✅ 用量扫描：`lib/sessions/opencode-db-layouts.js` 布局表 + `model-usage-scanner.js` 消费——扫全部存在的布局、
    同 id 按 token 总量合并、总量相等取新代（= 角色/类型以新代为准；真机 A/B：127 条 `synthetic`/`compaction`
    不再误记为提示词，其余仅 ±1ms 时间对齐差异）。
13. ✅ WebUI 会话历史（P1，见 §2 存储布局反模式）：`session-reader-opencode.js` 消费同一张布局表——
    会话面/定位/模型两代并集（同 id 取更新更晚副本；归档与子会话过滤移到合并之后，新代标记不被旧代
    冻结副本复活）；消息面并集 + 按 `contentModel` 渲染（`inline` 用 `type` 列角色 + `data.content`
    条目，tool 产出读 `state.content`；`parts` 走旧路径），同 id 新代优先、新代渲染为空不遮挡旧代；
    `readOpenCodeSessionModel` 从 `session-reader.js` 迁进读取器（新代优先、旧代兜底）；
    `detectOpenCodeSessionLayouts`（只要求会话表）与消息面探测区分，半残库会话面不整段读不到。
    真机 A/B（165 会话）：140 完全一致、14 新代超集（旧读 0 条 → 新读全量）、模型 139 一致 / 26 从无到有 /
    0 变化、列表 +14 会话 0 丢失；唯一索引级差异为 1 条旧代合并气泡被新代拆成 synthetic+user 两行（内容无损）。
    测试：`test/session-reader.opencode-v2.test.js` + 布局表会话面探测用例。
14. ✅ WebUI chat 代理写入（P2，见 §2 存储布局反模式）：`opencode-session-store.js` 消费同一张布局表——
    新会话写活跃布局（`detectOpenCodeWriteLayouts` 首个 = 新代优先，纯旧库写旧代）；已存在会话写它自己
    所在的布局（两代都有取新代、仅旧代保持旧代：消息不跨代分裂，也不触发 `session_message` → `session_v2`
    的 FK）；写入门禁 = `project` + 至少一代完整可写（会话表 + 消息表齐、旧代含 `part`），都不可写时
    报告「部分存在」那一代缺的表；inline 布局消息行形状对齐真机（user `{text,time}`、
    assistant `{agent,model,content,time,cost,tokens,finish}`，`seq` = max+1 单调唯一）。
    switch 行（agent-switched/model-switched）删除——真机取证它们从未成功持久化（旧写法只在
    `session_message` 存在时写，而该表存在即 FK 生效 → 新会话创建整段失败），opencode 自身的
    agent-switched 形状带 `previous`、读取方也忽略该类型。真机副本验证：修复前 `beginOpenCodeChatTurn`
    新会话直接 FK 失败；修复后新会话与续写都落 `session_v2`、旧表冻结、读取器读回一致。
    测试：`test/opencode-session-store-write-layouts.test.js`（测试 schema 镜像真机 FK：
    session_message→session_v2、message→session、part→message）。

**Phase 3.6 — opencode serve API 布局（work 模式两代接入，2026-10-16 新增）**
15. ✅ work(confirm) 模式的 `opencode serve` v2 接入（背景：`opencode_serve_api_layout_v2_not_implemented`——v2 下
    `/global/health` 返回 200 HTML，旧 v1 健康探测判否，布局识别正确但未实现）。落地形状与 12–14 同族：
    **差异是数据不是 if/else**——`opencode-serve-api-layouts.js` 每代一行（路由/鉴权/信封/作用域/请求体形状/
    探测谓词），`opencode-serve-client.js` 只按布局组装请求，`opencode-serve-event-mappers.js` 按 `eventShape`
    选事件适配器（v2 新词汇归一成 runner 既有信号：`session.text.delta|ended` 累积补尾、`session.tool.*` 成对出卡、
    `permission.asked{action,resources,source}` → 归一 props、`session.execution.succeeded` = 完成信号）。
    关键事实（真机 2.0.29 取证）：v2 全路由要 Basic（user `opencode`，密码取 serve 日志**最后一条** `server password`，
    轮换后旧值作废）；`/api/*` 响应统一 `{data}` 信封；会话创建必须放 body `location.directory`（query 无效，
    会话会落 serve cwd）；`/api/event` 是**全局**流（跨 location，按 `data.sessionID` 过滤）；模型走会话级
    `POST /api/session/:id/model`；权限回执是会话级路由 + `{decision}`；确认规则形状 `{action,resource,effect}`
    （`CONFIRM_PERMISSION_RULES` 因此改成规范形，v1 字段名由表映射、线上字节不变）。
    就绪探测谓词必须与 v1 **互斥**（v1 响应也带 `version`）：v2 = `{version:string, pid:number}`，v1 = `{healthy:true}`；
    两者共用 `health()` 自动探测（无布局时逐代试，命中落定并记住密码），ensure 把 layout/password 回传给回合客户端。
    验证：`test/opencode-serve-api-layouts.test.js` / `test/opencode-serve-client.test.js` / `test/opencode-serve-runner.test.js`
    共 32 用例；真机 E2E（真实 `startOpenCodeServeTurn` 打活的 46802 实例）：建会话→审批 allow→工具输出
    `e2e-ok`→`session.execution.succeeded`→`result` 正文含输出。

**Phase 3.7 — 插件能力契约（P1–P3，2026-10-20 新增）**
16. ✅ 价格/额度/元数据/扫描/Provider 描述符统一走插件契约：
    `contracts/plugins/contract.json` 是能力唯一事实源（`pricing.catalog` /
    `model.metadata` / `quota.probe` / `usage.scan` / `provider.descriptor`）。
    宿主裁决仍集中在既有门面：`lib/usage/pricing/{price-quote,merge-quotes}.js`、
    `lib/usage/quota/probe-result.js`、`lib/usage/usage-scan-contract.js`、
    `lib/providers/contract.js`；插件只送数据。
17. ✅ Provider 描述符插件化：`lib/providers/handler-registry.js` 统一解析
    `handler` id（缺失 = `provider_descriptor_handler_unavailable`），
    `lib/plugins/provider/descriptor-collector.js` 拒绝函数/重复/非法描述符，
    代次激活后 `replaceOrigin('plugin', …)` 整体替换（内置/外部目录不变），
    宿主空闲/崩溃时清空 plugin origin。`lib/plugins/provider/registry.js` 已并入
    canonical 校验，不再维护第二份形状与内置名单。样例：
    `examples/plugins/provider-descriptor/`。
18. ✅ 来源可追溯：价格/额度/元数据/扫描结果都带 `source` + 新鲜度；
    未知保持 `unknown`，只有来源明确免费才是 `free/0`；过期数据不丢、只标
    `stale`。WebUI 用紧凑 Tooltip/行内标签展示，不新增大块提示。
    验证：`test/{price-quote,quota-probe-contract,model-metadata-provenance,
    usage-scan-contract,provider-descriptor-plugin}.test.js`；WebUI 构建 +
    改动文件 eslint + 前端单测。

**Phase 3.8 — 账号与价格插件治理（P4/P5，2026-10-20 新增）**
19. ✅ 账号生命周期拆成四个窄能力（`account.source/login/refresh/materialize`），
    宿主保留账号分配、判重、入库、任务持久化与运行目录写入。插件只交换 JSON；
    登录任务只持久化公开状态，凭据不进入任务文件。刷新采用两阶段
    `match` → `refresh`，并用运行目录内容摘要做乐观 CAS，避免覆盖另一条
    refresh_token 轮换链。实现：`lib/plugins/account/{contract,service,auth-sources}.js`；
    WebUI 登录任务路由与管理面入口复用既有账号注册/重载链路，不新增 provider 分支。
20. ✅ 价格治理采用「收采集 + 快照 + 人工复核」三层：插件/社区只产出
    `PriceQuote`；`catalog-source-store` 负责原子快照与 pending/reviews；
    `catalog-layered` 只把已批准快照叠加到 models.dev。首次采集生效，后续变化
    不自动覆盖，失败保留旧快照。官方样例包与 LiteLLM/OpenRouter 固定解析器都走
    同一复核门；`cacheWrite1h` 独立，不做 5m 复制。
    验证：`test/{pricing-catalog-source-store,plugin-pricing-sync,plugin-account-contract}.test.js`。

**Phase 4 — 收口守卫**
11. ✅ 收口守卫：`test/design-pattern-guard.test.js` —— 描述符声明的 handler 必须已注册；63 个已知文件
   记录基线（只能减不能增）；`lib/` 下新增文件 ≥2 处 provider 名比较即红；基线里已清零的文件必须移除条目。

**验收标准（每个 provider × 每个采集面）**
- `npm run providers:audit` 显示该面的通道与依赖；CLI-only 必须带原因。
- 该 provider 的**纯 API 路径有真实账号实测证据**（不是「应该可以」）。
- 失败时账号页只呈现**原因**（结构化 reason + attempts）；不要给用户写「操作建议」——修复是开发者的责任，不是用户的作业。
