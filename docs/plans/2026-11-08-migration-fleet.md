# 迁移会战（2026-11-08）

> 目标：把剩余 Node 业务按切片迁到 Go，做好一个删一个。并行执行，切片之间文件互斥。
> 基线：main @ 65555ab7（工作区另有 activity/task-queue 线未提交改动，任何切片都不得修改它们）。

## 切片与文件归属

| 编号 | 切片 | 独占文件（其他人不得修改） | 交付 |
| --- | --- | --- | --- |
| S2 | 令牌刷新收口 | `internal/adapters/accountauth/{gemini,grok,cline}oauth/*`、`internal/host/aihserver/credential_refresh*.go`、`lib/server/token-refresh-strategies.js`、删除 `lib/server/{gemini,grok,cline}-token-refresh.js` | 三家刷新迁 Go，Node 策略表删三项 |
| S3 | 登录策略 | `internal/adapters/accountauth/{zcode,opencode}oauth/*`、`lib/server/oauth-strategies/{zcode,opencode}.js` | 两家登录走 Go 作业框架，删 Node 策略 |
| S4 | relay mux | `internal/adapters/relaymux/*`、`internal/adapters/socks5/*` | SOCKS5 服务端 + 首字节分流 + UDP 关联，golden 单测 |
| S5 | 账号删除宿主清理 | `internal/adapters/accountremoval/*`、`lib/account/account-removal.js` | 宿主投影/会话检查/指针清理迁 Go，删 Node 实现 |
| S6 | 账号页读模型 | `internal/transport/http/webuiaccountsapi/*`、`lib/server/webui-account-live.js` | Go 产出账号页行，Node 只代理 |
| S7 | 插件面 | `internal/host/aihserver/plugin*.go`、`lib/server/webui-plugin*.js` | 插件列表/启停迁 Go |
| S8 | 设置面 | `internal/transport/http/webuisettingsapi/*`、`lib/server/webui-settings*.js` | 设置读写迁 Go |
| S9 | 图片工作室 | `internal/transport/http/webuiimagestudio/*`、`lib/server/webui-image-studio*.js` | 图片工作室后端迁 Go |
| S10 | 额度统计收尾 | `internal/transport/http/usagestatsapi/*`、`lib/server/webui-account-token-usage*.js` | 统计页切 Go（usage_ledger 已有数据） |

## 规则

1. 只改自己独占的文件；共享装配文件（`internal/host/aihserver/composition.go`、`server.go`）由编排者统一接线。
2. 不执行 git 写操作（add/commit/checkout/reset）。
3. 不重启线上服务（9527）；真机验证由编排者在集成后统一做。
4. 每个切片必须带可运行的回归测试，并给出「旧代码会红」的变异证据。
5. 注释用中文，保持现有风格；不要引入新依赖除非必要。
