# 04-02 长推理 Trajectory 的自我修正、反思与工具交互循环

> **“传统的非推理模型在遇到工具执行报错时，往往只能进行简单的机械式重试或陷入死循环；而长推理模型（如 DeepSeek-R1、o1/o3）通过强化学习内置了‘元认知（Metacognition）与自我反思（Self-Correction）’能力。优秀的 Harness 必须构建一套能够捕获思维轨迹回溯点（Backtracking Point）、提供高信噪比环境反馈并引导假设检验的闭环评估引擎。”**

---

## 1. 章节导读与核心命题

在长程复杂编程任务中，Agent 几乎不可能一次性写出 100% 正确的代码。面对编译报错、测试用例失败、运行时空指针异常等现实挫折：
- **普通大模型的退化模式**：往往会原地重复生成相同的错误代码，或者向用户盲目提问“我遇到了错误，请问怎么做”；
- **推理大模型的自愈模式**：具备在思考链中自我质疑（“等等，我前面的假设前提是否成立？”）、回溯到前一个决策分支（Backtracking）并重新规划第二套甚至第三套解题路径的能力。

然而，大模型的自主反思能力不能脱离物理环境的确定性接地（Grounding）。如果 Harness 仅仅将工具的错误信息原样塞给模型：
1. **错误信息信噪比过低**：几千行的 Java StackTrace 或 Webpack 编译警告会冲垮思考链，导致模型抓不住根本原因；
2. **缺乏结构化假设检验框架（Hypothesis-Testing Framework）**：模型在思维链中提出假设后，缺乏 Harness 主动为其提供微观测试沙箱（如运行单个单元测试断言）；
3. **陷入局部最优震荡（Local Minima Oscillation）**：在两个相互冲突的错误解法之间来回跳跃，消耗巨量算力却无法收敛。

本节将深入解构推理大模型长执行轨迹（Trajectory）的自我修正机理、**Harness 闭环反思评估引擎（Self-Correction Eval Loop）**、回溯点状态快照算法以及高信噪比环境反馈设计。

```
┌────────────────────────────────────────────────────────────────────────────────────────────┐
│                             长推理 Trajectory 自我修正与反思闭环架构                        │
│                                                                                            │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                              ReAct Execution Trajectory                              │  │
│  │  - Step 1: 提出解决假设 (Hypothesis A) ──> 生成代码补丁 Patch A                       │  │
│  │  - Step 2: 驱动物理工具执行测试 (Run Test Runner) ──> 捕获物理报错                     │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                                             ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     Trajectory Eval Engine (轨迹评估与反馈压缩引擎)                  │  │
│  │                                                                                      │  │
│  │  1. 错误签名提炼 (Error Signature Extractor) ──> 剥离噪点，提取关键行与异常类型        │  │
│  │  2. 震荡侦测器 (Oscillation Detector) ─────────> 判定是否陷入重复死循环              │  │
│  │  3. 反思引导注入器 (Reflection Prompt Injector) ─> 注入结构化反思脚手架引导           │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                                             ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     DeepSeek-R1 / o3 内部自反思与回溯思维链展开                       │  │
│  │                                                                                      │  │
│  │   `<think>`                                                                          │  │
│  │   - 观测到测试在 test_jwt_expiry 处报 401，说明之前修改的 exp 容错并没有生效。         │  │
│  │   - 重新审视前置假设：难道不是因为时间戳溢出，而是由于系统的时钟漂移（Clock Skew）？ │  │
│  │   - 回溯决策分支：放弃对 jwt.ts 的修改，转向在 service.ts 中引入 5 秒容差窗口...       │  │
│  │   `</think>`                                                                         │  │
│  └──────────────────────────────────────────┬───────────────────────────────────────────┘  │
│                                             │                                              │
│                                             ▼                                              │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐  │
│  │                        Corrected Action / Patch B (自愈后新动作)                     │  │
│  │  - 生成精准补丁 Patch B ──> 再次触发测试 ──> 测试 100% 通过 (Convergence Reach)       │  │
│  └──────────────────────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 核心专业术语与概念精确释义

| 专业术语 (Terminology) | 中文标准译名 | 底层架构定义与机制说明 |
| :--- | :--- | :--- |
| **Execution Trajectory** | **执行轨迹 / 推理履历** | Agent 在解决任务过程中，按时间顺序产生的全部思考状态（Thoughts）、物理操作（Actions）、环境反馈（Observations）与代码变更构成的有向链条。 |
| **Self-Correction Loop** | **自我修正闭环** | 模型在接收到外部物理工具的负面反馈（如断言失败）后，主动重新审视前置假设、定位逻辑缺陷并生成纠正方案的闭环控制过程。 |
| **Backtracking Point** | **回溯锚点 / 决策分支点** | 轨迹树中的某个特定检查点（Checkpoint）。当当前探索路径被证实死胡同后，Harness 配合模型回退至该锚点并尝试其他潜在分支。 |
| **Error Signature Extraction** | **错误签名高纯度提炼** | 从动辄上千行的编译器/测试框架日志中，利用 AST 与模式匹配精确剔除冗余栈帧，提炼出核心失败原因（Fail Root Cause）与报错位置的技术。 |
| **Oscillation Detection** | **震荡死循环侦测** | 检测模型是否在方案 A（报错 1）与方案 B（报错 2）之间来回反复切换的监控算法。一旦触发，强制介入打破死锁。 |
| **Metacognition** | **元认知能力** | 大模型对自己思维过程的认知与监控能力（即“知道自己不知道什么”、“能够意识到自己刚刚的推导存在漏洞”）。 |
| **Hypothesis-Driven Debugging** | **假设驱动型调试** | 一种科学的排障范式：`观察现象 -> 形式化提出假设 -> 设计微观实验/测试用例验证假设 -> 根据结果确认或推翻假设`。 |

---

## 3. 推理大模型自我反思的底层四步认知模型

与传统大模型的线性执行不同，DeepSeek-R1 / o3 在接入工具环境时，展现了清晰的四步认知回溯状态机：

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              推理模型自我修正四步认知状态机                            │
│                                                                                        │
│  [Step 1: Observation Ingestion (现象感知)]                                             │
│    - 吸收物理工具回传的最新测试结果或命令退出码 (Stdout/Stderr)                         │
│                                                                                        │
│  [Step 2: Discrepancy Analysis (差异与证伪分析)]                                      │
│    - 比对预期结果 (Expected) 与实际结果 (Actual)，识别推导断裂点                        │
│    - 显式思考：“我原本预期返回 200，但实际输出了 500 NullPointerException”               │
│                                                                                        │
│  [Step 3: Root Cause Hypothesis & Backtracking (根因假设与分支回溯)]                    │
│    - 质疑前置假设，回退至上一级决策节点                                               │
│    - 显式思考：“看来原因不是缓存失效，而是数据库连接池用尽。之前的修改方向完全偏了。” │
│                                                                                        │
│  [Step 4: Alternative Strategy Generation (备选策略生成与验证)]                        │
│    - 制定全新的代码修改方案，并设计验证性探针动作                                     │
│    - 输出：全新的 Tool Use (如 Edit 或 Bash)                                           │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Harness 轨迹评估引擎（Trajectory Eval Engine）核心设计

为了给推理模型的思考链提供最高质量的输入，Harness 绝不能做“被动的数据传话筒”，而必须扮演 **“高纯度事实过滤器与引路人”**。

```
                       Raw Tool Execution Failure (15,000 Bytes)
                                         │
                                         ▼
                      [Step 1: 错误签名提炼器 (Error Filter)]
                      - 剔除 node_modules 内部冗余栈帧
                      - 提取业务代码第一现场: src/auth/jwt.ts:42
                      - 提取核心异常: TokenExpiredError: jwt expired
                                         │
                                         ▼
                      [Step 2: 轨迹震荡评估器 (Oscillation Check)]
                      - 计算当前错误签名与最近 3 轮历史的余弦相似度
                      - 若判定为反复震荡 (Oscillation Score > 0.85)
                        └── 注入系统干预断言: "[SYSTEM]: Repeated oscillation detected!"
                                         │
                                         ▼
                      [Step 3: 构造结构化反思反馈帧 (Reflection Frame)]
                      - 包含: 失败断言、最小复现文件、已尝试解法禁区
```

### 4.1 错误签名提炼算法实现范例

```typescript
export interface ExtractedErrorSignature {
  errorType: string;
  errorMessage: string;
  sourceFile?: string;
  sourceLine?: number;
  highlightStack: string[];
}

export function extractHighPurityError(rawStderr: string, workspaceRoot: string): ExtractedErrorSignature {
  const lines = rawStderr.split('\n');
  let errorType = 'RuntimeError';
  let errorMessage = '';
  let sourceFile: string | undefined;
  let sourceLine: number | undefined;
  const highlightStack: string[] = [];

  // 正则匹配标准异常头 (如 TypeError: Cannot read properties of null)
  const errorHeaderMatch = rawStderr.match(/([A-Za-z0-9_]+Error|[A-Za-z0-9_]+Exception):\s*(.+)/);
  if (errorHeaderMatch) {
    errorType = errorHeaderMatch[1];
    errorMessage = errorHeaderMatch[2].trim();
  }

  // 扫描栈帧，优先提取位于当前工作区（非 node_modules / 非标准库）的代码行
  for (const line of lines) {
    if (line.includes(workspaceRoot) && !line.includes('node_modules')) {
      highlightStack.push(line.trim());
      
      if (!sourceFile) {
        // 匹配形如 /workspace/src/app.ts:45:12
        const fileMatch = line.match(/(?:at\s+)?([\/a-zA-Z0-9_\-\.]+\.[a-zA-Z0-9]+):(\d+):(\d+)/);
        if (fileMatch) {
          sourceFile = fileMatch[1];
          sourceLine = parseInt(fileMatch[2], 10);
        }
      }
    }
  }

  return {
    errorType,
    errorMessage: errorMessage || rawStderr.slice(0, 300),
    sourceFile,
    sourceLine,
    highlightStack: highlightStack.slice(0, 5) // 仅保留前 5 行最核心的业务栈帧
  };
}
```

---

## 5. 闭环反思引导（Guided Reflection）协议规范与 Wire Payload

当工具执行失败时，Harness 将提炼后的错误结合历史轨迹，封装为标准化的 `<failure_investigation>` 结构回传给模型：

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "call_bash_test_01",
      "is_error": true,
      "content": "<failure_investigation>\n  <summary>Unit Test Suite Failed: test/auth.spec.ts</summary>\n  <error_signature type=\"AssertionError\">\n    Expected status code 200, but received 401 Unauthorized.\n  </error_signature>\n  <stack_location file=\"src/auth/jwt.ts\" line=\"42\" />\n  <eval_guidance>\n    1. Your previous patch assumed the token expired due to integer overflow. That assumption was refuted.\n    2. Check the clock drift (iat vs nbf) or signature secret mismatch.\n    3. Do NOT repeat the exact patch from Turn 1.\n  </eval_guidance>\n</failure_investigation>"
    }
  ]
}
```

---

## 6. 自反思状态机时序图与核心源码调用栈

### 6.1 自我反思与路径修正时序图 (Self-Correction Sequence)

```mermaid
sequenceDiagram
    autonumber
    participant Loop as Reasoning Agent Loop
    participant Model as DeepSeek-R1 / o3
    participant Runner as Test / Tool Runner
    participant Eval as Trajectory Eval Engine
    participant Git as Git Shadow Workspace

    Loop->>Model: 发起推理 (包含失败排查上下文)
    activate Model
    Model-->>Model: `<think>` 展开深度思考：分析 AssertionError 根因，推翻前置假设 `</think>`
    Model-->>Loop: 产出修正补丁 Patch B (Tool Use: Edit)
    deactivate Model

    Loop->>Git: 在影子工作区应用 Patch B
    Loop->>Runner: 物理执行回归测试 (npm test)
    activate Runner
    Runner-->>Loop: 测试 100% 通过 (ExitCode: 0, 15/15 passed)
    deactivate Runner

    Loop->>Eval: 提交执行结果进行轨迹收敛判定
    Eval->>Eval: 确认错误已被消解，无新引入回归
    Eval-->>Loop: 轨迹收敛 (Convergence Achieved)

    Loop->>Git: 将 Patch B 原子合并入主工作区
    Loop-->>Model: 注入测试通过事实，模型输出最终完成确认
```

### 6.2 核心源码级调用栈 (Source Call Stack)

```
[ReasoningAgentEngine.executeStep] (lib/reasoning/engine.ts:55)
  │
  ├── [ToolRunner.executeWithCapture] (lib/tools/runner.ts:40)
  │
  └── [TrajectoryEvalEngine.evaluateFeedback] (lib/reasoning/evaluator.ts:75)
        │
        ├── [ErrorSignatureExtractor.extractHighPurityError] (lib/reasoning/signature.ts:28)
        │
        ├── [OscillationDetector.computeSimilarity] (lib/reasoning/oscillation.ts:45)
        │     └── (若检测到循环震荡 ──> 注入强制反思系统指令)
        │
        ├── [ReflectionPromptCompiler.compile] (lib/reasoning/compiler.ts:60)
        │     └── 组装 <failure_investigation> XML 结构
        │
        └── [AgentEventLoop.yieldNextTurn] (lib/runtime/agent-event-loop.ts:110)
```

---

## 7. 极端异常边界与死锁突破治理

| 异常边界场景 | 物理成因与危害 | Harness 核心防线与自愈算法 (Self-Healing) |
| :--- | :--- | :--- |
| **1. 乒乓震荡死循环 (A-B-A-B Oscillation)** | 模型在两种互斥的错误解法之间来回切换（改了 A 导致 B 错，改了 B 又导致 A 错），消耗光所有轮次。 | **尝试禁区列表与强制打破（Forbidden Patch History）**：<br>Harness 维护最近 3 轮修改的 AST 补丁哈希表。一旦检测到模型试图再次生成与前序相同的补丁，工具层直接报错拦截：`"[SYSTEM GUARD]: Patch rejected. You already tried this exact approach in Turn N and it caused error X. Explore a totally different approach."`。 |
| **2. 思考链过度自信与幻觉证实 (Confirmation Bias)** | 模型在思考链中深信代码已经完全正确，而将真实的物理测试报错归咎于“测试用例本身写错了”并试图去删除测试用例。 | **测试用例防篡改保护锁（Test Immutability Lock）**：<br>Harness 在修复缺陷任务中，默认将 `*.spec.ts` / `*.test.py` 目录标记为只读受保护区域。若模型试图 `Edit` 测试文件，权限状态机直接弹窗拦截并引导其反思业务代码。 |
| **3. 思考链陷入发散推导无法收敛 (Runaway Thought Divergence)** | 模型在推导中不断引入无关的哲学探讨或过度设计，单轮思考时间超过 2 分钟。 | **分步微观锚定（Step-by-Step Micro-Anchoring）**：<br>通过 System-Reminder 强行注入思考纪律：`"Think concretely in 3 steps: 1. Identify the failing line; 2. Formulate 1 falsifiable hypothesis; 3. Emit the minimal patch."`，强行拉回模型的注意力发散。 |
| **4. 隐藏依赖级联破坏 (Hidden Cascading Breakage)** | 修复了模块 A 的当前测试，但在没有运行的全量测试中破坏了模块 B。 | **全量回归基线比对（Regression Baseline Check）**：<br>在最终交付前，Harness 自动在后台影子工作区运行全量测试套件；若产生次生破坏，立即将回归日志注入反思闭环进行二次修正。 |

---

## 8. 对 ai_home 自主 Harness 研发的落地指导与架构设计

在 `ai_home` 项目落地支持长推理大模型的自主修正与评估引擎时，必须贯彻以下三大架构规范：

### 8.1 架构设计一：构建独立的 `TrajectoryEvalEngine` 轨迹评估中枢
- **当前现状**：`ai_home` 目前直接将底层 Shell 的原始执行输出透传给模型，充斥大量无意义的 ANSI 乱码与外部依赖日志。
- **重构方案**：
  1. 新增 `lib/reasoning/eval-engine.ts`；
  2. 实现 `extractHighPurityError` 算法，在工具报错时自动提炼出高纯度错误签名与第一现场代码行；
  3. 将原始输出与提炼结构解耦，降低模型思考负担。

### 8.2 架构设计二：建立 AST 补丁指纹比对与震荡阻断器
- **落地方案**：
  1. 新建 `lib/reasoning/oscillation-detector.ts`；
  2. 记录会话内每次代码修改的 AST 差异指纹；
  3. 当侦测到模型在连续 3 轮内试图执行“撤销-重做”震荡操作时，自动合成强制反思指令，阻止算力无谓浪费。

### 8.3 架构设计三：引入影子工作区（Shadow Worktree）伴随验证机制
- **落地方案**：
  1. 结合前序的 Git Worktree 隔离能力，当推理模型生成重大修正补丁时，优先在影子工作区分支中运行快速测试验证；
  2. 验证通过后再原子合并至用户主工作区，保证用户前台工作目录永远处于可运行的稳定状态。

---

## 9. 本章小结与下章预告

本章全面解构了长推理大模型的 **自我修正与反思机理、四步认知状态机、Harness 错误签名高纯度提炼算法、震荡死循环阻断以及影子验证工程**，为 `ai_home` 构建具备自主纠偏能力的高阶 Harness 提供了标准规范。

在下一章 **【04-03 极长推理上下文的剪枝策略与 KV Cache 亲和度优化】** 中，我们将深入剖析推理大模型在面临超长思维链与长程轨迹时的上下文膨胀治理，拆解如何通过前缀对齐、思维链修剪与 KV Cache 显存亲和度优化，实现长推理任务的高性能持续演进。
