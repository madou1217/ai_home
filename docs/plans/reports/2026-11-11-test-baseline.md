# 全量测试基线（2026-11-11）

分支：`slice/mig-test-baseline`（worktree `/tmp/mig-test-baseline`，基线 `main @ 98cf3669`）
目的：给并行迁移切片一个可信的「改之前哪里是红的」快照；只修测试/基础设施，生产回归只报告。

## 1. 环境与命令

| 项 | 值 |
| --- | --- |
| Go | go1.27.3 darwin/arm64 |
| Node | v22.21.0 |
| Go 命令 | `go test ./... -timeout 300s` |
| Node 命令 | `node --test --test-timeout=180000 test/*.test.js` |

worktree 没有依赖目录，测试前临时软链（不提交、跑完删除）：

```sh
ln -s <主工作区>/node_modules node_modules
ln -s <主工作区>/web/node_modules web/node_modules
```

## 2. 结果总览

| 套件 | 包/文件 | 用例 | 通过 | 失败 | 跳过 |
| --- | --- | --- | --- | --- | --- |
| Go | 267（182 有测试 / 84 无测试 / 1 失败） | — | — | 1 个包 | 0 |
| Node（修后） | 346 文件 | 2194 | 2187 | 6 | 1 |

失败全部落在 5 类，没有一条是「迁移切片改坏生产」的泛红：

| # | 类别 | 用例数 | 判定 |
| --- | --- | --- | --- |
| A | worktree 缺 `web/node_modules` | 36（15 个文件） | 环境，软链后全绿 |
| B | 路由已切 Go、测试没跟 | 1 | 测试过期，已修 |
| C | 断言与新旗标值不一致 | 1 | 测试过期，待人确认（auto-switch 归属） |
| D | 回归守卫无实现 | 5 | 生产缺口，不猜修 |
| E | 终端 `TERM` 依赖宿主环境 | 1（Go） | 生产与 Node 行为不一致，不猜修 |

首轮失败 22 例 = A 15 + B 1 + C 1 + D 5；补依赖并修 B 之后剩 6 例（C 1 + D 5）。

## 3. 明细

### A. 缺依赖（15 个文件，非代码问题）

`test/chat-large-paste-settings.test.js`、`test/hud-*.test.js`、`test/web-*.test.js`、
`test/workbench-divider-drag.test.js` 直接 `require('../web/node_modules/typescript')`。
worktree 不共享主工作区的 `web/node_modules`，于是整文件失败（首轮被记成 15 个文件级失败，
补齐依赖后才展开成 36 例）。补软链后这批 36 例全通过。

### B. SSH 工作区终端状态路由（已修）

`test/ssh-remote-supervisor.test.js:148`：503 !== 200。
`GET /v0/webui/ssh-workspaces/sessions` 在 7d9192f8 已切 Go 代理
（`lib/server/webui-ssh-host-routes.js:535`，只读 `deps.goCoreSync.getSshWorkspaceSessions`），
用例还在注入老的 `probeTerminalSession`。改为注入 goCoreSync 并按 Go 的
`{ok, sessions:[...]}` 透传断言，200 与 sessions 深等断言原样保留。
Go 不可用 → 503 已由 `test/webui-ssh-connections-go-proxy.test.js:100` 覆盖。

### C. 自动换号 family 旗标（待人确认）

`test/switch-rejection-format.test.js:72` 断言 `options.family === true`；
`lib/cli/services/pty/usage-status-runtime.js:543` 在 783e5618 已改成 `family: false`
（注释：自动换号只在本站找目标，跨站是用户显式选择）。测试行还是 42a242af 的旧值。
已与 mig-autoswitch 对齐后再决定改断言还是改生产，本切片不单方面改。

### D. 共享日志用量归属：守卫在、实现不在（生产缺口）

`test/codebuddy-shared-log-ownership.test.js` 5 例失败：

| 用例 | 失败 |
| --- | --- |
| parseLogPidUser 只认同 pid 的 userId | `parseLogPidUser is not a function` |
| 单进程会话可按 pid → userId 归属 | `sessionOwner()` 返回 null |
| 同一会话多账号写入保持空归属 | 断言失败（同上，共享日志根本没被扫到） |
| 注册表：nativeSessionId 唯一可归属 | `readRegistrySessionOwners is not a function` |
| 注册表：两会话续写不归属 | 同上 |

事实：该测试文件由 783e5618 新增（170 行），但同一提交没有改任何 `lib/usage/*`；
全仓与全 history 也没有 `parseLogPidUser` / `readRegistrySessionOwners` 的实现
（`git log --all -S` 仅命中该测试提交）。
`createNativeMessageOwnership` 目前只扫账号投影里的私有日志
（`discoverPrivateLogs`），不读 `~/.codebuddy/logs` 共享日志，也忽略 `resolveLogOwner`。
即：**守卫是提前提交的，实现从未落地**。删测试或改断言会直接抹掉这条守卫，故不修，原样报红。

### E. Go：终端会话 TERM（环境相关 + 与 Node 不一致）

`internal/runtime/terminalsession` / `TestServiceSessionLifecycle/创建会话并规范化尺寸`：
`spec.Env 缺少 TERM=xterm-256color`。

- 本机 `TERM=tmux-256color` 时失败；`env -u TERM` 后通过 → 纯环境相关。
- 实现 `service.go:710` 只在宿主没有 TERM 时补 `xterm-256color`；
  测试要求结果里必须是 `TERM=xterm-256color`。
- 迁移前的 Node WebUI 终端是**强制覆盖**：`lib/server/webui-terminal-routes.js:102`
  `{ ...process.env, TERM: 'xterm-256color' }`（59311dfb 前）。
  所以测试钉的是 Node 契约，Go 侧目前是行为回归，只是 CI 环境没有 TERM 会掩盖。
- 建议修法（未改生产）：`terminalEnvironment` 把 TERM 固定为 `xterm-256color`，
  仅当调用方 `Spec.Env` 显式给了 TERM 时让位。等 terminalsession 归属的切片处理。

## 4. 跳过

1 例：`真机：创建 → 列表 → 停用 → 删除`，`# SKIP 未设置 AIH_GO_MANAGEMENT_URL/KEY`（真机 Go 管理面 e2e，预期跳过）。
Go 侧无 SKIP。

## 5. 结论

- 干净环境下 Go 只有 1 个包红（E），Node 有 6 例红（C 1 + D 5）；其余 15 个文件的红是 worktree 缺依赖。
- 迁移切片自测时照抄本文件的软链步骤，否则会把「缺 typescript」当成回归。
- 历史上有名的 dbpool 性能用例在本仓已不存在（全仓无 dbpool 包），本机跑全量不再有那类噪声；
  Go 工具链完整，无缺依赖导致的跳过。
- 修完 B 之后重跑全量的数字见第 2 节；C 待 mig-autoswitch 确认后落地。
