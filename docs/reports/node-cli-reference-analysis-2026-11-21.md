# Node CLI 库引用分析（2026-11-21）

快照：HEAD `eb384f7f`（分析期间共享工作区仍在被其他会话推进）。

## 规模

| 指标 | 数值 |
|---|---|
| `lib/cli/**/*.js` | 511 个文件 |
| 总行数 | 101,801 |
| 体积 | 4.9 MB |

## 方法

从实际入口做静态 require 图遍历，根节点分两类：

1. **产品根**：`bin/claude-desktop-credential.js`、Go 主动 spawn 的
   `lib/server/codex-app-server-stdio-proxy.js`、`bin/aih-translation.js`；
2. **开发根**：`scripts/**/*.js` 与 `bin/**/*.js` 全量。

另检查了动态 require：只有 3 处，分别是 `node:http/https` 与注入的脚本路径，
没有按变量加载 `lib/cli` 模块的情况，静态图可作删除依据。

## 结果

| 分类 | 文件数 | 说明 |
|---|---|---|
| 产品运行时可达 | **9** | 真正需要迁移/消除的 |
| 仅开发脚本可达 | 218 | 构建/审计/夹具工具，随脚本迁移再删 |
| 完全不可达 | **284**（2.58 MB） | 可直接删除 |

不可达文件集中在：

- `lib/cli/services` 253
- `lib/cli/commands` 12
- `lib/cli/bootstrap` 11
- `lib/cli/complete` 5
- `lib/cli/config` 2
- `lib/cli/app.js` 1

## 产品运行时可达的 9 个文件

| 文件 | 现状 / 迁移路径 |
|---|---|
| `services/ai-cli/claude-desktop-credential.js` | Go 已有 `aih __claude-desktop-credential`，可删 Node 包装 |
| `services/ai-cli/codex-session-visibility-repair.js` | 被 Go spawn 的 Node codex proxy 使用 |
| `services/ai-cli/codex-provider-args.js` | 同上 |
| `services/pty/codex-config-sync.js` (738 行) | 同上，迁移阻塞点 |
| `services/pty/codex-config-heal.js` (452 行) | 同上 |
| `services/pty/codex-provider-config-heal.js` | 同上 |
| `config/codex-feature-flags.js` | 同上 |
| `services/server/go-core-build-stamp.js` | 构建工具链；可由 Go 构建脚本直接产出 stamp |
| `services/server/go-core-supervisor.js` | 构建/安装工具链；可改写 `scripts/build-go-server.js` 后删除 |

## 迁移批次

1. **零风险**：删除 284 个不可达文件（独立提交，先 `node --check` 全仓）。
2. **claude credential**：把 `claudedesktopconfig` 的 helper 指向
   `bin/aih __claude-desktop-credential`，删除 Node 包装与对应 lib 模块。
3. **codex 配置**：把 `lib/server/codex-app-server-stdio-proxy.js` 的配置
   merge/heal/visibility 逻辑迁到 Go（`internal/transport/http/codexappserverapi`
   已有代理骨架），完成后删除 6 个 codex 配置模块与 Node helper。
4. **构建工具**：`go-core-build-stamp` / `go-core-supervisor` 由 Go 构建脚本替代，
   删除后 `lib/cli` 仅剩开发脚本依赖。

## 注意事项

- 共享工作区有多个会话同时提交，路径在分析期间出现过瞬时缺失；批量删除应在
  专用 worktree 中基于固定 commit 执行，避免把别人的未提交改动卷进去。
- 284 个不可达文件没有运行时调用方，但可能被仓库外的本地脚本按路径引用；删除前
  保留一个 commit 即可回滚。
