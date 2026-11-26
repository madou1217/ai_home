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
| 插件 / hooks | `lib/plugins/**`、`provider-session-hook-*`、旧 `aih-provider-session-hook-sender.js` | 插件运行时本身支持 `node|process`；Go 安装器已改写成 `__provider-hook` 子命令，Node sender 仅服务尚未重装的旧 hook 配置。托管命令不再固化接收端 URL（端口属于运行态）：发送器按 `config:server` 的当前 host/port 解析，旧命令的 `--url` 仍兼容 |
| 构建 / 发布 / 运维 | `scripts/build-go-server.js`、`scripts/package/*`、`collect-*`、`go-accounts-preview.js` | 工具链，不是运行时代码 |

厂商边界内也不再有第一方业务规则：身份、凭据校验、默认账号、状态推导、用量账本都已由 Go 持有。

## 验证

- `go build ./...` 通过；`core/accounts` 状态双读 parity 测试通过（夹具 `testdata/status-dual-read.json` 保留）。
- 真实 zcode 账号的桌面桥 binding 可解析（`readZcodeDesktopCredential` + identity 指纹），旧 compat 路径必然失败。
- zcode 运行时模块 `require` 冒烟通过；删除后全仓库无悬空引用。

## 明确不做

- WorkBuddy codec 的 Go 化：本机无 WorkBuddy App、库中无加密凭据，无法真机对拍；盲移只会把 JS 搬进 Go 字符串。待有真实凭据的机器再评估。
- 旧 hook 配置自动改写：属于产品行为变更，需要单独授权；当前由显式安装/修复流程改写为 Go sender。