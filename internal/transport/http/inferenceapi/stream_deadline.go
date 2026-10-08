package inferenceapi

import (
	"net/http"
	"time"
)

const (
	// StreamTotalTimeout 是单个推理请求（含流式交付）的总时长兜底上限。
	//
	// Node 宿主不对推理流设绝对上限，Go 侧保留一个兜底值避免连接被永久占用；
	// 它必须远大于任何真实推理会话——长上下文推理叠加工具循环可达数十分钟。
	StreamTotalTimeout = 60 * time.Minute
	// StreamIdleTimeout 是流式响应连续无数据后断开的阈值。
	//
	// 判据是「空闲」而不是「总时长」：真正卡死的流表现为长时间零字节，而只要上游
	// 还在持续产出事件（含 keepalive 事件）就应保持连接。取值刻意保守——Node 宿主
	// 本就没有这条限制，这里的目的是兜住故障连接，而不是给正常推理设新上限。
	StreamIdleTimeout = 5 * time.Minute
)

// StreamDeadline 把流式响应的写超时从「绝对截止时间」改成「空闲截止时间」。
//
// 标准库 http.Server.WriteTimeout 是从读完请求头起算的绝对截止时间，会把长推理流
// 硬切断（见 G3）。每交付一批数据就 Refresh 一次即可把断开的判据换成「持续没有数据」。
//
// 截止时间一律基于真实时间：它写入的是底层连接的 socket deadline，与调用方用于
// 观测/记账的注入时钟无关，混用会让测试里的假时钟直接算出一个已过期的 deadline。
type StreamDeadline struct {
	controller interface {
		SetWriteDeadline(time.Time) error
	}
	idle time.Duration
	now  func() time.Time
}

// NewStreamDeadline 为一次响应创建空闲写超时控制器。
func NewStreamDeadline(response http.ResponseWriter) *StreamDeadline {
	return newStreamDeadline(
		http.NewResponseController(response),
		StreamIdleTimeout,
		time.Now,
	)
}

// newStreamDeadline 允许注入空闲窗口与时钟，供测试精确断言 deadline 取值。
func newStreamDeadline(
	controller interface{ SetWriteDeadline(time.Time) error },
	idle time.Duration,
	now func() time.Time,
) *StreamDeadline {
	return &StreamDeadline{controller: controller, idle: idle, now: now}
}

// Refresh 在每次向客户端交付数据后把写截止时间推后一个空闲窗口。
//
// 底层不支持写 deadline（httptest.ResponseRecorder、已劫持的连接等）时静默忽略：
// 空闲超时是保护措施，不该让流式交付本身失败。
func (deadline *StreamDeadline) Refresh() {
	if deadline == nil || deadline.controller == nil || deadline.now == nil {
		return
	}
	_ = deadline.controller.SetWriteDeadline(deadline.now().Add(deadline.idle))
}
