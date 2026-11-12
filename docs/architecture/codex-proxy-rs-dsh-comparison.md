# codex-proxy-rs、DeepSeek Harness 与 AIH：吸收清单

日期：2026-09-30。交付范围是源码比较和插件化规划；本文不表示插件平台已经实现。

结论：插件的组合、依赖和资源生命周期以 DSH / Cordis 为主要参考；插件制品、跨进程合同和网关发布治理参考 codex-proxy-rs。AIH 的账号、会话、路由与真实协议边界继续由现有领域模块拥有。建议先完成插件底座，再按需要扩展多人网关能力。

## 1. 可复查的源码基线

| 对象 | 本次基线 | 范围 |
| --- | --- | --- |
| codex-proxy-rs | [d97c6e064b3714fa496f575aa6d7d64fb405601e](https://github.com/zyycn/codex-proxy-rs/tree/d97c6e064b3714fa496f575aa6d7d64fb405601e)，提交于 2026-09-30 09:54:47 UTC | 官方仓库源码归档；插件 SDK/runtime、请求快照、准入、价格与相关测试源码 |
| DeepSeek Harness | [639ed015397290b3745d163aafe02ffee4aa3f84](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)，提交于 2026-09-29 09:21:31 UTC | 源码 package.json 为 0.2.0-rc.2；Cordis、profile、工具执行与 UI 注册边界 |
| Cordis | DSH vendor/cordis/package.json 为 4.0.4 | [npm 元数据](https://registry.npmjs.org/@deepseek-ai%2fcordis)的 latest 同为 4.0.4，发布于 2026-09-22；元数据没有 gitHead，因此不声明 npm 制品与上述整仓 SHA 完全对应 |
| AIH | HEAD 041cdc0d185a847ca23170d002221b811756364d 加本次读取的工作树 | Go 应用端口、Provider 合同、Node Chat 扩展、客户端鉴权和用量投影 |

DSH 的官方身份由 [DeepSeek 官网](https://www.deepseek.com/harness/)及其链接的 deepseek-ai/deepseek-harness 仓库确认。它采用 Cordis；官方身份可以确认，适用性仍按具体机制评估。

我们已有的 [Chat Harness 参考文档](./chat-harness-absorption.md)使用过 DSH aa8262ec 等历史基线。此次比较更新了插件相关源码依据，保留历史验收范围和记录。

所有优势判断指向源码中的扩展边界和工程交付机制。本次没有执行两个上游的完整测试、真实推理或相同负载压测；不据语言、宣传或测试文件数量判断速度、风控和整体稳定性。

## 2. codex-proxy-rs 做得更完整的部分

P0 表示插件底座必需；P1 表示接入真实请求时必需；P2 表示多人网关等明确需求成立后实施。

| 优先级 / 吸收点 | 对方的具体依据 | AIH 当前证据与差距 | 我们应吸收什么 / 验收条件 |
| --- | --- | --- | --- |
| P0：独立 SDK 与跨进程合同 | [SDK 清单](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/sdk/src/manifest.rs)、[消息与版本](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/sdk/src/message.rs)、[帧收发](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/sdk/src/client/frame.rs)与宿主业务分离 | [Provider Catalog](../../lib/provider-catalog.js)是静态生成合同；[Chat 扩展](../../lib/server/chat-runtime/chat-runtime-extension-pipeline.js)接收进程内函数对象 | 独立插件 manifest、能力版本、SDK 和 RPC DTO。插件只依赖公开合同；Go 和 Node 不传函数、内部 Store 或整套领域对象 |
| P0：可安装制品及兼容检查 | [包校验](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/runtime/src/package/validation.rs)、[兼容性](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/runtime/src/package/compatibility.rs)、[打包工具](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/apps/plugin-cli/README.md) | 当前 Provider/策略随 AIH 构建；没有通用 AIH 插件安装、接受和版本切换入口 | 摘要固定的离线插件包，安装与启用分开，配置 schema 和敏感值引用分开；不兼容包在运行前拒绝 |
| P1：准备候选、原子发布、保留在途版本 | [实例准备与握手](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/runtime/src/generation/prepare/instance.rs)、[请求快照](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/src/routing/snapshot.rs) | [RouteCatalog](../../application/inferencegateway/route_catalog.go)和[候选读取](../../application/accountrouting/recruiter.go)已有不可变结构；尚无把插件、配置和能力一起发布的代次 | 复用现有不可变思路；一个请求持有一个插件 generation，更新后新请求进入新代次，旧 SSE / WS 操作排空后回收 |
| P1：配置并发、故障与回退形成运营闭环 | [版本校验事务](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-store/src/postgres/plugins/mutation.rs)、[重启熔断](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/runtime/src/generation/restart_circuit.rs)、[使用与回退合同](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/docs/plugins.md) | AIH 已有 Server/CLI 监督与故障策略，缺的是插件实例级管理语义 | expectedRevision 防并发覆盖；候选失败保留当前版本；区分停用、删除配置、删除制品。私有数据迁移不能仅靠切回二进制宣称恢复 |
| P1：插件可提议，宿主保留裁决 | [单次 next 组合器](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/src/middleware/mod.rs)、[策略合同](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/sdk/src/call/policy.rs) | [Canonical 组合根](../../internal/host/inferenceruntime/runtime.go)已有 RouteResolver、UpstreamAdapter、运行态与凭据端口 | 把这些端口作为接缝。插件选号结果必须重新检查资格；发送/交付水位、取消、重放和结算继续由宿主裁决 |
| P2：客户端 Key 的授权与用量产品 | [客户端策略快照](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/src/routing/snapshot.rs)、[准入](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/src/engine/admission.rs)、[预算账本](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-store/src/postgres/client_budgets.rs) | Go 标准推理入口的 [Authorizer](../../internal/transport/http/clientauth/authorizer.go)读取单一当前客户端 key；不能等同于拥有独立 Client Principal、分组授权和预算账本 | 多 Key + provider/model/account 范围 + RPM/并发/金额策略；空授权池明确拒绝。先完成原生授权领域，再允许插件提供窄策略 |
| P2：统一、有界且公平的容量等待 | [ConcurrencyWaitQueue / ConcurrencyWaitBudget](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/src/concurrency.rs)、[队列测试](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/tests/concurrency.rs) | [RequestPoolRetryPolicy](../../lib/server/request-pool-retry-policy.js)有请求总预算；[Recruiter](../../application/accountrouting/recruiter.go)有公平征召。两者不能证明具有 Key / 账号容量 FIFO 等待 | 共享请求级等待截止时刻；取消撤销排队位置；满队列是本地拒绝，不触发上游熔断。只在需要容量排队时增加 |
| P2：费用账本与分析投影分开 | [费用与价格类型](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-core/src/metering/pricing.rs)、[预算持久化](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-store/src/postgres/client_budgets.rs) | AIH [费用计算](../../lib/usage/model-usage-pricing.js)与[读投影](../../lib/usage/model-usage-read-projection.js)面向历史分析、支持价格重算；这不是独立授权账本 | 若增加金额限额，账本按 requestId 幂等结算、固定当次价格事实；历史分析继续允许重估，不把重估结果反写准入余额 |
| P1：插件行为的完整合同测试 | [真实进程准备测试](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/runtime/tests/generation/prepare/mod.rs)、[兼容测试](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/runtime/tests/package/compatibility.rs)、generation 下的观察、私有状态、策略和适配器测试 | AIH [扩展专项](../../test/chat-runtime-extension-pipeline.test.js)覆盖函数钩子、顺序和失败；没有通用插件包、跨进程版本切换合同 | 安装→启用→调用→停用→重启→升级→回退逐步验证；跨 Node/Go 请求、流、资源和副作用边界必须进入验收 |

以上是源码和测试覆盖面比较，不声明本次执行过对方套件。金额准入检查已结算费用，允许在途请求超过阈值；不能把它直接作为严格防超支保证。进程分离用于故障隔离，不代表 OS 安全沙箱。

## 3. DSH 更值得作为主线参考的部分

| 优先级 / 吸收点 | DSH 具体依据 | AIH 当前证据与差距 | 吸收方式 / 验收条件 |
| --- | --- | --- | --- |
| P0：资源随插件生命周期回收 | [Cordis Fiber](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/vendor/cordis/src/fiber.ts)的 effect、依赖 epoch、异步卸载 | [ChatRuntimeExtensionPipeline](../../lib/server/chat-runtime/chat-runtime-extension-pipeline.js)调用 dispose，但 close/unregister 不等待异步清理完成，也不拥有所有 watcher、服务注册和子插件 | 优先复用 Cordis，而非另造通用生命周期框架；适配器保证停用后注册消失、清理可等待、没有遗留计时器或订阅 |
| P0：按依赖启动和撤销 | [Registry / inject](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/vendor/cordis/src/registry.ts)、[Service](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/vendor/cordis/src/service.ts) | [ProviderDriverRegistry](../../lib/server/chat-runtime/provider-driver-registry.js)是 Map 工厂注册，尚无插件服务依赖图 | Cordis 管理 Node 服务依赖；AIH 管理公开服务版本和发布范围。缺失依赖须显示具体服务，不能让 pending 变成无解释的“已启用” |
| P1：profile → bundle → patch 的组合 | [profile 解析](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/src/profile.ts)、[组合测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/tests/profile.spec.ts) | AIH 的 Provider/runtime 概念已存在，但不是插件集合和配置覆盖层 | 内置 bundle、可选能力 bundle、用户覆盖，编译成一个版本化配置；AIH 现有账号 profile/runtime 继续保留原义，不与插件组合配置混用 |
| P1：观察、策略和变换有不同语义 | [Agent dispatch](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent/src/dispatch.ts)区分 emit、serial、waterfall，并隔离 Agent 观察者错误 | AIH 已有同类阶段，且本次 14 个扩展专项通过 | 延续现有合同，接上生命周期、超时和代次；注意直接调用 Cordis emit 并不自动获得 DSH agentEvents 的观察者错误隔离 |
| P1：策略位于工具真实执行边界 | [ToolRuntime](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/tools/src/index.ts)的 pre-execute / guard / execute / post 和取消状态 | [既有边界说明](./chat-harness-absorption.md)及扩展测试证明当前 Codex 钩子围绕工具事件持久化；拒绝持久化不能证明工具未执行 | 工具插件走真正执行器或原生审批请求；驱动没有执行前入口时明确不提供 veto 能力。用拒绝后 native marker 未生成证明阻断 |
| P1：界面也有公开扩展点 | [SlotRegistry](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-renderer/src/client/registry.ts)、[UI slot 核心测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/client/ui-slots/tests/core.client.spec.ts) | 当前 AIH 页面与 Chat UI 注册主要随 Web 构建；没有面向外部插件的稳定 UI 合同 | 公开导航、会话动作、侧栏等少量 slot；内置 React 组件走构建内注册，外部页面走独立 iframe + 有界桥。卸载撤销贡献，不耦合 Umi 内部模块 |
| P1：插件开发和组合配置可独立维护 | [PluginManager](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/plugin-manager/src/index.ts)、[兼容预检测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/boot/app-boot/tests/compatibility-preflight.spec.ts) | AIH 插件源码当前大多与宿主共同构建；OpenCode hook 插件属于上游集成，不是 AIH 插件管理器 | 提供独立 SDK、模板、validate/package/doctor 入口与外部仓库示例；开发者仅依赖公开入口，配置升级可解释 |

## 4. 吸收时保留的边界

1. DSH 适合 Agent 能力组合；codex-proxy-rs 适合网关插件运营。采用 Cordis 生命周期不等于把 DSH 的 Agent loop、SessionStore 和权限模型整体接管 AIH。
2. 一般 Cordis 插件和 DSH 业务插件需要的服务不同。兼容 apply / inject 不表示 DSH 插件可以全部直接运行；必须逐项声明提供了哪些 tools、llm、session、UI 和执行服务。
3. codex-proxy-rs 的 upstream_adapter 目前扩展内置 OpenAI / xAI，不是任意新 Provider 的完整注册平台；这点由其 [适配器合同](https://github.com/zyycn/codex-proxy-rs/blob/d97c6e064b3714fa496f575aa6d7d64fb405601e/backend/crates/gateway-plugin/sdk/docs/upstream-adapters.md)确认。AIH 的新 Provider 插件必须覆盖身份、认证、目录、路由与界面闭环。
4. AIH 已有静态 Provider 合同、不可变路由/候选、Adapter/Registry、观察者异常隔离和 Codex 客户端身份学习。重点补外部扩展生命周期与运营，不重复实现这些基础。
5. AIH 面向多 Provider、多客户端协议和原生持久会话。现有 canonical 语义、原生 wire 保真、accountRef 与精确会话语义是插件接入约束。
6. 保留 SDK 离线模型目录和跨平台本地运行；不因参考项目使用 PostgreSQL / Redis 而直接引入其部署依赖。插件包摘要能证明制品一致性，不能证明代码可信。

## 5. 建议实施顺序和验收证据

完整方案见 [AIH 插件化规划](../plans/2026-09-30-plugin-architecture-plan.md)。先验证 Cordis 接入和合同，再完成插件包与生命周期；随后接入 Node/Go 发布快照、Chat 工具与 UI、完整 Provider 插件，最后形成 SDK 发行闭环。

多人 Key、容量等待、金额账本是独立产品增量，列入吸收清单但不作为第一版插件底座的隐藏依赖。

本次执行：

~~~text
node --test test/chat-runtime-extension-pipeline.test.js test/provider-catalog.test.js test/repository-policy.test.js
20 tests / 20 pass / 0 fail / 0 skip
~~~

这证明当前扩展钩子、Provider 合同和仓库策略的相应基础测试通过。新 SDK、插件宿主、版本发布与外部插件兼容性尚待实施，不能由这 20 项测试推定完成。
