# Codex set-default：原生 OAuth 与 Relay 的边界

## 修复范围

`aih codex set-default <OAuth ID>` 已将宿主 `model_provider` 写成 `openai`、
`preferred_auth_method` 写成 `oauth`，但旧 App 线程仍可能恢复 `aih_server`。
本次修复原生 App/CLI 的恢复路径，不改变裸 `aih codex` 的显式网关入口、
账号启停、网关调度、凭据所有权，也不删除备用 provider 注册项。

## 三条错误路径

1. `reconcileSelectedThreadConfig` 只在当前 provider 是 AIH 时运行；切到 OAuth 后退出，
   `thread/resume.modelProvider=null` 没有覆盖旧线程的 AIH provider。
2. 桌面运行目录只要取得网关地址就强制生成 AIH provider，并使用独立移动身份，
   未尊重已经选中的宿主原生 OAuth 模式。
3. 原生 `codex resume` hook 看见本地 Server 在线就注入 `--remote`，即使默认是 OAuth。

## 正确不变量

- 原生 OAuth：保留宿主登录，不投影另一移动身份，不生成网关运行配置或注入网关 key；
  不启动 AIH 远控身份代理，不自动通过网关恢复。普通 HTTP(S) 代理配置不受影响。
- Relay：保留现有网关选择、凭据与隔离运行目录。可用性失败不能隐式变成原生 OAuth。
- 对原生 OAuth 下的隐式旧 AIH/OpenAI 线程恢复，明确传 `modelProvider=openai`；
  不改线程 ID、历史文件和数据库行，也不强制更换原模型。原生引擎可自行更新其会话状态。
- thread/read 仅查询，不能伪装成已切换。未知线程、第三方 provider、显式请求/项目配置
  的 transport 选择不被这个兼容层覆盖。原生 CLI 的显式 provider/profile/remote/OSS 同样保留。
- 读取真实 TOML（复用已有 smol-toml），尊重 child CODEX_HOME、profile 和启动 -c 覆盖；
  不从嵌套字段、示例字符串或网关是否在线猜模式。
- 过期/缺失 OAuth、账号在网关为 down、网关全不可用，都不是切到 relay 的理由。
  原生登录失败仍由原生客户端呈现，不跨模式兜底。
- `[model_providers.aih_server]` 继续保留，已实现的宿主注册项自愈继续工作；
  注册项存在并不等于选中了它。

## 与 Go 约定一致，但不混淆正式入口

`application/providerlaunch/intent.go` 区分 `native_direct` 与 `gateway_relay`，
`service.go` 的两个规划器不会互相回退。本次新增错误分支测试，覆盖 native 凭据不可用
和 relay 不可用时另一规划器调用次数为零；没有修改 Go 生产实现或将 Preview 切为正式入口。

正式 Node 的裸 `aih codex` 仍是 gateway profile。原生 App/普通 `codex` 才遵守这里的
set-default OAuth 选择；不能把 Go Preview 的命令语法直接当成已迁移的正式 CLI。

## 实际验证（2026-09-16）

- 基线 `2860409fcb5e4fa4295370c30692d6c0a3b433c8`。
- 173 项相关 Node 回归通过；另在 Node v22.16.0 运行 131 项跨版本相关回归通过。
- 新增核心 3 项在未修改基线独立运行均复现失败（不是缺依赖）：旧线程 OAuth 接管、
  原生 App 环境隔离、OAuth resume 不探测网关。修复后均通过。
- `GOPROXY=off go test ./application/providerlaunch ./internal/runtime/providercli` 两包通过。
- 实际安装的 App 引擎 Codex `0.154.0-alpha.6.2` 通过隔离 stdio 代理完成同一个线程的
  `relay → OAuth → relay` 三次推理；OAuth 使用模拟原生令牌，历史上下文保留，
  OAuth 阶段网关调用数为 0，host auth.json 字节不变。
- 同一原生引擎冒烟已分别在 Node v26.8.1 与实际 App hook 使用的 Node v22.16.0 下通过。
- 最终原生测试用系统 sandbox 限制为 localhost，临时 `openai_base_url` 把内建原生端点
  定向到独立本地夹具；网关为另一端点。实际 GUI、真实上游和用户凭据未用于该验收。
  初始夹具尝试用 chatgpt_base_url 替代推理端点不适用该版本，已修正；最终验证以受限网络运行记录为准。
- 本地完整 npm test：7272 项，7227 通过、1 失败、44 跳过。
  已有 pending OAuth 注册测试失败 `missing_stable_identity` 在未修改的基线单独运行也复现；
  没有删除或放宽原断言，不声称全量绿色。

```sh
node --test test/codex-native-transport.test.js test/server.codex-app-server-stdio-proxy.test.js test/codex-default-cli-launcher.test.js test/codex-native-credential-integration.test.js test/codex-host-provider-lifecycle.test.js test/config-sync.test.js test/codex-fresh-login-handoff.test.js
AIH_NATIVE_CODEX_TRANSPORT_SMOKE=1 node --test test/codex-native-transport-smoke.test.js
GOPROXY=off go test ./application/providerlaunch ./internal/runtime/providercli
npm test
```

## 模块与审查

- `codex-native-transport-policy.js` → 策略函数 → 一处确定原生模式、显式覆盖与环境隔离 → TOML、参数和真实文件测试。
- `codex-app-server-stdio-proxy-{runtime,resume,cliresume}.js` → 既有适配器/组合边界 → 启动、恢复均执行所选模式，不重造账号层 → 真实 SQLite 与原生引擎双向切换。
- `providerlaunch/service_test.go` → 互斥策略调度合同 → 将 Node 缺陷提炼成 Go 不变量，不复制 Node 状态结构 → Go 两包测试。

已按 SOLID/KISS/DRY/YAGNI 自检：复用既有 TOML 依赖、默认同步与账号登记；没有新增表、
网络重试服务或更改用户状态。无独立 reviewer，采用明确自审；用户已授权修复及 scoped commit/push。

## 生效方式

没有强制重启生产 App/Server。源码更新后，需要退出重开 App，或在真实宿主环境重新执行
`aih codex set-default <OAuth ID> --restart-client`，使 App 的 stdio hook 加载新代码并恢复线程。
这不是让账号变为 up；用户主动停用的网关账号保持停用。已有运行中的回合不会被后台偷偷重放。
