# 《现代 Coding Agent 高阶实战与生产级调优指南》
> **从从 0 到 100 打造个人全自动编程副驾、Token 成本控制与复杂工程重构工作流**

---

## 📖 书籍定位与愿景
本书以工程实战为导向，全面解构如何将 **Pi (`@earendil-works/pi`)** 及现代终端 Agent 深度融入一线软件研发全生命周期。涵盖 **上下文裁剪降本 80%、多文件 AST 精确重构、自定义 Slash Commands / 扩展插件开发、以及 5 大死循环与工具调用异常生产级自愈技巧**。

---

## 🗺️ 全景交互目录与章节进度

### 00. 快速起步与环境搭建 (Getting Started & Setup)
- [x] [00-01 从 0 到 1 部署你的自扩展终端编程副驾：Bun 单二进制编译与多模型配置](00-intro/01-installation-and-setup.md)

---

### 01. 💰 第一篇：上下文治理与 Token 经济学 (Context & Token Economics)
- [x] [01-01 长程编码会话的上下文膨胀危机与 80% 水位自适应微观剪枝](01-context-optimization/01-01-context-bloat-and-pruning.md)
- [x] [01-02 Prompt Cache 极致命中法：字节级对齐、不变前缀与会话粘性路由](01-context-optimization/01-02-prompt-cache-maximization.md)

---

### 02. 🛠️ 第二篇：复杂多文件重构与工程实战 (Multi-File Refactoring Practice)
- [x] [02-01 跨数十个源文件的架构重构：AST 局部精准切片与确定性校验](02-refactoring-workflows/02-01-cross-file-ast-refactoring.md)
- [x] [02-02 自动化测试生成、回归验证与 Git 原子提交分组工作流](02-refactoring-workflows/02-02-test-generation-and-atomic-commit.md)

---

### 03. 🔌 第三篇：自定义 Extensions 插件开发全流程 (Extension Ecosystem)
- [x] [03-01 编写第一个 Pi 插件：自定义 Slash Commands 与生命周期 Hook](03-custom-extensions/03-01-writing-first-extension.md)
- [x] [03-02 自动化代码审查（Code-Reviewer）与 CI/CD 流程联动插件实战](03-custom-extensions/03-02-ci-code-review-plugin.md)

---

### 04. 🛡️ 第四篇：生产级排障与异常自愈矩阵 (Troubleshooting & Self-Healing)
- [x] [04-01 模型幻觉死循环、工具格式错误与 429 熔断的 5 大生产级自愈锦囊](04-production-troubleshooting/04-01-troubleshooting-matrix.md)
