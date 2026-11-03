package inferencegateway

import (
	"context"
	"errors"
	"time"
)

const (
	DefaultRequestPoolRetryBackoff = 500 * time.Millisecond
	DefaultRequestPoolRetryBudget  = 30 * time.Second
	maxRequestPoolRetryBackoff     = 5 * time.Second
	maxRequestPoolRetryBudget      = time.Minute
)

var ErrInvalidRequestPoolRetryPolicy = errors.New("请求级账号池重试策略无效")

// RetrySleeper 把一次有界退避与策略判定解耦，便于取消与确定性测试。
type RetrySleeper interface {
	Sleep(ctx context.Context, delay time.Duration) error
}

type timerRetrySleeper struct{}

func (timerRetrySleeper) Sleep(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// RequestPoolRetryPolicyOptions 声明一次外部请求内唯一允许的账号池第二轮。
type RequestPoolRetryPolicyOptions struct {
	Backoff time.Duration
	Budget  time.Duration
	Sleeper RetrySleeper
}

// RequestPoolRetryPolicy 只表达 AGY 模糊整池失败的有界第二轮，不保存跨请求状态。
type RequestPoolRetryPolicy struct {
	backoff time.Duration
	budget  time.Duration
	sleeper RetrySleeper
}

func NewRequestPoolRetryPolicy(
	options RequestPoolRetryPolicyOptions,
) (*RequestPoolRetryPolicy, error) {
	if options.Backoff <= 0 ||
		options.Backoff > maxRequestPoolRetryBackoff ||
		options.Budget < options.Backoff ||
		options.Budget > maxRequestPoolRetryBudget ||
		options.Sleeper == nil {
		return nil, ErrInvalidRequestPoolRetryPolicy
	}
	return &RequestPoolRetryPolicy{
		backoff: options.Backoff,
		budget:  options.Budget,
		sleeper: options.Sleeper,
	}, nil
}

func NewDefaultRequestPoolRetryPolicy() (*RequestPoolRetryPolicy, error) {
	return NewRequestPoolRetryPolicy(RequestPoolRetryPolicyOptions{
		Backoff: DefaultRequestPoolRetryBackoff,
		Budget:  DefaultRequestPoolRetryBudget,
		Sleeper: timerRetrySleeper{},
	})
}

func (policy *RequestPoolRetryPolicy) withBudget(
	ctx context.Context,
) (context.Context, context.CancelFunc) {
	if policy == nil {
		return ctx, func() {}
	}
	return context.WithTimeout(ctx, policy.budget)
}

func (policy *RequestPoolRetryPolicy) wait(ctx context.Context) error {
	if policy == nil {
		return ErrInvalidRequestPoolRetryPolicy
	}
	return policy.sleeper.Sleep(ctx, policy.backoff)
}
