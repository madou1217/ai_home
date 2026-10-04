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
	Model string
	// Status 是写给客户端的 HTTP 状态码。
	Status int
	// Code 是网关错误码；上游非 2xx 原样透传时为 "upstream_status"。
	Code     string
	Elapsed  time.Duration
	Attempts []AttemptReport
}

// AttemptReport 描述一次失败的上游尝试。
type AttemptReport struct {
	AccountRef string
	// Outcome 是 "transport"（没拿到上游响应）、"http_<status>" 或 "safety_rejected"。
	Outcome string
	// Kind 是账号运行态的失败分类；Code 是上游失败分类代码。分类失败时为空。
	Kind    string
	Code    string
	Detail  string
	Elapsed time.Duration
}

const maxFailureDetail = 200

// failureTrail 在一次请求内累积失败尝试；没有 FailureLog 时所有方法都是空操作。
type failureTrail struct {
	sink     func(FailureReport)
	clock    func() time.Time
	model    string
	started  time.Time
	attempts []AttemptReport
}

func (handler *Handler) newFailureTrail(model string) *failureTrail {
	if handler.FailureLog == nil {
		return &failureTrail{}
	}
	return &failureTrail{sink: handler.FailureLog, clock: handler.Clock, model: model, started: handler.Clock()}
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
	}
	trail.attempts = append(trail.attempts, report)
}

func (trail *failureTrail) finish(status int, code string) {
	if trail.sink == nil {
		return
	}
	trail.sink(FailureReport{
		Model:    trail.model,
		Status:   status,
		Code:     code,
		Elapsed:  trail.clock().Sub(trail.started),
		Attempts: append([]AttemptReport(nil), trail.attempts...),
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
