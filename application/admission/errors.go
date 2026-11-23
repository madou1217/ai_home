// Package admission 实现网关上真正生效的准入：系统/Key/账号/账号+模型四层并发
// 天花板、Key/账号的 RPM/TPM/每日 token 速率上限、有界 FIFO 等待队列与饱和账号观测。
//
// 分层：core/concurrency 只提供上限解析与限流窗口契约（纯函数/接口）；本包持有运行态
// 计数、队列和热更新配置；传输层只负责在真实上游调用前后 Acquire/Release，并把拒绝
// 映射成统一的 429 + Retry-After 契约。
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
	// ReasonKeyRPM 表示 Key 的每分钟请求上限已满。
	ReasonKeyRPM Reason = "key_rpm_limit"
	// ReasonKeyTPM 表示 Key 的每分钟 token 上限已满。
	ReasonKeyTPM Reason = "key_tpm_limit"
	// ReasonKeyDailyTokens 表示 Key 的每日 token 上限已用完。
	ReasonKeyDailyTokens Reason = "key_daily_token_limit"
	// ReasonAccountRPM 表示账号的每分钟请求上限已满；调用方应换号。
	ReasonAccountRPM Reason = "account_rpm_limit"
	// ReasonAccountTPM 表示账号的每分钟 token 上限已满；调用方应换号。
	ReasonAccountTPM Reason = "account_tpm_limit"
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
// 这类拒绝不应继续排队等待：同一请求换一个账号可能马上就有容量。账号级速率
// 上限同理属于账号自身属性，换号可能绕开。
func (rejection *Rejection) IsOwnAccountSaturated() bool {
	if rejection == nil {
		return false
	}
	switch rejection.Reason {
	case ReasonAccountSaturated, ReasonModelSaturated, ReasonAccountRPM, ReasonAccountTPM:
		return true
	}
	return false
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

// NewSaturationError 构造“整轮候选仅因并发上限被跳过”的临时拒绝。
//
// 与 Canonical Coordinator 的汇合点一致：Retry-After 取当前安装控制器的配置，
// 未安装时回落到默认最小 1 秒。传输层必须把它映射成可重试的 429，而不是
// “没有可用账号”的 503 —— 账号是存在的，只是此刻被自己的并发天花板占满。
func NewSaturationError(reason Reason) *Rejection {
	seconds := 1
	if controller := Current(); controller != nil {
		if configured := controller.Config().RetryAfterSeconds; configured > 0 {
			seconds = configured
		}
	}
	return &Rejection{Reason: reason, RetryAfter: time.Duration(seconds) * time.Second}
}
