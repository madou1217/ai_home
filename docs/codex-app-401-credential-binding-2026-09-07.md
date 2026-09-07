# Codex App 401：连接地址与认证绑定修复

日期：2026-09-07。目标会话：`01a07a6a-19ee-7701-9113-2d91f5b9e8b0`。

后续更正：用户截图证明 App 的 `test` 轮次虽然完成，期间仍出现 4 次重试。下文“完成通知”仅证明最终完成，不证明零错误。新的 [Connection refused 排查与修复](codex-app-connection-refused-2026-09-07.md) 已确认本机源码自动重启打断连接，并记录默认重启策略修复及零重试验收。

## 结论

此次 `https://www.yeslaoban.com/llm/api/v1/responses` 返回 `Invalid API key` 的原因已经确认：App 继承的是 AIH 网关 client key，宿主 provider 配置却指向公网上游；原认证 helper 无条件优先透传环境变量，把本机网关 key 发给了上游。

这与此前 WebSocket 路径 404 是两个独立问题，也没有证据支持重新安装 Codex。修复限定本机 AIH 代码、宿主配置和进程；本轮没有修改、推送或部署 `llm_api`，没有提交代码。

原会话已用 App 随附的官方 app-server 恢复并完成真实推理；App 重新打开后，其实际日志也记录了原会话恢复、启动一轮和完成通知。裸 `codex` 与 `aih codex 1 exec` 均完成真实回复。

## 根因证据

| 检查对象 | 修复前事实 | 含义 |
| --- | --- | --- |
| 原 App 主进程 43899、app-server 44317 | `OPENAI_API_KEY` 与 AIH 网关 client key 相等，与账号上游 key 不等；只输出比较结果 | 进程拿到的是网关认证 |
| 宿主 `.codex/config.toml` | `model_providers.aih_server.base_url` 和根级 `openai_base_url` 指向公网 | provider 名为 AIH 不代表请求经过本机网关 |
| `scripts/aih-codex-provider-auth.js` | 无参数旧逻辑首先返回继承的 `OPENAI_API_KEY`；审计为 `tier=env-passthrough` | helper 把错误认证绑定到公网 URL |
| Codex 生命周期 | app-server 缓存配置和认证上下文 | 仅改文件不能修正正在运行的旧进程 |

未记录任何真实 key。原宿主配置与认证文件保存在权限受限的本机备份目录，不纳入 Git。

## 修复方案与已应用行为

连接链固定为：`Codex → 本机 AIH 网关 → 所选账号上游`。

1. `lib/server/codex-gateway-connection.js` 统一生成网关 URL、网关 key 和账号 pin。host-sync、默认 CLI、native/WebUI 运行时及 App 投影复用同一来源。
2. 宿主受管 provider 指向 `http://127.0.0.1:9527/v1`，写入 `X-Account-Ref`，启用 WebSocket。根级 URL 同步，避免旧内建 provider 留在公网地址。
3. 宿主认证命令显式携带 `--gateway --ai-home <真实 AIH 目录>`，仅从指定配置读取当前网关 key，忽略 App 继承的 key、HOME 和其他 AIH 路径。旧无参数模式保留兼容，不再由新宿主配置生成。
4. API-key 模式宿主 `auth.json` 同步为网关认证，原文件先备份。账号上游 key 仍由 AIH 账号存储和上游适配器持有。OAuth 登录路径保留原流程；API-key 模式本身不能替代 ChatGPT 云功能所需的 OAuth 登录。
5. `aih codex <账号>` 的 API-key 入口通过现有 relay profile 接入网关并保留指定账号；OAuth、login、显式 provider 选择不强制套用账号 relay。新增 pin 环境变量纳入账号环境清理和 tmux 继承白名单。参数不含 key，也不引入 Windows 引号。
6. 已备份和应用真实宿主配置，以真实 HOME 重启本机 AIH，并结束旧 App/app-server 后重新打开 App。`/readyz` 为 ready，Codex 账号数 3。

认证 helper 自身会读取轮换后的 key；Codex 的现有 `refresh_interval_ms=300000` 有缓存，服务 key 或地址变化仍应通过配置同步和进程更新完成切换。本修复不承诺上游撤销 key、欠费或未来独立故障不会产生任何 401。

此前 WS 404 的 AIH 侧兼容继续有效：只在标准握手 404 时尝试同源 `/responses/ws` 一次，401 不触发别名重试，详见 [WSS 兼容文档](codex-wss-aih-only-compatibility-2026-09-07.md)。

## 真实验收

证据目录：`/Users/model/.ai_home/backups/codex-401-connection-20260907-6Cm2tQ`。

| 验收 | 结果 | 证据 |
| --- | --- | --- |
| 指定原会话恢复与推理 | 官方 App binary，真实宿主配置，故意注入错误继承 key；`thread/resume` 成功，`turnStatus=completed`，回复随机标记 `AUTH_FIXED_e61c43bc85e7` | `thread-acceptance.json` |
| 原会话传输 | 成功连接 `ws://127.0.0.1:9527/v1/responses`；没有公网直连和 401 | `thread-acceptance-stderr.log` |
| 裸 `/Users/model/.local/bin/codex exec` | 故意注入错误 key 和 URL；exit 0，回复 `AIH_401_BARE_OK`，`turn.completed` | `bare-cli.stdout`、`bare-cli.stderr` |
| `aih codex 1 exec` | exit 0，回复 `AIH_401_CLI_OK`，`turn.completed` | `aih-cli.stdout`、`aih-cli.stderr` |
| App 重新打开 | 主进程 1416、app-server 1772；宿主 URL、认证命令和账号 pin 正确 | `app-reopened.json` |
| App 实际原会话事件 | 17:40:31 恢复成功；17:41:37 启动一轮成功；17:42:00 完成通知；新 App 日志无 yeslaoban 401 | `app-original-thread-events.json`；时间为北京时间 |

原会话验收最初被 App 的 active writer 拒绝；关闭 App 后仍有恢复超时。最终使用 `excludeTurns=true` 的恢复请求成功，启动通知同时显示 MCP 初始化。没有绕过 writer 锁，也没有把仅握手成功算作会话成功。该过程不证明所有恢复超时的根因。

UI 自动化接口持续返回 `Sky Computer Use native pipe startup failed`，因此没有自动点击界面的验收；App 证据来自其真实日志及会话的 `task_complete` 落盘事件。CLI 曾输出模型目录刷新超时，但请求本身成功。

## 全局检查发现的独立边界

官方 Chronicle 后台摘要启动的子命令包含 `--ignore-user-config`，并显式选择 `openai-memgen`、`requires_openai_auth=true`。它绕过宿主受管 provider，向 `api.openai.com/v1/responses` 发送继承的网关 key，产生另一组 401；这不是目标会话的公网 yeslaoban 401。

此官方后台功能需要单独处理官方认证或停用。不能通过修改 AIH 宿主 provider 就宣称修好它，也不能在未确认数据范围的情况下将屏幕摘要改送第三方上游。已询问用户是否停用；未得到选择前保留现状。ChatGPT 云任务和设置接口的无 OAuth 401 同样不属于第三方模型调用认证。

## 测试污染与修复

测试期间发现 CLI baseline 的临时 HOME 与 AIH_HOST_HOME 同时指向测试目录，旧 desktop-hook 仅比较两者相等，仍扫描 `/Applications`，导致真实 App 内的 `codex` 被测试 wrapper 替换。

修复增加 OS 用户 home 校验，并对缓存 App 路径实施相同宿主范围约束；baseline 显式隔离 CODEX_HOME/AIH_HOME 和认证环境。补充测试覆盖直接发现及缓存路径绕过。真实 App binary 已按原文件 hash 恢复；测试 wrapper 证据保留在备份目录，未删除官方组件。

恢复后的官方 `codex`：220585024 字节，SHA256 `a30ec314bbd0e3721632234d07db7c99855db3b9f1e32dbe8c791947f07e7629`。

## 代码验证

- 认证与入口集中测试先前 290/290；覆盖双账号、错误继承环境、key 轮换、OAuth/login、显式 provider 和 Windows 参数。
- 最终十个相关测试文件：245 项，244 通过，1 个已知宿主 CLI 路径断言失败。精确排除该已取证基线用例后，244/244 通过，日志 `/tmp/aih-401-closure-focused-final.log`。
- 全量测试：6373 项，6364 通过，2 失败，7 跳过，日志 `/tmp/aih-401-full-final.log`。失败为宿主 CLI 路径和共享工作区 node-rpc 账号断言；此前 HEAD 对照证明前者为环境基线、后者为共享 dirty 差异。全量运行早于最终 desktop-hook 缓存边界补充，后者已由上述集中测试覆盖。不能描述为全量全绿。
- 本轮未修改 WebUI 源码，未替其他任务的 dirty web 变更声明构建通过。
- 最终 22 个本轮相关 JavaScript 文件 `node --check` 通过，`git diff --check` 通过，范围受控的 Gitleaks 扫描未发现泄漏。测试后的官方 App binary hash 与恢复值一致，见证据目录 `final-checks.json`、`secret-scan.json`。App 保持打开；最终日志检查仍无 yeslaoban 401。

## 设计模式与原则复核

| 文件/模块 | 模式 | 为什么使用 | 验证证据 |
| --- | --- | --- | --- |
| `codex-gateway-connection.js` | 连接值对象、工厂函数 | 将 URL/key/pin 作为一个返回值生成，消除多个入口的认证来源漂移 | 双账号、轮换和污染环境测试；真实 App/CLI |
| `relay/codex-relay-profile.js` | 既有策略模式 | 在现有 provider 扩展点选择 API-key relay，保留 OAuth/login 等边界 | relay 边界测试、实际 `aih codex 1 exec` |
| `codex-desktop-hook.js` | 既有依赖注入与边界守卫 | 注入 OS home 取值，隔离测试路径与真实 App | 直接发现/缓存路径测试，官方 binary hash |

SOLID：连接生成、认证读取、入口编排各自负责一个边界。KISS：复用现有网关与 relay，不增设转发服务。DRY：共享 URL/key/pin 来源。YAGNI：不增加账号权限系统、无限认证回退或自动更换上游。
