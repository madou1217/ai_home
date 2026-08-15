package inferencegateway

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountcredentials"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

var (
	// ErrInvalidObservedAttemptRecorder 表示终态写入守卫缺少运行态或观察校验端口。
	ErrInvalidObservedAttemptRecorder = errors.New("凭据观察终态写入器依赖无效")
	// ErrInvalidObservedAttempt 表示路由、凭据观察和终态不属于同一调用。
	ErrInvalidObservedAttempt = errors.New("凭据观察终态写入请求无效")
)

// ObservedAttemptRecorder 是所有推理入口共享的终态写入守卫。
//
// 只有请求读取的凭据仍是账号当前快照时才允许写运行态；凭据已经轮换或存储
// 暂时无法验证时采用 fail-closed：跳过状态写入，但不改写调用方持有的上游终态。
type ObservedAttemptRecorder struct {
	attempts     AttemptRecorder
	observations CredentialObservationVerifier
}

// NewObservedAttemptRecorder 创建无请求局部状态、可并发复用的终态写入守卫。
func NewObservedAttemptRecorder(
	attempts AttemptRecorder,
	observations CredentialObservationVerifier,
) (*ObservedAttemptRecorder, error) {
	if attempts == nil || observations == nil {
		return nil, ErrInvalidObservedAttemptRecorder
	}
	return &ObservedAttemptRecorder{
		attempts:     attempts,
		observations: observations,
	}, nil
}

// RecordSuccess 在写入前复核凭据代次；不可验证时只跳过状态清理。
func (recorder *ObservedAttemptRecorder) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	success AttemptSuccess,
) (bool, error) {
	if !recorder.validObservation(ctx, route, observation) || !success.IsValid() {
		return false, ErrInvalidObservedAttempt
	}
	current, err := recorder.observations.IsCurrentCredentialObservation(
		ctx,
		observation,
	)
	if err != nil || !current {
		return false, nil
	}
	if err := recorder.attempts.RecordSuccess(ctx, route, success); err != nil {
		return false, err
	}
	return true, nil
}

// RecordFailure 在失败冷路径复核凭据观察，并返回是否实际写入了运行态。
//
// 校验存储异常与凭据已变化都返回 recorded=false、error=nil，避免把本地观察
// 故障替换成客户端原本应该收到的真实上游结果。
func (recorder *ObservedAttemptRecorder) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
) (bool, error) {
	if !recorder.validObservation(ctx, route, observation) || !failure.IsValid() {
		return false, ErrInvalidObservedAttempt
	}
	current, err := recorder.observations.IsCurrentCredentialObservation(
		ctx,
		observation,
	)
	if err != nil || !current {
		return false, nil
	}
	if err := recorder.attempts.RecordFailure(ctx, route, failure); err != nil {
		return false, err
	}
	return true, nil
}

// validObservation 统一成功和失败写入的身份不变量。
func (recorder *ObservedAttemptRecorder) validObservation(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
) bool {
	return recorder != nil &&
		recorder.attempts != nil &&
		recorder.observations != nil &&
		ctx != nil &&
		route.IsValid() &&
		observation.IsValid() &&
		observation.AccountRef() == route.AccountRef()
}
