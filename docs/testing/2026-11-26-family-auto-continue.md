# CodeBuddy 家族自动续聊验证（2026-11-26）

## 范围

验证 aih codebuddycn 2 / aih codebuddy 1 在切换账号后自动接上最近会话并发送
continue；若会话有未完成 /goal，恢复 goal。

## 结果

| Provider | 账号 | 验证方式 | 结果 |
|---|---|---|---|
| codebuddycn | #2 | 真实 CodeBuddy CLI，resume + 合成 active goal | 输出 delta，会话写入 Goal set 与 goal-result ok:true |
| codebuddycn | #2 | 真实 CodeBuddy CLI，裸启动（PTY） | 会话新增用户消息 continue |
| codebuddy | #1 | 合成会话 + AIH_CODEBUDDY_BINARY 假 CLI | 参数为 --permission-mode bypassPermissions --continue "/goal Reply with the single word: delta" |
| codebuddy | #1 | 同上，--fresh | 参数不再包含 --continue / goal |
| workbuddycn | #1 | 桌面端入口 | 无原生 CLI，自动续聊逻辑不进入该路径；桌面会话由客户端管理 |
| workbuddy | 0 账号 | 桌面端入口 | 无账号，未执行 |

## 结论

- CodeBuddy CLI 家族（codebuddy / codebuddycn）的自动 continue 和 goal 恢复已生效。
- --fresh / --new 可跳过自动续聊，强制新建会话。
- workbuddy / workbuddycn 是桌面端 Provider，当前不走原生 CLI 参数注入；自动续聊的
  边界只覆盖有原生 CLI 的家族成员。
- codebuddy 国际站账号当前上游返回 403，使用假 CLI 验证参数注入，避免把账号限制误判为
  代码问题；codebuddycn 使用真实 CLI 完成端到端验证。
