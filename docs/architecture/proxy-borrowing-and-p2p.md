# 借用远端代理与 P2P 隧道设计

状态：传输与出口分层已落地；SSH 本地转发借用 Windows 代理已真机验证；WebUI 本机入口面板由核心维护并已验证启停/HTTP/SOCKS5；`--peer` 在 Mac→Windows 与 Mac→AWS→Windows 链路上借用 Windows Clash 出口（SG）真机验证；直连 P2P 仍要求 `network.connector` 给出可复核路径证据，当前不作“已打通直连 P2P”声明。

## 1. 三个平面必须分开

| 平面 | 负责 | 现有实现 |
| --- | --- | --- |
| 控制面 | 候选、租约、管理鉴权、过期回收 | `/v1/management/proxy-candidates`、`/v1/management/proxy-leases` |
| 传输面 | 把本机控制/数据流量送到远端 AIH | SSH 本地转发（已验证）、SSH 反向隧道/中继（已有组件）、network.connector 插件（契约已定义） |
| 出口面 | 真正访问互联网的代理或内核 | Windows Clash Verge mihomo、AIH egress engine 插件、本机中转边车 |

“有公网 endpoint”不等于 P2P；“连接成功”不等于直连。三者必须分别报告。

## 2. 借用 Windows 代理

已验证路径：

```text
Mac aih proxy serve --ssh <connectionId>
  -> SSH direct-tcpip -> Windows loopback AIH
  -> Windows AIH /v1/management/proxy-leases
  -> /connect HTTP Upgrade (aih-proxy)
  -> Windows lease 的 loopback mihomo / sing-box
  -> ssrdog 节点
```

`aih proxy serve` 做三件事：

- 通过管理面申请一个租约；
- 在当前主机建立 `127.0.0.1` 的认证 HTTP 与 SOCKS5 入口；
- `--ssh <connectionId>` 使用本机已保存的 SSH 连接自动建立本地转发，无需手工 `ssh -L`。

`--system` 会额外启动一个仅 loopback 的匿名 HTTP 入口供操作系统系统代理使用：
系统代理无法可靠保存每个应用的凭据，因此这个入口跳过客户端认证，但上游仍使用
租约令牌认证。该入口只在显式 `--system` 时创建，退出时恢复原系统代理。

它不会自动改系统代理，也不把管理密钥写进代理 URL。输出中的 URL 含租约令牌，终端可见，但不得写入日志或提交。

操作系统/应用接入：

- 任意应用：使用输出的 `HTTP_PROXY` / `HTTPS_PROXY`；
- macOS 系统代理：使用同一 host/port 与 Basic 认证；
- 任务型 CLI：复用现有 `--proxy` lease ingress，而不是再起一套实现。

## 3. 传输面选择

| 传输 | 适用 | 状态 |
| --- | --- | --- |
| SSH 本地转发 | Mac 能 SSH 到 Windows/Linux；最稳定 | 已实现 `--ssh` 自动转发并真机验证；`--ssh-via` 可指定跳板 |
| SSH mesh 跳板 | 已有 Mac↔Windows、Mac↔AWS、Windows↔AWS 链路 | 已真机验证 Mac→AWS→Windows→Clash 出口 |
| SSH 对等借用（`--peer`） | 对端自己运行 aih，且不共享管理密钥 | 已实现并在 Mac→Windows、Mac→AWS→Windows 真机验证；远端密钥不出对端 |
| SSH 反向隧道 + 公网中继 | 双方都在 NAT 后，但有一台可达中继 | 已有 `sshtunnel` / reverse tunnel 组件，可复用 |
| Tailscale | 需要设备间 mesh、DERP 回退 | 通过 `network.connector@1` 外部插件；未安装/未验证 |
| WireGuard | 固定节点、可接受手工 peer 配置 | 通过外部插件；未验证 |
| Cloudflare Tunnel | 只暴露 HTTP，不应冒充节点间 P2P | 外部插件；未验证 |
| WebRTC/QUIC 打洞 | 未来低延迟路径 | 未实现 |

## 4. 直连 P2P 的边界

连接器必须用证据区分：

- `direct-p2p`：两端观察到直接路径，无中继；
- `peer-relay`：同一网络的对等中继；
- `derp-relay`：厂商云中继；
- `outbound-tunnel`：仅出站隧道（Cloudflare 类）；
- `wireguard-tunnel`：握手成功但未证明路径；
- `unavailable` / `unknown`。

禁止把 `derp-relay`、`outbound-tunnel` 或“公网 endpoint 可连”展示为直连 P2P。路径变化时必须允许降级。

## 5. 安全边界

- 远端 AIH 默认只监听 loopback；跨机必须显式建立传输，不直接暴露管理端口。
- 管理密钥只用于控制面；数据面使用租约令牌。
- 本机入口只绑定 loopback，并要求 `Proxy-Authorization`。
- 租约有过期和显式释放；客户端退出应释放，异常退出由服务端到期清理。
- 日志/错误不得回显管理密钥、租约令牌或节点凭据。
- 网络连接器插件是进程权限边界：只接受签名制品，安装/启停必须显式确认。

## 6. 后续实现顺序

1. `aih proxy serve` HTTP + SOCKS5（已实现并真机验证）；
2. `--ssh <connectionId>` 自动 SSH 本地转发（已实现并真机验证）；
   `--ssh-via <connectionId>` 使用已有链路做跳板（Mac→AWS→Windows 已验证）；
3. `--system` 系统代理写入/恢复（macOS 真机验证；Windows/Linux 使用系统无认证入口）；
3. `network.connector` 插件宿主与实装（Tailscale/WireGuard）；
4. 连接器证据采集与 UI 状态（direct/relay/unknown 分开）；
5. 只有插件给出可复核 path 证据后，才启用“直连 P2P”文案。

## 7. 本地 TUN

`aih proxy serve --tun` 通过 `internal/runtime/tuningress` 生成 sing-box TUN 配置，
把租约的认证 HTTP 入口作为唯一出站。`--tun-dry-run` 只生成并执行 `sing-box check`，
不创建接口、不改路由；真正启动需要 root/管理员权限，且是显式的网络层接管。
外部 TUN（Clash Verge 等）与系统代理的所有权冲突必须由调用方显式报告，不能静默争抢。

## 8. WebUI 操作面

本机入口的操作面板由**核心项目维护**，不交给插件提供任意 UI：

- 插件只贡献 `egress.engine` / `network.connector` 能力，不拥有入口会话；
- 会话生命周期必须由宿主唯一持有，否则无法保证同时只有一个入口去申请租约、
  占用系统代理和监听回环端口；
- 管理面契约是 `GET/POST /v1/management/webui/proxy-serve[/start|/stop]`，
  由 `internal/runtime/proxyserve` 启动同目录 `aih-go proxy serve --json` 子进程；
- 子进程只拿到 `AIH_HOME_DIR` 与管理密钥环境变量，不把密钥写进命令行；
- `--system` / `--tun` 需要操作系统提权，面板只展示可复制命令，不静默执行；
- 入口停止或意外退出后，带租约令牌的 URL 不再回传，客户端退出必须释放监听。

## 9. SSH 对等借用（`--peer`）

`--ssh` 复用本机管理密钥，适合两端共享同一管理信任根。独立安装的对等节点通常
各有自己的 Management Key，因此新增 `--peer <connectionId>`：

```text
Mac aih proxy serve --peer <windowsConnectionId> [--peer-via <jumpId>]
  -> SSH 会话在 Windows 执行固定的 `aih proxy serve --json --selector ...`
  -> Windows CLI 用它自己的 Management Key 申请 Windows 租约、建立 loopback 入口
  -> Mac 只经 SSH direct-tcpip 转发入口端口，返回本地 HTTP/SOCKS5 URL
```

- 远端密钥与租约控制面不出对端；本机只拿到入口 URL（含租约令牌）。
- `--peer-via` 复用已保存的 SSH 连接作为跳板，已验证 Mac→AWS→Windows→Clash 出口。
- 远端 CLI 必须支持 `--exit-on-stdin-eof`；本机通过关闭 SSH stdin 让远端走正常退出路径并释放租约，
  不依赖平台的 SIGTERM 或 `taskkill`。
- 远端 aih 路径默认按 PATH、Homebrew、`~/.ai_home/bin`、Windows `%LOCALAPPDATA%`/`$env:` 探测；
  也可用 `--peer-aih <path>` 显式指定。
- 这是**对等中继**，不是直连 P2P。只有 `network.connector` 插件观察到 `direct-p2p` 的
  `CurAddr` 等路径证据时，才能使用“直连 P2P”文案。
