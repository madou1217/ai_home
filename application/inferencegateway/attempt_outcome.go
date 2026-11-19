package inferencegateway

import (
	"github.com/madou1217/ai_home/application/accountcredentials"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

// attemptOutcome 描述单次上游调用对编排的影响。
//
// stream 始终非空，即使调用以内部故障结束。编排层据此判断客户端是否已经看到
// 本次调用的事件：只有一个字节都没写出去时，补发更早记录的真实上游失败才是安全的。
type attemptOutcome struct {
	stream          *attemptStream
	retry           bool
	failure         AttemptFailure
	cooldownReceipt runtimecore.CooldownReceipt
	observation     accountcredentials.CredentialObservation
}

// newFailedAttemptOutcome 保存本次结构化失败，供请求级策略判定是否全为模糊失败。
func newFailedAttemptOutcome(
	stream *attemptStream,
	retry bool,
	failure AttemptFailure,
) attemptOutcome {
	return newFailedAttemptOutcomeWithReceipt(
		stream,
		retry,
		failure,
		runtimecore.CooldownReceipt{},
		accountcredentials.CredentialObservation{},
	)
}

// newFailedAttemptOutcomeWithReceipt 同时保留本次失败写入产生的原子 cooldown 代次凭证与
// 失败尝试读取的原始低敏凭据观察。
func newFailedAttemptOutcomeWithReceipt(
	stream *attemptStream,
	retry bool,
	failure AttemptFailure,
	receipt runtimecore.CooldownReceipt,
	observation accountcredentials.CredentialObservation,
) attemptOutcome {
	return attemptOutcome{
		stream:          stream,
		retry:           retry,
		failure:         failure,
		cooldownReceipt: receipt,
		observation:     observation,
	}
}

// newAttemptOutcome 创建保留事件边界的调用结果。
func newAttemptOutcome(
	stream *attemptStream,
	retry bool,
) attemptOutcome {
	return attemptOutcome{stream: stream, retry: retry}
}

// Visible 表示本次调用已经向客户端写出至少一个事件。
func (outcome attemptOutcome) Visible() bool {
	return outcome.stream.Visible()
}
