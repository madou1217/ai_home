# 插件架构 M0 报告：合同与技术验证

日期：2026-10-04。对应 [插件化规划](../plans/2026-09-30-plugin-architecture-plan.md) §7 的 M0。本文只记录有运行证据的结论；没有证据的条目标为「未完成」。

## 1. 交付物

| 交付 | 落点 | 说明 |
| --- | --- | --- |
| 固定 Cordis 制品 | `package.json`（`@deepseek-ai/cordis` 4.0.4；`overrides` 钉住 cosmokit 1.8.5、@standard-schema/spec 1.1.0）；`contracts/plugins/contract.json` 的 `runtimeDependencies` | 仓库不跟踪锁文件，所以版本靠 overrides 固定、integrity 记在合同里，测试拿 `node_modules/.package-lock.json` 中 npm 安装时校验过的 integrity 逐一比对 |
| ESM/CJS 接缝 | `lib/plugins/host/register-hooks.mjs`、`resolve-hooks.mjs` | 宿主以 `node --import <hooks 的 file URL> host-entry.mjs` 启动；`module.register()` 把插件里的 `@ai-home/plugin-sdk` 与 `@deepseek-ai/cordis` 解析到宿主自带的那一份，全宿主只有一个 Cordis。宿主是 ESM，SDK/传输/诊断是 CJS，两边经 `createRequire` 互通 |
| 跨平台传输 | `lib/plugins/transport/*`、`internal/adapters/pluginruntime` | POSIX 私有 Unix socket（0700 目录、0600 文件）；Windows named pipe（Go 侧用 go-winio 重叠 I/O）。一套线合同，不维护两套 RPC |
| 帧格式与上限 | `contract.json` `limits` | 12 字节头 + JSON 元数据（≤64 KiB）+ 二进制 payload（≤4 MiB）；缓冲上限 8.06 MiB；在途 64；握手 2 s；默认调用超时 10 s。超限在读头时就拒绝，不先缓冲正文 |
| 公共服务与能力版本 | `contract.json` `capabilities`；`ctx.aih` | 14 个能力各带版本与调用模式；M0 宿主只开放 `register` / `provide` / `instance` 三个窄服务，均按清单校验归属 |
| DTO 生成 | `scripts/generate-plugin-contract.js` | 由 `contract.json` 生成 Go 常量与 DTO（gofmt 对齐）、TS 类型、SDK 用 JSON；`--check` 进测试 |
| 最小 sample | `examples/plugins/echo` | 外部插件，只 import SDK；回显 JSON 与二进制 payload、可被取消的等待、取消计数、异步 disposer |
| 空链快路径 | `lib/plugins/host/dispatcher.js` | 能力没有已发布贡献项时直接返回原值，不启动宿主、不建连接 |

## 2. 验收证据

| 规划要求的证据 | 证据 | 结果 |
| --- | --- | --- |
| Node 22 加载/卸载 | `test/plugin-host-m0.test.js`「external sample loads…」：外部临时目录里的 sample 经真实宿主进程准备、发布、调用、卸载；卸载后调用返回 `plugin_generation_unknown` | macOS（Node 22.16）与 Windows（Node 22.23）均通过 |
| 依赖缺失/恢复 | 「missing services are diagnosed…」：只启用消费方 → `plugin_service_missing`；加入提供方的新代次 → 先加载提供方再加载消费方，调用拿到服务返回值 | 通过 |
| 循环诊断 | 「dependency plan…」与「dependency cycles…」：`plugin_dependency_cycle`，诊断给出环路 `a → b → a`。Cordis 本身对成环依赖只会让 fiber 停在 PENDING、无任何诊断（M0 实测），所以在加载任何插件代码之前做静态诊断 | 通过 |
| 其他准备期拒绝 | 插件 ID 重复、贡献项重复、服务版本不满足、宿主版本不兼容、能力版本不支持、注册未声明的贡献项、apply 抛错（带原始错误信息） | 通过；被拒绝的候选不留下半加载的代次 |
| 异步 disposer 完成 | sample 的 20 ms 异步 disposer：卸载耗时 ≥ 20 ms 才返回；disposer 抛错不阻塞卸载并归属到具体实例（「a throwing disposer…」） | 通过 |
| Go↔Node 往返 | `go test ./internal/adapters/pluginruntime`：Go 客户端对真实 Node 宿主，4 MiB（恰好上限）payload 原样往返；32 路并发调用 | macOS（含 `-race`）与 Windows（named pipe）均通过 |
| 取消 | Go 与 Node 两侧：ctx 取消 / AbortSignal → 宿主 handler 的 signal 真的 abort（sample 取消计数 = 2，含一次 deadline）；已取消的调用不回发结果 | 通过 |
| 版本不兼容 | 以协议版本 2 握手 → `plugin_rpc_incompatible` 并带支持范围 `{min:1,max:1}`；错误令牌只断开、不泄露信息 | Go 与 Node 两侧通过 |
| 有界大 payload | 恰好上限通过；超 1 字节在客户端拒绝；手工发出超限帧头 → 宿主先回 `plugin_rpc_payload_limit` 再断开，客户端拿到的是具体原因而不是 EOF | 通过 |
| 宿主崩溃诊断 | 插件中 `process.exit(7)` → 在途调用 `plugin_rpc_closed`，supervisor 记录退出码 7 与 stderr 尾部 | 通过 |
| 凭据隔离 | 宿主进程环境变量按白名单构造：插件读不到网关注入的密钥（「plugins cannot read gateway secrets…」） | 通过 |
| 空链与启用插件的 p50/p95/p99 基线 | `node scripts/plugin-m0-bench.js`；`go test -bench . ./internal/adapters/pluginruntime` | 见 §3 |

变异检验：故意放宽握手版本检查、去掉 disposer 错误归属后，对应 3 个测试失败；恢复后全部通过。

## 3. 性能基线

### macOS：Apple M4，10 核，16 GiB，Node 22.16.0（连续 3 次）

| 场景 | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 空链（未启动宿主） | 0.04 µs | 0.08 µs | 0.13 µs |
| 启用 1 个插件，小 JSON（Node 公开宿主 → Plugin Host） | 34–39 µs | 71–77 µs | 195–251 µs |
| 启用 1 个插件，1 MiB payload 往返 | 1.76–1.83 ms | 2.4–4.8 ms | 8.0–8.8 ms |
| Go → Plugin Host（平均） | 小 JSON 32 µs/次；1 MiB 2.0 ms/次（约 1.0 GB/s） | | |

### Windows：Intel i5-12600KF，16 线程，64 GiB，Node 22.23.1（named pipe）

| 场景 | p50 | p95 | p99 |
| --- | --- | --- | --- |
| 空链（未启动宿主） | 0.10 µs | 0.10 µs | 0.20 µs |
| 启用 1 个插件，小 JSON | 82 µs | 226 µs | 331 µs |
| 启用 1 个插件，1 MiB payload 往返 | 3.4 ms | 4.5 ms | 5.2 ms |
| Go → Plugin Host（平均） | 小 JSON 90 µs/次；1 MiB 3.0 ms/次（约 0.7 GB/s） | | |

说明：

- 帧解码最初每收到一个 socket 块就整体拼接一次，大帧拷贝量随帧大小平方增长；改为凑够整帧再拼接一次后，1 MiB 往返 p50 从 6.2 ms 降到 1.8 ms（macOS）。
- 小 JSON 的 p99 受本机其他负载影响明显（同机运行着网关与编辑器），后续阶段按同一脚本、同一负载比较。

## 4. 已知限制（未解决，已量化）

1. **代次轮换的模块内存不回收。** 每个代次用带 `generation` 查询参数的 URL 重新 import 插件模块，ESM 模块记录无法卸载。实测连续准备并发布 50 代 echo 样例后，宿主 RSS +14.5 MiB、堆 +8.2 MiB（约 170 KiB/代）。缓解：M1 的 supervisor 在累计轮换达到阈值、且没有在途调用时重启宿主进程；或者按 bundle 拆分宿主进程。
2. **Windows 上没有跑 Go 的 `-race`。** 那台机器没有 gcc，cgo 不可用；race 检测在 macOS 上跑过并通过。
3. **单一宿主进程是故障单元。** Cordis 能隔离加载与回调异常，但插件里的 `process.exit` 或 CPU 阻塞会影响同一宿主中的所有插件（崩溃测试即此场景）。这与规划 ADR-P2 一致，不宣称每个插件进程隔离。
4. **调用语义只有一种。** M0 的分发器只实现「按顺序串行、上一项输出作下一项输入」，用于测量。observer、serial、waterfall、middleware（包括跨进程的单次 `next`）在 M2 接入网关时按能力合同补齐。
5. **未接入网关热路径。** M0 不改变任何公开路由；网关目前不会调用插件。

## 5. 未完成 / 不在 M0

- 插件包安装、摘要校验、配置 revision、启停与重启后恢复（M1）。原型代码在 `lib/plugins/control/`，未验证，未提交。
- Provider 插件注册（M4）。原型在 `lib/plugins/provider/`，未提交；宿主里引用它的坏代码已删除。
- 网关 request / route / attempt 接线与 generation 发布协议（M2）。`lib/plugins/runtime/capability-pipeline.js` 原型未提交。
