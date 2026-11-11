# 反向隧道接 Go：实施计划（2026-11-11）

## 1. 业务流

```
远端 sshd（公网/NAT 外）                     AIH Go（本机，NAT 内）
  127.0.0.1:P  ◀══ SSH 反向转发（Go 发起）══  sshremote.Dial(远端)
       │                                              │
       └─ 远端 ssh 客户端连 127.0.0.1:P ─────────────▶ dial 127.0.0.1:22 → 本机 sshd
```

- Go 主动连远端，在远端**回环**上申请监听端口 P；不开公网端口、不改防火墙。
- 远端连 P 的流量经 SSH channel 回到本机，由本机 sshd 认证；隧道本身不授予权限。
- 配置仍来自 `ssh_connections.reverseTunnel = {remotePort, localPort?}`。

## 2. Node 现状（要迁的语义）

- `lib/remote-workspace/transport/reverse-tunnel.js`
  - `ReverseTunnel`：`forwardIn('127.0.0.1', P)`、accept 后连本机 22、双向 pipe、stats。
  - `probe()`：再次 `forwardIn`；`unable to bind/already in use` = 健康；成功 = 之前丢了，重绑并计 rebounds。
  - `ReverseTunnelSupervisor`：按连接 reconcile；退避 2/5/10/30/60s；30s 探活；配置变化关旧开新。
- 启动时 `server.js` 调 `reconcileReverseTunnels`；连接新增/修改/删除时也调。
- 隧道用**独立 SSH 车道**，不占用户交互会话。

## 3. Go 设计

### 3.1 传输原语

新增 `internal/adapters/sshremote/reverse.go`：

```go
type ReverseTunnel struct {
    remote *Client
    listener net.Listener
    remotePort int
    localTarget string // 固定 127.0.0.1:22（见安全）
    stats Stats
}
func OpenReverseTunnel(ctx, config, remotePort, localTarget) (*ReverseTunnel, error)
func (t *ReverseTunnel) Probe(ctx) error
func (t *ReverseTunnel) Close() error
```

- 用独立 `sshremote.Dial`；`Client.Listen("tcp","127.0.0.1:P")` 申请远端监听。
- Accept 循环：`net.Dial("tcp", localTarget)`，双向 `io.Copy`，half-close。
- `Probe`：再次 `Listen`；bind-taken 视为健康；成功则采用新 listener（rebound）。
- 端口校验 1024–65535；错误码 `tunnel_forward_refused` / `tunnel_bind_failed` / `tunnel_probe_failed`。

### 3.2 监督者

新增 `internal/runtime/sshtunnel/supervisor.go`：

- `Reconcile([]Spec)`：按 connectionId 增删改；旧代次关闭，避免重复绑定。
- 每连接状态：`connecting/open/error/stopped`、attempt、lastError、openedAt、lastProbeAt、stats。
- 退避 2/5/10/30/60s；探活 30s；配置变化立即关旧开新。
- 关闭时取消所有 goroutine、关闭 listener/SSH。

### 3.3 宿主接线

- `internal/host/aihserver/composition.go`：
  - 启动后读取 `ssh_connections`（app-state）→ `supervisor.Reconcile`；
  - shutdown 时 `supervisor.Close()`。
- 配置读取放 Go，避免 Node 再持有隧道逻辑；Phase 3 前 Node 仍写 `ssh_connections`。

### 3.4 管理面

新增 `internal/transport/http/webuisshreverseapi`：

- `GET /v1/management/webui/ssh/reverse-tunnels`：返回各连接状态（不含凭据）。
- `POST /v1/management/webui/ssh/reverse-tunnels/reconcile`：管理密钥；Go 重读 `ssh_connections` 并 reconcile。
- Node 在连接新增/修改/删除成功后调用 reconcile；Node 启动不再本地拉起隧道。
- 路由仍走统一 `webuiroutes.go` 注册表。

## 4. 接流阶段

1. **Phase 1 原语**：`sshremote.ReverseTunnel` + 单测（fake SSH listener、accept/dial/copy、probe、端口校验）。
2. **Phase 2 监督者 + E2E（Node 仍持生产）**：
   - 真实 E2E：临时 sshd 作远端，Go 建反向隧道 P；再从"远端"用 ssh 客户端连 `127.0.0.1:P`，应落到本机 sshd 并执行 `echo REVERSE_TUNNEL_OK`。
   - 覆盖：远端端口占用、AllowTcpForwarding no、断线重连、probe 自愈、reconcile 增删改。
   - 测试使用临时 HOME/随机端口，不碰生产 22/9527；Node 生产逻辑不动。
3. **Phase 3 一次性切流**：
   - `server.js` 删除启动 reconcile；连接变更路由改调 Go reconcile；
   - 启动 Go supervisor；删除 Node `reverse-tunnel.js` 与未用 ssh2 依赖；
   - 用同一提交完成，避免 Node/Go 同时抢同一远端端口。
4. **Phase 4 状态面**：WebUI 显示 tunnel 状态/错误；只在 GET 状态稳定后做。

回滚：Phase 3 前直接 revert 切流提交即可回到 Node；Phase 3 后回滚整个 release（Node 文件已删，不能半切）。

## 5. 安全决策

- 远端监听固定 `127.0.0.1`，端口 1024–65535，禁止公网 bind。
- 本地目标固定 `127.0.0.1`；`localPort` **建议只允许 22**（本机 sshd）。Node 现在允许任意 localPort，等于把任意本地服务暴露给远端，必须收窄；如确有需求，走显式 allowlist，不做通用端口转发。
- 状态/日志只记录 connectionId、端口、状态、错误码，不记录密码/私钥。
- 反向隧道建立前仍走完整 SSH 认证与 known_hosts；远端连入后仍要过本机 sshd 认证。

## 6. 验收清单

- [ ] Go 原语：远端 listener、双向转发、半关闭、Close 清理、端口校验。
- [ ] Probe：bind-taken 健康、重绑成功计 rebound、连接断开失败。
- [ ] Supervisor：退避、探活、reconcile 增删改、旧代次不误关新隧道。
- [ ] 真实 E2E：临时 sshd + 反向端口 + 本机 sshd 回连成功。
- [ ] 故障：端口占用、AllowTcpForwarding no、远端重启后自动恢复。
- [ ] 切流后 Node 无本地隧道逻辑、Go 不可用时状态接口 503、无双重绑定。
- [ ] 文档/迁移矩阵记录真实证据与剩余边界。

## 7. 待确认

1. `localPort` 是否只允许 22？（推荐是）
2. Phase 3 是否允许同时删除 Node `reverse-tunnel.js`，还是先保留一个版本做回滚？
3. 状态面是否需要在 Phase 3 同版上线，还是先只做管理 API？
