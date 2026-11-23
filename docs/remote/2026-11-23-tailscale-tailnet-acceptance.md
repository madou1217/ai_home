# Tailscale 真实 tailnet / P2P 验收记录

日期：2026-11-23（Asia/Shanghai）
对象：`aih-plugin-tailscale` v0.1.6（Linux 支持）
环境：Linux 测试机 `desired.cn:22008`（免密 sudo）+ AWS 第二节点（免密 sudo）

## 1. 目标

1. 用插件 `configure` + `enable` 把节点加入真实 tailnet，不依赖浏览器登录；
2. 从第二个节点经 tailnet IP 访问第一个节点，证明数据面可用；
3. 校验连通性口径：`direct-p2p` 只在 `Peer.CurAddr` 出现时报告，否则报告 `derp-relay`；
4. 校验 `disable` 与无免密 sudo 时的失败边界。

## 2. 环境准备

- 两台 Ubuntu 主机安装 Tailscale 1.104.7 静态包（`tailscaled` systemd 服务）；
- auth key 使用 reusable key，两台主机分别入网；
- Linux 测试机上 `RuntimeDirectoryMode=0755`，保证普通用户可读取 daemon socket 状态。

## 3. 插件路径验收

通过插件协议直接驱动 connector（`prepare` → `operate configure` → `operate enable` → `operate probe` → `operate disable`）。

| 检查项 | 结果 |
|---|---|
| configure 写入 authKey | 通过，`state.json` 0600，状态目录 0700 |
| install（已安装场景） | 通过，返回 `tailscale 已安装` 与版本 1.104.7 |
| enable | 通过，`已连接 Tailnet`，状态 `运行中` |
| enable 使用的权限 | Linux 下 `sudo -n tailscale up --auth-key=file:<临时文件> --reset` |
| auth key 是否出现在 argv | 否，使用 `--auth-key=file:`，临时文件用后删除 |
| 无免密 sudo 时 enable | 返回「需要管理员权限：请在终端执行 sudo tailscale up 后重试」，状态不变，无阻塞 |
| disable | 通过，`已断开 Tailnet`，状态 `已停止（Stopped）` |
| macOS 行为 | 未改变（仍走 `TS_AUTHKEY`，不调用 sudo） |

## 4. 真实数据面

- AWS 节点 → Linux 节点 tailnet IP 的 HTTP 请求返回 `tailnet-ok`（HTTP 200）；
- `tailscale ping` 显示直连路径：
  `pong from model (100.95.21.77) via 222.82.10.115:61737`；
- 反向 `pong` 同样为直连，非 DERP。

## 5. 连通性口径

| 场景 | 插件报告 | 证据字段 |
|---|---|---|
| 刚连接、尚无直连路径 | `derp-relay` | `Peer.Relay`（syd / sfo） |
| 产生流量后建立直连 | `direct-p2p` | `Peer.CurAddr=16.178.55.97:41641` |
| 断开后 | `unavailable` | 无运行中的 daemon 状态 |

两种模式都由 `tailscale status --json` 的实际字段决定，没有把中继冒充直连。

## 6. 清理

- 两节点 `tailscale down`/`logout`，停止并删除 `tailscaled` 服务与二进制；
- 删除测试插件状态目录（含测试 auth key）、临时 key 文件与临时 HTTP 服务；
- 注意：Linux 节点先删除了 `/var/lib/tailscale` 状态，无法再执行 logout，管理台可能残留一台离线设备（主机名与测试机一致），可在 Tailscale 管理台手动移除。

## 7. 发布

- 插件：`aih-plugin-tailscale` v0.1.6（commit `2aef7a4`）
- Release：https://github.com/madou1217/aih-plugin-tailscale/releases/tag/v0.1.6
- 发布资产：`tailscale-0.1.6.aih-plugin`、`public.pem`、`SHA256SUMS`；下载哈希与本地构建一致（`06f838ea…`）。

## 8. 边界

- 本记录覆盖 Linux 插件路径与真实 tailnet 数据面；macOS 仍按原有路径运行；
- 未覆盖 Tailscale ACL/tag 策略与大规模 mesh；
- 连通路径会随 NAT/空闲状态在直连与 DERP 之间切换，插件报告的是探测时刻的观测值。
