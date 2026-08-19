# 01-01 ReAct 核心事件循环与状态机生命周期

> **“在现代工业级 Agent 运行时中，ReAct 不仅是一种提示词工程（Prompt Engineering）技巧，而是一套严密、确定性且具备高容错能力的有限状态机（Finite State Machine, FSM）与异步事件总线（Event Loop）。”**

---

## 1. 章节导读与核心命题

作为当今工业界最强大的编码 Agent（Coding Agent）实现之一，Anthropic **Claude Code** 将大模型的长程规划、工具调用、权限审批与上下文管理收敛于一套极为紧凑且高效的 **ReAct 核心事件循环** 中。

许多开发者误以为 Agent 就是写一个简单的 `while (hasToolCalls)` 循环，但在实际工程中，面对网络闪断、Token 超限、思考流截断、破坏性操作审批挂起、并发子代理分流等现实复杂工况时，简陋的 `while` 循环会瞬间陷入死锁、状态错乱或递归爆栈。

本节将深入 Claude Code 的架构内核，逐行解构其 **ReAct 事件循环（Reasoning + Acting Loop）的状态机生命周期、消息轮次迭代拓扑、流式协议解包通道与异常恢复模型**。

<div class="rich-diagram-box">
  <div class="diagram-header-tag">ReAct Control Topology</div>
  <div class="diagram-title"><span>🔄</span> Claude Code ReAct 核心事件循环与控制流</div>
  <div class="harness-stack">
    <div class="chips-grid-4">
      <div class="tech-card blue"><div class="card-label">1. INIT / IDLE</div><div class="card-sub">会话绑定与信号监听</div></div>
      <div class="tech-card cyan"><div class="card-label">2. PERCEIVE</div><div class="card-sub">环境感知与上下文水合</div></div>
      <div class="tech-card purple"><div class="card-label">3. INFER & STREAM</div><div class="card-sub">三通道流式解包</div></div>
      <div class="tech-card red"><div class="card-label">4. PERM GATING</div><div class="card-sub">4 态权限门禁拦截</div></div>
    </div>
    <div class="flow-connector">⬇️ 物理工具分发执行 / 递归下一轮 ReAct</div>
    <div class="chips-grid-3">
      <div class="tech-card orange"><div class="card-label">5. EXECUTE TOOLS</div><div class="card-sub">PTY 超时强杀 / Worktree 沙箱</div></div>
      <div class="tech-card green"><div class="card-label">6. COMPACT & HARVEST</div><div class="card-sub">水位线治理与状态沉淀</div></div>
      <div class="tech-card blue"><div class="card-label">7. NEXT TURN</div><div class="card-sub">循环直到 stop_reason=end_turn</div></div>
    </div>
  </div>
</div>

---

## 2. 核心专业术语与概念精确释义

为了确保概念的教科书级严谨性，本节对涉及的核心术语定义如下：

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **ReAct Loop** | **推理-行动迭代循环** | 一种将大模型的隐式思考推理（Reasoning/Thinking）与显式物理动作（Acting/Tool Use）交替执行的闭环控制算法。每次 Action 的执行结果（Observation）将作为新上下文反馈给下一次推理。 |
| **Finite State Machine (FSM)** | **有限状态机** | 一种表示有限个状态以及在这些状态之间的转移和动作等行为的数学计算模型。Agent Harness 依靠 FSM 确保执行流的单向确定性与非法状态拦截。 |
| **Stop Reason** | **停机原因 / 终止判据** | 大模型完成单次 Forward 输出时由上游服务商返回的终止标记（如 `end_turn` 正常结束、`tool_use` 请求调用工具、`max_tokens` 长度截断、`stop_sequence` 命中停用词）。 |
| **Thinking Stream (`<thought>`)** | **显式思考流** | Claude 3.7 / DeepSeek 等推理模型在输出最终答案前，生成的链式思考（Chain-of-Thought）原始 Token 流。Harness 必须将其与正文文本流和工具参数流在传输层解耦。 |
| **Tool Use Block** | **工具调用块** | LLM API 返回的结构化内容块，包含 `id`、`name` 和符合 JSON Schema 的 `input` 参数对象。 |
| **Tool Result Block** | **工具执行反馈块** | 运行时将工具物理执行的 Stdout/Stderr 或结构化数据封装为 `role: "user"`（或专门的 `tool_result` 结构）回传给模型的载荷。 |
| **Turn / Round** | **对话轮次 / 迭代回合** | 从用户发起输入或 Harness 提交前一轮工具结果，到大模型完成响应并产生新的动作或结束标记的单次完整交互。 |
| **Backoff & Jitter** | **指数退避与抖动** | 面对网络错误（5xx）或限流（429）时，采用 $T = \text{base} \times 2^{\text{attempt}} + \text{random\_jitter}$ 计算重试间隔的弹性容错算法。 |

---

## 3. Claude Code ReAct 状态机的六大生命周期阶段

<div id="widget-fsm-container"></div>



Claude Code 将 Agent 的单次完整任务执行严格划分为 6 个确定性的状态阶段：

<div class="rich-diagram-box">
  <div class="diagram-header-tag">Fault-Tolerance Matrix</div>
  <div class="diagram-title"><span>🛡️</span> ReAct 运行时异常防御矩阵</div>
  <div class="chips-grid-4">
    <div class="tech-card red"><div class="card-label">死循环与重复震荡</div><div class="card-sub">SHA-256 参数滑窗熔断</div></div>
    <div class="tech-card orange"><div class="card-label">网络退避与抖动</div><div class="card-sub">429 / 502 指数退避 (Jitter)</div></div>
    <div class="tech-card purple"><div class="card-label">流式中断与半包</div><div class="card-sub">TCP 断点延续与语法树自愈</div></div>
    <div class="tech-card green"><div class="card-label">思考流预算饿死</div><div class="card-sub">4,096 Tokens 净空锁死</div></div>
  </div>
</div>

### 6.1 死循环与重复震荡防御 (Infinite Ping-Pong Detection)
- **触发机理**：大模型调用 `Read` 读取一个不存在的文件，报错后模型没有修改逻辑，再次尝试调用 `Read` 相同文件，连续触发数十次无意义消耗。
- **Harness 防御算法**：
  1. 维护最近 5 轮 Tool Calls 的 **SHA-256 指纹滑窗队列**：$H = \text{Hash}(\text{tool\_name} + \text{canonical\_json\_params})$；
  2. 若检测到完全相同的工具及参数在连续 3 轮中重复出现且均返回失败：
  3. Harness 强制阻断执行，合成一条显式系统干预提示注入模型：
     `"[SYSTEM GUARD]: You have called tool 'X' with identical arguments 3 times and received the same error. Stop repeating this action. Re-evaluate your strategy or ask the user."`

### 6.2 网络瞬断、429 限流与指数退避 (Backoff with Jitter)
- **触发机理**：上游 API 偶发 502/503 或突发 429 Rate Limit。
- **Harness 防御算法**：
  - 严禁在 ReAct 循环内部直接向用户抛出异常中断；
  - 启动带抖动的指数退避重试器：
    $$\text{Delay} = \min(\text{MaxDelay}, \text{InitialDelay} \times 2^{\text{retry\_count}}) \pm \text{Uniform}(0, \text{Jitter})$$
  - 重试期间通过状态机向 UI 抛出 `RETRYING` 瞬态事件，并在控制台显示倒计时，最大重试 5 次后再升级为 Fatal 异常。

### 6.3 思考流过大吃光 Token 预算 (Thinking Starvation)
- **触发机理**：推理模型（如 Claude 3.7 Thinking / DeepSeek R1）将绝大部分 `max_tokens` 消耗在 `<thought>` 思考过程中，导致正文尚未输出即触发 `stop_reason = 'max_tokens'`。
- **Harness 防御算法**：
  - 严格限制 `thinking.budget_tokens` 与 `max_tokens` 的保留差值（例如保留至少 4,096 tokens 给 Answer 和 Tool Use）；
  - 若截断发生，Harness 捕获半包并自动发起带历史前缀的 continuation 请求，拼接未完成的 JSON 语法树。

---

## 7. 对 ai_home 自主 Harness 研发的落地指导与架构设计

针对 `ai_home` 项目当前已有的架构基础，研发下一代生产级 Agent ReAct 运行时必须落地以下具体设计规范：

### 7.1 设计规范一：重构统一的 `AgentEventLoop` 引擎核心
- **当前现状**：`ai_home` 目前存在部分逻辑直接依赖 Provider 客户端的简单回调，缺乏统一的事件循环中枢。
- **重构方案**：
  1. 新建 `lib/runtime/agent-event-loop.ts`，基于 Node.js `EventEmitter` 构建纯状态机驱动的执行中枢；
  2. 严格将一次会话划分为 `INIT` -> `PERCEIVE` -> `INFER` -> `GATE` -> `EXECUTE` -> `HARVEST` 六大状态；
  3. 彻底解耦“物理工具执行”与“模型流式传输”，使两者成为事件总线上的可插拔消费者。

### 7.2 设计规范二：构建防重入与带指纹追踪的 Tool Dispatcher
- **落地方案**：
  1. 在 `lib/tools/dispatcher.ts` 中加入工具调用指纹记录表（`ToolCallDeduplicator`）；
  2. 当大模型在一轮中并行返回多个工具调用时：
     - 若全部为无副作用的只读工具（`isReadOnly: true`），并行分发给 worker pool；
     - 若包含任何有副作用的写工具（`isDestructive: true`），强行转换为拓扑串行队列执行；
  3. 任何工具调用执行时间超过预设（如 Bash 120s，Read 5s）必须触发带超时的 AbortSignal。

### 7.3 设计规范三：双端完全等价的非阻塞审批网桥 (Unified Approval Bridge)
- **落地方案**：
  1. 当状态机流转到 `GATING` 阶段时，生成全局唯一 `approvalId`，并将当前 AgentLoop 挂起在一个 `Promise<ApprovalResult>` 上；
  2. 同时向 WebSocket（WebUI 客户端）与 PTY Stdout（终端用户）广播审批请求帧；
  3. 无论哪一端先提交了 `APPROVE` 或 `REJECT`，网桥立即 `resolve` 该 Promise，恢复 AgentLoop 运行，并向另一端广播已审批状态，防止两端状态不一致。

---

## 8. 本章小结与下章预告

本章对 **Claude Code** 核心的 ReAct 事件循环进行了源码级、状态机级与数据流协议级的全面解构，揭示了生产级 Agent 运行时在生命周期管理、流式解包、并发调度与容错自愈上的架构本质，并给出了 `ai_home` 运行时的具体落地重构规范。

在下一章 **【01-02 工具系统（Tools Protocol）、动态注入与执行沙箱】** 中，我们将深入剖析 Claude Code 的工具协议设计，详细拆解其 `Read`、`Edit`、`Bash` 等核心工具的高性能实现原理、AST 补丁机制以及基于 OS/Worktree 的多层防御沙箱体系。
