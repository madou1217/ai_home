# 借用远端代理与 P2P 隧道设计

状态：传输与出口分层已落地；SSH 本地转发借用 Windows 代理已真机验证；直连 P2P 尚未安装网络连接器插件，不作已打通声明。

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
| SSH 本地转发 | Mac 能 SSH 到 Windows/Linux；最稳定 | 已实现 `--ssh` 自动转发并真机验证 |
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
3. `--system` 系统代理写入/恢复（macOS 真机验证；Windows/Linux 使用系统无认证入口）；
3. `network.connector` 插件宿主与实装（Tailscale/WireGuard）；
4. 连接器证据采集与 UI 状态（direct/relay/unknown 分开）；
5. 只有插件给出可复核 path 证据后，才启用“直连 P2P”文案。
