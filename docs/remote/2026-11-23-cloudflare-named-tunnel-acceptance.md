# Cloudflare 具名隧道验收记录

日期：2026-11-23（Asia/Shanghai）
对象：`aih-plugin-cloudflared` v0.1.5
环境：AWS 上正在运行的具名隧道 `proxy.meadeo.com → http://127.0.0.1:9527`
（credentials JSON 模式，生产 systemd 实例 `cloudflared.service` 常驻）

## 1. 目标

1. 用插件 `configure` + `enable` 以 credentials JSON 拉起同一条具名隧道；
2. 从公网 `https://proxy.meadeo.com/readyz` 回源验证；
3. 证明流量确实可由插件副本承接，且不影响生产实例；
4. 校验 `disable` 只停止插件副本。

## 2. 发现并修复的问题

插件原先把 `credentialsFile` 直接当作 `cloudflared --config` 传入。该路径是
credentials JSON（`AccountTag` / `TunnelID` / `TunnelSecret`），不是 cloudflared
配置，cloudflared 打印帮助后立即退出，具名隧道无法启动。

v0.1.5 改为：

- 读取 credentials JSON，生成带 `tunnel`、`credentials-file`、`ingress`
  （`hostname → serviceUrl`，兜底 `http_status:404`）的 `config.yml`（0600）；
- `cloudflared tunnel --config <config.yml> run`，`--config` 固定放在 `run` 之前；
- 若路径本身已是含 `tunnel:` 的 cloudflared `config.yml`，直接使用（向后兼容）；
- 启动失败返回 cloudflared 日志尾部。

## 3. 验收步骤与结果

测试使用凭据副本（0600，仅测试主机可见），与生产 systemd 实例同机并存；
两者 ingress 指向同一 `127.0.0.1:9527`，因此即使流量落在插件副本语义也一致。

| 场景 | 结果 |
|---|---|
| configure（credentialsFile + hostname + serviceUrl） | 通过 |
| enable（生成 config.yml） | 通过，`运行中`，cloudflared 注册 4 条连接（syd06/syd08 等） |
| 公网访问 `https://proxy.meadeo.com/readyz`（双副本） | HTTP 200 |
| **停止生产 systemd 实例，仅保留插件副本** | 连续 3 次 HTTP 200 |
| 恢复生产实例 | `active`，公网 HTTP 200 |
| probe | `运行中` / `outbound-tunnel` |
| disable | 插件进程退出，`已停止`；生产实例持续 `active`，公网 200 |

## 4. 清理

- 测试用 credentials 副本、插件状态目录、临时脚本全部删除；
- 生产 `cloudflared.service`、`/etc/cloudflared` 配置与隧道 ingress 未改动；
- 仓库与文档中不保存 TunnelSecret / credentials 内容。

## 5. 发布

- 插件：`aih-plugin-cloudflared` v0.1.5（commit `faf1994`）
- Release：https://github.com/madou1217/aih-plugin-cloudflared/releases/tag/v0.1.5
- 资产：`cloudflared-0.1.5.aih-plugin`、`public.pem`、`SHA256SUMS`；下载哈希与本地构建一致（`b71a8568…`）。

## 6. Token 模式验证（临时隧道）

为不触碰生产隧道，用本机账号 cert 创建了一条**临时隧道**（不配置 DNS、不配置远程
ingress，因此没有任何公网暴露），仅验证插件的 Token 链路：

| 步骤 | 结果 |
|---|---|
| 插件 configure `{tunnelToken}` | 配置已保存 |
| 插件 enable（`TUNNEL_TOKEN` + `cloudflared tunnel run`） | `运行中`，cloudflared 注册 4 条连接 |
| 账号侧 `cloudflared tunnel list` | 临时隧道连接数 = 4（确认连接归属该隧道） |
| 插件 disable | `已停止`，临时隧道连接数 = 0 |
| 清理 | 删除临时隧道、credentials 与 Token 文件，生产隧道公网 200 |

说明：Token 模式的 ingress 由 Cloudflare 远程管理，本轮没有配置远程 ingress 与 DNS，
因此验证到「Token 被接受、连接建立、可被账号侧观测」为止；域名回源路由属于账号侧配置，
未在本轮覆盖。

## 7. 边界

- 本记录验证了本地 credentials 模式的完整域名回源，以及 Token 模式的连接建立；
- 未修改生产隧道配置，也未修改任何 DNS；
- 若需要验证远程管理 ingress 下的 Token 域名回源，需要在 Cloudflare 侧配置远程 ingress
  与 DNS 后再跑一次。
