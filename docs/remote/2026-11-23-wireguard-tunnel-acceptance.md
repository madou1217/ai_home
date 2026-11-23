# WireGuard 真实隧道验收记录

日期：2026-11-23（Asia/Shanghai）
对象：`aih-plugin-wireguard` v0.1.1（Linux 支持）
环境：Linux 测试机 `desired.cn:22008`（免密 sudo）+ AWS 第二节点（免密 sudo）

## 1. 目标

1. 用插件 `configure` + `enable` 拉起真实 WireGuard 接口；
2. 两端使用真实私钥/公钥完成握手，并验证隧道内 ICMP 与 HTTP；
3. 校验 `disable` 能停用接口并清理系统配置。

## 2. 网络前提与传输路径

端口号不是约束，协议才是。实测两端的入站规则：

| 目标 | 协议/端口 | 结果 |
|---|---|---|
| AWS | UDP 53 / 123 / 443 / 500 / 4500 / 3478 / 51820 | 全部收不到包 |
| AWS | TCP 443 / 80 / 8080 / 8443 / 2222 | 全部连接超时 |
| AWS | TCP 22 | 唯一可达（SSH） |
| desired.cn | UDP 51820 / 443 / 22008 | 全部收不到包 |
| desired.cn | TCP 22008 | 唯一可达（SSH） |

也就是说，AWS 安全组与 desired.cn 的端口映射都只放行了各自的 SSH 端口。把 WireGuard
改听 443 或任何“已知开放端口”都不成立——这些端口在入站方向并未开放；51820 只是
WireGuard 的默认值，与阻塞原因无关。

- AWS 侧无法自行放行：实例 IAM 角色 `AWSEC2RoleforDefaultAWSServiceAccess`
  没有 `ec2:DescribeInstances` / `ec2:AuthorizeSecurityGroupIngress` 权限，本机也没有
  其他 AWS 凭据；路由器不支持 NAT-PMP/UPnP，两台主机也没有全局 IPv6。

因此在“条件无法改变”时的解法是：复用唯一开放端口（SSH/22）承载 WireGuard 的 UDP
报文（两端各一个最小编码的 UDP-over-TCP 中继进程）。WireGuard 仍是真实密钥、真实
握手、真实数据面，没有伪报；这不需要新开端口，也不依赖云权限。

## 3. 插件路径验收

| 检查项 | 结果 |
|---|---|
| configure 写入配置 | 通过，state.json 与配置 0600 |
| enable（Linux） | 通过，`WireGuard 已启用` / `运行中` / `wireguard-tunnel` |
| 配置安装位置 | `/etc/wireguard/wgtest0.conf`，0600 |
| `wg-quick` 启动方式 | `sudo -n wg-quick up wgtest0`（按接口名） |
| 对端握手 | 通过，`latest handshake: 4 seconds ago`，双向 transfer 计数 |
| 隧道内 ICMP | 通过，3/3，RTT 约 318 ms |
| 隧道内 HTTP | 通过，返回 `wireguard-ok` |
| disable | 通过，接口消失，`/etc/wireguard` 配置删除 |
| macOS 行为 | 未改变（仍使用插件状态目录中的配置路径） |

## 4. 修复的问题

Ubuntu 自带的 `wg-quick` 带 AppArmor 配置，只允许读取 `/etc/wireguard`。
插件原先直接对状态目录中的配置执行 `wg-quick up <path>`，会得到：

```text
/usr/bin/wg-quick: line 40: .../wgtest0.conf: Permission denied
```

v0.1.1 在 Linux 上先 `install -m 600` 到 `/etc/wireguard/<iface>.conf`，再按接口名
启动；`disable` 成功后删除该副本。macOS 路径不变。

## 5. 清理

- 两节点 `wg-quick down`，删除 `/etc/wireguard`、临时密钥、中继脚本与 HTTP 服务；
- 卸载临时安装的 `wireguard-tools`，恢复测试机原状；
- 移除 AWS `authorized_keys` 中为本轮 SSH 隧道临时添加的公钥；
- 未修改任何安全组或路由配置。

## 6. 发布

- 插件：`aih-plugin-wireguard` v0.1.1（commit `0c99ab3`）
- Release：https://github.com/madou1217/aih-plugin-wireguard/releases/tag/v0.1.1
- 资产：`wireguard-0.1.1.aih-plugin`、`public.pem`、`SHA256SUMS`；下载哈希与本地构建一致（`87999385…`）。

## 7. SSH 自建传输（v0.1.2）

“开哪个端口”不应成为用户负担。v0.1.2 增加 `transport: "ssh"`：插件复用一台已有
SSH 账号的主机，把 WireGuard 的 UDP 报文按长度分帧走 SSH 的 stdin/stdout，两端都只
使用环回 UDP 端口（默认 `localUdpPort=51822`、`remoteUdpPort=51821`），不监听任何
公网端口，也不需要在对端开放新端口或使用常用端口。

验收（Linux 测试机，2026-11-24）：

| 检查项 | 结果 |
|---|---|
| 插件 configure（transport=ssh） | 通过 |
| 插件 enable | 通过，`运行中` / `wireguard-tunnel` |
| WireGuard 真实握手 | 通过（对端为独立网络命名空间中的内核 WireGuard） |
| 隧道内 ICMP | 通过，3/3 |
| 隧道内 HTTP | 通过，返回 `netns-http-ok` |
| 插件 disable | 通过，接口与 SSH 中继均停止 |
| 对外监听端口 | 无（仅本机环回） |

说明：该轮对端是测试机上的独立网络命名空间，用于消除对 AWS 实例的依赖；SSH 传输的
代码路径（ssh 子进程、分帧、内核 WireGuard 握手）全部经过真实执行。跨主机版本此前已
用同一传输方式（手工中继）验证过。

## 8. 边界

- 本记录没有使用原生 UDP 入站路径；若需要验证 NAT 穿透/原生 UDP 性能，需要先开放
  任一侧的 UDP 端口（AWS 安全组或 desired.cn 路由器）；
- 隧道密钥与地址均为一次性测试值，已随环境清理删除。
