# Go 全量接管实施蓝图（2026-10-22）

> 前提（用户 2026-10-22 决策）：**终局是 Go 全量接管**，Node 逐步下线。
> 配套清单见 `docs/architecture/2026-10-22-go-node-alignment-inventory.md`（差距盘点）。
> 本文是**执行手册**：分阶段、每阶段的入口/出口条件、验证手段、风险。

## 0. 地基已验证（不是推测）

| 关键未知数 | 验证方式 | 结果 |
|---|---|---|
| Go 能否起真 PTY | `creack/pty` 实跑 `/bin/sh`，读回显与 tty 设备 | ✅ 拿到 `/dev/ttys044` |
| Windows 能否编译 | `GOOS=windows CGO_ENABLED=0 go build` | ✅ 4.6MB 静态二进制 |
| mmdb 本地查询 | 本次交付，Node/Go 同文件逐条一致 | ✅ |
| 跨平台 PTY 抽象 | `aymanbagabas/go-pty`（Unix 用 creack，Windows 用 ConPTY） | ✅ 可拉取、可编译 |

**结论**：全量迁移没有「技术不可行」的阻塞项，剩下的是工程量与顺序。

## 1. 规模对照（Node 侧待迁）

| 能力面 | Node 文件数 | Go 现状 |
|---|---|---|
| WebUI 管理面（`webui-*`） | 87 | 无 |
| chat 运行时（`chat-runtime/`） | 104 | 无 |
| Codex 专项（`codex-*`） | 100 | 无 |
| 原生会话引擎（`native-*`） | 42 | 无 |
| PTY / 终端（`pty/`） | 28 | 无（依赖已验证） |
| Fabric（`fabric-*`） | 20 | 无 |
| 远程节点（`remote/`） | 19 | 无 |
| 工具箱（`toolkit/`） | 203 | 无 |
| **合计** | **~600** | 约 21 个领域包 |

Go 侧现有：`application/*` 21 包 + `internal/*` + `core/*`，已覆盖推理面与 provider 层。

## 2. 分阶段计划

原则：**每一阶段结束时，系统都处于可发布状态**（不是「半年后一起切」）。

### P0 推理面切所有权（功能已就绪，只差切换）

- **入口条件**：无（Go 已实现全部 7 条 capability route）
- **动作**：跑 `npm run gateway:shadow -- --node <url> --go <url>` 全量对比 →
  逐 entry 走 `node_owned → write_frozen → migrated_and_verified → go_owned`
- **出口条件**：15 条 `cutover_blocking` entry 全部 `go_owned`
- **风险**：低。Go 已在跑（`private_canary`），只是流量没切
- **收益**：最高（唯一「已做完只差临门一脚」的部分）

### P1 控制面 `/v0/management/*`（30 条）

- **入口条件**：P0 完成
- **动作**：`usage/*`（15 条）优先——Go 已有 `accountusage`/`accountusagefeed` 领域包，复用度高；
  其余按 `docs/functional-matrix.md` 判定归属
- **需决策**：`/reload`、`/restart`、`/shutdown` 属进程生命周期，**建议保持 Node**（Go 管不了自己的重启）
- **出口条件**：usage 类全部 go_owned；生命周期类明确标注保留理由

### P2 PTY / 多路复用（28 文件，地基已验证）

- **入口条件**：P0/P1 完成（或并行，与推理面无耦合）
- **动作**：
  1. 移植 `lib/runtime/multiplexer/` 的 **driver 模式**（tmux/herdr 各一个 driver）到 Go；
  2. PTY 运行时（`pty-runtime-spawn/run/launch`）→ Go，用 `creack/pty`(Unix) + `go-pty`(Windows)；
  3. 保留 `ansi-terminal-screen` 的终端解析（Go 有等价库或自行移植）
- **出口条件**：`aih <provider>` 的 PTY 会话在 macOS / Windows 真机跑通
- **风险**：中。Windows ConPTY 与 Unix 行为差异（已有真机 `madou@192.168.3.76` 可验）

### P3 原生会话引擎 + chat 运行时（42 + 104 文件）

- **入口条件**：P2 完成（会话依赖 PTY）
- **动作**：`native-session-chat`、`native-run-adoption`、`native-approval-bridge`、`chat-runtime/*`
  —— 注意这与 **legacy→canonical 收敛**（见 inventory §6）是同一批代码，**两件事一起做**，不要迁两遍
- **出口条件**：canonical 表面覆盖全部 14 个 provider，legacy 可删
- **风险**：高。这是全项目最复杂的一块（审批桥、事件流、恢复）

### P4 Codex 专项（100 文件）

- **入口条件**：P3 完成
- **动作**：`codex-app-server-*`、`codex-*-adapter`、`codex-*-heal` 等
- **需决策**：app-server 是 Codex CLI 的 stdio 协议代理，Go 侧要重新实现协议桥
- **风险**：中高（协议细节多，但有 `contracts/` 可对照）

### P5 WebUI + Fabric + 远程节点（87 + 20 + 19 文件）

- **入口条件**：P3/P4 完成
- **动作**：WebUI 后端（前端可继续用现有 React，只换 API 实现）；
  Fabric 与远程节点是分布式能力，需先确认是否仍要
- **需决策**：**WebUI 前端是否也换**（现在 `web/` 是 React，Go 侧可继续服务同一份 dist）
- **风险**：中

### P6 工具箱 + CLI 收尾（203 文件）

- **入口条件**：P5 完成
- **动作**：`aih` CLI 已部分在 Go（`cmd/aih`），补齐工具箱（应用管理、镜像、环境、订阅聚合等）
- **出口条件**：Node 仅剩无法迁移的部分（或完全移除）

## 3. 横向要求（每阶段都要满足）

1. **契约先行**：新增能力先在 `contracts/` 声明，再实现（项目既有纪律）
2. **双跑验证**：能用 `gateway:shadow` 的都用；不能的（PTY/会话）用**真机 A/B**
3. **所有权状态机**：每个 entry 必须走完 `node_owned → … → go_owned`，不允许「直接换」
4. **不允许双写**：迁移期间数据只有一个所有者，避免两侧状态分叉
5. **Node 侧冻结**：entry 进入 `write_frozen` 后不再加新功能

## 4. 需要你决策的点（按时间顺序）

| # | 决策 | 影响 |
|---|---|---|
| 1 | `/reload`、`/restart`、`/shutdown` 是否保留 Node | P1 范围 |
| 2 | **legacy 与 canonical 是否合并成一次迁移**（建议：是） | P3 工作量可减半 |
| 3 | WebUI 前端是否也重写 | P5 范围 |
| 4 | Fabric / 远程节点是否仍要（若不是，P5 可砍掉 39 文件） | P5 范围 |
| 5 | 每阶段的节奏（一次一个大阶段，还是按能力并行） | 排期 |

## 5. 立即可以开始的事（不依赖任何决策）

1. **P0 切所有权**——功能已就绪，`gateway:shadow` 跑起来就能逐条切；
2. **P2 的 PTY 抽象**——把 `lib/runtime/multiplexer/` 的 driver 契约翻成 Go 接口（纯设计，不依赖其他阶段）。

## 附：复现与验证命令

```bash
npm run gateway:routes                  # 差距盘点
npm run gateway:shadow -- --node <url> --go <url>   # P0 切所有权前的对比
npm run providers:audit                 # provider 采集面
npm run chat:legacy-readiness           # P3 的 legacy 退役就绪度
go test ./... && go build ./...         # Go 侧健康度
```
