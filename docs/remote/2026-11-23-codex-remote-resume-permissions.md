# Codex `--remote` 与权限覆盖：规则、继续命令与会话观测（2026-11-23）

## `--remote` 在 AIH 里的用途

`codex --remote ws://127.0.0.1:<port> --remote-auth-token-env …` 让 TUI 作为客户端连接
**独立的 app-server 进程**；不加时 TUI 自己带起（或内嵌）本地 app-server（stdio）。

AIH 的默认 `codex` 启动路径固定走前者：`aih-go __codex-default-cli` 先拉起
`aih-server __codex-local-app-server`（loopback、一次性 token、父进程绑定），再由 TUI
连接它。目的不是“远程执行”，而是：

- **同身份 app-server 池化复用**，减少每个终端各起一份 app-server 的内存占用
  （见 `docs/product-integrity/terminal-memory-2026-11-17.md`）；
- 由 AIH 控制后端生命周期、MCP 预热与有效服务档位（`codexlocalappserver` 包）；
- 需要时可以把同一后端换成远端地址（当前未启用）。

代价是 Codex 把该 TUI 视为“remote task”：`/resume`、`/fork` 时拒绝**客户端会话级
权限覆盖**（`-s/-a/--full-auto/--approve-for-me/--dangerously-bypass…`、
`-c approval_policy=… / sandbox_mode=… / permissions… / network… / approvals_reviewer…`）。

## 永久规则

1. **AIH 不产生「remote + 权限覆盖」组合。**
   `runCodexDefaultCLI` 检测到权限覆盖时改用本地 app-server（不注入 `--remote`），
   显式权限被保留，`/resume`、`/fork` 可用（`fix(codex): keep permission overrides
   out of remote TUI mode`）。
2. **要同时保留 remote（池化）与固定权限，把权限写进原生命令配置。**
   Codex 从 `~/.codex/config.toml` 读取 `approval_policy` / `sandbox_mode`，属于配置层
   而非会话级覆盖，不触发守卫。Toolkit 的「应用到宿主配置」（`applyToHost`）正是写入
   这两个键；写入后 `permissionlaunch` 会跳过多余的命令行参数。
3. **恢复既有会话不需要重新给出权限。**
   Codex 0.149+ 在 resume 时恢复会话持久化的审批/沙箱策略；原生 `codex resume <id>`
   （不带权限参数）即可继续由 `--remote` 创建的旧会话。真机验证：恢复
   `01a1f351…` 后进入同一线程且无守卫报错。

## WebUI 观测

两个会话 API（`/webui/projects` 与 `/webui/sessions/{provider}/{accountRef}`）的会话条目
新增 `continue`：

```json
{
  "aih": "aih codex resume <id>",
  "native": "codex resume <id>",
  "note": "原生恢复不要追加 -s/-a/...；远程模式会拒绝权限覆盖，权限请写入 ~/.codex/config.toml。"
}
```

命令由 `core/providers` 合同生成（`NativeSessions.Resume` 模板 + `CLI.BinaryName`），
不是按 Provider 名硬编码；未声明恢复能力的 Provider 不下发该字段。WebUI 在会话行提供
入口，工作台 Sessions 面板在选中会话时展示两条命令与说明。Toolkit 高级设置里补充提示：
开启最大权限但未「应用到宿主配置」时，远程模式下 `/resume`、`/fork` 会被拒绝。

## 边界

- 本地模式（无 `--remote`）下不享受 app-server 池化；这是保留逐次权限参数的代价。
- 原生继续命令不含 AIH 账号/网关参数；需要 AIH 账号时用 `aih` 命令。
