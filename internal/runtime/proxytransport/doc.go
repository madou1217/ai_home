// Package proxytransport 把远端 AIH 管理面映射成本机 loopback 入口。
//
// 这一层只负责传输：它持有一条到远端管理面 loopback 地址（默认
// 127.0.0.1:9527）的字节通道，并暴露本机 loopback base URL；Management Key、
// 代理租约与系统代理设置都不属于本包。调用方把 Transport.BaseURL() 当作
// AIH_SERVER_BASE_URL 使用即可。
//
// # 约束
//
//   - 本地监听与远端地址都只允许 loopback；不接受对外网卡暴露。
//   - SSH 传输只用 direct-tcpip（sshremote.Client.DialTCP）搬运字节，从不执行
//     远端命令。Connector 接口刻意不提供命令执行能力，使该保证由类型约束而
//     不是调用纪律来维持。
//   - 本包不访问 app-state / SQLite：ssh_connections 与 ssh_known_hosts 以原始
//     JSON 与指纹 map 传入，读取存储是调用方的职责。
//   - Close 幂等：重复调用返回同一次关闭的结果，底层连接器只关闭一次。
//
// # 扩展点
//
// direct / tailscale / wireguard / relay 等未来连接器不需要改动 SSH 传输：
// 实现 Dialer 与 io.Closer（合起来即 Connector），再复用包内的 loopback
// 转发器（newForwarder）即可获得同样的连接跟踪、幂等关闭与 BaseURL 语义。
// 本包不实现任何厂商 P2P 协议，也不内置直连或中继。
package proxytransport
