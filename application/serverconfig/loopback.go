package serverconfig

import (
	"net"
	"strings"
)

// IsLoopbackPeerAddress 判定 TCP 对端地址是否回环。
//
// 输入可以是 host、host:port 或 [v6]:port；接受 IPv6 zone id（fe80::1%lo0）
// 与 IPv4-mapped 形式（::ffff:127.0.0.1）。空地址（进程内调用）视为非回环。
func IsLoopbackPeerAddress(value string) bool {
	host, _, err := net.SplitHostPort(strings.TrimSpace(value))
	if err != nil {
		host = strings.Trim(strings.TrimSpace(value), "[]")
	}
	if zoneIndex := strings.IndexByte(host, '%'); zoneIndex >= 0 {
		host = host[:zoneIndex]
	}
	host = strings.TrimPrefix(strings.ToLower(host), "::ffff:")
	if host == "::1" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// IsLoopbackHostValue 判定配置值或 Host 头里的主机是否本机回环。
//
// 只接受 localhost 与回环 IP：不解析 DNS 名称，避免把可被投毒的解析结果
// 当成「来自本机」。IPv6 方括号会先去掉，端口不属于本函数的输入。
func IsLoopbackHostValue(value string) bool {
	host := strings.ToLower(strings.Trim(strings.TrimSpace(value), "[]"))
	if host == "" {
		return false
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
