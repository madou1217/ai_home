# Node 运行时面（2026-11-26 收敛后）

本页只记录「第一方运行时还剩哪些 Node，以及为什么不能/不必再迁」，不是迁移进度总账。
更早的总账（`README.md`、逐域卡片）是当时快照，不能当当前状态。

## 筛查方法

入口集合取全部真实调用面，再做静态 `require` 反向图 + 动态加载扫描
（`require.resolve` / `import()` / Go 字符串路径）：

- `package.json` 的 `scripts` 与 `bin`
- Go 调起的 Node 文件：zcode attribution runner / captcha hook、codebuddy IDE bridge、
  workbuddy credential codec、provider session hook sender
- 插件运行时（`lib/plugins/**`）与仓库内插件清单
- `scripts/**`（全部保留的手工/运维脚本都算入口）

结论：`lib/` 下 104 个 JS 模块中，运行时/构建入口可达 61 个，**不可达 0 个**；
不存在悬空 `require`。

## 已收敛（本次与上一轮）

| 提交 | 内容 |
| --- | --- |
| `a6a33cd8` | 删除 go-bridge 剩余垫片与已死脚本（provider auth、旧账号导入、Node 账号读取） |
| `21066473` | ZCode 桌面桥改读 Go 规范表 `accounts + account_credentials`（旧路径读 compat 表，zcode 行恒为 0）；删除 Node 账号身份/凭据/状态集群 51 模块与 3 个迁移对拍脚本 |
| `9a908d04` | 删除收敛后不可达的 11 个模块（server-config 遗留、model-id/providers、status-event-journal、egress evidence 等） |
| `27f44a97` | 删除 6 个 Node↔Go 切流对拍脚本（compare-*、parity-token-usage） |

## 保留的 Node 边界

| 边界 | 代表文件 | 不能迁的原因 |
| --- | --- | --- |
| ZCode 进程内钩子 | `lib/runtime/zcode-*-hook.js`、`zcode-session-attribution-runner.js`、`zcode-desktop-protocol-bridge.js` | 必须注入 zcode 自己的 Node 进程（patch agent 源码、包 fetch、tap stdio）；Go 只负责拉起 runner |
| 厂商 Electron 边界 | `lib/account/workbuddy-credential-codec.js` + `scripts/aih-workbuddy-credential-codec.cjs`、`lib/runtime/codebuddy-ide-bridge-*.{js,cjs}` | at-rest 密钥来自 `process._linkedBinding('electron_browser_workbuddy_storage')`，只有厂商二进制能提供；bridge 同样运行在厂商 Electron 内 |
| 插件 / hooks | `lib/plugins/**` | 插件运行时本身支持 `node|process`。Hook 传输已全部收敛到**同一套 Go 底层**：CLI/JSON/agy 命令、opencode 插件、Codex Desktop/VSCode/CLI 包装器都走 Go 的事件管线；命令与插件不含接收端 URL，发送器投递时按 `config:server` 解析；Desktop 侧旧的 receiver-url 选项/state/启动参数已删除。Node sender/config/template 已删除，重装即改写旧托管 handler |
| 构建 / 发布 / 运维 | `scripts/build-go-server.js`、`scripts/package/*`、`collect-*`、`go-accounts-preview.js` | 工具链，不是运行时代码 |

厂商边界内也不再有第一方业务规则：身份、凭据校验、默认账号、状态推导、用量账本都已由 Go 持有。

## 验证

- `go build ./...` 通过；`core/accounts` 状态双读 parity 测试通过（夹具 `testdata/status-dual-read.json` 保留）。
- 真实 zcode 账号的桌面桥 binding 可解析（`readZcodeDesktopCredential` + identity 指纹），旧 compat 路径必然失败。
- zcode 运行时模块 `require` 冒烟通过；删除后全仓库无悬空引用。

## 明确不做

- WorkBuddy codec 的 Go 化：本机无 WorkBuddy App、库中无加密凭据，无法真机对拍；盲移只会把 JS 搬进 Go 字符串。待有真实凭据的机器再评估。
- 旧 hook 配置自动改写：属于产品行为变更，需要单独授权；当前由显式安装/修复流程改写为 Go sender。
## Hook 实机验收（2026-11-26）

环境：本机 9527 正在运行，六家 hook 已于 22:35 全部重装为新形状。

| Provider | 结论 | 证据 |
| --- | --- | --- |
| claude | 真实会话直接投递成功 | 重装后的多个真实 Claude Code 会话在 `run/provider-session-state/` 产生 `official-hook` 事件（UserPromptSubmit / Notification 等） |
| codex | 真实会话可投递，但需通过 Codex 的 hook trust | `aih codex --dangerously-bypass-hook-trust exec ...` 输出 `hook: SessionStart/UserPromptSubmit/Stop`，会话快照写入 `turnState=completed` 与 Stop 事件 |
| gemini | 真实会话经本机网关投递成功 | Gemini CLI 0.70.0，`GOOGLE_GEMINI_BASE_URL=http://127.0.0.1:9527`、API-key 认证（临时设置，已还原），模型经网关路由；会话产生 `AfterAgent` / `SessionEnd` 事件 |
| agy | 真实会话（AWS agy 1.5.18）投递成功 | 在 AWS 账号投影 HOME 与宿主 HOME 安装无 URL 的 agy hooks；`agy --print` 真实会话产生 `PreInvocation` / `PostInvocation` / `Stop` 事件，写入 AWS Server 的 `provider-session-state` |
| opencode | 真实会话（免费 zen）投递成功 | opencode 2.4.2，默认 opencode #12 的免费模型 `seaglass-alpha-free`；插件 spawn 发送器并 detach，`UserPromptSubmit` 与 `Stop` 都写入会话快照 |
| grok | 未跑 | 本机与 AWS 均无健康账号（`没有可用账号`），与 hook 实现无关 |

**provider 默认账号的双事实源**：`aih <provider>` 的默认账号回退原先只读 app_kv 的 `account:default:<provider>`；opencode 这类 Go 独有默认只存在 `account_defaults` 表，于是被误报为“没有可用账号”。已改为 app_kv 缺失时回落 Go 默认关系。另发现 opencode 账号 #8 是 2026-10-18 的测试残留（api_key + codex dummy），健康选号偶尔会选中它并报“凭据类型不受支持”；显式 `aih opencode 12 …` 可正常使用免费 zen。

**Codex trust 注意**：Codex 按自身规范化对每个 handler 计算 `sha256`，写入 `config.toml` 的 `[hooks.state."<hooks.json>:<event>:<matcher>"] trusted_hash`；托管命令一改，旧信任即失效，非交互 `exec` 会静默跳过 hook（交互 TUI 会要求确认）。目前没有受支持的安装器写入信任的入口（上游 issue openai/codex#21615），因此本仓库**不伪造信任哈希**：重装后需用户在 TUI 确认一次，自动化场景才使用 `--dangerously-bypass-hook-trust`。
