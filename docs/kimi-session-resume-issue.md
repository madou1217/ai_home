# Kimi 跨账号 sessions 可见但无法 resume：现象记录

> 状态：**已记录，待排查**（2026-08-16 由用户报告，应用户要求先登记，根因未调查）。

## 原始现象

- 不同 Kimi 账号的 sessions 列表是互通的：在账号 A 的会话列表里能看到账号 B 的 session。
- 但对这些 session 执行 resume 操作不成功（无法恢复到对应会话）。

## 待排查方向（未验证）

- `lib/sessions/session-reader.js` 的会话枚举是否按账号隔离（凭证目录 / 投影目录）；
- resume 路径（`lib/runtime/persistent-session.js` 的 exact-target attach、provider 原生 resume）使用的 accountRef / cwd 与枚举路径是否一致；
- 是否因为列表走了共享索引而 resume 走了按账号隔离的凭证目录，导致"看得到、恢复不了"。

## 关联

- 持久会话（tmux）寻址模型见 `AGENTS.md`「Persistent sessions」一节：socket 按 accountRef 隔离、session 按项目分组，跨账号可见性与该模型的预期不符。
