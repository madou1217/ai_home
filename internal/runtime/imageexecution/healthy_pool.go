package imageexecution

import (
	"context"
	"errors"
	"strings"
	"sync/atomic"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/application/upstreamretry"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
	"github.com/madou1217/ai_home/internal/adapters/images"
)

// maxHealthyPoolExtensionAccounts 限制在初始 images.Execute（上限 3）之后、进入任何 429 睡眠前，
// 零等待续扫剩余健康候选账号的有限上限。命中该上限时严格区分于真实池耗尽：不伪装耗尽、不进入睡眠。
const maxHealthyPoolExtensionAccounts = 32

type healthyPoolOutcome struct {
	result          Result
	recovered       bool
	trulyExhausted  bool
	capHit          bool
	terminalStop    bool
	lastErr         error
	lastFailure     inferencegateway.AttemptFailure
	lastFailureSeen bool
}

// continueHealthyPoolAfter429 仅在非钉选请求已观察到至少一次合法瞬态原始 429、尚未有任何
// 上游提交被接受且初始 3 次尝试未因终态错误提前停止时调用：复用共享已实际派发集合，零等待
// 继续扫描池内其余健康且满足能力闸门的唯一账号，直到成功、真实池耗尽、命中安全上限或遇到终态停止条件。
func (executor *Executor) continueHealthyPoolAfter429(
	ctx context.Context,
	execCtx context.Context,
	reqState *upstreamretry.RequestState,
	reacquirer RateLimitReacquirer,
	provider string,
	request imagegeneration.Request,
	dispatched map[string]struct{},
	tracker *image429Tracker,
	submissionAccepted *atomic.Bool,
	initialErr error,
) healthyPoolOutcome {
	outcome := healthyPoolOutcome{lastErr: initialErr}
	if ctx.Err() != nil || submissionAccepted.Load() {
		outcome.terminalStop = true
		return outcome
	}

	eligibleFn := func(account images.Account) bool {
		return candidateEligible(executor.registry, provider, request, account)
	}
	cursor, err := reacquirer.OpenHealthyPool(ctx, provider, request.Model, dispatched, eligibleFn)
	if err != nil {
		// 无法打开完整健康池游标时不能谎称池已耗尽并开始睡眠。
		outcome.terminalStop = true
		return outcome
	}

	extensionAttempts := 0
	for {
		if ctx.Err() != nil || submissionAccepted.Load() {
			outcome.terminalStop = true
			return outcome
		}
		next, found, nextErr := cursor.Next(ctx)
		if nextErr != nil {
			outcome.terminalStop = true
			return outcome
		}
		if !found {
			outcome.trulyExhausted = true
			return outcome
		}
		if extensionAttempts >= maxHealthyPoolExtensionAccounts {
			// 池中仍有未尝试的健康账号，但已达到本阶段有限安全上限：严禁把 cap-hit 当成池耗尽去睡眠。
			outcome.capHit = true
			return outcome
		}

		refKey := strings.TrimSpace(next.Account.AccountRef)
		if refKey == "" || !next.Observation.IsValid() {
			continue
		}
		if _, already := dispatched[refKey]; already {
			continue
		}
		ref, refErr := accountcore.ParseAccountRef(refKey)
		route, routeErr := runtimecore.NewModelRoute(ref, strings.TrimSpace(request.Model))
		if refErr != nil || routeErr != nil || next.Observation.AccountRef() != ref {
			continue
		}

		dispatched[refKey] = struct{}{}
		extensionAttempts++

		submitCtx := images.ContextWithSubmissionGate(execCtx, func(gateCtx context.Context) error {
			if submissionAccepted.Load() {
				return &submissionAbortError{reason: upstreamretry.AbortReacquireUnavailable}
			}
			if ctx.Err() != nil || gateCtx.Err() != nil {
				return &submissionAbortError{reason: upstreamretry.AbortCancelled}
			}
			return nil
		})

		releaseAdmission, admitErr := executor.acquireAttemptAdmission(ctx, provider, next.Account, request.Model)
		if admitErr != nil {
			// 准入拒绝是瞬态容量事实，不是账号失败：跳过该候选，不记冷却。
			continue
		}
		strategy := executor.registry.Resolve(provider, next.Account)
		generated, generateErr := func() (images.Result, error) {
			defer releaseAdmission()
			return strategy.Generate(submitCtx, buildImagesInput(request, next.Account, executor.http))
		}()
		if generateErr == nil {
			reqState.ClearExplicitRetryAfter()
			outcome.recovered = true
			outcome.result = Result{
				Execution: images.Execution{
					Provider: provider,
					Account:  next.Account,
					Result:   generated,
					Strategy: strategy,
				},
				Observation: next.Observation,
				HasObserved: true,
				Retry:       buildRetryMetadata(reqState, false, executor.now()),
			}
			return outcome
		}

		var abortErr *submissionAbortError
		if errors.As(generateErr, &abortErr) {
			outcome.terminalStop = true
			return outcome
		}
		outcome.lastErr = generateErr
		if ctx.Err() != nil {
			outcome.terminalStop = true
			return outcome
		}

		failure, failureComplete, failureErr := executor.classifyAttemptFailure(provider, next.Account, generateErr)
		var receipt runtimecore.CooldownReceipt
		if failureErr == nil && failure.IsValid() {
			outcome.lastFailure = failure
			outcome.lastFailureSeen = true
			recordImageFailureHint(reqState, generateErr, failure)
			recordCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), executor.recordTimeout)
			recordCtx = runtimecore.ContextWithPriorCooldownReceipt(recordCtx, runtimecore.CooldownReceipt{})
			_, receipt, _ = executor.observedAttempts.RecordFailureWithReceipt(
				recordCtx,
				route,
				next.Observation,
				failure,
			)
			cancel()
		} else {
			reqState.ClearExplicitRetryAfter()
		}

		// I4：只要上游已接受过任意一次 2xx 提交，立刻停止任何续扫与等待，保留当前真实错误。
		if submissionAccepted.Load() {
			outcome.terminalStop = true
			return outcome
		}

		evidence := buildImage429Evidence(
			executor.surface,
			provider,
			next.Account.AccountRef,
			false,
			generateErr,
			failureComplete,
			failure,
		)
		if upstreamretry.Eligible(evidence) {
			if executor.upstream429Retries != nil {
				executor.upstream429Retries.FreezePolicyAtObservation(ctx, reqState, evidence)
			}
			tracker.Record(image429Candidate{
				route:             route,
				evidence:          evidence,
				cooldownReceipt:   receipt,
				originObservation: next.Observation,
				lastErr:           generateErr,
			})
			continue
		}

		if failureErr != nil || !allowsPoolExtensionAfterFailure(failure) {
			outcome.terminalStop = true
			return outcome
		}
	}
}
