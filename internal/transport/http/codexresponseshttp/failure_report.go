package codexresponseshttp

import (
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// FailureReport 是一次原生 /v1/responses 请求以失败结束时的低敏摘要。
//
// Go 直接服务的请求在 Node 侧只有访问日志；没有这份摘要，502/503 无法区分是
// 上游失败、换号耗尽还是没有可用账号。摘要只含模型、账号引用、状态码、失败分类与
// 截断后的传输错误描述，不含请求体、上游正文与凭据。
type FailureReport struct {
	// RequestID 是网关 Request ID（响应头 X-Request-Id 同值），用于把这次失败
	// 和按天日志里的 upftream_failure / retry_* 事件串起来。
	RequestID string
	Model     string
	// Status 是写给客户端的 HTTP 状态码。
	Status int
	// Code 是网关错误码；上游非 2xx 原样透传时为 "upstream_status"。
	Code     string
	Elapsed  time.Duration
	Attempts []AttemptReport
	// Selection 是选号阶段（尚未联系任何上游）失败的截断描述。
	//
	// 没有它时，attempts=[] 的 503 无法区分“没有候选账号”和“候选账号全部被并发、
	// 额度或运行态门禁挡下”。只写错误文本与稳定码，不含凭据。
	Selection string
	// Candidate 是候选游标给出的低敏扫描诊断（检查数、模型冷却/并发/其它阻塞计数）。
	// 与 Selection 一起覆盖 503 no_available_account 的两种成因：开游标失败与扫空。
	Candidate string
	// FinalAccount 是最终成功交付的账号；请求带换号链成功时用于日志归因。
	FinalAccount string
	// PinFallback 记录钉选账号不可用时实际服务的账号；空表示未发生回落。
	PinFallback string
}

// AttemptReport 描述一次失败的上游尝试。
type AttemptReport struct {
	AccountRef string
	// Outcome 是 "transport"（没拿到上游响应）、"http_<status>"、
	// "precommit_failure"（尚未输出内容的流内/JSON 错误）或 "safety_rejected"。
	Outcome string
	// Kind 是账号运行态的失败分类；Code 是上游失败分类代码。分类失败时为空。
	Kind   string
	Code   string
	Detail string
	// Source/Signal/Semantic 是这次分类命中的规则层、信号 ID 与语义；
	// 未命中契约信号（Provider 内置兜底）时为空。
	Source   string
	Signal   string
	Semantic string
	Elapsed  time.Duration
}

const maxFailureDetail = 200

// failureTrail 在一次请求内累积失败尝试；没有 FailureLog 时所有方法都是空操作。
type failureTrail struct {
	sink            func(FailureReport)
	requestID       string
	clock           func() time.Time
	model           string
	started         time.Time
	attempts        []AttemptReport
	selectErr       string
	candidate       string
	finalAccount    string
	pinFallbackNote string
}

func (handler *Handler) newFailureTrail(model string, requestID string) *failureTrail {
	if handler.FailureLog == nil {
		return &failureTrail{}
	}
	return &failureTrail{
		sink:      handler.FailureLog,
		requestID: requestID,
		clock:     handler.Clock,
		model:     model,
		started:   handler.Clock(),
	}
}

func (trail *failureTrail) now() time.Time {
	if trail.sink == nil {
		return time.Time{}
	}
	return trail.clock()
}

func (trail *failureTrail) attempt(
	ref accountcore.AccountRef,
	outcome string,
	failure inferencegateway.AttemptFailure,
	detail string,
	started time.Time,
) {
	if trail.sink == nil {
		return
	}
	report := AttemptReport{AccountRef: string(ref), Outcome: outcome, Detail: sanitizeDetail(detail), Elapsed: trail.clock().Sub(started)}
	if failure.IsValid() {
		report.Kind = string(failure.RuntimeKind())
		report.Code = failure.ResponseFailure().Code()
		provenance := failure.Provenance()
		report.Source = string(provenance.Source())
		report.Signal = provenance.SignalID()
		report.Semantic = string(failure.RuntimeKind())
	}
	trail.attempts = append(trail.attempts, report)
}

// selection 记录选号阶段（尚未联系上游）的错误；只保留错误文本。
func (trail *failureTrail) selection(err error) {
	if trail.sink == nil || err == nil {
		return
	}
	trail.selectErr = sanitizeDetail(err.Error())
}

// explain 记录候选游标扫空时的低敏诊断；不含请求体、上游正文或凭据。
func (trail *failureTrail) explain(reason string) {
	if trail.sink == nil || reason == "" {
		return
	}
	trail.candidate = sanitizeDetail(reason)
}

// failedAttempts 返回已记录的失败尝试数；成功换号时据此决定是否输出恢复摘要。
func (trail *failureTrail) failedAttempts() int {
	if trail == nil {
		return 0
	}
	return len(trail.attempts)
}

// hasObservations 报告本轮是否记录了失败尝试或钉选回落；两者都需要日志。
func (trail *failureTrail) hasObservations() bool {
	if trail == nil {
		return false
	}
	return len(trail.attempts) > 0 || trail.pinFallbackNote != ""
}

// succeededOn 记录最终成功交付的账号，只用于日志归因。
func (trail *failureTrail) succeededOn(accountRef accountcore.AccountRef) {
	if trail == nil || !accountRef.IsValid() {
		return
	}
	trail.finalAccount = string(accountRef)
}

// pinFallback 记录钉选账号没有实际服务、请求改由另一个账号承接。
//
// 这类回落过去完全静默：显式钉选的账号因池排除/冷却不可用时，请求会直接
// 落到普通池并成功，日志与响应头之外没有任何痕迹（实测连续 20 次）。
func (trail *failureTrail) pinFallback(pinned, served accountcore.AccountRef) {
	if trail == nil || !pinned.IsValid() || !served.IsValid() || pinned == served {
		return
	}
	trail.pinFallbackNote = string(pinned) + "->" + string(served)
}

func (trail *failureTrail) finish(status int, code string) {
	if trail.sink == nil {
		return
	}
	trail.sink(FailureReport{
		RequestID:    trail.requestID,
		Model:        trail.model,
		Status:       status,
		Code:         code,
		Elapsed:      trail.clock().Sub(trail.started),
		Attempts:     append([]AttemptReport(nil), trail.attempts...),
		Selection:    trail.selectErr,
		Candidate:    trail.candidate,
		FinalAccount: trail.finalAccount,
		PinFallback:  trail.pinFallbackNote,
	})
}

// sanitizeDetail 把传输错误压成一行并截断；传输错误只含方法、URL 与原因，不含正文与凭据。
func sanitizeDetail(detail string) string {
	detail = strings.Join(strings.Fields(detail), " ")
	if runes := []rune(detail); len(runes) > maxFailureDetail {
		detail = string(runes[:maxFailureDetail]) + "…"
	}
	return detail
}
