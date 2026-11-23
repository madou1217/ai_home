// Package admission 实现网关上真正生效的并发准入：系统/Key/账号/账号+模型
// 四层天花板、有界 FIFO 等待队列与饱和账号观测。
//
// 分层：core/concurrency 只提供上限解析（纯函数）；本包持有运行态计数、队列和
// 热更新配置；传输层只负责在真实上游调用前后 Acquire/Release，并把拒绝映射成
// 统一的 429 + Retry-After 契约。
package admission

import (
	"errors"
	"time"
)

// CodeAccountTemporarilyUnavailable 是并发/排队拒绝的稳定错误码。
const CodeAccountTemporarilyUnavailable = "account_temporarily_unavailable"

// Reason 是准入拒绝的稳定原因码（写入日志/诊断，不直接当 HTTP 状态）。
type Reason string

const (
	// ReasonAccountSaturated 表示目标账号总量已达上限；调用方应换号。
	ReasonAccountSaturated Reason = "account_saturated"
	// ReasonModelSaturated 表示目标账号的该模型已达上限；调用方应换号。
	ReasonModelSaturated Reason = "model_saturated"
	// ReasonQueueFull 表示等待队列已满。
	ReasonQueueFull Reason = "queue_full"
	// ReasonWaitTimeout 表示排队等待超过 queueWaitTimeoutMs。
	ReasonWaitTimeout Reason = "wait_timeout"
	// ReasonCanceled 表示等待期间客户端取消。
	ReasonCanceled Reason = "canceled"
)

// Rejection 是准入拒绝的强类型错误。
//
// Error() 返回稳定错误码，便于各客户端协议把它写进自己的 code 字段；RetryAfter
// 由同一份配置快照冻结，避免响应写出时配置已被热更新。
type Rejection struct {
	Reason     Reason
	RetryAfter time.Duration
}

// Error 返回稳定错误码。
func (rejection *Rejection) Error() string {
	if rejection == nil {
		return CodeAccountTemporarilyUnavailable
	}
	return CodeAccountTemporarilyUnavailable
}

// RetryAfterSeconds 返回向上取整的 Retry-After 秒数（最小 1）。
func (rejection *Rejection) RetryAfterSeconds() int {
	if rejection == nil {
		return 1
	}
	seconds := int((rejection.RetryAfter + time.Second - 1) / time.Second)
	if seconds < 1 {
		seconds = 1
	}
	return seconds
}

// IsOwnAccountSaturated 报告拒绝是否只因为目标账号/模型自身满额。
//
// 这类拒绝不应继续排队等待：同一请求换一个账号可能马上就有容量。
func (rejection *Rejection) IsOwnAccountSaturated() bool {
	if rejection == nil {
		return false
	}
	return rejection.Reason == ReasonAccountSaturated || rejection.Reason == ReasonModelSaturated
}

// AsRejection 从错误链上取出准入拒绝。
func AsRejection(err error) (*Rejection, bool) {
	var rejection *Rejection
	if errors.As(err, &rejection) {
		return rejection, true
	}
	return nil, false
}

// IsRejection 报告错误是否为并发准入拒绝。
func IsRejection(err error) bool {
	_, ok := AsRejection(err)
	return ok
}

// NewTransientError 构造一个“排队/并发导致暂时不可用”的错误，供没有具体账号
// 归属的汇合点（例如整轮候选都因并发被拒）使用。
func NewTransientError(reason Reason, retryAfter time.Duration) *Rejection {
	return &Rejection{Reason: reason, RetryAfter: retryAfter}
}
