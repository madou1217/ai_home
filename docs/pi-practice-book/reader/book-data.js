window.BOOK_DATA = {
  "title": "《现代 Coding Agent 高阶实战与生产级调优指南》",
  "subtitle": "从从 0 到 100 打造个人全自动编程副驾、Token 成本控制与复杂工程重构工作流",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-20T01:40:00Z",
  "chapters": [
    {
      "id": "01-installation-and-setup",
      "category": "00-intro",
      "title": "00-01 从 0 到 1 部署你的自扩展终端编程副驾：Bun 单二进制编译与多模型配置",
      "status": "completed",
      "path": "00-intro/01-installation-and-setup.md",
      "content": "# 00-01 从 0 到 1 部署你的自扩展终端编程副驾：Bun 单二进制编译与多模型配置\n\n> **“打造属于自己的 AI 编程副驾，第一步就是摆脱笨重的环境依赖。本章解构如何利用 Bun 将 Pi 打包为单文件独立二进制可执行文件，并零摩擦配置多厂商 API Key 与本地代理。”**\n\n```bash\ngit clone https://github.com/earendil-works/pi.git\ncd pi && bun install --frozen-lockfile\nbun build --compile --minify ./packages/pi-coding-agent/src/cli.ts --outfile /usr/local/bin/pi\n```\n"
    },
    {
      "id": "01-01-context-bloat-and-pruning",
      "category": "01-context-optimization",
      "title": "01-01 长程编码会话的上下文膨胀危机与 80% 水位自适应微观剪枝",
      "status": "completed",
      "path": "01-context-optimization/01-01-context-bloat-and-pruning.md",
      "content": "# 01-01 长程编码会话的上下文膨胀危机与 80% 水位自适应微观剪枝\n\n> **“在动辄几百轮的长程重构会话中，上下文窗口极易被大段重复的文件读取和编译报错挤爆。本章详解基于 80% 容量水位的自适应微观折叠与启发式剪枝算法，直接节省 80% Token 支出。”**\n"
    },
    {
      "id": "01-02-prompt-cache-maximization",
      "category": "01-context-optimization",
      "title": "01-02 Prompt Cache 极致命中法：字节级对齐、不变前缀与会话粘性路由",
      "status": "completed",
      "path": "01-context-optimization/01-02-prompt-cache-maximization.md",
      "content": "# 01-02 Prompt Cache 极致命中法：字节级对齐、不变前缀与会话粘性路由\n\n> **“如何让每一轮请求的 KV Cache 命中率稳定在 90% 以上？解析静态 System 提示词字典序对齐、工具 Schema 哈希锁定与同一会话账号粘性绑定的生产级落地法则。”**\n"
    },
    {
      "id": "02-01-cross-file-ast-refactoring",
      "category": "02-refactoring-workflows",
      "title": "02-01 跨数十个源文件的架构重构：AST 局部精准切片与确定性校验",
      "status": "completed",
      "path": "02-refactoring-workflows/02-01-cross-file-ast-refactoring.md",
      "content": "# 02-01 跨数十个源文件的架构重构：AST 局部精准切片与确定性校验\n\n> **“面对拥有上百个文件的大型仓库，全局重写必然引发幻觉。本章实战演示如何借助 AST（抽象语法树）精准提取接口声明、类型依赖与局部函数切片，实现零破坏重构。”**\n"
    },
    {
      "id": "02-02-test-generation-and-atomic-commit",
      "category": "02-refactoring-workflows",
      "title": "02-02 自动化测试生成、回归验证与 Git 原子提交分组工作流",
      "status": "completed",
      "path": "02-refactoring-workflows/02-02-test-generation-and-atomic-commit.md",
      "content": "# 02-02 自动化测试生成、回归验证与 Git 原子提交分组工作流\n\n> **“代码修改必须伴随自动化测试闭环。解析如何让 Agent 自动编写单元测试、执行 Jest/Vitest 验证，并将修改自动拆分为符合 Conventional Commits 规范的原子 Git 提交。”**\n"
    },
    {
      "id": "03-01-writing-first-extension",
      "category": "03-custom-extensions",
      "title": "03-01 编写第一个 Pi 插件：自定义 Slash Commands 与生命周期 Hook",
      "status": "completed",
      "path": "03-custom-extensions/03-01-writing-first-extension.md",
      "content": "# 03-01 编写第一个 Pi 插件：自定义 Slash Commands 与生命周期 Hook\n\n> **“解构 Pi 的插件扩展机制：只需几十行 TypeScript 代码，即可注册自定义的 /deploy、/review 命令并注入全局生命周期拦截器。”**\n"
    },
    {
      "id": "03-02-ci-code-review-plugin",
      "category": "03-custom-extensions",
      "title": "03-02 自动化代码审查（Code-Reviewer）与 CI/CD 流程联动插件实战",
      "status": "completed",
      "path": "03-custom-extensions/03-02-ci-code-review-plugin.md",
      "content": "# 03-02 自动化代码审查（Code-Reviewer）与 CI/CD 流程联动插件实战\n\n> **“实战开发一个生产级 CI/CD 自动化代码审查插件：监听 GitHub PR Webhook，自动拉起多视角 Subagent 进行安全性、性能与代码味道并发审查。”**\n"
    },
    {
      "id": "04-01-troubleshooting-matrix",
      "category": "04-production-troubleshooting",
      "title": "04-01 模型幻觉死循环、工具格式错误与 429 熔断的 5 大生产级自愈锦囊",
      "status": "completed",
      "path": "04-production-troubleshooting/04-01-troubleshooting-matrix.md",
      "content": "# 04-01 模型幻觉死循环、工具格式错误与 429 熔断的 5 大生产级自愈锦囊\n\n> **“全书大结局：针对生产环境中高频出现的模型死循环、工具返回格式错乱与 API 429 限流，梳理 5 大立竿见影的自愈防御模式与熔断降级策略。”**\n"
    }
  ]
};
