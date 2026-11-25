# MCP 启用范围与共享桥设计

- 状态：Phase 1–3 已实现；WebUI 共享桥三档已补（2026-11-25）；Phase 4（跨 harness 聚合）待做
- 日期：2026-11-23（实现更新 2026-11-24；UI 与真机计数验证 2026-11-25）
- 范围：MCP registry、账号与会话级启用策略、共享桥进程模型、跨 harness 复用边界

## 0. 实现进度

- Phase 1：registry + 账号策略（auto/allowlist/disabled）+ 账号页 MCP Tab + 启动读取，已上线。
- Phase 2：会话级 `--mcp` / `--no-mcp` / `--mcp-profile` / `--mcp-status`、统一 registry 选择、
  Tab 补全（原生 MCP ∪ 账号允许的注册表 MCP）、外部 MCP `<id>.<tool>` 前缀代理，已实现。
- Phase 3：共享桥 daemon + 薄 shim、`config:server.mcpBridgeSharing = global|workspace|off`，
  已实现；Windows 暂回退到每会话一个桥（named pipe 权限模型未验证）。
- 仍待做：把注册表 MCP 聚合进共享桥（跨 harness 复用，Phase 4）、`--mcp-status` 的
  daemon 计数观测、Windows named pipe；WebUI 的 MCP 注册表编辑页、标准 stdio
  （command/args/env）安装表单（当前仅 Node 单脚本）。

## 0.1 验证结论（2026-11-25）

1. **共享桥进程计数（真实 Claude 工作区会话，本机 workspace）**
   - `off`（每会话）：2 个会话 → 2 个 `aih-server __mcp-remote-tools`，无 daemon、无 shim；
     单桥 RSS 约 27–29 MB。
   - `global`：1 个会话 → 1 个 `__mcp-bridge-daemon`（约 27 MB）+ 1 个 `aih-mcp-shim`
     （约 3.4 MB）；2 个会话 → 同一个 daemon + 2 个 shim（约 3.4 / 5.7 MB），无完整桥。
   - 结论：`off` 按会话线性增长；`global` 只增 shim，daemon 复用。
2. **WebUI 上在哪里设置 MCP**
   - 共享桥三档：开发工具 → 应用管理 → Codex → 高级设置 → MCP。
   - 账号级启用策略：账号 → 某账号「更多」→ 运行设置 → MCP（仅桌面端；
     auto / 手动选择 / 全部关闭）。
   - 给单个 Provider 安装原生 MCP：开发工具 → 插件与资源 → MCP → 安装资源
     （当前只支持 Node 脚本路径）。
   - 单次会话禁用：工作区连接器 → 打开 agent → 「本次禁用 MCP」。
   - 注意：账号 MCP 策略只约束注册表 MCP；`插件与资源` 安装到 Provider 原生配置的
     MCP 不走该策略。

## 1. 背景

当前每个会话都会启动一个独立的 MCP 桥：

- 入口：internal/transport/http/webuisshapi/remote_agent.go
- 协议：internal/transport/http/webuisshapi/remote_tools_mcp.go
- 形态：provider 以 stdio 启动 aih-server __mcp-remote-tools，每个会话一个进程
- 实测：桥约 13MB/会话；5 个会话约 65MB，codex runtime 约 100–119MB/会话

同一 workspace 的多个会话也会各有一个桥；会话全部 detached 时不会自动退出。

之前已经做过两类优化：

- 3330d27f：Codex 池化 app-server，启用 mcp_lazy_stdio_startup / mcp_connection_sharing，消除每线程 MCP 扇出
- 6680f769：同身份 Codex 终端复用 app-server 后端，线程归属过滤

本次解决的是“跨会话、跨 provider 的 MCP 桥共享与启用策略”，不改变 relay chat 架构。

## 2. 两个正交维度

1. 启用（enablement）：某个账号/会话是否允许使用某个 MCP。
2. 共享（sharing）：启用之后，桥进程是全局、按 workspace，还是每会话一个。

关闭 MCP 就不会启动桥；共享模式只在启用之后生效。

## 3. 目标与非目标

目标：

- 账号级可视化开关：auto / 手动允许列表 / 全部关闭
- 会话级选择：--mcp、--no-mcp、--mcp-profile、Tab 补全、--mcp-status
- 共享桥：global（默认）/ workspace / off
- 跨 provider 复用 MCP 工具后端（MCP-capable harness）
- 明确的权限边界与审计

非目标：

- 不把 relay chat 接入 Codex app-server
- 不跨不同 provider 共享 app-server
- 不改变 MCP 工具语义与现有调用结果

## 4. Registry 模型

每个 MCP 一条定义：

    id            唯一标识，例如 aih_remote、github
    displayName   展示名
    transport     stdio | http
    command/args  启动命令（stdio）
    env           环境变量或密钥引用
    capabilities  read / write / run / network
    providers     兼容的 harness 列表，空 = 全部
    default       global 默认是否启用
    requiredFor   需要强制启用的场景（例如 workspace 绑定）
    secretRefs    密钥引用，只存引用不存明文

内置 MCP 由核心注册；其它 MCP 由插件注册，核心不写厂商枚举。

## 5. 解析模型与优先级

从宽到窄：

1. 全局默认：registry 的 default 与全局允许列表
2. 账号策略：auto | allowlist | disabled
3. workspace 约束：某些 workspace 强制需要 aih_remote
4. 会话选择：--mcp / --no-mcp / profile

规则：

- 账号策略是天花板：会话只能收窄，不能放宽
- workspace 必需的 MCP 若被账号禁用，启动直接报错，不静默降级
- 最终生效列表必须可见（账号页、--mcp-status）

### 5.1 账号禁用是什么

“账号禁用”指针对某一个账号，把某个 MCP（或全部 MCP）标记为不可用。典型场景：

- 公司/共享账号不允许挂 GitHub MCP
- 额度紧张的账号不使用重型工具 MCP
- 凭据隔离：某账号不应访问某类外部服务

行为：

- 该账号的会话无法通过 --mcp 重新启用
- 账号页显示“账号禁用”，并列出原因
- 与全局关闭的区别：全局关闭影响所有账号；账号禁用只影响该账号

### 5.2 自动（auto）是什么

auto 不是黑盒推荐，而是一张规则表：

- 绑定了 workspace 的会话 → 启用 aih_remote
- provider/harness 已关闭原生 shell → 不再重复挂 shell 类 MCP
- 模型/工具能力不支持 → 不启用
- 账号策略与凭据限制 → 排除

账号页必须能展开看到“最终解析结果 + 来源 + 原因”，并允许切到手动允许列表或全部关闭。

## 6. 账号级可视化

账号详情新增 MCP 区块：

- 每个 MCP 一行：开关、来源（全局/账号/自动）、能力标签
- 模式：auto（默认）、手动允许列表、全部关闭
- “查看解析结果”展示最终列表与原因
- 账号禁用对会话是硬约束

## 7. 会话级选择

CLI 统一支持：

    aih codex                     # 使用账号/全局解析结果
    aih codex --no-mcp            # 本次不挂任何 MCP
    aih codex --mcp aih_remote    # 只启用指定 MCP，可逗号分隔
    aih codex --mcp-profile work  # 命名集合
    aih codex --mcp-status        # 打印生效列表、来源与共享 scope

规则：

- --no-mcp 优先级最高；与 --mcp 同时出现直接报参数冲突
- --mcp 只能选择账号允许的子集；越界时报错并给出账号策略
- Tab 补全候选 = registry ∩ 账号允许列表，补全项带描述与能力标签
- Claude 与 Codex 使用同一套参数语义

## 8. 共享桥架构

### 8.1 形态

- Daemon：aih-server __mcp-bridge-daemon --scope global|workspace:<id> --socket <path>
- Shim：现有 __mcp-remote-tools 增加 shim 模式，launch context 只含 {socketPath, token}
- Socket：~/.ai_home/run/mcp-bridge/global.sock 或 ws-<hash>.sock，权限 0600
- Windows 使用 named pipe，权限模型单独验证

### 8.2 令牌与权限

- 每个会话一个随机 token，不落盘、不进命令行
- daemon 内存映射：token → { workspaceId, capabilities, credentialIdentity, expiresAt }
- 客户端不能自报 workspace；工具调用只按 token 映射执行
- 会话结束吊销 token；过期或未知 token 拒绝

### 8.3 生命周期

- 第一个会话启动 daemon，租约计数
- 最后一个会话结束后空闲 N 分钟退出（默认 5）
- daemon 崩溃时 shim 返回 MCP 错误，下次工具调用自动重启
- 按会话隔离 JSON-RPC id，按 workspace 串行化有状态操作

### 8.4 共享层级

    global     一个 daemon，所有 workspace 按 token 路由（默认）
    workspace  每个 workspace 一个 daemon，隔离更强
    off        每会话一个完整桥（现有行为，回退用）

## 9. 凭据

沿用现有方式：registry 只存 env / secretRefs，密钥由既有的配置与账号投影提供；不新增密钥存储，不把明文写入 registry 或 launch context。

## 10. 重名策略

- registry 强制 id 唯一
- 外部注册的 MCP 工具统一暴露为 <mcpId>.<toolName>
- 内置 aih_remote 保持现有工具名，保证兼容
- 若检测到冲突，--mcp-status 显示映射结果，启动日志记录一次
- 不做“只在冲突时加前缀”的动态行为，避免同一会话前后名称变化

## 11. 跨 harness 复用

MCP 是共同协议，共享桥可以服务所有 MCP-capable harness：

- stdio-only 的 harness 用薄 shim；支持 HTTP/SSE 的直接连 daemon
- 每个 harness 一份 capability profile，工具子集与审批语义由 harness 决定
- 审批留在 harness，daemon 只做授权、路由、审计
- 共享的收益：进程、SSH/connector 连接、凭据解析、限流、审计

不覆盖：relay chat、不支持 MCP 的 harness。通用工具网关属于后续附加项，不在本设计范围。

## 12. Codex work 会话的 app-server 池

- 仅 Codex work/终端，同 account、model、workspace、runtime/MCP 配置
- 复用现有 6680f769 的后端池与线程过滤
- relay chat 与其它 provider 不参与
- MCP 配置按 scope 收敛后，同 workspace 的 work 会话才具备池化条件
- 独立上线，不与共享桥耦合

## 13. 兼容与迁移

- 全局 registry 默认等价于当前行为（aih_remote 开启）
- 账号策略未设置 = 继承全局，现有账号零迁移
- 共享模式默认 global；off 可一键回退
- 已运行会话不热切换，下一次启动生效

## 14. 可观测性

- 账号页：生效 MCP、来源、原因
- 全局状态：daemon 数、会话数、shim 数、估算节省内存
- 审计：token 前缀、工具名、workspace 哈希、时间、结果；不记凭据
- 指标：工具调用数、拒绝数、daemon 重启次数、空闲退出次数

## 15. 阶段计划

1. Registry + 解析器 + 账号 MCP UI（默认行为不变）
2. 会话 flags + Tab 补全 + --mcp-status
3. 共享 daemon/shim（global/workspace/off、token、空闲退出）
4. 跨 harness 适配 + Codex work app-server 池
5. AWS 实测：5 会话进程/RSS、工具结果一致性、跨账号隔离

## 16. 测试

- 单元：scope 解析、token 映射、配置校验、过期拒绝、重名映射
- 集成：3 个同 workspace 会话 → 1 daemon + 3 shim；跨 workspace 隔离；token 重放拒绝；空闲退出；off 回退
- 端到端：Claude/Codex 各跑 read/write/run_command；并发调用；daemon 重启恢复
- 性能：daemon/shim RSS、SSH 连接数、首次工具调用延迟

## 17. 风险

- 全局 daemon 是单点故障与更高价值目标：token 隔离、0600 socket、审计必须到位
- 同 workspace 不同账号的连接复用：按 credentialIdentity 分桶
- Windows named pipe 权限模型需单独验证
- 共享模式切换只对新会话生效，排障时需要 --mcp-status

## 18. 已确认决策

- 账号禁用 = 账号级硬天花板，会话不能放宽
- auto = 规则表推导，结果必须可见
- MCP 自带凭据沿用现有配置/密钥引用方式
- 外部 MCP 工具统一加 <mcpId>. 前缀；内置 aih_remote 保持原名
- 共享模式默认 global
