# 旧 Node Codex CLI 包装器残留导致 `codex` 启动失败（2026-11-23）

## 症状

在任意目录执行 `codex`：

```text
Error: Cannot find module '/Users/model/projects/feature/ai_home/lib/server/codex-app-server-stdio-proxy.js'
    at Function._resolveFilename (node:internal/modules/cjs/loader:1383:20)
MODULE_NOT_FOUND
```

`~/.local/bin/codex` 当时指向 `~/.codex/packages/standalone/current/bin/codex`。

## 根因

1. 该文件是旧 Node 实现的 Codex CLI/app-server stdio 代理（接管默认 CLI、`app-server`、`resume`，把 stdio 中转到 AIH 网关并注入会话头）。
2. 它在 `44008326 chore(node): delete dead codex app-server proxy`（2026-11-22）中随 Node 运行时一起被删除（14 个文件、-4060 行）；当前包装器模板已改为 Go 内建入口：
   - 默认：`aih-go __codex-default-cli`
   - app-server：`aih-go __codex-cli-app-server`
   - resume：`aih-go __codex-cli-resume`
3. 出问题的包装器是 **Node 时代写下的旧文件**（mtime 2026-11-19 12:31），且其中的
   `STATE_FILE` 指向 `/private/tmp/aih-serve-test-home/run/codex/cli-hook-state.json`
   ——一个临时测试 home。说明它由旧会话/测试写进了真实安装目录（跨会话污染）。
4. 当前 aih-server 默认关闭 Codex CLI hook（`EnableCLIHook` 默认 false），自愈循环不会
   主动改写它；健康检查只覆盖 hook 服务当前解析出的受管目标，旧的 standalone 安装不在其内。

## 修复

用仓库当前的 Go 生成器重写包装器（`codexhooks`，不手写模板）：

- `CLIHookService.EnsureInstalled` 重写受管目标
  `~/.local/share/aih-cli/codex/bin/codex`，并把 `~/.local/bin/codex`、
  `~/Library/pnpm/codex` 修复为受管别名；
- 对不再被引用的旧 standalone 安装，用
  `BuildWrapperScriptForTarget(target, upstream)` 按同一模板重写
  `~/.codex/packages/standalone/current/bin/codex`；
- `cli-hook-state.json` 更新为真实 home（`~/.ai_home/run/codex/cli-hook-state.json`）。

## 验证

```text
which codex                                   → /Users/model/.local/bin/codex
codex --version                               → codex-cli 0.171.0
codex --help                                  → 正常（默认路由）
codex resume --help                           → 正常（resume 路由）
~/.codex/packages/standalone/current/bin/codex --version → 0.171.0
```

## 后续

- 包装器模板已不含 Node 路径，新写入的包装器不会再有该问题；
- 仍然存在的风险是「临时 AIH home 下安装 hook 却写入真实宿主安装目录」。本次未改代码，
  如再次出现，优先检查 `cli-hook-state.json` 与包装器内的 `STATE_FILE` 是否指向临时目录。
