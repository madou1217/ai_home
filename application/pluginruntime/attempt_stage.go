package pluginruntime

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// CapabilityGatewayAttempt 是尝试中间件的能力名。
const CapabilityGatewayAttempt = "gateway.attempt"

// attemptNextMethod 是宿主执行内层（下一个中间件，最内层是真实上游尝试）的反向调用名。
const attemptNextMethod = "gateway.next"

const (
	defaultAttemptStepBudget = time.Second
	defaultAttemptDeadline   = 10 * time.Minute
)

// attemptRecoveryActions 是可以被插件收窄的尝试结果：只有这些结果上的 stop 才改变换号。
var attemptRecoveryActions = map[string]bool{
	"retry_next":      true,
	"retry_same":      true,
	"retry_transient": true,
}

// ReverseCall 处理宿主在父调用进行中的反向调用（协议 v2 的 call 帧）。
type ReverseCall func(ctx context.Context, method string, value json.RawMessage) (any, error)

// ReverseInvoker 是支持反向调用的 Invoker 扩展；gateway.attempt 的 next() 需要它。
type ReverseInvoker interface {
	InvokeReverse(ctx context.Context, generation int64, contributionID string, value any, timeout time.Duration, onCall ReverseCall) (json.RawMessage, error)
}

// AttemptRun 是一次真实尝试的结果摘要。
//
// Action 是尝试对编排的影响（return / retry_next / retry_same / retry_transient / error / unknown），
// 与 Node request-orchestrator 的 outcome.action 同名。Err 与 RunAttemptStage 返回的 Err 相同，
// 供调用方在插件阶段结束后原样重抛。
type AttemptRun struct {
	Action string
	Err    error
}

// AttemptRequest 是交给 gateway.attempt 的一次尝试描述。
//
// Run 执行真实尝试，至多一次（宿主与网关两端都校验 next 只调用一次）。
// Commit 在响应写给客户端的那一刻关闭；Committed 报告同一事实（提交点之后的一切都不可撤回）。
// LastError 返回上一次尝试的失败文本，只用于给插件看的摘要。
type AttemptRequest struct {
	Provider   string
	Model      string
	AccountRef string
	AuthType   string
	Attempt    int
	Run        func(ctx context.Context) (AttemptRun, error)
	Commit     <-chan struct{}
	Committed  func() bool
	LastError  func() string
}

// AttemptOptions 控制插件预算；零值取合同默认（next 前后各 1s、整次调用 10 分钟）。
type AttemptOptions struct {
	StepBudget     time.Duration
	InvokeDeadline time.Duration
}

// AttemptFailure 是中间件失败的一次记录（低敏，只用于诊断）。
type AttemptFailure struct {
	InstanceID     string
	ContributionID string
	Code           string
	Message        string
}

// AttemptRejection 是插件拒绝这次尝试的公开信息（上游零命中）。
type AttemptRejection struct {
	Status  int
	Code    string
	Message string
}

// AttemptResult 是 gateway.attempt 的结果。
//
// Started=false 表示真实尝试从未执行（插件在 next() 之前拒绝，或插件失败按 deny 处理）；
// 此时 Rejected 非空，调用方应按它的状态码结束请求。Started=true 时 Run/Err 是尝试本身的结果。
type AttemptResult struct {
	Started  bool
	Run      AttemptRun
	Err      error
	Stop     bool
	Rejected *AttemptRejection
	Failures []AttemptFailure
}

// RunPinnedAttemptStage 用请求固定的插件代次执行 gateway.attempt。
//
// 没有代次、该代次没有 gateway.attempt 贡献项或调用器不可用时返回 ran=false，
// 调用方照常执行尝试（不启动任何插件 RPC，热路径零开销）。
func RunPinnedAttemptStage(ctx context.Context, request AttemptRequest, options AttemptOptions) (AttemptResult, bool) {
	pin := PinFrom(ctx)
	if pin == nil || pin.observer == nil || !pin.Projection.Has(CapabilityGatewayAttempt) {
		return AttemptResult{}, false
	}
	return RunAttemptStage(ctx, pin.observer.invoker, pin.Projection, request, options), true
}

// RunAttemptStage 按投影顺序把 gateway.attempt 包在一次真实尝试外面，语义与 Node 的
// lib/plugins/gateway/attempt-stage.js 一致：
//
//   - 插件 handler 收到 { provider, model, attempt, accountRef, authType }（不含请求体与凭据），
//     并可在上下文里调用 next()（反向调用 gateway.next）让网关执行内层尝试；
//   - 不调用 next() 时只能返回 { reject: { status, message } } 拒绝这次尝试（上游零命中）；
//   - next 之后、未提交的失败上可以返回 { recovery: 'stop' } 停止后续换号；
//   - next 至多一次；已提交之后的返回值只用于观察，不改变结果；
//   - 失败按 failurePolicy：deny（默认）在尝试执行前拒绝请求（502），delegate 视为透明中间件。
//
// 与 Node 的唯一差别：摘要的提交点判定在 Go 侧取自「尝试已写出至少一个事件」，
// 因此摘要不含 Node 在提交点才有的 status 字段。
func RunAttemptStage(
	ctx context.Context,
	invoker Invoker,
	projection Projection,
	request AttemptRequest,
	options AttemptOptions,
) AttemptResult {
	state := newAttemptState(invoker, projection, request, options)
	if len(state.chain) == 0 {
		run, err := state.awaitRun(ctx)
		return AttemptResult{Started: state.runStarted(), Run: run, Err: err}
	}
	state.enter(ctx, 0)
	if !state.runStarted() {
		return AttemptResult{Started: false, Rejected: state.rejected, Failures: state.failureList()}
	}
	run, err := state.awaitRun(ctx)
	return AttemptResult{
		Started:  true,
		Run:      run,
		Err:      err,
		Stop:     state.stop && !state.committed() && attemptRecoveryActions[run.Action],
		Failures: state.failureList(),
	}
}

// attemptSummary 是宿主在 next() 上看到的尝试摘要。
type attemptSummary struct {
	Committed bool
	Outcome   string
	Error     string
}

type attemptRunResult struct {
	run AttemptRun
	err error
}

// attemptState 保存一次中间件调用的全部状态：真实尝试只执行一次，摘要只结算一次。
type attemptState struct {
	invoker    Invoker
	generation int64
	request    AttemptRequest
	chain      []Contribution
	budget     time.Duration
	deadline   time.Duration

	runOnce   sync.Once
	started   bool
	runDone   chan struct{}
	runMu     sync.Mutex
	runResult attemptRunResult

	innerOnce sync.Once
	inner     attemptSummary

	stop     bool
	rejected *AttemptRejection
	failures []AttemptFailure
}

func newAttemptState(invoker Invoker, projection Projection, request AttemptRequest, options AttemptOptions) *attemptState {
	budget := options.StepBudget
	if budget <= 0 {
		budget = defaultAttemptStepBudget
	}
	deadline := options.InvokeDeadline
	if deadline < budget {
		deadline = defaultAttemptDeadline
	}
	return &attemptState{
		invoker:    invoker,
		generation: projection.Generation,
		request:    request,
		chain:      projection.ByCapability(CapabilityGatewayAttempt),
		budget:     budget,
		deadline:   deadline,
	}
}

// enter 是洋葱的第 index 层：调用插件，把它名下的 next() 接到下一层。
func (state *attemptState) enter(ctx context.Context, index int) attemptSummary {
	if index >= len(state.chain) {
		return state.innerSummary(ctx)
	}
	item := state.chain[index]
	reverse, ok := state.invoker.(ReverseInvoker)
	if !ok {
		// 没有反向调用能力就无法执行 next()，按插件失败（deny）处理，不让请求静默绕过中间件。
		state.recordFailure(item, "plugin_runtime_inactive", "插件调用器不支持反向调用")
		state.rejected = &AttemptRejection{Status: 502, Code: "plugin_runtime_inactive", Message: "插件调用器不支持反向调用"}
		return attemptSummary{Outcome: "rejected"}
	}

	callCtx, cancelCall := context.WithCancel(ctx)
	defer cancelCall()

	var mu sync.Mutex
	overBudget := false
	nextCalled := false
	var timer *time.Timer
	// 预算只在 next 前后生效：等待上游（next 进行中）不计入。
	arm := func() {
		mu.Lock()
		defer mu.Unlock()
		stopTimer(timer)
		timer = time.AfterFunc(state.budget, func() {
			mu.Lock()
			overBudget = true
			mu.Unlock()
			cancelCall()
		})
	}
	disarm := func() {
		mu.Lock()
		defer mu.Unlock()
		stopTimer(timer)
		timer = nil
	}
	defer disarm()

	var innerOnce sync.Once
	var inner attemptSummary
	onCall := func(reverseCtx context.Context, method string, _ json.RawMessage) (any, error) {
		if method != attemptNextMethod {
			return nil, &StageError{Code: "plugin_rpc_method_unknown", Message: "不支持的反向调用 " + method}
		}
		mu.Lock()
		if nextCalled {
			mu.Unlock()
			return nil, &StageError{Code: "plugin_next_called_twice", Message: "next() 在一次调用中只能调用一次"}
		}
		nextCalled = true
		mu.Unlock()
		disarm()
		// 内层尝试属于请求，不属于这次反向调用：next() 的摘要可能在提交点提前结算并让反向
		// 调用立刻结束，而真实上游仍在用这个 Context 记录终态。若把 reverseCtx（连接层在反向
		// 调用结束时取消）传下去，慢 runner 上 RecordSuccess 会拿到 context canceled 并以 503
		// 结束一个已经成功的请求。请求取消仍经外层 ctx 传播。
		innerOnce.Do(func() { inner = state.enter(ctx, index+1) })
		arm()
		// 交给插件的是摘要 + 宿主侧已收窄的状态（stopped / rejected），不是内部摘要结构。
		return state.flags(inner), nil
	}

	arm()
	raw, invokeErr := reverse.InvokeReverse(
		callCtx,
		state.generation,
		item.ID,
		state.attemptValue(),
		state.deadline,
		onCall,
	)
	disarm()

	failure := state.stepFailure(item, invokeErr, overBudget)
	if failure == nil && !nextCalled {
		if rejection := validAttemptRejection(raw); rejection != nil {
			state.rejected = rejection
			return attemptSummary{Outcome: "rejected"}
		}
		failure = state.newFailure(item, "plugin_result_invalid", "没有调用 next() 时必须返回 { reject: { status, message } }")
	}
	if failure != nil {
		state.failures = append(state.failures, *failure)
		if !nextCalled {
			if item.FailurePolicy != "delegate" {
				state.rejected = &AttemptRejection{Status: 502, Code: failure.Code, Message: failure.Message}
				return attemptSummary{Outcome: "rejected"}
			}
			// delegate：视为透明中间件，由网关替它调用 next()。
			innerOnce.Do(func() { inner = state.enter(ctx, index+1) })
		}
		return inner
	}
	summary := inner
	// 只收窄：停止换号只对未提交的尝试有效，其余返回值仅供观察。
	if !summary.Committed && stopRequested(raw) {
		state.stop = true
	}
	return summary
}

// innerSummary 结算真实尝试一次，并在提交点（调用方提供了 Commit 时）提前返回摘要。
//
// 提前结算只改变插件拿到摘要的时机；尝试的结果始终留在带缓冲的通道里，供顶部重新取回。
func (state *attemptState) innerSummary(ctx context.Context) attemptSummary {
	state.innerOnce.Do(func() {
		state.startRun(ctx)
		if state.request.Commit != nil {
			select {
			case <-state.request.Commit:
				state.inner = attemptSummary{Committed: true, Outcome: "committed"}
				return
			case <-state.runDone:
				// 两个信号同时就绪时以提交点为准：已经写出过的尝试只能报「已提交」，
				// 这样摘要不会因为 goroutine 调度顺序而在 committed/return 之间抖动。
				if state.committed() {
					state.inner = attemptSummary{Committed: true, Outcome: "committed"}
					return
				}
			}
		}
		state.inner = state.summaryOf(state.result())
	})
	return state.inner
}

func (state *attemptState) summaryOf(result attemptRunResult) attemptSummary {
	if result.err != nil {
		return attemptSummary{
			Committed: state.committed(),
			Outcome:   "error",
			Error:     truncateRunes(firstNonEmpty(errorCode(result.err), result.err.Error()), 300),
		}
	}
	return attemptSummary{
		Committed: state.committed(),
		Outcome:   firstNonEmpty(result.run.Action, "unknown"),
		Error:     truncateRunes(state.lastError(), 300),
	}
}

// startRun 启动真实尝试一次。
//
// 结果写进 state.runResult 并关闭 runDone：摘要可以在提交点提前结算，但尝试本身的结果必须
// 一直可取（顶部要原样把尝试的错误交还宿主），所以不能用一个只读一次的信道承载它。
func (state *attemptState) startRun(ctx context.Context) {
	state.runOnce.Do(func() {
		state.started = true
		done := make(chan struct{})
		state.runDone = done
		if state.request.Run == nil {
			state.runMu.Lock()
			state.runResult = attemptRunResult{err: &StageError{Code: "plugin_attempt_unavailable", Message: "没有可执行的尝试"}}
			state.runMu.Unlock()
			close(done)
			return
		}
		go func() {
			run, err := state.request.Run(ctx)
			state.runMu.Lock()
			state.runResult = attemptRunResult{run: run, err: err}
			state.runMu.Unlock()
			close(done)
		}()
	})
}

// result 返回尝试结果（调用前必须已经 startRun 或 awaitRun）。
func (state *attemptState) result() attemptRunResult {
	state.runMu.Lock()
	defer state.runMu.Unlock()
	return state.runResult
}

// awaitRun 启动（如果还没启动）并取回尝试结果。
func (state *attemptState) awaitRun(ctx context.Context) (AttemptRun, error) {
	state.startRun(ctx)
	<-state.runDone
	result := state.result()
	return result.run, result.err
}

func (state *attemptState) runStarted() bool { return state.started }

func (state *attemptState) committed() bool {
	return state.request.Committed != nil && state.request.Committed()
}

func (state *attemptState) lastError() string {
	if state.request.LastError == nil {
		return ""
	}
	return state.request.LastError()
}

func (state *attemptState) failureList() []AttemptFailure {
	if len(state.failures) == 0 {
		return nil
	}
	return append([]AttemptFailure(nil), state.failures...)
}

// attemptValue 是插件看到的尝试描述：只有这五个键，不含请求体与凭据。
func (state *attemptState) attemptValue() map[string]any {
	return map[string]any{
		"provider":   state.request.Provider,
		"model":      state.request.Model,
		"attempt":    state.request.Attempt,
		"accountRef": state.request.AccountRef,
		"authType":   state.request.AuthType,
	}
}

// flags 是交给插件的摘要加上宿主侧已经收窄的状态。
func (state *attemptState) flags(summary attemptSummary) map[string]any {
	flags := map[string]any{
		"committed": summary.Committed,
		"outcome":   summary.Outcome,
		"error":     summary.Error,
		"stopped":   state.stop,
	}
	if state.rejected != nil {
		flags["rejected"] = map[string]any{
			"status":  state.rejected.Status,
			"message": state.rejected.Message,
		}
	}
	return flags
}

// stepFailure 把调用错误映射为中间件失败；调用成功返回 nil。
//
// 超出预算时如实报超时：连接层只会给本地取消，无法区分是谁取消的。
func (state *attemptState) stepFailure(item Contribution, err error, overBudget bool) *AttemptFailure {
	if err == nil {
		return nil
	}
	if overBudget {
		return state.newFailure(item, "plugin_rpc_timeout", fmt.Sprintf("超出插件预算 %s", state.budget))
	}
	var stageErr *StageError
	if errors.As(err, &stageErr) {
		return state.newFailure(item, firstNonEmpty(stageErr.Code, "plugin_failed"), stageErr.Message)
	}
	return state.newFailure(item, firstNonEmpty(errorCode(err), "plugin_failed"), err.Error())
}

func (state *attemptState) newFailure(item Contribution, code string, message string) *AttemptFailure {
	return &AttemptFailure{
		InstanceID:     item.InstanceID,
		ContributionID: item.ID,
		Code:           firstNonEmpty(code, "plugin_failed"),
		Message:        message,
	}
}

func (state *attemptState) recordFailure(item Contribution, code string, message string) {
	state.failures = append(state.failures, *state.newFailure(item, code, message))
}

// validAttemptRejection 解析 { reject: { status, message } }；status 必须在 400..599 之间。
func validAttemptRejection(raw json.RawMessage) *AttemptRejection {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil
	}
	var result struct {
		Reject *struct {
			Status  json.Number `json:"status"`
			Message any         `json:"message"`
		} `json:"reject"`
	}
	if json.Unmarshal(trimmed, &result) != nil || result.Reject == nil {
		return nil
	}
	status, err := result.Reject.Status.Int64()
	if err != nil || status < 400 || status > 599 {
		return nil
	}
	message := "请求被插件拒绝"
	if text, ok := result.Reject.Message.(string); ok && text != "" {
		message = truncateRunes(text, 500)
	}
	return &AttemptRejection{Status: int(status), Code: "plugin_rejected", Message: message}
}

// stopRequested 判断插件是否要求停止后续换号（{ recovery: 'stop' }）。
func stopRequested(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return false
	}
	var result struct {
		Recovery string `json:"recovery"`
	}
	if json.Unmarshal(trimmed, &result) != nil {
		return false
	}
	return result.Recovery == "stop"
}

func stopTimer(timer *time.Timer) {
	if timer != nil {
		timer.Stop()
	}
}
