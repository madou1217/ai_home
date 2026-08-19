# 03-01 插件化架构与双向 Hook 事件拦截流水线

> **“一个真正开放的工业级 Agent Harness，绝不能将自身限制为封闭的单体黑盒。OpenCode 的精髓在于其完全事件驱动的微内核（Microkernel）设计：通过在生命周期的关键决策点设立双向可变 Hook 拦截管线，开发者可以在不修改内核一行代码的前提下，实现工具注入、Prompt 重写、安全门禁以及遥测监控的无限横向扩展。”**

---

## 1. 章节导读与核心命题

在解构了 Anthropic Claude Code 的 ReAct 单进程体系与 OpenAI Codex 的 Stdio App Server 架构后，我们正式开启 **第三篇：OpenCode 架构深度解构**。

作为开源社区最具代表性的多模型终端 Agent 平台之一，**OpenCode**（及其背后的微内核架构）探索出了一条与官方闭源产品截然不同的演进路线：
1. **多模型 Provider 的完全平权（Multi-Provider Parity）**：不绑定任何单一模型厂商（无论是 Claude、GPT-5、DeepSeek 还是本地 Ollama），通过统一适配器层抽象抹平差异；
2. **微内核与高度插件化（Microkernel & Plugin Ecosystem）**：将核心运行时极简化为状态驱动引擎，所有高级特性（如 Git 状态注入、Linter 自动修复、权限审计、通知推送）均作为独立的插件（Plugins）插拔接入；
3. **双向可变 Hook 流水线（Bidirectional Mutable Hook Pipeline）**：与传统的只读事件监听器（Read-only Event Listeners）不同，OpenCode 的 Hook 具备**双向拦截与载荷就地重写（In-place Payload Mutation）**能力，允许插件在 Prompt 进网关前修改上下文，在工具执行前修改参数，甚至直接短路（Short-circuit）执行流程。

本节将系统拆解 OpenCode 的插件化微内核架构、生命周期 Hook 拓扑矩阵、洋葱模型拦截流水线以及核心源码实现。

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                             OpenCode 插件化微内核与 Hook 拦截架构                           │
│                                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              OpenCode Microkernel Core                               │  │
│  │  - 状态驱动引擎 (State Engine)               - 全局插件注册表 (Plugin Registry)      │  │
│  │  - 事件调度总线 (Event Dispatcher Bus)       - 统一 Provider 抽象层 (Model Gateway)  │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                     ┌───────────────────────┴───────────────────────┐                      │
│                     ▼                                               ▼                      │
│  ┌────────────────────────────────────────┐   ┌─────────────────────────────────────────┐  │
│  │    Ingress Pipeline (输入与提示词管线)  │   │    Egress Pipeline (工具与执行管线)     │  │
│  │                                        │   │                                         │  │
│  │  1. `before_prompt_hydrate`            │   │  1. `before_tool_dispatch`              │  │
│  │     (插件注入自定义 Rules/Memory)       │   │     (安全审计 / 参数清洗 / AST 拦截)     │  │
│  │  2. `transform_model_payload`          │   │  2. `wrap_tool_execution`               │  │
│  │     (多模型协议格式转换 / 思考流解耦)  │   │     (沙箱隔离 / PTY 包装 / 超时守护)    │  │
│  │  3. `before_stream_start`              │   │  3. `after_tool_executed`               │  │
│  │     (鉴权令牌刷新 / 请求头覆写)        │   │     (结果截断 / 状态快照 / Linter 触发) │  │
│  └──────────────────┬─────────────────────┘   └────────────────────┬────────────────────┘  │
│                     │                                              │                       │
│                     └───────────────────────┬──────────────────────┘                       │
│                                             │                                              │
│                                             ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                             Active Plugin Instances (插件实例集合)                   │  │
│  │  ┌───────────────────────┐  ┌────────────────────────┐  ┌─────────────────────────┐  │  │
│  │  │  SecurityGuardPlugin  │  │  MemoryRetrieverPlugin │  │ AutoLinterFixerPlugin   │  │  │
│  │  │  (拦截 rm -rf / 提权) │  │  (检索本地 .md 规则库) │  │ (文件修改后自动跑 eslint)│  │  │
│  │  └───────────────────────┘  └────────────────────────┘  └─────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Microkernel Architecture** | **微内核架构** | 将系统核心精简为仅包含最基础的生命周期调度、通信总线与插件挂载点，所有具体业务逻辑与扩展能力均通过独立插件模块实现的架构模式。 |
| **Mutable Hook Pipeline** | **可变拦截钩子流水线** | 一种按固定拓扑顺序执行的中间件链。每个 Hook 函数不仅能观测事件，还能修改传递进来的上下文对象（Payload Mutation）或提前阻断并返回自定义结果（Short-circuiting）。 |
| **Onion Model Interceptor** | **洋葱模型拦截器** | 类似 Koa / Express 中间件的执行模式：请求从外层插件逐层向内穿透至核心执行层，执行完成后再由内向外反向穿出，支持在单个 Hook 内同时包裹前置处理与后置收割。 |
| **Short-Circuiting** | **执行短路 / 快速熔断** | 某个前置 Hook 拦截器直接构造并返回最终结果，阻止后续中间件及底层真实物理操作执行的机制（常用于权限拦截与本地命中缓存）。 |
| **Plugin Isolation** | **插件运行时隔离** | 确保单个第三方插件发生未捕获异常（Uncaught Exception）或异步死锁时，不会导致整个 Agent 核心进程崩溃的容错保护机制。 |
| **Telemetry Hook** | **遥测与观测钩子** | 专门用于捕获 Token 消耗、工具执行耗时、错误日志与用户行为，并异步上报至监控系统的只读观察者钩子。 |

---

## 3. OpenCode 六大核心生命周期 Hook 拓扑矩阵

OpenCode 将 Agent 单轮 ReAct 交互精确划分为 6 个核心拦截锚点：

```
 [User Input] 
      │
      ▼
 [Hook 1: before_prompt_hydrate] ────> 允许插件追加自定义 System Prompt、召回记忆与注入规则
      │
      ▼
 [Hook 2: transform_model_payload] ──> 允许插件重写上送给 Provider 的消息体与工具 Schema
      │
      ▼
 [Model Streaming Inference]
      │
      ▼
 [Hook 3: before_tool_dispatch] ─────> 权限与安全门禁拦截点 (支持短路抛出 PermissionDenied)
      │
      ▼
 [Hook 4: wrap_tool_execution] ──────> 洋葱包裹层 (管理 Worktree 隔离、PTY 超时守护)
      │
      ▼
 [Physical Tool Execution]
      │
      ▼
 [Hook 5: after_tool_executed] ──────> 产物治理点 (超长结果截断、触发自动 Linter/格式化)
      │
      ▼
 [Hook 6: on_turn_complete] ─────────> 轮次终态收割点 (持久化 WAL、计量 Token、广播 UI)
```

### 3.1 Hook 语义、参数契约与能力矩阵

| Hook 锚点名称 | 触发时机 | 传入参数 (可变 Payload) | 典型应用场景与能力 |
| :--- | :--- | :--- | :--- |
| **`before_prompt_hydrate`** | 用户提交指令后，构建 Prompt 前 | `{ sessionId, userPrompt, systemReminders[] }` | 记忆检索插件注入 `MEMORY.md`、动态注入 Git 分支与当前时间。 |
| **`transform_model_payload`** | 调用大模型 API 序列化前 | `{ model, messages[], tools[], options }` | 针对特定模型过滤不支持的 Tool Schema、抹除敏感词、调整 Temperature。 |
| **`before_tool_dispatch`** | 模型解析出 `tool_use`，执行前 | `{ callId, toolName, arguments, sessionContext }` | **安全拦截中枢**：扫描 AST 危险指令，触发 HITL 人工审批或直接阻断。 |
| **`wrap_tool_execution`** | 物理工具启动瞬间 (洋葱层) | `(ctx, next) => Promise<ToolResult>` | 动态切换 CWD 至临时 Git Worktree 沙箱、启动 120s 进程树超时守护。 |
| **`after_tool_executed`** | 物理工具返回 Stdout/Stderr 后 | `{ callId, result, isError, executionTimeMs }` | 历史输出截断、检测到 `.ts` 修改后自动触发 `eslint --fix` 伴随修复。 |
| **`on_turn_complete`** | 单轮 ReAct 完成，准备交付时 | `{ sessionId, turnIndex, totalUsage, finalStatus }` | 刷新 WebUI 状态卡、将本轮事件写入 SQLite 与 JSONL。 |

---

## 4. 双向可变 Hook 流水线（Mutable Pipeline）TypeScript 核心实现

为了实现极高执行效率与严密异常隔离，OpenCode 设计了一个基于 TypeScript 的洋葱型 Hook 流水线引擎。

### 4.1 核心类型契约与接口定义

```typescript
export interface HookContext {
  readonly sessionId: string;
  readonly workspaceRoot: string;
  readonly metadata: Map<string, unknown>;
  isShortCircuited: boolean;
  shortCircuitResult?: unknown;
}

export type NextFunction = () => Promise<void>;

export type HookHandler<TPayload> = (
  payload: TPayload,
  ctx: HookContext,
  next: NextFunction
) => Promise<void>;

export interface OpenCodePlugin {
  readonly name: string;
  readonly version: string;
  
  beforePromptHydrate?: HookHandler<{ userPrompt: string; systemReminders: string[] }>;
  transformModelPayload?: HookHandler<{ model: string; messages: any[]; tools: any[] }>;
  beforeToolDispatch?: HookHandler<{ toolName: string; args: Record<string, unknown> }>;
  wrapToolExecution?: (ctx: HookContext, toolName: string, args: Record<string, unknown>, next: () => Promise<any>) => Promise<any>;
  afterToolExecuted?: HookHandler<{ toolName: string; result: any; isError: boolean }>;
  onTurnComplete?: HookHandler<{ turnIndex: number; usage: { inputTokens: number; outputTokens: number } }>;
}
```

### 4.2 管道执行器（HookPipelineExecutor）完整源码实现

```typescript
export class HookPipelineExecutor {
  private plugins: OpenCodePlugin[] = [];

  public registerPlugin(plugin: OpenCodePlugin): void {
    this.plugins.push(plugin);
  }

  /**
   * 洋葱模型执行器：支持插件逐层进入并在返回时后置处理
   */
  public async executePipeline<TPayload>(
    hookName: keyof OpenCodePlugin,
    payload: TPayload,
    ctx: HookContext
  ): Promise<TPayload> {
    const handlers: HookHandler<TPayload>[] = [];

    for (const plugin of this.plugins) {
      const handler = plugin[hookName] as HookHandler<TPayload> | undefined;
      if (handler && typeof handler === 'function') {
        handlers.push(handler.bind(plugin));
      }
    }

    let index = -1;
    const runner = async (i: number): Promise<void> => {
      if (ctx.isShortCircuited) return;
      if (i <= index) throw new Error('next() called multiple times in single hook');
      index = i;

      if (i < handlers.length) {
        const fn = handlers[i];
        try {
          await fn(payload, ctx, () => runner(i + 1));
        } catch (err) {
          // 插件异常沙箱隔离：记录错误但不使主进程崩溃
          console.error(`[Plugin Exception] Plugin in hook '${String(hookName)}' threw an error:`, err);
          // 继续推进下一个插件
          await runner(i + 1);
        }
      }
    };

    await runner(0);
    return payload;
  }
}
```

---

## 5. 经典实战插件范例：代码质量伴随修复插件 (AutoLinterPlugin)

以下范例展示了如何编写一个纯解耦的 OpenCode 插件：当 Agent 通过 `Edit` 或 `Write` 修改了代码文件后，插件在 `afterToolExecuted` 钩子中自动运行 `eslint --fix`，并在出错时将修复结果追加反馈给模型。

```typescript
export const AutoLinterPlugin: OpenCodePlugin = {
  name: 'auto-linter-fixer',
  version: '1.0.0',

  async afterToolExecuted(payload, ctx, next) {
    // 1. 先执行后续插件
    await next();

    // 2. 只拦截写文件类工具
    if ((payload.toolName === 'Edit' || payload.toolName === 'Write') && !payload.isError) {
      const targetFile = (payload.result as any)?.file_path;
      if (targetFile && (targetFile.endsWith('.ts') || targetFile.endsWith('.tsx') || targetFile.endsWith('.js'))) {
        try {
          // 3. 本地静默执行 linter
          const { execSync } = require('child_process');
          execSync(`npx eslint --fix "${targetFile}"`, {
            cwd: ctx.workspaceRoot,
            timeout: 5000,
            stdio: 'pipe'
          });
          
          // 4. 修改结果载荷，注入 Linter 成功状态
          if (typeof payload.result === 'object') {
            payload.result.linterStatus = 'AUTO_FIXED_CLEAN';
          }
        } catch (lintErr: any) {
          // 若存在无法自动修复的规则错误，向工具结果追加报错，引导模型在下一轮修正
          if (typeof payload.result === 'object') {
            payload.result.linterWarning = `Linter found issues: ${lintErr.stdout?.toString() || lintErr.message}`;
          }
        }
      }
    }
  }
};
```

---

## 6. 插件拦截状态机时序流与核心源码调用栈

### 6.1 Hook 拦截流水线时序图 (Hook Pipeline Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant Loop as OpenCode ReAct Loop
    participant Pipeline as HookPipelineExecutor
    participant SecPlugin as SecurityGuardPlugin
    participant LintPlugin as AutoLinterPlugin
    participant ToolRunner as Tool Execution Driver

    Loop->>Pipeline: 收到 tool_use (Bash: "rm -rf /dist && npm build")
    
    activate Pipeline
    Pipeline->>SecPlugin: 触发 beforeToolDispatch 钩子
    activate SecPlugin
    SecPlugin->>SecPlugin: AST 扫描检测到 "rm -rf"
    SecPlugin->>SecPlugin: 判定为普通编译清理，放行并调用 next()
    SecPlugin-->>Pipeline: next() 推进
    deactivate SecPlugin
    
    Pipeline->>LintPlugin: 触发 beforeToolDispatch 钩子
    LintPlugin-->>Pipeline: 无需前置处理，直接 next()
    Pipeline-->>Loop: 流水线通过，允许执行
    deactivate Pipeline

    Loop->>ToolRunner: 物理执行命令
    ToolRunner-->>Loop: 返回执行成功结果

    Loop->>Pipeline: 物理执行完成，触发 afterToolExecuted
    activate Pipeline
    Pipeline->>LintPlugin: 触发 afterToolExecuted
    activate LintPlugin
    LintPlugin->>LintPlugin: 检查修改文件并运行 eslint --fix
    LintPlugin-->>Pipeline: 伴随修复完成
    deactivate LintPlugin
    Pipeline-->>Loop: 结果载荷已增强，注入下一轮上下文
    deactivate Pipeline
```

### 6.2 核心源码级调用栈 (Source Call Stack)

```
[OpenCodeEngine.executeTurn] (src/core/engine.ts:65)
  │
  ├── [HookPipelineExecutor.executePipeline('beforePromptHydrate')] (src/core/pipeline.ts:40)
  │     └── [MemoryRetrieverPlugin.beforePromptHydrate]
  │
  ├── [ModelGateway.streamChat] (src/gateway/router.ts:88)
  │     └── [HookPipelineExecutor.executePipeline('transformModelPayload')]
  │
  └── [ToolDispatcher.dispatch] (src/tools/dispatcher.ts:110)
        │
        ├── [HookPipelineExecutor.executePipeline('beforeToolDispatch')]
        │     └── [SecurityGuardPlugin.beforeToolDispatch] ── (若违规直接 shortCircuit)
        │
        ├── [ToolDriver.run] (src/tools/drivers/bash.ts:50)
        │
        └── [HookPipelineExecutor.executePipeline('afterToolExecuted')]
              └── [AutoLinterPlugin.afterToolExecuted]
```

---

## 7. 极端异常边界与插件沙箱容错治理

| 异常边界场景 | 物理成因与危害 | Harness 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. 插件异步死锁或无限挂起 (Plugin Lockup)** | 某个第三方插件在 Hook 中发起了不可达的外部网络请求且未设置超时，导致主循环挂起。 | **Hook 超时熔断保护（Hook Timeout Guard）**：<br>为每一个插件 Hook 设置 3000ms 严格超时定时器；若超时直接中断当前插件并记录警报日志，强制自动执行 `next()` 推进，杜绝主进程死锁。 |
| **2. 插件抛出未捕获异常 (Uncaught Exception)** | 插件代码存在空指针（`TypeError: Cannot read property of undefined`），引发进程崩溃。 | **洋葱层 Try-Catch 错误隔离与静默剔除**：<br>执行器严格使用 `try/catch` 包裹每个插件的执行体；若某插件连续抛出 3 次未捕获异常，将其自动加入 `FaultyPlugins` 隔离黑名单，并从本次会话中动态卸载。 |
| **3. 插件非法篡改关键协议字段 (State Poisoning)** | 恶意或残缺插件将 `messages` 数组中的 System Message 彻底删除，导致大模型角色错乱。 | **不可变核心镜像校验（Immutable Deep-Freeze）**：<br>核心系统提示词与关键环境变量以 `Object.freeze()` 深度冻结保护；在进入模型网关前执行 Schema 完整性合法性断言（Assertion Check）。 |
| **4. 插件顺序竞争导致结果不确定 (Hook Ordering Conflict)** | 插件 A 试图修改命令参数，插件 B 试图直接执行命令，执行顺序不同导致行为不可预测。 | **显式插件优先级拓扑排序（Topological Priority Sorting）**：<br>每个插件必须声明 `priority` 权重（例如 `Security: 1000`、`Transform: 500`、`Telemetry: 0`）；执行器在初始化时自动按照优先级从大到小严格排序。 |

---

## 8. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目从单纯的多模型网关向支持高度可扩展的自主 Agent Harness 演进时，微内核与插件化子系统必须落地以下三大设计规范：

### 8.1 架构设计一：落地 `AihPluginRegistry` 微内核事件总线
- **当前现状**：`ai_home` 当前各种增强功能（如权限审批、记忆召回、命令截断）紧耦合在各个核心文件中，违背单一职责原则。
- **重构方案**：
  1. 新建 `lib/plugins/` 目录，提取 `PluginRegistry` 与 `HookPipelineExecutor` 核心调度器；
  2. 将 `SecurityGuard`、`MemoryHydrator`、`OutputTruncator` 全面重构为标准独立的内建插件，实现内核与业务特性的彻底解耦。

### 8.2 架构设计二：支持工作区级 `.aih/plugins/` 本地插件热插拔
- **落地方案**：
  1. 支持在项目根目录创建 `.aih/plugins/*.js` 独立插件脚本；
  2. 启动时动态通过 `import()` 或 `require()` 加载工作区插件，允许企业团队根据自身技术栈（如 Java Maven 依赖检查、Go 格式化）编写定制化 Agent 拦截规则。

### 8.3 架构设计三：引入插件执行健康度与性能遥测看板
- **落地方案**：
  1. 精准度量每个插件在各个 Hook 锚点的执行时间（微秒级记录）；
  2. 在 WebUI 设置页面的“插件生态”面板中直观展示各插件的耗时分布与拦截统计，对卡顿严重的插件提供一键禁用开关。

---

## 9. 本章小结与下章预告

本章全面解构了 OpenCode 工业级的 **插件化微内核架构、双向可变 Hook 拦截流水线、洋葱模型执行器以及插件异常隔离沙箱**，剖析了其如何通过开放生态实现能力的无限扩展，并为 `ai_home` 提供了微内核重构方案。

在下一章 **【03-02 SQLite 实体关系（opencode.db 会话/消息/用量归属模型）】** 中，我们将深入剖析 OpenCode 的持久化数据架构，拆解其如何在单文件数据库中精妙管理多工作区、多会话分支以及跨模型的 Token 用量精确归属。
