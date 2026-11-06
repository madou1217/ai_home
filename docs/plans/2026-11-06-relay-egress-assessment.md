# relay / egress 迁移评估（2026-11-06 只读）

> 结论：mux 可迁，但**前提是 Go 已持有监听端口**；egress 池不是 S 级；peer-dispatch 与 relay-settings 不迁。

## 1. 链路与依赖

| 模块 | 行数 | 做什么 | 复杂度来源 |
| --- | ---: | --- | --- |
| relay-port-mux | 440 | 同端口 TCP 首字节分流：`0x05` → SOCKS5（用户名 `n`+sha1(nodeId)12 位选节点），其余原样交 http.Server；CONNECT 直通回环边车，ASSOCIATE 注册 UDP 前端并改写 BND | peek + 回填 listener、连接热路径 |
| relay-udp-front | 180 | 同号 UDP：共享 socket + 两张表（sidecar BND / client ip:port），首报锁定客户端，120s 空闲回收 | NAT/frp advertise、歧义丢弃 |
| local-relay + kernel-sidecar + relay-config | ~1.4k | sing-box/mihomo 子进程、配置编译、端口探测、就绪探活、fail-closed | **主体复杂度在这里**，mux 只是壳 |
| egress-*（17 文件） | ~1.1k | 本地 mihomo + controller API + mixedPort/lanes + 健康/geo/车道规划 | 跨进程状态、孤儿回收 |
| peer-dispatch-daemon | 115 | peer 收件箱补投（3s） | 与 relay 无关 |
| relay-settings | 48 | `AIH_RELAY_SETTINGS` 的 k=v 投影 | 配置契约，两侧共读 |

## 2. Go 现状

- 已有：`net.ListenConfig` + `Serve(net.Listener)`、Hijacker、`tls.Server`、单连接 listener（`claude_oauth_connect.go:25`）→ 分流与透传可实现；net/http 原生支持 socks5 客户端。
- 缺失：SOCKS5 **服务端**与常量时间认证、UDP 中继、egress 全部（658 个 .go 零命中）、用户名→回环端口的跨进程映射、按账号 proxy transport（全仓仅 `ProxyFromEnvironment`）。
- 语义差异：stdlib 把 socks5 等同 socks5h（远端解析），Node 是本地解析。

## 3. 切片排序

**S（建议先做）**：mux 的「首字节分流 + SOCKS5 认证 + CONNECT 透传」，UDP ASSOCIATE 同批（关联表是内存态，单独搬没意义）。
**前提**：Go 已持有该监听端口（P3 前门）；否则只能另开回环口，不算真迁。
验收：同端口 HTTP 仍 200（分流未坏）+ `curl --socks5-hostname n…:pw@host:port` 命中指定节点出网 + 一次 UDP ASSOCIATE 往返、断控制连接后关联消失。

**A**：egress 池（mihomo 子进程 + 控制面/健康/车道）。验收是「经 lane 的 HTTPS 200 且出口 IP 改变」，跨进程状态与孤儿回收让它不是 S。

**不迁**：peer-dispatch-daemon（绑 Node peer store/tmux）、relay-settings（两侧共读的配置契约）。

## 4. 风险

- **认证**：凭据文件双读、轮换=删文件重启；UDP 前端本身不认证，未锁定窗口内能到 UDP 端口者可抢注关联（威胁模型需确认）。
- **性能/正确性**：mux 在全部 HTTP/WS 连接热路径，peek+回填出错=全站不可用；**全仓无 relay 测试**，迁之前必须补 golden 用例。
- **UDP 语义**：BND 改写、advertise 主机/端口、client 锁定与歧义丢弃须逐条对齐，否则串节点或回程丢失。
- **耦合**：relay 与 egress 只共享节点库+编译器，别把协议矩阵一起搬（热点文件）。
- **回滚**：保留 `portMode` 开关与 Node 实现，Go 版共用同一凭据文件并行切换；客户端配置不变即可回退。

## 5. 待确认

1. P3 前门切流时间点（决定 Go 是否已持 listener）；
2. Go 侧是否允许新增 `x/net` 依赖；
3. UDP 抢注的威胁模型边界。
