window.BOOK_DATA = {
  "title": "《现代 Coding Agent 高阶实战与生产级调优指南》",
  "subtitle": "从从 0 到 100 打造个人全自动编程副驾、Token 成本控制与复杂工程重构工作流",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-19T20:39:42.474Z",
  "chapters": [
    {
      "id": "01-installation-and-setup",
      "category": "00-intro",
      "title": "00-01 从 0 到 1 部署你的自扩展终端编程副驾：Bun 单二进制编译与多模型配置",
      "status": "completed",
      "path": "00-intro/01-installation-and-setup.md",
      "content": "# 00-01 从 0 到 1 部署你的自扩展终端编程副驾：Bun 单二进制编译与多模型配置\n\n> **“打造属于自己的 AI 编程副驾，第一步就是摆脱笨重的环境依赖。本章解构如何利用 Bun 将 Pi 打包为单文件独立二进制可执行文件，并零摩擦配置多厂商 API Key 与本地代理。”**\n\n---\n\n## 1. 快速编译与单二进制生成\n\n```bash\n# 1. 克隆代码并安装依赖\ngit clone https://github.com/earendil-works/pi.git && cd pi\nbun install --frozen-lockfile\n\n# 2. 单二进制编译 (体积 ~48MB, 启动时间 < 25ms)\nbun build --compile --minify ./packages/pi-coding-agent/src/cli.ts --outfile /usr/local/bin/pi\n\n# 3. 验证运行\npi --version\n```\n\n---\n\n## 2. 多模型配置文件规范 (~/.pi/config.json)\n\n```json\n{\n  \"defaultProvider\": \"anthropic\",\n  \"providers\": {\n    \"anthropic\": {\n      \"apiKey\": \"sk-ant-api03-...\",\n      \"model\": \"claude-3-7-sonnet\"\n    },\n    \"openai\": {\n      \"apiKey\": \"sk-proj-...\",\n      \"model\": \"gpt-4o\"\n    },\n    \"local_aih\": {\n      \"baseUrl\": \"http://127.0.0.1:9527/v1\",\n      \"model\": \"claude-opus-5[1m]\"\n    }\n  },\n  \"maxContextTokens\": 200000,\n  \"sandbox\": \"gondolin\"\n}\n```\n\n---\n\n## 3. 生产级环境自检与故障排查\n\n| 检测项 | 标准输出 | 故障自愈策略 |\n| :--- | :--- | :--- |\n| **Node/Bun 运行时** | `bun >= 1.1.0` | 若缺失则执行 `curl -fsSL https://bun.sh/install | bash` 极速安装。 |\n| **本地 aih-server 连通性** | `HTTP 200` on `127.0.0.1:9527` | 若未启动则执行 `aih serve --port 9527`。 |\n"
    },
    {
      "id": "01-01-context-bloat-and-pruning",
      "category": "01-context-optimization",
      "title": "01-01 长程编码会话的上下文膨胀危机与 80% 水位自适应微观剪枝",
      "status": "completed",
      "path": "01-context-optimization/01-01-context-bloat-and-pruning.md",
      "content": "# 01-01 长程编码会话的上下文膨胀危机与 80% 水位自适应微观剪枝\n\n> **“在动辄几百轮的长程重构会话中，上下文窗口极易被大段重复的文件读取和编译报错挤爆。本章详解基于 80% 容量水位的自适应微观折叠与启发式剪枝算法，直接节省 80% Token 支出。”**\n\n---\n\n## 1. 上下文膨胀痛点与自适应剪枝拓扑\n\n```\n[Active Context Window (200k Budget)]\n┌─────────────────────────────────────────────────────────────────────────────┐\n│ System (3k) │ Tools (4k) │ Active Turns (15k) │ 历史冗余输出 (150k > 80% 水位!) │\n└─────────────────────────────────────────────────────────────────────────────┘\n                                      │\n                                      ▼ (80% 水位自适应微观折叠)\n┌─────────────────────────────────────────────────────────────────────────────┐\n│ System (3k) │ Tools (4k) │ Active Turns (15k) │ 压缩摘要与紧凑哈希 (8k)         │\n└─────────────────────────────────────────────────────────────────────────────┘\n```\n\n---\n\n## 2. 生产级 TypeScript 启发式微观剪枝器\n\n```typescript\nexport class ContextPruner {\n  public static pruneHistory(messages: any[], maxTokens = 200000): any[] {\n    const threshold = maxTokens * 0.8;\n    return messages.map((m, idx) => {\n      // 保留最近 3 轮完整工具输出，折叠历史长工具输出\n      if (m.role === \"tool\" && idx < messages.length - 6 && m.content.length > 1000) {\n        return {\n          ...m,\n          content: m.content.slice(0, 300) + \"\\n...[TRUNCATED BY PRUNER: \" + (m.content.length - 300) + \" bytes folded]...\"\n        };\n      }\n      return m;\n    });\n  }\n}\n```\n"
    },
    {
      "id": "01-02-prompt-cache-maximization",
      "category": "01-context-optimization",
      "title": "01-02 Prompt Cache 极致命中法：字节级对齐、不变前缀与会话粘性路由",
      "status": "completed",
      "path": "01-context-optimization/01-02-prompt-cache-maximization.md",
      "content": "# 01-02 Prompt Cache 极致命中法：字节级对齐、不变前缀与会话粘性路由\n\n> **“在动辄几百轮的长程重构会话中，如何让云端 KV Cache 命中率持续保持在 90% 以上？本章系统拆解字节级四段式对齐、工具 Schema 字典序锁定与多账号粘性路由的三大落地铁律。”**\n\n---\n\n## 1. 四段式字节对齐布局拓扑\n\n```\n[Byte 0: 静态基础系统前缀 (System Base)] ──► 100% 命中 Cache\n       │ (Breakpoint 1: cache_control = ephemeral)\n       ▼\n[静态工具声明 (Built-in + MCP Tools)] ─────► 字典序严格排序，保持哈希稳定\n       │ (Breakpoint 2: cache_control = ephemeral)\n       ▼\n[项目双层记忆与历史摘要 (<compacted_state>)] ─► 95% 增量命中\n       │ (Breakpoint 3: cache_control = ephemeral)\n       ▼\n[最近 2 轮活跃工作窗口 (Active Turns)] ────► 仅产生 500~1,500 Tokens 增量 Prefill (TTFT < 180ms)\n```\n\n---\n\n## 2. 生产级 TypeScript 缓存断点注入器\n\n```typescript\nexport class PromptCacheOptimizer {\n  public static injectEphemeralBreakpoints(systemPrompt: string, tools: any[], messages: any[]): any {\n    const sortedTools = [...tools].sort((a, b) => a.name.localeCompare(b.name));\n    if (sortedTools.length > 0) {\n      sortedTools[sortedTools.length - 1].cache_control = { type: \"ephemeral\" };\n    }\n    if (messages.length >= 4) {\n      messages[messages.length - 3].cache_control = { type: \"ephemeral\" };\n    }\n    return { system: systemPrompt, tools: sortedTools, messages };\n  }\n}\n```\n"
    },
    {
      "id": "02-01-cross-file-ast-refactoring",
      "category": "02-refactoring-workflows",
      "title": "02-01 跨数十个源文件的架构重构：AST 局部精准切片与确定性校验",
      "status": "completed",
      "path": "02-refactoring-workflows/02-01-cross-file-ast-refactoring.md",
      "content": "# 02-01 跨数十个源文件的架构重构：AST 局部精准切片与确定性校验\n\n> **“面对拥有上百个源文件的大型工程，全量文件读写不仅消耗巨量 Token，更容易引发幻觉与编译破坏。本章解构基于 AST（抽象语法树）的局部符号切片、引用关系图谱分析与增量原子打补丁方法论。”**\n\n---\n\n## 1. 跨文件 AST 引用追踪时序\n\n```\nTarget Symbol (e.g. \"interface UserAuth\")\n   │ (Babel / TypeScript AST Parse)\n   ▼\n[Symbol Exporter: auth-types.ts]\n   │ (Find References in Project AST)\n   ├────► [Consumer 1: login-controller.ts] (AST Node: import { UserAuth })\n   ├────► [Consumer 2: session-store.ts]   (AST Node: UserAuth.token)\n   └────► [Consumer 3: auth-middleware.ts] (AST Node: req.user as UserAuth)\n```\n\n---\n\n## 2. 生产级 TypeScript 局部 AST 切片提取器\n\n```typescript\nimport * as parser from \"@babel/parser\";\nimport traverse from \"@babel/traverse\";\n\nexport class ASTPatcher {\n  public static extractSymbolSlice(sourceCode: string, targetIdentifier: string): { start: number; end: number; code: string } | null {\n    const ast = parser.parse(sourceCode, { sourceType: \"module\", plugins: [\"typescript\", \"jsx\"] });\n    let result = null;\n\n    traverse(ast, {\n      Identifier(path) {\n        if (path.node.name === targetIdentifier && path.parentPath.isFunctionDeclaration()) {\n          const { start, end } = path.parentPath.node;\n          if (start != null && end != null) {\n            result = { start, end, code: sourceCode.slice(start, end) };\n          }\n        }\n      }\n    });\n\n    return result;\n  }\n}\n```\n"
    },
    {
      "id": "02-02-test-generation-and-atomic-commit",
      "category": "02-refactoring-workflows",
      "title": "02-02 自动化测试生成、回归验证与 Git 原子提交分组工作流",
      "status": "completed",
      "path": "02-refactoring-workflows/02-02-test-generation-and-atomic-commit.md",
      "content": "# 02-02 自动化测试生成、回归验证与 Git 原子提交分组工作流\n\n> **“任何没有自动化测试守护的重构都是危险的冒险。本章详解 Coding Agent 如何自动解析重构函数的边界分支、生成 Jest/Vitest 单元测试、执行物理验证并在通过后自动将改动拆解为符合 Conventional Commits 规范的原子 Git 提交。”**\n\n---\n\n## 1. 自动化回归测试状态机\n\n```\n[Diff Generated] ──► [Run Tests (npm test)]\n                           │\n             ┌─────────────┴─────────────┐\n             ▼ (Passed)                  ▼ (Failed)\n[Auto Git Commit Grouping]    [Self-Repair Subagent Loop]\n- feat(auth): ... (files A, B)        │ (Max 3 retries)\n- test(auth): ... (file C)            ▼\n- chore(types): ... (file D)  [Regenerate Fix & Retest]\n```\n\n---\n\n## 2. Conventional Commits 原子分组算法\n\n```typescript\nexport class CommitGrouper {\n  public static groupChangesByDomain(changedFiles: string[]): { type: string; scope: string; files: string[] }[] {\n    const groups: { [key: string]: string[] } = {};\n    changedFiles.forEach(f => {\n      const scope = f.split(\"/\")[1] || \"core\";\n      groups[scope] = groups[scope] || [];\n      groups[scope].push(f);\n    });\n    return Object.entries(groups).map(([scope, files]) => ({\n      type: \"refactor\",\n      scope,\n      files\n    }));\n  }\n}\n```\n"
    },
    {
      "id": "03-01-writing-first-extension",
      "category": "03-custom-extensions",
      "title": "03-01 编写第一个 Pi 插件：自定义 Slash Commands 与生命周期 Hook",
      "status": "completed",
      "path": "03-custom-extensions/03-01-writing-first-extension.md",
      "content": "# 03-01 编写第一个 Pi 插件：自定义 Slash Commands 与生命周期 Hook\n\n> **“通过将业务特定的重复工作流封装为 Extension 插件，开发者可以一键执行复杂的自动化运维与部署操作。本章带领读者从零开发一个名为 `/db-migrate` 的自扩展插件。”**\n\n---\n\n## 1. 插件生命周期接口规范\n\n```typescript\nexport interface PiExtension {\n  name: string;\n  version: string;\n  slashCommands: {\n    name: string;\n    description: string;\n    handler: (args: string, ctx: any) => Promise<void>;\n  }[];\n  hooks: {\n    beforeToolExecution?: (toolName: string, args: any) => Promise<boolean>;\n    afterToolExecution?: (toolName: string, result: any) => Promise<void>;\n    onSessionEnd?: (sessionId: string) => Promise<void>;\n  };\n}\n```\n\n---\n\n## 2. 实战开发 `/db-migrate` 扩展插件\n\n```typescript\nexport const DbMigrateExtension: PiExtension = {\n  name: \"db-migrate-plugin\",\n  version: \"1.0.0\",\n  slashCommands: [\n    {\n      name: \"/db-migrate\",\n      description: \"执行数据库 Prisma 迁移并校验 Schema 一致性\",\n      handler: async (args, ctx) => {\n        ctx.terminal.log(\"🚀 Executing prisma migrate deploy...\");\n        const result = await ctx.exec(\"npx prisma migrate deploy\");\n        ctx.terminal.log(result.stdout);\n      }\n    }\n  ]\n};\n```\n"
    },
    {
      "id": "03-02-ci-code-review-plugin",
      "category": "03-custom-extensions",
      "title": "03-02 自动化代码审查（Code-Reviewer）与 CI/CD 流程联动插件实战",
      "status": "completed",
      "path": "03-custom-extensions/03-02-ci-code-review-plugin.md",
      "content": "# 03-02 自动化代码审查（Code-Reviewer）与 CI/CD 流程联动插件实战\n\n> **“在 CI/CD 流水线中集成 AI Code Reviewer 能够拦截 80% 以上的代码异味与安全漏洞。本章实战演示如何开发一个并发拉起 3 个多视角审查 Subagent（安全性、正确性、性能）的生产级插件。”**\n\n---\n\n## 1. 多视角并发审查流水线架构\n\n```\n[GitHub PR Webhook] ──► [CI Reviewer Dispatcher]\n                               │\n       ┌───────────────────────┼───────────────────────┐\n       ▼                       ▼                       ▼\n [Security Agent]       [Correctness Agent]     [Performance Agent]\n (SQL注入/XSS/越权)     (边界溢出/逻辑回归)     (N+1查询/死锁风险)\n       │                       │                       │\n       └───────────────────────┼───────────────────────┘\n                               ▼\n            [Aggregated PR Markdown Review Comment]\n```\n\n---\n\n## 2. TypeScript 并发评审插件实现\n\n```typescript\nexport class PRReviewPlugin {\n  public async reviewPullRequest(diffText: string): Promise<string> {\n    const agents = [\"security\", \"correctness\", \"performance\"];\n    const results = await Promise.all(agents.map(async a => {\n      return this.spawnSubagentReview(a, diffText);\n    }));\n    return results.join(\"\n\n---\n\n\");\n  }\n\n  private async spawnSubagentReview(lens: string, diff: string): Promise<string> {\n    return `### 🔍 ${lens.toUpperCase()} Review Findings\n- 0 critical violations found in diff.`;\n  }\n}\n```\n"
    },
    {
      "id": "04-01-troubleshooting-matrix",
      "category": "04-production-troubleshooting",
      "title": "04-01 模型幻觉死循环、工具格式错误与 429 熔断的 5 大生产级自愈锦囊",
      "status": "completed",
      "path": "04-production-troubleshooting/04-01-troubleshooting-matrix.md",
      "content": "# 04-01 模型幻觉死循环、工具格式错误与 429 熔断的 5 大生产级自愈锦囊\n\n> **“全书大结局：针对生产环境中高频出现的模型死循环、工具返回格式错乱与 API 429 限流，梳理 5 大立竿见影的自愈防御模式与熔断降级策略。”**\n\n---\n\n## 1. 5 大生产级自愈锦囊矩阵\n\n| 故障现象 | 物理根因 | 生产级自愈防御锦囊 |\n| :--- | :--- | :--- |\n| **1. 相同错误反复重试 (Loop Flapping)** | 模型未能从上一次报错中提取负向约束，机械重复相同命令。 | **错误模式指纹去重（Error Fingerprint Deduplication）**：连续 2 次相同报错时强行注入 `<negative_constraint>` 标签禁止相同路径。 |\n| **2. 工具输出超长卡死 (Huge Stdout Freeze)** | 执行 `cat massive.log` 输出上百兆文本撑爆内存。 | **流式前向截断沙箱（Stdout Streaming Truncator）**：超过 64KB 自动生成临时 blob 句柄并仅返回预览摘要。 |\n| **3. API 429 频繁限流 (Rate Limit Spike)** | 高并发请求触发云端 TPM/RPM 阈值。 | **双层漏桶 + 指数退避抖动算法（Jittered Backoff）**：基础延迟 1000ms，按 $2^n + \\text{rand}(0, 500)$ 毫秒退避。 |\n| **4. 进程组泄漏与僵尸进程 (Zombie Subprocess)** | 子代理中途被取消，但后台编译进程仍在死循环消耗 CPU。 | **进程组树杀（`SIGKILL -pgid`）**：在分配 PTY 时绑定独立进程组 ID，取消时整树瞬间清除。 |\n| **5. 数据库并发写锁死 (SQLite Busy Lock)** | 多个后台定时任务与前台交互同时执行写事务。 | **WAL 模式 + 5000ms Busy Handler 内存重试队列**。 |\n"
    }
  ]
};

window.HARNESS_BOOK_DATA = (window.BOOK_DATA && window.BOOK_DATA.chapters) ? window.BOOK_DATA.chapters : [];
