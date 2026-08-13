// Package accountruntime 提供真实上游验收使用的低敏运行态观察装饰器。
package accountruntime

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	runtimeinmemory "github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
)

var (
	// ErrInvalidRuntime 表示观察装饰器缺少可用的生产运行态。
	ErrInvalidRuntime = errors.New("真实验收账号运行态无效")
)

// FailureObservation 是不含 Provider 正文、请求内容或凭据的失败投影。
type FailureObservation struct {
	route      runtimecore.ModelRoute
	kind       runtimecore.FailureKind
	retryAfter time.Duration
	directive  runtimecore.BlockDirective
}

// Route 返回失败实际写入的账号模型元组。
func (observation FailureObservation) Route() runtimecore.ModelRoute {
	return observation.route
}

// Kind 返回 Provider Adapter 生成的稳定失败分类。
func (observation FailureObservation) Kind() runtimecore.FailureKind {
	return observation.kind
}

// RetryAfter 返回有限的模型恢复提示。
func (observation FailureObservation) RetryAfter() time.Duration {
	return observation.retryAfter
}

// BlockDirective 返回硬阻塞作用域；非硬阻塞失败返回零值。
func (observation FailureObservation) BlockDirective() runtimecore.BlockDirective {
	return observation.directive
}

// Runtime 使用 Decorator 保留生产状态转换，并额外记录低敏验收证据。
type Runtime struct {
	delegate  *runtimeinmemory.Runtime
	mu        sync.Mutex
	successes int
	failures  []FailureObservation
}

// New 创建生产内存运行态及其低敏观察装饰器。
func New(clock func() time.Time) (*Runtime, error) {
	delegate, err := runtimeinmemory.New(clock)
	if err != nil {
		return nil, errors.Join(ErrInvalidRuntime, err)
	}
	return &Runtime{delegate: delegate}, nil
}

// CheckEligibility 委托生产运行态读取账号模型资格。
func (runtime *Runtime) CheckEligibility(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	if runtime == nil || runtime.delegate == nil {
		return runtimecore.Eligibility{}, ErrInvalidRuntime
	}
	return runtime.delegate.CheckEligibility(ctx, route)
}

// RecordSuccess 先提交生产状态转换，再增加低敏成功计数。
func (runtime *Runtime) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	if runtime == nil || runtime.delegate == nil {
		return ErrInvalidRuntime
	}
	if err := runtime.delegate.RecordSuccess(ctx, route); err != nil {
		return err
	}
	runtime.mu.Lock()
	runtime.successes++
	runtime.mu.Unlock()
	return nil
}

// RecordFailure 先提交生产状态转换，再保存稳定分类与作用域。
func (runtime *Runtime) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	if runtime == nil || runtime.delegate == nil {
		return ErrInvalidRuntime
	}
	if err := runtime.delegate.RecordFailure(ctx, route, failure); err != nil {
		return err
	}
	observation := FailureObservation{
		route:      route,
		kind:       failure.RuntimeKind(),
		retryAfter: failure.RetryAfter(),
		directive:  failure.BlockDirective(),
	}
	runtime.mu.Lock()
	runtime.failures = append(runtime.failures, observation)
	runtime.mu.Unlock()
	return nil
}

// SuccessCount 返回已经由生产运行态接纳的成功终态数量。
func (runtime *Runtime) SuccessCount() int {
	if runtime == nil {
		return 0
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.successes
}

// Failures 返回已经由生产运行态接纳的低敏失败副本。
func (runtime *Runtime) Failures() []FailureObservation {
	if runtime == nil {
		return nil
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return append([]FailureObservation(nil), runtime.failures...)
}

// ExpectedEligibility 返回单次真实失败后目标模型或兄弟模型应有的资格。
// 它只解释领域策略，不读取 Runtime 内部 map，避免验收断言依赖实现细节。
func ExpectedEligibility(
	observation FailureObservation,
	targetModel bool,
) (runtimecore.EligibilityStatus, error) {
	policy, err := runtimecore.PolicyFor(observation.Kind())
	if err != nil {
		return "", errors.Join(ErrInvalidRuntime, err)
	}
	switch policy.Action() {
	case runtimecore.ActionNoStateChange:
		return runtimecore.EligibilityAvailable, nil
	case runtimecore.ActionModelCooldown:
		if targetModel && policy.FailureThreshold() == 1 {
			return runtimecore.EligibilityModelCooldown, nil
		}
		return runtimecore.EligibilityAvailable, nil
	case runtimecore.ActionCredentialBlock:
		return expectedBlockStatus(
			observation,
			targetModel,
			runtimecore.EligibilityCredentialBlocked,
		)
	case runtimecore.ActionQuotaBlock:
		return expectedBlockStatus(
			observation,
			targetModel,
			runtimecore.EligibilityQuotaBlocked,
		)
	case runtimecore.ActionPolicyBlock:
		return expectedBlockStatus(
			observation,
			targetModel,
			runtimecore.EligibilityPolicyBlocked,
		)
	default:
		return "", ErrInvalidRuntime
	}
}

// expectedBlockStatus 把明确账号或账号模型作用域投影为资格状态。
func expectedBlockStatus(
	observation FailureObservation,
	targetModel bool,
	blocked runtimecore.EligibilityStatus,
) (runtimecore.EligibilityStatus, error) {
	directive := observation.BlockDirective()
	if !directive.IsValidFor(observation.Kind()) {
		return "", ErrInvalidRuntime
	}
	switch directive.Scope() {
	case runtimecore.BlockScopeAccount:
		return blocked, nil
	case runtimecore.BlockScopeAccountModel:
		if targetModel {
			return blocked, nil
		}
		return runtimecore.EligibilityAvailable, nil
	default:
		return "", ErrInvalidRuntime
	}
}
