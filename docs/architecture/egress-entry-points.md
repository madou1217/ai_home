# 账号出口调用链审计（egress entry points）

- 审计基线：`85c2509e`（分支 `arch/egress-audit`），2026-11-22。
- 范围：所有会「按账号身份发起外部请求」的入口，以及它们与 `internal/runtime/egress.Manager`、`internal/adapters/agy/egress.Resolver` 的关系。
- 判定口径：
  - **经过 Manager** 指调用了 `Manager.ResolveAccountEgress` / `ApplyStoredAccountEgress` / `ProbeUpstreamAccount`（或其 Launch/Display 子集）。
  - **直接构造 Resolver** 指在调用点直接写 `agyegress.NewResolver(...)`，绕开 Manager 的编排（车道、探测、桌面端重启、apply 事务）。
  - **fail-closed** 指绑定存在但解析失败时返回错误，请求中止；**回落** 指仍发出请求，但出口换成了进程默认网络或其他节点。
- 本文所有 `file:line` 都在 `85c2509e` 上用 `git grep` / `sed` 现场核对，复核命令见第 6 节。

---

## 0. 结论摘要

1. **网关的账号出口在组合根里从未接上**：`inferenceEgressResolver{manager: egressManager}` 在 `internal/host/aihserver/composition.go:1502` 求值，而 `egressManager` 的唯一赋值在 `composition.go:1911`（同函数内晚 409 行）。结构体按值捕获，拿到的是 nil。`inference_egress.go:27-29` 对 nil manager 返回 `("", false, nil)`，于是 `/v1/messages`、`/v1/responses`、chat、Translation Studio 推理全部走进程默认网络，账号绑定（url/pool/ssh/direct）一律不生效。见 R1。
2. **即使修好 R1，网关仍会静默改直连**：`inference_egress.go:96` 用 `wrapOutboundTransport` 包住显式账号代理，而 `outbound_fallback.go:86-93` 只有在 `AIH_SERVER_PROXY_STRICT` 非空时才禁止回退；该变量在全仓库没有任何写入点。explicit 账号代理连不上 → 请求改直连，出口 IP 变了却没有任何错误。见 R2。
3. **8 处 `agyegress.NewResolver` 中，6 处注入了 `ResolveManagedSSH`（#2–#6 与 #8），1 处不需要（#7，ssh 已在 `account_runtime.go:454-472` 分支处理），1 处是裸构造兜底（`accountactivity/http_client.go:65`）**。裸兜底会把 `ssh:` 绑定报成 `unknown_egress_mode`，错误码误导。见第 2 节与 R3。
4. **一条 binding 有三套解析实现**（Manager / CLI launch / probe），三者在 `system` 模式上语义不一致：Manager 探测系统代理并 fail-closed，CLI launch 原样继承宿主环境，probe 则替换成 `config:server.proxyUrl`。见 R6、R7。
5. **session 车道在请求期不可达**：`Session: true` 没有任何调用点，`state.SessionLanes` 只写不读（唯一读点在 `supervisor.go:1565`）。session 策略账号 slot>0 时不在 `state.Lanes` 里，只能走端点池兜底或 fail-closed。见 R4。

---

## 1. 三层解析模型

| 层 | 位置 | 职责 | 是否读 binding | 是否探测 | 是否启动/重启池或桌面端 |
|---|---|---|---|---|---|
| L1 binding store | `internal/adapters/agy/egress/store.go` | 读 `account:egress:<ref>` 原始 JSON 并做形状校验（损坏即报错） | 是 | 否 | 否 |
| L2 Resolver | `internal/adapters/agy/egress/resolver.go:59` `NewResolver` / `:98` `Resolve` | 单条 binding → `Decision{Target}`；平台判定、system/tun 探测、ssh 解析、pool 读运行文件 | 是（可注入 `ReadBinding` 做合成输入） | 仅 system/tun | 否 |
| L3 Manager | `internal/runtime/egress/account_runtime.go:563` `ResolveAccountEgress` | 账号编排：策略分派、池车道、端点池、连通性探测、轮换 | 是 | 是（`SkipProbe` 可关） | 池：`EnsurePoolStarted`；apply：重启桌面端 |

**同一份 binding 的三套「binding → 出口」实现**（这是审计里最容易漏掉的地方）：

| 实现 | 位置 | 覆盖模式 | system 语义 | 探测 |
|---|---|---|---|---|
| Manager 解析 | `account_runtime.go:358` `resolveEgressTarget` → `:379` / `:439` | direct/system/tun/url/ssh/pool | 读系统代理；读不到即 `system_proxy_unavailable` | 有（非 `SkipProbe`） |
| CLI 启动解析 | `launch.go:30` `ResolveAccountLaunchEgress` → `strategy_exit.go:27` `ResolveNonPoolExit` / `strategy_registry.go:62` `launchPoolStrategy` | 同上 | 只标记 `System=true`，`Env()` 返回 `nil,nil`（不校验、不清代理） | 无（设计如此） |
| 账号上游探测 | `account_probe.go:38` → `:120` `probeDirectAccountUpstream` | 同上 | **不用系统代理**，改读 `ResolveServerProxyConfig`（`config:server.proxyUrl` → env） | 本身就是探测 |

---

## 2. 全部 `agyegress.NewResolver` 构造点（8 处）

| # | 位置 | 用途 | Options 注入 | `ResolveManagedSSH` | 判断 |
|---|---|---|---|---|---|
| 1 | `internal/adapters/accountactivity/http_client.go:65` | 领取/活动 HTTP 客户端的裸兜底 | `AIHomeDir` | **无** | 缺陷：ssh 绑定 → `unknown_egress_mode`（`resolver.go:153`）；见 R3 |
| 2 | `internal/host/aihserver/composition.go:736` | agy OAuth 刷新 | `AIHomeDir` + SSH | 有 | 正常；但宿主重复了 5 次同一段闭包 |
| 3 | `internal/host/aihserver/usage_providers.go:109` | agy 额度采集 | `AIHomeDir` + SSH | 有 | 正常 |
| 4 | `internal/host/aihserver/webui_kimi_routes.go:35` | Kimi 托管登录 + 套餐统计 | `AIHomeDir` + SSH | 有 | 正常 |
| 5 | `internal/host/aihserver/webui_ops_misc_routes.go:45` | 账号活动执行器 | `AIHomeDir` + SSH | 有 | 正常 |
| 6 | `internal/host/aihserver/webui_translation_studio_routes.go:596` | Image/Translation Studio 凭据解析器 | `AIHomeDir` + SSH | 有 | 正常，但这是**第二套** `accountcredentials.Resolver` |
| 7 | `internal/runtime/egress/account_runtime.go:478` | 把内存里的合成 binding 交给同一套策略语义 | `AIHomeDir`+`Platform`+`DetectSystemProxy`+`DetectTUN`+`PidAlive`+`ReadBinding` | 无 | 正确：ssh 在 `:454-472` 已被 `ManagedSSHProxyURL` 分支吃掉，不会进到这个合成 resolver |
| 8 | `internal/runtime/egress/strategies.go:165` | 策略目录的「当前环境是否可用」 | 同上 + SSH | 有 | 正确 |

补充事实：

- `Platform` 只在 #7/#8 显式注入；#2–#6 留空，走 `runtime.GOOS`（`resolver.go:233-238`）。server 恒为本机进程，可接受，但意味着 WebUI 传入的 `platform` 参数只影响 #7/#8。
- `DetectSystemProxy` / `DetectTUN` / `PidAlive` 在 #2–#6 全为空，走 `agyegress` 的 macOS 默认实现（`resolver.go:167-171`、`:192-196`）。`NewManager` 在 `composition.go:1911-1915` 也没注入这三个，所以 Manager 内部（#7）同样落到默认实现。
- 「resolver == nil 就构造裸 resolver」只有一处：`accountactivity/http_client.go:64-66`。当前两个生产构造点（`webuiroutes.go:835`、`webui_ops_misc_routes.go:142`）都通过 `newNativeActivityExecutor` 注入了带 SSH 的 resolver，所以是潜在坑而非现网故障。

---

## 3. 账号出口入口清单

| # | 链路 | 触发入口（file:line） | 经过 Manager | 直接 Resolver / 客户端 | 失败语义 | 判断 |
|---|---|---|---|---|---|---|
| 1 | agy OAuth 刷新 | `composition.go:736` → `:742` → `agyoauth.NewWithEgress` `:764` | 否 | Resolver #2 | fail-closed（error 直接抛出） | 正确；只覆盖 agy |
| 2 | 其他 Provider OAuth 刷新 | `composition.go:714-733`（`oauthClient`） | 否 | 默认 Transport（env 代理 + 断连回退直连） | 不看 binding | 绑定被接受但不生效，见 R9 |
| 3 | Account Activity / 领取 | `webui_ops_misc_routes.go:45` → `native_executor.go:77` → `qoder_daily.go:146` / `workbuddy_daily.go:157` / `zcode_plan.go:240` → `http_client.go:44` | 否 | Resolver #5 | binding 错 → `account_egress_unavailable:<code>`；未绑定 → `AIH_SERVER_PROXY_URL`/env | 基本正确；有 R3 兜底 |
| 4 | 绑定写入 / apply | `webuiaccountegressapi/handler.go:379`、`:400` → `account_runtime.go:629` | 是 | Manager 内部 #7 | 探测失败即回滚并返回 `!OK` | 正确（唯一带事务的入口） |
| 5 | usage（agy） | `usage_providers.go:109` → `:115` | 否 | Resolver #3 | fail-closed | 正确 |
| 6 | usage（其他 Provider） | `usage_providers.go:74/86/98/138/146/154/162/170/185/197` → `usage.go:68` | 否 | `context.client`，未设 `Proxy`（默认 Transport） | 不看 binding | 见 R9 |
| 7 | Kimi 托管登录 / 套餐 | `webui_kimi_routes.go:35` → `:41` → `desktopsession.New` `:64` / `planstats.New` `:79` | 否 | Resolver #4 | resolve 错直接返回；未绑定返回 `nil,nil` → 用默认 client | 正确 |
| 8 | Kimi usage | `usage_providers.go:170` | 否 | `context.client` | 不看 binding | 与 #7 不一致，见 R9 |
| 9 | Translation Studio 推理 | `webui_translation_studio_routes.go:302` `BuildTranslationGatewayConfig` → 本机网关 → #10 | 间接（经网关，当前失效） | 无 | 取决于网关 | 依赖 R1 |
| 10 | Image Studio 出图 | `webui_translation_studio_routes.go:213`、`:236`（`http.DefaultClient`） | 否 | 无 | 不看 binding | 见 R8 |
| 11 | inference gateway | `composition.go:1473`（`newInferenceComposition`）→ `:1502` → `inference_egress.go:30` → `coordinator.go:758` | 是（但拿到 nil） | — | 当前等于未绑定 | 见 R1 |
| 12 | Claude 原生 Relay | `composition.go:1417`（`relayClient`）→ `:1751` `claudenativerelay.NewHandler` | 否 | 无 | 不看 binding | 见 R13 |
| 13 | CLI 启动（`aih <provider>` native） | `aihcli/app.go:624` → `:729` `resolveLaunchEgress` → `launch.go:30` | 否 | `strategy_exit.go` / `strategy_registry.go:62` | 任何错误都中止启动 | 基本正确；R7 |
| 14 | Desktop / CLI 启动（WebUI open-app） | `webui_open_app_routes.go:51` → `native_launcher.go:50` → `egress_bridge.go:28` → `desktop_launcher.go:143` / `cli_launcher.go:212` | 是 | — | `!OK` 即拒启动；`Egress==nil` 则静默跳过 | 正确（有 R14） |
| 15 | 账号浏览器 live | `webui_account_browser_live_routes.go:35` → `Manager.ResolveAccountEgress`（`SkipProbe=false`） | 是 | — | 绑定必需但解析失败 → `ErrScopeUnavailable` | 正确 |
| 16 | 账号上游探测 | `webuiegressupstreamsapi/handler.go:365` → `account_probe.go:38` | 是 | 内部 #8（策略可用性）/ `ResolveNonPoolExit` | 非池：`skipped` + reason；池：车道→端点池→skipped | 见 R6 |
| 17 | pool lane | `account_runtime.go:379` `resolvePoolTarget` → `supervisor.go:1558` `CurrentAccountProxyURL` → `endpoint_pool.go:36` | 是 | — | 车道/端点池都失败 → `egress_pool_not_ready` | 见 R4、R5、R12 |
| 18 | direct endpoint（`url`） | `account_runtime.go:439` ModeURL 分支；`strategy_exit.go:45-53` | 视入口 | — | 非法 URL / scheme 不收 → fail-closed | 正确 |
| 19 | 桌面客户端实例复用 | `desktop_launcher.go:121` | 是（仅生成提示） | — | `already_running` 不校验新出口 | 已知设计：提示「需关闭后重开」 |

---

## 4. fail-open / 静默降级清单

| ID | 严重度 | 事实 | 证据 | 影响 / 触发条件 |
|---|---|---|---|---|
| R1 | P0 | 网关的 `AccountEgressResolver` 捕获 nil Manager | `composition.go:627` 声明 → `:1502` 使用 → `:1911` 唯一赋值；`inference_egress.go:27-29` nil → `("",false,nil)`；`inference.go:156` 仍会装 `egressAwareInferenceClient`（接口非 nil） | 所有 Canonical 上游调用（chat / messages / responses / 翻译）忽略账号绑定；`direct` 策略说明里「网关请求绕开全局上游代理」（`strategies.go:42`）也未兑现 |
| R2 | P0 | 显式账号代理仍允许「连不上就直连」 | `inference_egress.go:93-99` → `outbound_fallback.go:58-93`；`AIH_SERVER_PROXY_STRICT` 全仓库无写入点（仅 `outbound_fallback.go:33` 定义） | R1 修好后立即生效：pool lane / url / ssh 代理拒绝连接时，请求改直连，出口 IP 静默改变。对比 `oauth_egress_client.go:19-44` 明确不包 fallback |
| R3 | P1 | 裸 resolver 兜底丢 ssh | `accountactivity/http_client.go:64-66`；`agy/egress/resolver.go:152-154` | 未注入 `EgressResolver` 的调用方遇到 `ssh:` 绑定得到 `account_egress_unavailable:unknown_egress_mode`，既非「ssh 未就绪」也不可重试 |
| R4 | P1 | session 车道请求期不可达 | `Session` 字段仅 `account_runtime.go:142`/`:156`/`:170` 声明；`git grep 'Session: *true'` 无结果；唯一读点 `supervisor.go:1565`；`manager.go:1187-1199` 只给 slot 0 写 `nextLanes` | session 策略账号 slot>0 时 `state.Lanes[ref]` 不存在 → `CurrentAccountProxyURL` 返回 `""` → 端点池兜底或 `egress_pool_not_ready`。表现是「配了专用车道，请求从不走它」 |
| R5 | P1 | 池账号不在计划里时用全局池出口 | `supervisor.go:1579-1586`：`computed.Accounts[ref]==nil` 时落到 `state.ProxyURL` | 与函数注释「绝不回落」相反；绑定了 pool 但账号未进入任何 lane/plan 时，出口换成共享池节点，scope 可能不匹配 |
| R6 | P1 | probe 的 system/direct 模式换了出口 | `account_probe.go:164-171`：`system` 不读系统代理，改读 `ResolveServerProxyConfig`（`sqlite_helpers.go:168-181`） | 面板显示的 exit/geo 与账号真实流量不一致；`direct` 绑定在有 server proxy 时也会被代理「顶替」（除非 `noProxy` 命中） |
| R7 | P1 | CLI 启动的 system 绑定零校验 | `strategy_exit.go:38-40` 返回 `System=true`；`launch.go:68-70` `system` → `nil,nil` | 系统代理关闭时 `aih <provider>` 直接走直连；同样的绑定在 Manager 路径会 `system_proxy_unavailable` fail-closed |
| R8 | P1 | Image Studio 出图不带账号出口 | `webui_translation_studio_routes.go:213`（executor）、`:236`（service）都用 `http.DefaultClient`；`images` 包无 egress | 绑定 pool/url 的账号出图仍走进程默认网络，地区受限时表现为上游 403 而不是出口错误 |
| R9 | P2 | 非 agy Provider 的绑定被接收但不参与刷新/额度 | `webuiaccountegressapi/handler.go:72-73`、`:195` 只校验目录内存在；egress-aware 刷新只有 `composition.go:764`，egress-aware 额度只有 `usage_providers.go:115` | codex / claude / kiro / gemini / grok / cline / zcode 等绑定只影响启动（#13/#14），不影响 token 刷新与额度采集；用户看到「已绑定」但部分流量仍走默认网络 |
| R10 | P2 | 管理面会新建第二个 Manager | `webui_egress_geo_routes.go:33-38` | 该实例无 `Catalog`/`EnginePlugins`，未 `Start`；`isSupportedProvider` 在 catalog==nil 时对任意非空 provider 返回 true（`account_runtime.go:280-290`），与主实例语义不同 |
| R11 | P2 | 进程默认网络本身不确定 | `outbound_fallback.go:47-56` 全局安装 `proxyFallbackTransport` | 未绑定账号的 OAuth/usage/模型目录在 env 代理不可达时会改直连。审计不能把「env 代理」当作稳定出口 |
| R12 | P3 | pool 空白名单被扩为 all | `agy/egress/binding.go:228-237`：`groups`/`nodes` 都为空 → `kind="all"` | 若前端传空数组表示「不选任何节点」，实际语义是「全部节点」，scope 被静默放大 |
| R13 | P1 | Claude 原生 Relay 完全不接出口 | `composition.go:1417` `relayClient` = `wrapOutboundTransport(newUpstreamTransport())`；`claudenativerelay` 包内无 proxy/egress；`Fallback` 字段只赋值不读（`claudenativerelay/handler.go:118`、`:156`） | Claude 的 `/v1/messages` 走 relay 时按 env 代理/直连出口，账号绑定不生效；且 relay 不会回落到 Canonical |
| R14 | P3 | 端口未接线时静默放行 | `egress_bridge.go:29-31`（adapter nil → `OK:true`）；`native_launcher.go:50`；`cli_launcher.go:212`、`desktop_launcher.go:121`/`:143`/`:235`（`if deps.Egress != nil`）；`webui_account_browser_live_routes.go:43-45` | 组合根目前恒注入 Manager（`composition.go:2016`），属于潜在坑；一旦某个入口单独装配就会静默忽略绑定 |

---

## 5. wave-2 迁移清单

目标形态：`internal/runtime/egress` 暴露**唯一**的账号解析器构造入口，由 host 组合根调用；`internal/adapters/agy/egress` 保持纯解析引擎，不反向依赖 runtime。

```go
// internal/runtime/egress/account_resolver.go（新增）
type AccountResolverOptions struct {
    AIHomeDir         string
    Platform          string
    DetectSystemProxy agyegress.SystemProxyDetector
    DetectTUN         agyegress.TUNDetector
    PidAlive          func(pid int) bool
    ReadBinding       agyegress.BindingReader // 合成 binding 用；nil 表示读 app-state
}

// NewAccountResolver 固定注入 ResolveManagedSSH，调用方不再自行决定是否为 ssh 注入实现。
func NewAccountResolver(opts AccountResolverOptions) *agyegress.Resolver
```

放在 `internal/runtime/egress` 而不是 adapter：`ManagedSSHProxyURL` 在该包（`managed_ssh.go:22`），adapter 不能反向 import runtime。现在 5 个 host 文件各自抄同一段 5 行闭包，正是缺少这个接缝的症状。

| 顺序 | 文件 | 现状 | wave-2 动作 | 保留自定义的理由 |
|---|---|---|---|---|
| 0 | `internal/host/aihserver/composition.go:1502` | 在 `egressManager` 赋值（1911）之前按值捕获 | **先修**：把 `accountEgress` 改成延迟取值（`func() *runtimeegress.Manager` 或 1911 之后再填） | 无；这是排序错误，不涉及设计取舍 |
| 1 | `internal/runtime/egress/account_resolver.go`（新建） | — | 新增 `NewAccountResolver` | 必须持有 `ManagedSSHProxyURL` 依赖 |
| 2 | `internal/host/aihserver/composition.go:736-741` | 手写 Resolver + SSH 闭包 | 改调 `runtimeegress.NewAccountResolver` | 无 |
| 3 | `internal/host/aihserver/usage_providers.go:109-114` | 同上 | 同上；`usageProviderContext.aiHomeDir` 保留 | 无 |
| 4 | `internal/host/aihserver/webui_kimi_routes.go:35-40` | 同上 | 同上 | 无 |
| 5 | `internal/host/aihserver/webui_ops_misc_routes.go:45-50` | 同上 | 同上 | 无 |
| 6 | `internal/host/aihserver/webui_translation_studio_routes.go:596-601` | 同上 | 同上 | 无 |
| 7 | `internal/host/aihserver/webui_translation_studio_routes.go:560-719` | 路由装配期重建第二套 `accountcredentials.Resolver`（kiro/kimi/codex/claude/agy/gemini/grok/cline + 静态策略） | 给 `webuiRouteDependencies` 增加 `Credentials *accountcredentials.Resolver`，复用组合根那一份；本文件只保留 `imagestudio` 的装配 | 必须保留「按 Provider 组织策略」的依赖注入，但不应在路由装配里重新构造；复用前先核对两处 `OwnsRefresh` 与 `OnCredentialRefreshed`（agy 投影回写）语义一致 |
| 8 | `internal/adapters/accountactivity/http_client.go:64-66` | `resolver == nil` 时裸构造 | 删除兜底；改为返回 `account_egress_unavailable:resolver_missing` | 无；裸构造注定丢 ssh |
| 9 | `internal/host/aihserver/webui_egress_geo_routes.go:33-38` | Manager 为 nil 时新建第二个实例 | 改为装配错误（返回 `fmt.Errorf`） | 管理面不应静默换一个池实例 |
| 10 | `internal/host/aihserver/inference_egress.go:93-99` | 账号代理外套 `wrapOutboundTransport` | 与 `oauth_egress_client.go` 对齐：显式账号代理不包 env 回退 | 无；这是 R2 的唯一修复点 |
| 11 | `internal/host/aihserver/composition.go:1417` | Claude relay 用无出口 client | relay 的 `Client` 改为按账号选 transport（或把 relay 请求并入 Canonical 网关） | 需要 relay 的「不重编码正文」特性，不能简单删掉 |
| 12 | `internal/transport/http/webuiopenappapi/cli_launcher.go:212` 等 5 处 | `if deps.Egress != nil` 静默跳过 | `NewNativeLauncher` 在 `Egress == nil && EgressManager == nil` 时直接返回装配错误 | 无 |
| — | `internal/runtime/egress/account_runtime.go:478` | 合成 binding resolver | **保留**，只把 `ReadBinding`/`Platform`/`Detect*`/`PidAlive` 作为 `NewAccountResolver` 的可选项传入 | 不是「读账号绑定」，而是「把内存里的合成 binding 跑同一套策略语义」，`ReadBinding` 必须由调用方提供 |
| — | `internal/runtime/egress/strategies.go:165` | 合成 mode 可用性 | **保留**，同上 | 同上；且必须保留 SSH（`SupportsProbe` 要能回答 ssh 是否可用） |

---

## 6. 复核命令

以下命令均在 worktree 内执行（`cd /private/tmp/aih-arch-egress-audit`）。

```sh
# 0. 基线
git rev-parse HEAD

# 1. 8 处构造点（应输出 8 行）
git grep -n 'agyegress.NewResolver' -- '*.go'

# 2. 每个构造点的 Options 明细
for spec in \
  'internal/adapters/accountactivity/http_client.go:64:70' \
  'internal/host/aihserver/composition.go:736:742' \
  'internal/host/aihserver/usage_providers.go:109:115' \
  'internal/host/aihserver/webui_kimi_routes.go:35:41' \
  'internal/host/aihserver/webui_ops_misc_routes.go:45:51' \
  'internal/host/aihserver/webui_translation_studio_routes.go:596:602' \
  'internal/runtime/egress/account_runtime.go:478:490' \
  'internal/runtime/egress/strategies.go:165:177'; do
  f=${spec%%:*}; rest=${spec#*:}; a=${rest%%:*}; b=${rest#*:}
  echo "===== $f ($a-$b) ====="; sed -n "${a},${b}p" "$f"
done

# 3. R1：Manager 在 inference 装配之后才赋值
grep -n 'egressManager' internal/host/aihserver/composition.go
sed -n '1473,1506p' internal/host/aihserver/composition.go
sed -n '1908,1918p' internal/host/aihserver/composition.go
sed -n '22,40p'   internal/host/aihserver/inference_egress.go

# 4. R2：显式代理仍套 env 回退
sed -n '93,100p' internal/host/aihserver/inference_egress.go
grep -n 'wrapOutboundTransport' internal/host/aihserver/outbound_fallback.go
grep -rn 'AIH_SERVER_PROXY_STRICT' --include='*' . | grep -v '^./.git'

# 5. R3：裸兜底
sed -n '44,70p' internal/adapters/accountactivity/http_client.go
sed -n '148,156p' internal/adapters/agy/egress/resolver.go

# 6. R4：session 车道无调用方
git grep -n 'Session: *true' -- '*.go'
grep -n 'SessionLanes' internal/runtime/egress/*.go
sed -n '1180,1206p' internal/runtime/egress/manager.go

# 7. R5：pool 全局出口回落
sed -n '1558,1588p' internal/runtime/egress/supervisor.go

# 8. R6/R7：三套 system 语义
sed -n '120,175p' internal/runtime/egress/account_probe.go
sed -n '27,75p'  internal/runtime/egress/strategy_exit.go
sed -n '30,80p'  internal/runtime/egress/launch.go

# 9. R8/R13：无出口的上游客户端
grep -n 'http.DefaultClient' internal/host/aihserver/webui_translation_studio_routes.go
sed -n '1414,1424p' internal/host/aihserver/composition.go
grep -rn 'fallback' internal/transport/http/claudenativerelay/handler.go

# 10. R9：绑定准入与覆盖范围
sed -n '70,75p;190,200p' internal/transport/http/webuiaccountegressapi/handler.go
git grep -n 'NewWithEgress' -- '*.go'

# 11. R10/R14：未接线时静默放行
sed -n '30,40p' internal/host/aihserver/webui_egress_geo_routes.go
sed -n '26,34p' internal/transport/http/webuiopenappapi/egress_bridge.go
sed -n '210,216p' internal/transport/http/webuiopenappapi/cli_launcher.go
```

---

## 7. 遗留风险与未覆盖范围

- **未做真机验证**：本次只做静态调用链核对，没有启动 server、没有改 AWS、没有触发真实上游。R1 的运行时表现（网关确实不带代理）建议用一次带 `pool` 绑定的请求 + 出口 IP 对比来确认；静态证据已经足够定位，但关闭前应留一条运行时证据。
- **R2 在 R1 修复前不会触发**（因为根本不会设置账号代理）；两项必须一起验收，否则修完 R1 会引入新的静默直连。
- **Provider 差异只按代码覆盖判断**：`isSupportedProvider` 用目录判定，而 egress-aware 的刷新/额度只有 agy（+ Kimi 的两条专用路由）。哪些 Provider 实际会写绑定，取决于 WebUI 前端是否对所有 Provider 展示出口选择；本次未审计前端。
- **未审计 Node 残留路径**：仓库已无 Node 出口实现（`lib/` 不在本分支的 egress 引用里），但历史 `AIH_SERVER_PROXY_STRICT` 的写入方原本在 Node 侧；若仍有旧版 Node 启动器在跑，R2 的判定会不同。当前 Go 单入口下该变量无人写入。
- **`probe` 的出口选择与真实流量不一致（R6）属于观测口径问题**，不改变真实请求路径；修不修取决于是否要求面板 geo 与账号真实出口严格一致。

---

## 8. 修复状态（2026-11-22）

审计正文保留 `85c2509e` 的原始取证与行号，下表记录之后的落地情况：

| 风险 | 状态 | 落地 |
| --- | --- | --- |
| R1 网关取到 nil Manager | 已修复 | `33f15ce0 fix(egress): make account exits effective and fail closed`：解析器改为延迟取值 |
| R2 账号代理允许改直连 | 已修复 | 同上：账号代理客户端不再包 `wrapOutboundTransport` |
| R3 裸 resolver 兜底丢 ssh | 已修复 | `c3dc4d27 refactor(egress): centralize account resolver construction`：唯一构造入口 + 失败关闭 |
| R13 Claude Native Relay 不接出口 | 已修复 | `1e0fb182 feat(relay): honor account egress bindings`；`relaycore`（codebuddy 家族/插件 Provider 透传）同步接入共享 `relayegress` 端口 |
| R5 池账号不在计划时借用全局出口 | 已修复 | `103f6453 fix(egress): fail closed when an account has no pool lane`：无车道返回空，展示同样不借用 GLOBAL |
| R8 Image Studio 出图不带账号出口 | 已修复 | `91bd5e58 feat(images): honor account egress for image generation`：images API、共享执行器与 Studio 回退路径都按候选账号取客户端 |
| R4 session 车道请求期不可达 | 已修复 | `d85d4ad6 fix(egress): honor session pool lanes from binding`：解析从绑定识别 session 策略，CLI 启动按进程领会话车道 |
| R7 CLI 的 system 绑定零校验 | 已修复 | `2ef2d2c2 fix(egress): validate system proxy for CLI launch`：无系统代理 fail-closed，探测地址写入 CLI 代理环境 |
| R9 非 agy 绑定不参与刷新/额度 | 已修复 | `a0409868 feat(egress): apply account egress to refresh and usage`：应用层 Decision + Context 端口，OAuth/kiro/额度共用上下文感知客户端 |
| R6 probe 与真实流量出口不一致 | 已修复 | `297baa7e fix(egress): probe through the same exit as real traffic`：system 用探测到的系统代理，direct/tun 不再被 server proxy 顶替 |
| R10 管理面新建第二个 Manager | 已修复 | `f146fa2e fix(egress): refuse a second manager in management routes`：缺装配直接报错，路由测试注入真实 Manager |
| R11 未绑定账号的 env 代理回退 | 保持现状 | 这是进程默认网络的既有语义；账号绑定存在时始终 fail-closed，不属于漏接 |
| R12 空 scope 归一化为 all | 保持现状 | 与 Node `parsePoolSelection` 保持一致：空 groups/nodes 表示不筛选；WebUI 用显式 `kind=all` 表达全部节点，避免再新增歧义写法 |
| R14 nil 端口静默放行 | 已由装配断言覆盖 | `f146fa2e` 让管理面缺 Manager 时直接失败；launcher 内部的 nil 检查保留给测试/嵌入宿主，生产组合根恒注入 |

新增回归守卫：`npm run egress:check`（`cmd/egress-guard`）禁止 `internal/runtime/egress` 之外自行构造 `agyegress.NewResolver/Options`。
