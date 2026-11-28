# 透明 TCP 重定向设计（Windows）

目标：不依赖应用读取 `HTTP_PROXY` / `--proxy-server`，把受保护进程树的外部 TCP 连接透明地接到该实例的代理入口。首个原型使用已签名的 WinDivert 驱动；WFP `ALE_CONNECT_REDIRECT` 作为产品化后端。

## 数据流

1. 出站句柄：`outbound and tcp and not loopback`。
2. 对受保护 PID 的 SYN，分配映射 `(srcIP,srcPort,dstIP,dstPort) -> clientPort`，把包改写为
   `src=127.0.0.1:srcPort, dst=127.0.0.1:relayPort`，重算 IPv4/TCP checksum 后重新注入。
3. 单实例一个 relay listener（`127.0.0.1:relayPort`），按 `clientPort` 查原目标；用该实例的代理 URL 发起 HTTP CONNECT（或 SOCKS5），双向拷贝。
4. 回程句柄：`inbound and tcp and loopback and tcp.SrcPort == relayPort`。
   把 relay 发出的包改写为 `src=dstIP:dstPort, dst=srcIP:srcPort`，重算 checksum 后按 inbound 注入。
5. 非受保护 PID / 非映射 5 元组一律原样重注入。

## 必须处理的边界

- **MSS**：loopback 握手会协商超大 MSS。relay 侧 `TCP_NODELAY` + 每次写入 ≤1200 字节，避免超大段进入外部路径；后续可在 SYN-ACK 中改写 MSS option。
- **checksum**：IPv4 header + TCP pseudo-header 全量重算；WinDivert 地址结构只重用捕获方向，不手工构造。
- **UDP/QUIC**：原型继续阻断受保护进程的外部 UDP（现有 WinDivert 逻辑），迫使应用回落 TCP；UDP ASSOCIATE 后续再做。
- **DNS**：Dnscache 由 svchost 代发，不在实例 PID 集；Phase 5 单独处理。
- **PID 复用**：沿用创建时间校验；映射表在 PID 被清理时同步删除。
- **失败语义**：relay 无法连代理时立即关闭；不得把连接改回直连。代理断开时应用看到连接失败。
- **单 guard 进程**：多个 WinDivert 句柄会重复注入，必须由一个 guard 持有两个句柄并维护全部映射。

## 验收

1. 受保护 Chrome（`--no-proxy-server`）能打开 HTTPS 页面，代理日志出现对应 CONNECT。
2. 同 exe 两个实例分别指向不同代理入口，出口 IP 不同。
3. 代理入口断开：页面失败，抓包无直连 SYN。
4. 非目标进程网络不受影响；loopback 代理连接正常。
5. kill 实例后 relay、映射、guard 全部清理。

## 风险

用户态 NAT 的窗口/分片/重传边界较多，必须先做 IPv4/TCP/单实例原型并抓包验证；WFP redirect 是长期方案。