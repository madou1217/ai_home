# 《Pi-Telegram 远程自主开发与全自动调度系统设计》
> **基于 Telegram 打造随时随地的 7×24 小时无人值守 AI 研发协作中心**

---

## 📖 书籍定位与愿景
本书以 **Pi-Telegram (`Ziphyrien/Pi-Telegram`)** 为实战核心，解构如何将终端 Coding Agent 无缝桥接至移动端与分布式团队即时通讯软件中。深度剖析 **AI Tag 语义协议拦截分发、基于 Croner 10 的分布式 `/cron` 定时任务引擎、多租户会话目录物理隔离与 24/7 守护高可用架构**。

---

## 🗺️ 全景交互目录与章节进度

### 00. 桥接理念与系统拓扑 (Bridge Architecture & Topology)
- [x] [00-01 为什么要把终端 Agent 接入 Telegram？随时随地的移动端 AI 编程协作](00-intro/01-why-bridge-to-telegram.md)

---

### 01. 📡 第一篇：全双工网关与 AI Tag 协议分发 (AI Tag Protocol)
- [x] [01-01 Telegram Bot API 与本地 Pi Agent 之间的全双工长轮询与 WebSocket 架构](01-bridge-gateway/01-01-bot-api-and-long-polling.md)
- [x] [01-02 AI Tag 语义协议设计：`tg-reply`、`tg-attachment` 与 `tg-cron` 流式拦截引擎](01-bridge-gateway/01-02-ai-tag-demuxing-protocol.md)

---

### 02. ⏰ 第二篇：分布式 `/cron` 定时任务与长程守护 (Cron & Automation)
- [x] [02-01 基于 Croner 10 的多粒度定时引擎：一次性提醒、秒/分周期任务与复杂 Cron 表达式解析](02-cron-scheduler/02-01-croner-scheduling-engine.md)
- [x] [02-02 自动化无人值守巡检、依赖更新告警与 Git 补丁自动推送实战](02-cron-scheduler/02-02-unattended-ci-patrol.md)

---

### 03. 🔒 第三篇：多租户会话隔离与安全架构 (Multi-Tenant Isolation)
- [x] [03-01 会话目录隔离拓扑：`<bot-name>/bot<token-hash>_chat<chatId>` 与持久化重放](03-session-security/03-01-chat-session-directory-layout.md)
- [x] [03-02 白名单鉴权、防滥用 Rate-Limiter 与多 Bot 进程保活集群](03-session-security/03-02-whitelist-and-rate-limiting.md)
