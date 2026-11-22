// Package egress 的架构契约
//
// # 分层
//
//	绑定层    adapters/agy/egress.Binding + StrategyDefinition
//	          （模式、范围、策略；策略目录是唯一声明）
//	解析层    Manager.ResolveAccountEgress / ResolveAccountLaunchEgress
//	          （把绑定翻译成一次出口：direct/proxy/pool/ssh，失败关闭）
//	执行层    PoolCore（mihomo / sing-box 车道）或 EndpointPool（无内核直连池）
//	规划层    ComputeEgressPlan + NodeHealthLedger（账号→车道、节点选择）
//	策略层    RoutingPolicy（domain/ip 规则 + DNS，编译进内核）
//	呈现层    BuildUpstreamsView / StrategyCatalog / Diagnostics / WebUI
//
// # 不可变事实
//
//   - 绑定只保存稳定引用：url 模式存无凭据代理地址，pool 存 scope/strategy，
//     ssh 存 ssh:<connectionId>；凭据只在运行时解析，不落绑定。
//   - 节点标签按“输入位置”固定为 node-<index>，不按已编译数量递增；不同内核
//     可能跳过不同协议，按数量编号会让同一逻辑节点在切换内核后错位。
//   - 池状态 state.json 记录 coreKind/coreVersion/globalGroup；配置读取按
//     coreKind 选文件，启动后删除另一内核的旧配置。
//   - 显式出口失败关闭：绑定损坏、隧道/车道未就绪、没有可用内核/直连节点时
//     不回落宿主网络。
//
// # 选路
//
//   - 规划器（ComputeEgressPlan）只做纯计算：账号、绑定、scope、策略、健康、
//     地区证据 → 车道与允许集合。
//   - 初始/失效车道用 PickBest：新鲜成功 > 未探测 > 陈旧成功 > 新鲜失败；
//     轮换用 PickNext 保证确定性顺序。陈旧成功不能当可靠事实。
//   - 死节点不是控制面问题：它们是探测/冷却输入，不应改变账号绑定或架构。
//   - 池生命周期显式化为 stopped/starting/ready/degraded/failed；ready 只有在
//     控制器可用且至少一个节点有新鲜成功探测时才成立（见 lifecycle.go）。
//
// # 扩展点
//
//   - 新策略：在 adapters/agy/egress/strategies.go 加一条 StrategyDefinition，
//     在 strategy_registry.go 注册 Resolve/Launch/Display 三个入口（池模式单列），
//     前端 AccountEgressMode union 加值；弹窗和策略面板会自动渲染
//     （输入类型 none/proxy_url/ssh_connection/pool_scope）。
//   - 新内核：实现 PoolCore 的 BuildConfig/CheckConfig/RunArgs/GlobalGroup/
//     ConfigFileName，并让 ReadPoolRuntimeConfig 能解析其配置；控制面必须兼容
//     Clash API（/version、/proxies、PUT /proxies/{group}、/delay）。
//   - 新规则类型：routing.go 的 normalize + MihomoRoutingRules/SingBoxRoutingRules，
//     以及 WebUI 规则编辑器选项。
//
// # 插件化目标架构
//
//   - 内核插槽：application/egressengine.Engine（Descriptor/Compile），
//     插件只编译配置与启动事实，宿主负责进程、控制面、健康、车道与回收。
//   - 插件发现：pluginhost 能力 egress.engine（CollectEgressEngines），
//     manifest contributes 声明；主体不 import 任何具体内核。
//   - 现有 mihomo/sing-box 的 in-tree 编译器是过渡参考适配器；目标是把它们
//     移到独立进程插件（cmd/aih-engine-*），主二进制只保留注册表与规划。
//   - 策略/呈现同理：StrategyRuntime 已可注册；Surge/sing-box profile 渲染
//     属于呈现插件，不应进入代理执行层。
//
// # 当前边界
//
//   - mihomo 使用全局规则模式，listener 的强制出站可能优先于全局规则；
//     sing-box 通过按车道复制规则保证规则逐车道生效。
//   - MITM、脚本钩子、Apple 生态入口不在本包内；MITM 需要独立的证书/TLS
//     安全设计，不能作为普通代理策略顺手实现。
package egress
