# Kimi 跨账号 sessions 可见但无法 resume：现象记录与修复

> 状态：**已修复**（2026-08-18）。会话数据保持全账号共享（物理上一份），索引改为每账号私有视图。

## 原始现象

- 不同 Kimi 账号的 sessions 列表是互通的：在账号 A 的会话列表里能看到账号 B 的 session。
- 但对这些 session 执行 resume 不成功，kimi CLI 报
  `Failed to resume session <id>: [session.not_found]`。

## 根因（已从 kimi CLI 源码确认）

- kimi CLI（`@moonshot-ai/kimi-code/dist/main.mjs`）的 `readSessionIndex` 在读取
  `session_index.jsonl` 时用 `isPathInside(sessionsDir, sessionDir)` 做**纯字符串前缀**
  过滤（不做 realpath）：`sessionDir` 不在当前进程 `KIMI_CODE_HOME/sessions` 下的条目
  直接丢弃；resume 找不到条目即抛 `session.not_found`。
- aih 旧布局把每个账号投影的 `.kimi-code/sessions` 和 `.kimi-code/session_index.jsonl`
  都 symlink 到宿主共享目录，而索引条目的 `sessionDir` 记录的是**创建者账号投影的绝对
  路径**——其他账号读共享索引时该条目前缀不匹配，被过滤，于是「看得到、恢复不了」。

## 修复设计（2026-08-18）

原则：除账号凭证外全部共享，零会话数据拷贝。

- `sessions` 目录保持 provider 共享（symlink 到宿主 `~/.kimi-code/sessions`，物理上只有
  一份会话数据）。
- `session_index.jsonl` 改为**每账号私有视图**（`provider-storage-policy.js` 将其列入
  kimi `privateArtifacts`）。索引只是查找元数据，不是会话数据。
- `session-store.js` 的 `syncKimiSessionIndexView`（每次 `aih kimi <id>` 启动时经
  `ensureSessionStoreLinks` 触发）：
  1. 维护宿主规范索引 `~/.kimi-code/session_index.jsonl`，条目统一为宿主路径形式
     （旧数据里任何投影路径前缀都会被归一化；无法识别的行原样保留，不丢数据）；
  2. 把本账号私有索引里新增的会话（投影路径形式）合并进规范索引，`deleted` 标记跨
     账号传播；
  3. 重新生成本账号的私有视图：条目相同、`sessionDir` 重写为本账号投影路径，使 kimi
     的前缀检查通过；只列出数据实际存在的会话（检查共享 store 与投影本地目录两处，
     覆盖合并过渡态）。
  - 存量投影的共享 symlink / Windows 硬链接会被替换为私有视图文件；外部陌生链接
    fail-closed 记入 `unresolved`，不读取、不删除其目标。
- 存量「私有 sessions 目录」状态（2026-08-18 私有化方案短暂上线产生）会在下次启动时
  由既有的 `migrateAndLinkSessionEntry` 自动合并回共享 store 并恢复 symlink。

## 覆盖测试

`test/session-store.test.js`：视图重写为投影路径、跨账号传播、deleted 标记传播、
外部索引链接 fail-closed、legacy 布局 sessions 保持共享链接。

## 关联

- 持久会话（tmux）寻址模型见 `AGENTS.md`「Persistent sessions」一节；本修复针对的是
  kimi 原生 conversation session 的存储/索引，不涉及 tmux 层。
- usage 扫描（`lib/usage/model-usage-scanner.js`）同时扫宿主与投影目录并按物理路径去
  重，与该布局兼容。
