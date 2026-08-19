window.BOOK_DATA = {
  "title": "《Pi-Telegram 远程自主开发与全自动调度系统设计》",
  "subtitle": "基于 Telegram 打造随时随地的 7×24 小时无人值守 AI 研发协作中心",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-19T17:10:28.221Z",
  "themeStyle": "remote-collaboration",
  "coverImage": "/docs/pi-telegram-book/assets/images/cover-pi-telegram-book.jpg",
  "chapters": [
    {
      "id": "01-why-bridge-to-telegram",
      "category": "00. 桥接理念与系统拓扑 (Bridge Architecture & Topology)",
      "title": "00-01 为什么要把终端 Agent 接入 Telegram？随时随地的移动端 AI 编程协作",
      "status": "completed",
      "path": "00-intro/01-why-bridge-to-telegram.md",
      "content": "# 00-01 为什么要把终端 Agent 接入 Telegram？随时随地的移动端 AI 编程协作\n"
    },
    {
      "id": "01-01-bot-api-and-long-polling",
      "category": "01. 📡 第一篇：全双工网关与 AI Tag 协议分发 (AI Tag Protocol)",
      "title": "01-01 Telegram Bot API 与本地 Pi Agent 之间的全双工长轮询与 WebSocket 架构",
      "status": "completed",
      "path": "01-bridge-gateway/01-01-bot-api-and-long-polling.md",
      "content": "# 01-01 Telegram Bot API 与本地 Pi Agent 之间的全双工长轮询与 WebSocket 架构\n"
    },
    {
      "id": "01-02-ai-tag-demuxing-protocol",
      "category": "01. 📡 第一篇：全双工网关与 AI Tag 协议分发 (AI Tag Protocol)",
      "title": "01-02 AI Tag 语义协议设计：`tg-reply`、`tg-attachment` 与 `tg-cron` 流式拦截引擎",
      "status": "completed",
      "path": "01-bridge-gateway/01-02-ai-tag-demuxing-protocol.md",
      "content": "# 01-02 AI Tag 语义协议设计：`tg-reply`、`tg-attachment` 与 `tg-cron` 流式拦截引擎\n"
    },
    {
      "id": "02-01-croner-scheduling-engine",
      "category": "02. ⏰ 第二篇：分布式 `/cron` 定时任务与长程守护 (Cron & Automation)",
      "title": "02-01 基于 Croner 10 的多粒度定时引擎：一次性提醒、秒/分周期任务与复杂 Cron 表达式解析",
      "status": "completed",
      "path": "02-cron-scheduler/02-01-croner-scheduling-engine.md",
      "content": "# 02-01 基于 Croner 10 的多粒度定时引擎：一次性提醒、秒/分周期任务与复杂 Cron 表达式解析\n"
    },
    {
      "id": "02-02-unattended-ci-patrol",
      "category": "02. ⏰ 第二篇：分布式 `/cron` 定时任务与长程守护 (Cron & Automation)",
      "title": "02-02 自动化无人值守巡检、依赖更新告警与 Git 补丁自动推送实战",
      "status": "completed",
      "path": "02-cron-scheduler/02-02-unattended-ci-patrol.md",
      "content": "# 02-02 自动化无人值守巡检、依赖更新告警与 Git 补丁自动推送实战\n"
    },
    {
      "id": "03-01-chat-session-directory-layout",
      "category": "03. 🔒 第三篇：多租户会话隔离与安全架构 (Multi-Tenant Isolation)",
      "title": "03-01 会话目录隔离拓扑：`<bot-name>/bot<token-hash>_chat<chatId>` 与持久化重放",
      "status": "completed",
      "path": "03-session-security/03-01-chat-session-directory-layout.md",
      "content": "# 03-01 会话目录隔离拓扑：`<bot-name>/bot<token-hash>_chat<chatId>` 与持久化重放\n"
    },
    {
      "id": "03-02-whitelist-and-rate-limiting",
      "category": "03. 🔒 第三篇：多租户会话隔离与安全架构 (Multi-Tenant Isolation)",
      "title": "03-02 白名单鉴权、防滥用 Rate-Limiter 与多 Bot 进程保活集群",
      "status": "completed",
      "path": "03-session-security/03-02-whitelist-and-rate-limiting.md",
      "content": "# 03-02 白名单鉴权、防滥用 Rate-Limiter 与多 Bot 进程保活集群\n"
    }
  ]
};
