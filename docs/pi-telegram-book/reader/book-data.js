window.BOOK_DATA = {
  "title": "《Pi-Telegram 远程自主开发与全自动调度系统设计》",
  "subtitle": "基于 Telegram 打造随时随地的 7×24 小时无人值守 AI 研发协作中心",
  "version": "1.0.0-PROD",
  "buildTime": "2026-08-20T01:40:00Z",
  "chapters": [
    {
      "id": "01-why-bridge-to-telegram",
      "category": "00-intro",
      "title": "00-01 为什么要把终端 Agent 接入 Telegram？随时随地的移动端 AI 编程协作",
      "status": "completed",
      "path": "00-intro/01-why-bridge-to-telegram.md",
      "content": "# 00-01 为什么要把终端 Agent 接入 Telegram？随时随地的移动端 AI 编程协作\n\n> **“工程师不可能永远守在电脑终端前。Pi-Telegram 将强大的本地 Coding Agent 搬上了移动端即时通讯软件，让你在手机上就能随时触发复杂的代码重构与巡检任务。”**\n"
    },
    {
      "id": "01-01-bot-api-and-long-polling",
      "category": "01-bridge-gateway",
      "title": "01-01 Telegram Bot API 与本地 Pi Agent 之间的全双工长轮询与 WebSocket 架构",
      "status": "completed",
      "path": "01-bridge-gateway/01-01-bot-api-and-long-polling.md",
      "content": "# 01-01 Telegram Bot API 与本地 Pi Agent 之间的全双工长轮询与 WebSocket 架构\n\n> **“解构 Telegram Bot 长轮询（Long Polling）与本地 Agent 进程之间的双向数据流转拓扑，确保消息在毫秒级完成接收、转发与流式打字回显。”**\n"
    },
    {
      "id": "01-02-ai-tag-demuxing-protocol",
      "category": "01-bridge-gateway",
      "title": "01-02 AI Tag 语义协议设计：`tg-reply`、`tg-attachment` 与 `tg-cron` 流式拦截引擎",
      "status": "completed",
      "path": "01-bridge-gateway/01-02-ai-tag-demuxing-protocol.md",
      "content": "# 01-02 AI Tag 语义协议设计：`tg-reply`、`tg-attachment` 与 `tg-cron` 流式拦截引擎\n\n> **“Agent 如何向用户发送带格式的富文本、代码补丁文件并自动设置定时提醒？详解基于 XML/HTML 风格的自定义 AI Tag 协议分发机制。”**\n"
    },
    {
      "id": "02-01-croner-scheduling-engine",
      "category": "02-cron-scheduler",
      "title": "02-01 基于 Croner 10 的多粒度定时引擎：一次性提醒、秒/分周期任务与复杂 Cron 表达式解析",
      "status": "completed",
      "path": "02-cron-scheduler/02-01-croner-scheduling-engine.md",
      "content": "# 02-01 基于 Croner 10 的多粒度定时引擎：一次性提醒、秒/分周期任务与复杂 Cron 表达式解析\n\n> **“内置基于 Croner 10 的生产级定时任务子系统：支持 5m、2h 自然时间短语、一次性定时唤醒与标准 5 字段 Cron 表达式。”**\n"
    },
    {
      "id": "02-02-unattended-ci-patrol",
      "category": "02-cron-scheduler",
      "title": "02-02 自动化无人值守巡检、依赖更新告警与 Git 补丁自动推送实战",
      "status": "completed",
      "path": "02-cron-scheduler/02-02-unattended-ci-patrol.md",
      "content": "# 02-02 自动化无人值守巡检、依赖更新告警与 Git 补丁自动推送实战\n\n> **“实战演练：配置一个 7×24 小时无人值守的深夜依赖巡检任务，自动扫描 CVE 漏洞、运行测试并在通过后向 Telegram 群组推送 PR 链接。”**\n"
    },
    {
      "id": "03-01-chat-session-directory-layout",
      "category": "03-session-security",
      "title": "03-01 会话目录隔离拓扑：`<bot-name>/bot<token-hash>_chat<chatId>` 与持久化重放",
      "status": "completed",
      "path": "03-session-security/03-01-chat-session-directory-layout.md",
      "content": "# 03-01 会话目录隔离拓扑：`<bot-name>/bot<token-hash>_chat<chatId>` 与持久化重放\n\n> **“如何支持多个 Telegram 用户同时与 Agent 交互而不发生上下文串线？解析基于 ChatId 与 Token 哈希的物理目录隔离与断点续传设计。”**\n"
    },
    {
      "id": "03-02-whitelist-and-rate-limiting",
      "category": "03-session-security",
      "title": "03-02 白名单鉴权、防滥用 Rate-Limiter 与多 Bot 进程保活集群",
      "status": "completed",
      "path": "03-session-security/03-02-whitelist-and-rate-limiting.md",
      "content": "# 03-02 白名单鉴权、防滥用 Rate-Limiter 与多 Bot 进程保活集群\n\n> **“全书大结局：构建生产级高可用 Bot 集群，基于 Telegram User ID 白名单与 Token Bucket 限流算法，筑牢防被外部滥用的安全铁壁。”**\n"
    }
  ]
};
