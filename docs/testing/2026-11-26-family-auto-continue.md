# CodeBuddy 家族显式续聊自动 continue 验证（2026-11-26）

## 范围

验证 aih <codebuddy|codebuddycn> resume [<id>] 在续接会话后自动发送
continue；若该会话有未完成 /goal，恢复 goal。

裸启动 aih codebuddycn 2 **不**自动续聊：同一目录可能同时存在 3-5 个会话，
按“最近一段”猜测会接错目标。只有显式 resume 才进入自动续聊。

## 结果

| Provider | 账号 | 验证方式 | 结果 |
|---|---|---|---|
| codebuddycn | #2 | 真实 CodeBuddy CLI，resume <id> + 合成 active goal | 输出 delta，会话写入 Goal set 与 goal-result ok:true |
| codebuddy | #1 | 合成会话 + AIH_CODEBUDDY_BINARY 假 CLI，resume <id> | 参数为 --resume <id> /goal Reply with delta |
| codebuddy | #1 | 同上，resume 不带 id | 参数为 --continue /goal Reply with delta |
| codebuddy | #1 | 同上，裸启动 | 只有 --permission-mode bypassPermissions，无 continue |
| workbuddycn | #1 | 桌面端入口 | 无原生 CLI，自动续聊逻辑不进入该路径；桌面会话由客户端管理 |
| workbuddy | 0 账号 | 桌面端入口 | 无账号，未执行 |

## 结论

- 显式 resume（codebuddy / codebuddycn）的自动 continue 和 goal 恢复已生效。
- 裸启动不注入 --continue，避免多会话场景下接错会话。
- workbuddy / workbuddycn 是桌面端 Provider，当前不走原生 CLI 参数注入。
- codebuddy 国际站账号当前上游返回 403，使用假 CLI 验证参数注入；codebuddycn
  使用真实 CLI 完成端到端验证。
