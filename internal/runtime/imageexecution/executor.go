package imageexecution

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
	"github.com/madou1217/ai_home/internal/adapters/upstreamfailure/configured"
)

const defaultRecordTimeout = 5 * time.Second

// Dependencies 声明共享图片执行器所需的稳定依赖；429 重试与观察端口均可选。
type Dependencies struct {
	Surface                string
	Registry               images.Registry
	Accounts               images.AccountSource
	HTTP                   images.HTTPDoer
	Upstream429Retries     *upstreamretry.Controller
	Attempts               inferencegateway.AttemptRecorder
	CredentialObservations inferencegateway.CredentialObservationVerifier
	Rules                  configured.Rules
	LegacyFailure          LegacyFailureRecorder
	LegacySuccess          LegacySuccessRecorder
	Clock                  func() time.Time
	RecordTimeout          time.Duration
}

// Executor 编排一次图片执行：先沿用既有 images.Execute 零等待尝试健康池/钉选账号，
// 仅在耗尽且观察到至少一次合法瞬态原始 HTTP 429 时进入有界可取消等待与重征召循环。
type Executor struct {
	surface            string
	registry           images.Registry
	accounts           images.AccountSource
	http               images.HTTPDoer
	upstream429Retries *upstreamretry.Controller
	observedAttempts   *inferencegateway.ObservedAttemptRecorder
	rules              configured.Rules
	legacyFailure      LegacyFailureRecorder
	legacySuccess      LegacySuccessRecorder
	clock              func() time.Time
	recordTimeout      time.Duration
}

// NewExecutor 创建共享图片执行器。未同时注入 Attempts 与 CredentialObservations 时
// 保持 observedAttempts 为 nil，自动退回旧有 Legacy 记账且对 429 重试 fail-closed。
func NewExecutor(dependencies Dependencies) *Executor {
	surface := strings.TrimSpace(dependencies.Surface)
	if surface == "" {
		surface = "images_api"
	}
	clock := dependencies.Clock
	if clock == nil {
		clock = time.Now
	}
	recordTimeout := dependencies.RecordTimeout
	if recordTimeout <= 0 {
		recordTimeout = defaultRecordTimeout
	}
	var observedAttempts *inferencegateway.ObservedAttemptRecorder
	if dependencies.Attempts != nil && dependencies.CredentialObservations != nil {
		if recorder, err := inferencegateway.NewObservedAttemptRecorder(
			dependencies.Attempts,
			dependencies.CredentialObservations,
		); err == nil {
			observedAttempts = recorder
		}
	}
	return &Executor{
		surface:            surface,
		registry:           dependencies.Registry,
		accounts:           dependencies.Accounts,
		http:               dependencies.HTTP,
		upstream429Retries: dependencies.Upstream429Retries,
		observedAttempts:   observedAttempts,
		rules:              dependencies.Rules,
		legacyFailure:      dependencies.LegacyFailure,
		legacySuccess:      dependencies.LegacySuccess,
		clock:              clock,
		recordTimeout:      recordTimeout,
	}
}

// Execute 执行一次图片生成或编辑请求。
//
// 本方法只在每次真实失败尝试后记录一次失败与冷却凭证，绝不在渲染/写出/物化之前调用 RecordSuccess；
// 调用方必须在输出成功提交后显式调用 RecordSuccess 一次。
func (executor *Executor) Execute(
	ctx context.Context,
	provider string,
	request imagegeneration.Request,
) (Result, error) {
	if executor == nil {
		return Result{}, &images.Error{
			StatusCode: 500,
			Code:       "image_executor_unavailable",
			Detail:     "image executor is not configured",
		}
	}
	ctx, reqState := upstreamretry.EnsureRequestState(ctx)
	_, requestPinned := inferencegateway.PinnedAccount(ctx)

	source := executor.accounts
	reacquirer, supportsReacquire := executor.accounts.(RateLimitReacquirer)
	var session ObservedAccountSession
	if supportsReacquire {
		session = reacquirer.NewObservedSession()
		if session != nil {
			source = session
		}
	}

	tracker := &image429Tracker{}
	var submissionAccepted atomic.Bool
	var stateMu sync.Mutex
	dispatched := make(map[string]struct{}, 4)
	var (
		lastInitialFailure    inferencegateway.AttemptFailure
		hasLastInitialFailure bool
		attemptAccountRef     string
	)

	execCtx := images.ContextWithSubmissionAccepted(ctx, func() {
		submissionAccepted.Store(true)
	})

	executeOptions := images.ExecuteOptions{
		HTTP: executor.http,
		AttemptFailure: func(account images.Account, model string, attemptErr error) {
			failure, hasFailure := executor.observeInitialAttemptFailure(
				ctx,
				reqState,
				session,
				tracker,
				provider,
				requestPinned,
				account,
				model,
				attemptErr,
			)
			stateMu.Lock()
			if ref := strings.TrimSpace(account.AccountRef); ref != "" {
				dispatched[ref] = struct{}{}
				attemptAccountRef = ref
			}
			lastInitialFailure = failure
			hasLastInitialFailure = hasFailure
			stateMu.Unlock()
		},
	}

	execution, executeErr := images.Execute(
		execCtx,
		executor.registry,
		source,
		provider,
		request,
		executeOptions,
	)
	if executeErr == nil {
		reqState.ClearExplicitRetryAfter()
		var obs accountcredentials.CredentialObservation
		var hasObs bool
		if session != nil {
			obs, hasObs = session.ObservationFor(execution.Account.AccountRef)
		}
		return Result{
			Execution:         execution,
			AttemptAccountRef: execution.Account.AccountRef,
			Observation:       obs,
			HasObserved:       hasObs && obs.IsValid(),
			Retry:             buildRetryMetadata(reqState, false, executor.now()),
		}, nil
	}

	// I4：只要本次请求内任意上游生成/编辑 POST 已返回 2xx（哪怕后续解析或本地转码失败），
	// 严禁再启用历史 429 候选进行健康池续扫或退避重试，原样保留当前错误。
	if submissionAccepted.Load() {
		if !isRaw429Error(executeErr) {
			reqState.ClearExplicitRetryAfter()
		}
		return Result{
			AttemptAccountRef: attemptAccountRef,
			Retry:             buildRetryMetadata(reqState, isRaw429Error(executeErr), executor.now()),
		}, executeErr
	}

	if ctx.Err() == nil &&
		executor.upstream429Retries != nil &&
		executor.observedAttempts != nil &&
		supportsReacquire &&
		tracker.HasCandidates() {
		stateMu.Lock()
		initialAllowsExtension := !hasLastInitialFailure || allowsPoolExtensionAfterFailure(lastInitialFailure)
		stateMu.Unlock()
		if !initialAllowsExtension {
			return Result{
				Retry: buildRetryMetadata(reqState, isRaw429Error(executeErr), executor.now()),
			}, executeErr
		}

		finalErr := executeErr
		if !requestPinned {
			// I3：未钉选请求在初始 3 次窗口因合法 429 结束后，必须先零等待续扫池内剩余健康账号，
			// 仅在确认真实池耗尽（而非命中安全 cap 或终态停止）后，才允许进入 429 等待重试。
			poolOutcome := executor.continueHealthyPoolAfter429(
				ctx,
				execCtx,
				reqState,
				reacquirer,
				provider,
				request,
				dispatched,
				tracker,
				&submissionAccepted,
				executeErr,
			)
			if poolOutcome.recovered {
				return poolOutcome.result, nil
			}
			finalErr = poolOutcome.lastErr
			if submissionAccepted.Load() {
				reqState.ClearExplicitRetryAfter()
				return Result{
					AttemptAccountRef: attemptAccountRef,
					Retry:             buildRetryMetadata(reqState, false, executor.now()),
				}, finalErr
			}
			if !poolOutcome.trulyExhausted || poolOutcome.capHit || poolOutcome.terminalStop {
				return Result{
					AttemptAccountRef: attemptAccountRef,
					Retry:             buildRetryMetadata(reqState, isRaw429Error(finalErr), executor.now()),
				}, finalErr
			}
		}

		loopResult, loopErr := executor.runImage429RetryLoop(
			ctx,
			execCtx,
			reqState,
			reacquirer,
			provider,
			request,
			requestPinned,
			tracker,
			&submissionAccepted,
			finalErr,
		)
		if loopResult.AttemptAccountRef == "" {
			loopResult.AttemptAccountRef = attemptAccountRef
		}
		return loopResult, loopErr
	}

	return Result{
		AttemptAccountRef: attemptAccountRef,
		Retry:             buildRetryMetadata(reqState, isRaw429Error(executeErr), executor.now()),
	}, executeErr
}

// RecordSuccess 在输出渲染与交付完成后调用一次，以真实凭据代次记录成功并清理冷却；
// 无 ObservedAttemptRecorder 或无真实观察时退回旧有 LegacySuccess 记账一次。
func (executor *Executor) RecordSuccess(
	ctx context.Context,
	result Result,
	model string,
) {
	if executor == nil {
		return
	}
	accountRef := strings.TrimSpace(result.Execution.Account.AccountRef)
	model = strings.TrimSpace(model)
	if accountRef == "" || model == "" {
		return
	}
	at := executor.now()
	if executor.observedAttempts != nil && result.HasObserved && result.Observation.IsValid() {
		ref, err := accountcore.ParseAccountRef(accountRef)
		if err != nil {
			return
		}
		route, routeErr := runtimecore.NewModelRoute(ref, model)
		if routeErr != nil {
			return
		}
		success, successErr := inferencegateway.NewAttemptSuccess(at)
		if successErr != nil {
			return
		}
		_, _ = executor.observedAttempts.RecordSuccess(ctx, route, result.Observation, success)
		return
	}
	if executor.legacySuccess != nil {
		executor.legacySuccess(ctx, accountRef, model, at)
	}
}

func (executor *Executor) now() time.Time {
	if executor != nil && executor.clock != nil {
		return executor.clock().UTC()
	}
	return time.Now().UTC()
}
