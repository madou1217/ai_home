# 02-02 Responses API 协议契约、流式解包与工具调用桥接

> **“从传统的 `/v1/chat/completions` 演进至新一代 `/v1/responses`，标志着大模型通信协议从单纯的‘文本消息补全’向‘原生状态机事件驱动、内置工具执行器与会话状态服务端托管’的根本性范式跃迁。”**

---

## 1. 章节导读与核心命题

多年来，OpenAI 的 `/v1/chat/completions` API 一直是生成式 AI 应用的行业事实标准。然而，当开发者试图基于该接口构建生产级编程 Agent（Coding Agent）时，其原始设计的局限性暴露无遗：
1. **工具调用的多层封包开销（Tool Call Framing Overhead）**：模型在流式输出工具参数时，需要反复解析复杂的 `delta.tool_calls[i]` 分片，客户端必须在内存中手动维护多索引参数累加器；
2. **缺乏原生状态机感知**：服务端不维护会话状态，客户端每轮迭代必须将全部历史消息重新序列化上传，导致网络带宽浪费与客户端状态失步；
3. **思考过程与正文输出混杂**：在 o1/o3/gpt-5 系列推理模型出现后，原有的 `content` 字段无法优雅解耦推理思维链与用户正文。

为了彻底解决这些痛点，OpenAI 推出了专门为现代 Agent Harness 设计的 **新一代 Responses API (`POST /v1/responses`)**。在 Codex CLI / App Server 体系中，Responses API 是其最核心的底层通信支柱。

本节将深入解构：
1. **Responses API 与传统 Chat Completions 的本质设计差异与协议契约**；
2. **Server-Sent Events (SSE) 事件流分片协议与状态机事件解包**；
3. **多工具调用（Tool Calls）的极速流式桥接、参数校验与本地物理执行流水线**；
4. **对 `ai_home` 多协议网关与适配层研发的落地指导**。

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                             OpenAI Responses API 流式管道拓扑                               │
│                                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              Client Request (POST /v1/responses)                     │  │
│  │  - conversation_id / previous_response_id (服务端会话状态延续)                        │  │
│  │  - tools: [ { type: "function", function: { ... } }, { type: "computer" } ]          │  │
│  │  - input: "修复单元测试并运行"                                                         │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                                             ▼ (HTTP/2 SSE Event Stream)                    │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                         Responses Wire Protocol Event Stream                         │  │
│  │                                                                                      │  │
│  │   1. event: response.created ───────────────> (初始化响应元数据与 ID)                │  │
│  │   2. event: response.output_item.added ─────> (新增输出项: Message / Function Call)  │  │
│  │   3. event: response.reasoning.delta ───────> (流式思考过程: 思维链展开)             │  │
│  │   4. event: response.text.delta ────────────> (流式正文输出: 渲染到终端/UI)          │  │
│  │   5. event: response.function_call_arguments.delta ─> (工具参数流式累加器)           │  │
│  │   6. event: response.output_item.done ──────> (单项输出闭环校验)                     │  │
│  │   7. event: response.completed ─────────────> (响应生命周期终态，Token 用量结算)     │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                                             ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     ResponsesStreamParser (流式协议解包与工具桥接器)                 │  │
│  │                                                                                      │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────┐  ┌──────────────────────┐  │  │
│  │  │   Thinking Channel      │  │      Text Channel       │  │ Tool Bridge Dispatch │  │  │
│  │  │ (Reasoning Chunk Buffer)│  │ (UI Text Chunk Emitter) │  │(Schema Validate & Run│  │  │
│  │  └─────────────────────────┘  └─────────────────────────┘  └──────────┬───────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┼──────────────┘  │
│                                                                          │                 │
│                                                                          ▼                 │
│                                                      ┌───────────────────────────────────┐ │
│                                                      │ Physical Tool Execution (Bash/FS) │ │
│                                                      └───────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Responses API** | **新一代响应交互协议** | OpenAI 推出的以 Agent 为中心的一体化通信 API。支持服务端托管状态、多模态输入输出解耦、原生工具生命周期管理与结构化推理流。 |
| **Chat Completions API** | **传统聊天补全协议** | OpenAI 早期推出的经典无状态 API（`POST /v1/chat/completions`）。客户端必须每轮上送全量 `messages` 数组，工具调用解析逻辑繁重。 |
| **Output Item** | **输出项实体** | Responses API 中的基本产物单元。单次响应可并发或顺序生成多个 Item，包含 `message`（文本回复）、`function_call`（函数调用）、`reasoning`（推理思考）等具体类型。 |
| **Reasoning Stream** | **推理思考流** | 推理模型在生成可执行决策或答案前产生的思维链数据流（在 Responses 协议中表现为 `response.reasoning.delta` 事件）。 |
| **Tool Call Bridging** | **工具调用桥接** | 将模型在 SSE 流中吐出的 `function_call` 参数分片实时拼接、完成 JSON Schema 强校验，并无缝分发给本地物理驱动执行的中间件层。 |
| **Stateful Server Continuity** | **服务端状态延续** | 通过在请求中传递 `previous_response_id`，直接由服务端恢复上一轮上下文与 KV Cache，无需客户端每次上送几万 Token 的历史。 |
| **SSE (Server-Sent Events)** | **服务端发送事件** | 一种基于标准 HTTP 的轻量级单向长连接流式传输协议。每一帧包含 `event:` 类型、`data:` JSON 载荷与 `\n\n` 结束符。 |

---

## 3. Responses API vs Chat Completions API 核心架构差异对比

| 架构对比维度 | 传统 Chat Completions API (`/v1/chat/completions`) | 新一代 Responses API (`/v1/responses`) |
| :--- | :--- | :--- |
| **会话状态存储模型** | **完全无状态（Client-side State）**<br>客户端每次必须全量上传数百 KB 的 `messages` 历史。 | **服务端状态托管（Server-managed State）**<br>支持传递 `previous_response_id` 或 `conversation_id` 自动延续状态。 |
| **数据流分帧粒度** | 粗粒度的 `choices[0].delta` 混合结构。 | **强类型语义事件流**<br>明确区分为 `text.delta`、`reasoning.delta`、`function_call.delta`。 |
| **工具调用解析复杂度** | **极高**：需手动管理 `index`，拼接多个可能交织出现的 `tool_calls`。 | **极简**：每个工具调用是一个独立的 `output_item`，有明确的 `added` 与 `done` 生命周期。 |
| **内置原生能力** | 纯模型文本生成，无法调用服务端预置能力。 | 支持原生服务端内置工具（如 Web 检索、代码解释器、文件搜索）。 |
| **Token 传输与开销** | 每次迭代重复传输巨量 Prompt，网络带宽与延迟敏感。 | 仅传输最新增量，Prompt Cache 亲和度极高，网络开销下降 90%。 |

---

## 4. Responses Wire Protocol 完整事件流时序与 Payload 规范

<div id="widget-responses-container"></div>



在一次典型的 Coding Agent 交互中（模型先进行推理思考，然后吐出一句解释，接着调用 Bash 工具），Responses API 的 SSE 原始数据帧流转如下：

```
                              HTTP/2 POST /v1/responses
                                          │
    ┌─────────────────────────────────────┴─────────────────────────────────────┐
    ▼                                                                           ▼
[Step 1: 响应生命周期初始化]                                              [Step 2: 思考流展开]
event: response.created                                                event: response.output_item.added (type: "reasoning")
data: {"id":"resp_001","status":"in_progress"}                         event: response.reasoning.delta {"delta":"正在分析测试脚本..."}
                                                                       event: response.output_item.done
                                                                                │
    ┌───────────────────────────────────────────────────────────────────────────┘
    ▼
[Step 3: 正文回复流渲染]
event: response.output_item.added (type: "message")
event: response.text.delta {"delta":"我将执行 npm test 验证当前模块"}
event: response.output_item.done
    │
    ▼
[Step 4: 工具调用分片累加与闭环]
event: response.output_item.added (type: "function_call", "call_id":"call_101", "name":"bash")
event: response.function_call_arguments.delta {"call_id":"call_101", "delta":"{\"command\":"}
event: response.function_call_arguments.delta {"call_id":"call_101", "delta":"\"npm test\"}"}
event: response.output_item.done (type: "function_call", "call_id":"call_101")
    │
    ▼
[Step 5: 响应全量完成与用量结算]
event: response.completed
data: {"id":"resp_001","status":"completed","usage":{"input_tokens":1200,"output_tokens":180}}
```

### 4.1 核心 SSE 协议帧 JSON 结构详解

#### (1) 工具调用开始帧 (`response.output_item.added`)
```json
{
  "type": "response.output_item.added",
  "response_id": "resp_01j7xyz990",
  "output_index": 2,
  "item": {
    "id": "item_func_001",
    "type": "function_call",
    "call_id": "call_bash_8821",
    "name": "bash",
    "status": "in_progress"
  }
}
```

#### (2) 工具参数增量流式分片 (`response.function_call_arguments.delta`)
```json
{
  "type": "response.function_call_arguments.delta",
  "response_id": "resp_01j7xyz990",
  "item_id": "item_func_001",
  "call_id": "call_bash_8821",
  "output_index": 2,
  "delta": "{\"command\": \"git diff --stat\"}"
}
```

#### (3) 工具调用闭环完成帧 (`response.output_item.done`)
```json
{
  "type": "response.output_item.done",
  "response_id": "resp_01j7xyz990",
  "output_index": 2,
  "item": {
    "id": "item_func_001",
    "type": "function_call",
    "call_id": "call_bash_8821",
    "name": "bash",
    "arguments": "{\"command\": \"git diff --stat\"}",
    "status": "completed"
  }
}
```

---

## 5. 流式协议解包与工具调用桥接器实现

为了将 Responses API 的流式事件高效桥接给本地物理工具系统，Harness 需要实现一个基于状态机的高性能解包器 `ResponsesStreamParser`。

### 5.1 TypeScript 完整解包与分流器实现

```typescript
import { EventEmitter } from 'events';

export interface ReasoningDeltaEvent {
  responseId: string;
  delta: string;
}

export interface TextDeltaEvent {
  responseId: string;
  delta: string;
}

export interface FunctionCallCompleteEvent {
  responseId: string;
  callId: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ResponseCompletedEvent {
  responseId: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
}

export class ResponsesStreamParser extends EventEmitter {
  private activeItems: Map<string, { type: string; callId?: string; name?: string; argsBuffer: string }> = new Map();

  /**
   * 消费单帧 SSE 消息并分流处理
   */
  public feedSseFrame(eventType: string, dataJson: string): void {
    if (!dataJson || dataJson.trim() === '[DONE]') return;
    
    let payload: any;
    try {
      payload = JSON.parse(dataJson);
    } catch (e) {
      this.emit('error', new Error(`Failed to parse SSE JSON payload: ${dataJson}`));
      return;
    }

    switch (eventType) {
      case 'response.created':
        this.emit('created', { responseId: payload.id });
        break;

      case 'response.output_item.added':
        this.activeItems.set(payload.item.id, {
          type: payload.item.type,
          callId: payload.item.call_id,
          name: payload.item.name,
          argsBuffer: ''
        });
        break;

      case 'response.reasoning.delta':
        this.emit('reasoning', {
          responseId: payload.response_id,
          delta: payload.delta
        } as ReasoningDeltaEvent);
        break;

      case 'response.text.delta':
        this.emit('text', {
          responseId: payload.response_id,
          delta: payload.delta
        } as TextDeltaEvent);
        break;

      case 'response.function_call_arguments.delta': {
        const item = this.activeItems.get(payload.item_id);
        if (item) {
          item.argsBuffer += payload.delta;
          this.emit('function_call_progress', {
            callId: payload.call_id,
            currentLength: item.argsBuffer.length
          });
        }
        break;
      }

      case 'response.output_item.done': {
        const item = this.activeItems.get(payload.item.id);
        if (item && item.type === 'function_call') {
          let parsedArgs = {};
          try {
            parsedArgs = JSON.parse(item.argsBuffer || payload.item.arguments || '{}');
          } catch (err) {
            this.emit('error', new Error(`Malformed JSON in function call [${item.name}]: ${item.argsBuffer}`));
          }

          this.emit('function_call_complete', {
            responseId: payload.response_id,
            callId: item.callId || payload.item.call_id,
            name: item.name || payload.item.name,
            arguments: parsedArgs
          } as FunctionCallCompleteEvent);
        }
        this.activeItems.delete(payload.item.id);
        break;
      }

      case 'response.completed':
        this.emit('completed', {
          responseId: payload.id,
          usage: {
            inputTokens: payload.usage?.input_tokens || 0,
            outputTokens: payload.usage?.output_tokens || 0
          }
        } as ResponseCompletedEvent);
        break;
    }
  }
}
```

---

## 6. 工具桥接与状态机交互时序图与核心调用栈

### 6.1 Responses API 工具桥接完整交互时序图

```mermaid
sequenceDiagram
    autonumber
    participant Loop as Codex Event Loop
    participant Client as Responses API Client
    participant Parser as ResponsesStreamParser
    participant Bridge as Tool Execution Bridge
    participant OS as Physical OS / PTY

    Loop->>Client: 发起 POST /v1/responses (previous_response_id: "resp_001")
    activate Client
    
    loop SSE Stream Events
        Client-->>Parser: event: response.reasoning.delta
        Parser-->>Loop: emit('reasoning') -> 终端渲染思考过程
        
        Client-->>Parser: event: response.text.delta
        Parser-->>Loop: emit('text') -> 终端输出正文
        
        Client-->>Parser: event: response.function_call_arguments.delta
        Parser->>Parser: 累加参数缓冲区 (argsBuffer += delta)
        
        Client-->>Parser: event: response.output_item.done (function_call)
        Parser->>Parser: JSON.parse(argsBuffer) 校验结构
        Parser-->>Bridge: emit('function_call_complete', { callId, name, args })
    end

    Client-->>Parser: event: response.completed
    deactivate Client

    Bridge->>OS: 物理执行命令 (如 Bash: git diff)
    OS-->>Bridge: 捕获 Stdout/Stderr 与 ExitCode
    
    Bridge-->>Loop: 组装 tool_result 载荷
    Loop->>Client: 发起下一轮 POST /v1/responses (带 tool_result 与 previous_response_id)
```

### 6.2 核心源码级调用栈 (Source Call Stack)

```
[CodexTurnManager.executeTurn] (src/engine/turn_manager.rs:45)
  │
  ├── [ResponsesClient.streamResponse] (src/client/responses.rs:80)
  │     ├── [ReqwestHttpClient.postStream] (src/http/client.rs:32)
  │     └── [SseEventReader.next_frame] (src/http/sse.rs:55)
  │
  └── [ResponsesStreamParser.onFrame] (src/parser/responses_parser.rs:90)
        │
        ├── emit("reasoning", delta) ──> [UiRenderer.renderThinking]
        ├── emit("text", delta) ───────> [UiRenderer.renderText]
        │
        └── emit("function_call_complete", call) ──> [ToolExecutionBridge.dispatch] (src/tools/bridge.rs:60)
              ├── [SchemaValidator.assertValid] (src/tools/validator.rs:25)
              ├── [PtyRunner.runCommand] (src/pty/runner.rs:77)
              └── [NextTurnContext.attachToolResult] (src/engine/context.rs:115)
```

---

## 7. 极端异常边界与容错流控防御

| 异常边界场景 | 物理成因与危害 | Harness 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. SSE 流半途被网络 RST 掐断 (Mid-stream Drop)** | HTTP/2 连接在传输大型工具参数的中途突发断开，导致参数 JSON 残缺不闭合。 | **基于 Checkpoint 的状态续连（Stream Resumption）**：<br>1. Harness 捕获 `ECONNRESET` 或异常 EOF；<br>2. 提取当前已成功接收的最新 `item_id` 与 `response_id`；<br>3. 携带 `resume_from_item_id` 向服务端发起重试请求，拉取未完成的尾部流。 |
| **2. 并发多个工具参数交错混淆 (Interleaved Tool Args)** | 模型同时并发调用多个工具，SSE 事件帧交替下发导致参数混淆。 | **基于 `item_id` 与 `call_id` 的双重哈希隔离槽**：<br>`ResponsesStreamParser` 绝不使用单一全局 buffer，而是为每一个 `output_item.added` 动态分配独立的 `Map<itemId, StringBuffer>`，按 `item_id` 严格隔离累加。 |
| **3. 服务端状态过期失效 (State Expiration / 404)** | 传递 `previous_response_id` 时，服务端缓存已过期被清理（返回 HTTP 404/410）。 | **无感知自动回退全量水合（Fallback to Full Hydration）**：<br>当捕获 `response_not_found` 错误时，客户端立即将本地 SQLite/JSONL 中保存的完整历史记录打包为传统的全量 Prompt，发起冷启动降级请求，对用户完全透明。 |
| **4. 参数 JSON Schema 幻觉损坏 (Malformed Tool JSON)** | 模型在高负荷推理下输出截断的 JSON 格式（如末尾缺失闭合引号）。 | **本地 JSON 启发式自愈与显式错误反馈**：<br>优先调用 `jsonrepair` 进行自动修复；若修复依然失败，直接封装标准错误帧 `tool_error: "Invalid JSON arguments generated"` 回传给模型，触发下一轮重试。 |

---

## 8. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目演进为支持多 Provider 统一接入网关与自主 Agent 运行时的过程中，针对 Responses API 的协议适配必须落实以下三大架构规范：

### 8.1 架构设计一：构建 `ResponsesWireAdapter` 协议双向转换桥
- **当前现状**：`ai_home` 内部主要以 Anthropic Messages 协议与 OpenAI Chat Completions 协议为主。
- **重构方案**：
  1. 新建 `lib/models/adapters/responses-wire-adapter.ts`；
  2. 实现 `Responses API <-> Anthropic Messages` 与 `Responses API <-> OpenAI Chat Completions` 的双向透明降级与转换；
  3. 使前端统一消费归一化的事件流（Thinking / Text / ToolCall），屏蔽底层上游协议差异。

### 8.2 架构设计二：落地服务端会话状态延续缓存池
- **落地方案**：
  1. 在网关层维护 `SessionResponseMapping`，记录每个 `sessionId` 对应的最新 `response_id`；
  2. 当对接原生 OpenAI 模型时，默认启用 `previous_response_id` 模式，将单轮请求的传输 Payload 从上百 KB 压缩至 1KB 以内，大幅削减网络延迟。

### 8.3 架构设计三：实现非阻塞流式工具调度分发器（Streaming Tool Bridge）
- **落地方案**：
  1. 将 `ResponsesStreamParser` 深度集成至 `lib/runtime/`；
  2. 一旦捕获到 `function_call` 完成帧，无需等待整个 HTTP 响应结束，立即进入异步并行权限评估与工具执行准备，实现工具执行与模型流式结束的无缝重叠与零等待调度。

---

## 9. 本章小结与下章预告

本章全面解构了 OpenAI 新一代 **Responses API (`/v1/responses`)** 的底层协议契约、SSE 语义分帧事件流、TypeScript 流式解包与工具调用桥接器实现，并提供了异常自愈机制与 `ai_home` 适配层的架构方案。

在下一章 **【02-03 线程持久化、JSONL 事件追溯与会话断点续传（Resume）】** 中，我们将深入剖析 Codex 的存储引擎内核，拆解其如何通过 SQLite 实体关系映射与 JSONL 事务日志，实现大型 Agent 任务的确定性重放与无缝断点续传。
