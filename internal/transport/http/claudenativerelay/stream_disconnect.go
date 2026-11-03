package claudenativerelay

import (
	"strings"
	"time"
)

// Relay 流中途断开的低敏诊断。
//
// 上游在中途断开时，relay 会正常结束响应（访问日志仍是 200），客户端（Claude Code）
// 只看到缺少 message_stop 的流并报 "Connection lost mid-response"。没有这条记录就
// 无法区分是上游链路（代理/网络）断开，还是客户端一侧先断开。只记录模型、账号、
// 断开方、已持续时长与错误文本，不记录请求或响应内容。

// StreamDisconnectSide 标识哪一侧先断开。
type StreamDisconnectSide string

const (
	// StreamDisconnectUpstream 表示上游（Anthropic 或代理链路）在完成前断开。
	StreamDisconnectUpstream StreamDisconnectSide = "upstream"
	// StreamDisconnectClient 表示客户端（或前置宿主）在完成前断开。
	StreamDisconnectClient StreamDisconnectSide = "client"
)

// maxDisconnectErrorLength 限制写入日志的错误文本长度。
const maxDisconnectErrorLength = 240

// StreamDisconnect 是一次 relay 流中途断开的事实。
type StreamDisconnect struct {
	Side       StreamDisconnectSide
	Model      string
	AccountRef string
	Elapsed    time.Duration
	Error      string
}

// disconnectErrorText 截断错误文本，避免超长日志。
func disconnectErrorText(err error) string {
	if err == nil {
		return ""
	}
	text := strings.TrimSpace(err.Error())
	if len(text) > maxDisconnectErrorLength {
		text = text[:maxDisconnectErrorLength] + "…"
	}
	return text
}
