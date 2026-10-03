# 插件架构 M0 报告：合同与技术验证

日期：2026-10-04。对应 [插件化规划](../plans/2026-09-30-plugin-architecture-plan.md) §7 的 M0。本文只记录有运行证据的结论；没有证据的条目标为「未完成」。

## 1. 交付物

| 交付 | 落点 | 说明 |
| --- | --- | --- |
| 固定 Cordis 制品 | `package.json`（`@deepseek-ai/cordis` 4.0.4；`overrides` 钉住 cosmokit 1.8.5、@standard-schema/spec 1.1.0）；`contracts/plugins/contract.json` 的 `runtimeDependencies` | 仓库不跟踪锁文件：版本靠 overrides 固定，integrity 记在合同里；测试拿 `node_modules/.package-lock.json` 中 npm 安装时校验过的 integrity 逐一比对 |
| ESM/CJS 接缝 | `lib/plugins/host/register-hooks.mjs`、`resolve-hooks.mjs` | 宿主以 `node --import <hooks 的 file URL> host-entry.mjs` 启动；`module.register()` 把插件里的 `@ai-home/plugin-sdk` 与 `@deepseek-ai/cordis` 解析到宿主自带的那一份（全宿主一个 Cordis）；并把代次参数传给插件解析出的每个本地 ESM 模块，同一代次的整棵模块树独立 |
| 跨平台传输 | `lib/plugins/transport/*`、`internal/adapters/pluginruntime` | POSIX 私有 Unix socket（0700 目录、0600 文件）；Windows named pipe（Go 侧 go-winio 重叠 I/O，同步句柄并发读写会死锁）。一套线合同 |
| 帧格式与上限 | `contract.json` `limits` | 12 字节头 + JSON 元数据（≤64 KiB）+ 二进制 payload（≤4 MiB）；缓冲 8.06 MiB；在途 64；握手 2 s；默认调用 10 s。超限在读头时拒绝，不先缓冲正文 |
| 公共服务与能力版本 | `contract.json` `capabilities`、`hostServices`；`ctx.aih` | 14 个能力各带版本与模式；宿主公共服务 `aih` 版本 1.0.0，插件 `requires` 它时按 semver 校验；M0 只开放 `register` / `provide` / `instance`，按清单校验归属；返回值是普通 JSON 或显式 `withPayload(value, bytes)`，不猜测信封 |
| DTO 生成 | `scripts/generate-plugin-contract.js` | 生成 Go 常量与 DTO（gofmt 对齐）、TS 类型、SDK 用 JSON；`--check` 进测试 |
| 最小 sample | `examples/plugins/echo` | 外部插件，只 import SDK |
| 空链快路径 | `lib/plugins/host/dispatcher.js` | 能力没有已发布贡献项时直接返回原值，不启动宿主、不建连接 |
| 宿主边界 | `supervisor.js`、`host-entry.mjs` | 环境变量白名单（不传网关凭据）；RPC 令牌经 stdin 第一行交付，不进环境块；父进程退出（stdin EOF）宿主随之退出 |

## 2. 验收证据

测试：`node --test test/plugin-host-m0.test.js`（19 项）、`go test ./internal/adapters/pluginruntime`（6 项，拉起真实 Node 宿主）。两台机器均全部通过：macOS（Apple M4，Node 22.16，Go 测试含 `-race`）与 Windows（i5-12600KF，Node 22.23，named pipe）。

| 规划要求的证据 | 证据 |
| --- | --- |
| Node 22 加载/卸载 | 外部临时目录的 sample 经真实宿主准备、发布、调用、卸载；卸载后调用返回 `plugin_generation_unknown` |
| 依赖缺失/恢复 | 只启用消费方 → `plugin_service_missing`；加入提供方的新代次 → 先提供方后消费方，调用拿到服务返回值 |
| 循环诊断 | `plugin_dependency_cycle`，诊断给出环路 `a → b → a`。Cordis 对成环/缺失依赖只会让 fiber 静默停在 PENDING（M0 实测），所以在加载任何插件代码前做静态诊断，加载后再检查 fiber 状态 |
| 其他准备期拒绝 | 插件 ID / 贡献项重复、服务版本不满足（含宿主服务 `aih@^2`）、宿主版本不兼容、能力版本不支持、注册未声明的贡献项、apply 抛错（带原始信息）；被拒绝的候选不留半加载代次 |
| 异步 disposer 完成 | sample 的 20 ms 异步 disposer：卸载 ≥ 20 ms 才返回；disposer 抛错不阻塞卸载并归属到具体实例 |
| 代次隔离 | 双文件插件：helper 的模块级计数在 gen1 递增到 2，gen2 重新从 1 开始（修复前为 3） |
| Go↔Node 往返 | 4 MiB（恰好上限）payload 原样往返；32 路并发 |
| 取消 | ctx 取消 / AbortSignal / deadline 都让插件 handler 的 signal 真的 abort（sample 计数 = 2）；已取消的调用不回发结果 |
| 宿主卡住 | 插件同步占满 CPU 1.5 s 时，Go 带 4 MiB payload、200 ms 期限的调用在约 200 ms 返回 `plugin_rpc_timeout`（修复前被拖到 1.4 s）；写超时会关闭连接，避免半帧错位 |
| 版本不兼容 | 以协议版本 2 握手 → `plugin_rpc_incompatible` + 支持范围 `{min:1,max:1}`；错误令牌只断开、不泄露信息 |
| 有界大 payload | 恰好上限通过；超 1 字节在客户端拒绝；手工超限帧头 → 宿主先回 `plugin_rpc_payload_limit` 再断开 |
| 崩溃与孤儿 | 插件 `process.exit(7)` → 在途调用 `plugin_rpc_closed`，记录退出码与 stderr；父进程被 SIGKILL 后宿主几秒内自行退出 |
| 环境暴露 | `process.env` 里没有网关注入的密钥，也没有宿主 RPC 令牌。**这不是安全边界**：插件与网关同一用户，仍可读 `~/.ai_home` 下的文件；按 ADR-P2，可执行插件只来自明确接受的可信制品 |
| 空链与启用插件基线 | 见 §3 |

变异检验：分别放宽握手版本检查、去掉 disposer 错误归属、去掉代次参数传播、去掉令牌删除、关闭父进程退出检测、去掉写期限，对应测试均失败；恢复后通过。

## 3. 性能基线与冻结门槛

`node scripts/plugin-m0-bench.js`（Node 公开宿主 → Plugin Host，经 dispatcher）；`go test -run '^$' -bench . ./internal/adapters/pluginruntime`（Go → Plugin Host，平均值）。同机运行着网关与编辑器，数字取多次运行的范围。

| 场景 | macOS M4 p50 / p95 / p99 | Windows i5-12600KF p50 / p95 / p99 |
| --- | --- | --- |
| 空链（宿主未启动） | 0.04 / 0.08 / 0.13 µs | 0.10 / 0.10 / 0.20 µs |
| 1 个插件，小 JSON | 24–39 / 52–77 / 134–251 µs | 77–95 / 197–259 / 320–391 µs |
| 1 个插件，1 MiB 往返 | 1.6–1.8 / 1.8–3.1 / 2.0–4.8 ms | 3.4–3.6 / 4.6–4.9 / 5.0–5.8 ms |
| Go → 宿主（平均） | 小 JSON 32 µs；1 MiB 2.0 ms | 小 JSON 90–105 µs；1 MiB 2.9–3.0 ms |

帧解码最初每收到一个 socket 块就整体拼接，大帧拷贝量随帧大小平方增长；改为整帧拼接一次后，1 MiB 往返 p50 从 6.2 ms 降到约 1.7 ms（macOS）。

**冻结门槛**（后续阶段沿同一脚本比较，超出即视为回归，需要解释或修复）。测量条件：开发机日常负载（网关、编辑器在运行），取连续 3 次中位数那次；单次 p99 受负载尖峰影响（M0 期间 macOS 小 JSON 出现过一次 695 µs），超门槛时先在空闲条件下复测再判定：

| 指标 | macOS | Windows |
| --- | --- | --- |
| 空链 | 不启动宿主；p99 ≤ 1 µs | 不启动宿主；p99 ≤ 1 µs |
| 1 个插件，小 JSON | p50 ≤ 80 µs，p99 ≤ 600 µs | p50 ≤ 200 µs，p99 ≤ 800 µs |
| 1 个插件，1 MiB 往返 | p50 ≤ 4 ms，p99 ≤ 12 ms | p50 ≤ 7 ms，p99 ≤ 12 ms |
| 代次轮换保留堆（sample，GC 后） | ≤ 64 KiB / 代 | ≤ 64 KiB / 代 |

## 4. 已知限制

1. **代次轮换的 ESM 模块记录不回收。** 每代重新 import 插件的模块树。GC 后实测：连续 50 代 echo 样例，macOS 保留堆 +0.9 MiB（约 18 KiB/代，三次一致）；Windows 两次为 +0.9 MiB 与 −0.2 MiB。RSS 读数不及时归还系统，不作依据。增长与插件模块树大小成正比；M1 由 supervisor 在累计轮换达到阈值、且无在途调用时重启宿主。
2. **插件的 CommonJS 依赖跨代次共享。** 隔离只覆盖 ESM 模块树；`require` 缓存按文件名共享。需要代次独立状态的插件应使用 ESM 或把状态放在 `apply` 内。
3. **Node 侧写入没有背压处理。** 网关到宿主的大量并发写入目前直接 `write`；M2 接入网关热路径前补齐。
4. **Windows 上没跑 Go 的 `-race`。** 测试机没有 gcc，cgo 不可用；race 检测在 macOS 上通过。
5. **单一宿主进程是故障单元。** 插件的 `process.exit` 或 CPU 阻塞会影响同一宿主内所有插件（崩溃与卡住两个测试即此场景）。与规划 ADR-P2 一致，不宣称每插件进程隔离。
6. **调用语义只有一种。** dispatcher 只实现「按顺序串行、上一项输出作下一项输入」，用于测量；observer / serial / waterfall / middleware（包括跨进程的单次 `next`）在 M2 按能力合同补齐。
7. **未接入网关。** M0 不改变任何公开路由。

## 5. 未完成 / 不在 M0

- 插件包安装、摘要校验、配置 revision、启停与重启后恢复（M1）。原型在 `lib/plugins/control/`，未验证，未提交。
- Provider 插件注册（M4）。原型在 `lib/plugins/provider/`，未提交。
- 网关接线与 generation 发布协议（M2）。`lib/plugins/runtime/capability-pipeline.js` 原型未提交。
