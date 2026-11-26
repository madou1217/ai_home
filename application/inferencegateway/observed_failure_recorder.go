package inferencegateway

import (
	"context"
	"errors"

	"github.com/madou1217/ai_home/application/accountcredentials"
	pluginruntime "github.com/madou1217/ai_home/application/pluginruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

var (
	// ErrInvalidObservedAttemptRecorder 表示终态写入守卫缺少运行态或观察校验端口。
	ErrInvalidObservedAttemptRecorder = errors.New("凭据观察终态写入器依赖无效")
	// ErrInvalidObservedAttempt 表示路由、凭据观察和终态不属于同一调用。
	ErrInvalidObservedAttempt = errors.New("凭据观察终态写入请求无效")
	// ErrObservedCredentialRejectionUnsupported 表示自定义运行态未提供观察归属门禁。
	ErrObservedCredentialRejectionUnsupported = errors.New("账号运行态不支持凭据拒收观察归属")
)

// CredentialRejectionScheduler 只接收请求实际读取的低敏凭据代次。
// 调度失败不改变当前请求的终态，也不触发请求重放。
type CredentialRejectionScheduler interface {
	TryScheduleCredentialRejection(accountcredentials.CredentialObservation) bool
}

// CredentialRejectionWrite 在当前观察校验之前登记，校验后最多提交一次。
// 所有出口都必须 Close；句柄不保存凭据，也不执行校验 I/O。
type CredentialRejectionWrite interface {
	Commit(context.Context, AttemptFailure) (recorded bool, err error)
	Close()
}

// ObservedCredentialRejectionRuntime 是不扩展旧 AttemptRecorder 的可选能力。
// Clear 的 replacement 必须由调用方提供权威新代证据；该端口不读取凭据存储。
type ObservedCredentialRejectionRuntime interface {
	BeginObservedCredentialRejection(context.Context, runtimecore.ModelRoute,
		accountcredentials.CredentialObservation) (CredentialRejectionWrite, error)
	ClearObservedCredentialRejection(context.Context,
		accountcredentials.CredentialObservation,
		accountcredentials.CredentialObservation) (cleared bool, err error)
}

// ObservedFailureReceiptRuntime 是不扩展旧 AttemptRecorder 的可选能力，用于在同锁内
// 原子返回本次被接受的 cooldown 写入所对应的单调代次凭证。
type ObservedFailureReceiptRuntime interface {
	RecordFailureWithReceipt(
		ctx context.Context,
		route runtimecore.ModelRoute,
		failure AttemptFailure,
	) (runtimecore.CooldownReceipt, error)
}

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
//
// 插件观察事件是「这次尝试发生过」的事实，和运行态是否允许写入无关：凭据轮换或
// 存储暂时不可读时仍要投递，否则 observe 插件会漏掉这次请求（Node 侧按尝试记录，
// 不按状态写入是否成功记录）。
func (recorder *ObservedAttemptRecorder) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	success AttemptSuccess,
) (bool, error) {
	if !recorder.validObservation(ctx, route, observation) || !success.IsValid() {
		return false, ErrInvalidObservedAttempt
	}
	defer pluginruntime.ObserveAttempt(ctx, route.AccountRef().String(), route.ModelID().String(), true, "")
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
// 故障替换成客户端原本应该收到的真实上游结果。观察事件不受该守卫影响，理由
// 同 RecordSuccess。
func (recorder *ObservedAttemptRecorder) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
) (bool, error) {
	recorded, _, err := recorder.RecordFailureWithReceipt(ctx, route, observation, failure)
	return recorded, err
}

// RecordFailureWithReceipt 在失败冷路径复核凭据观察，并在写入实际被运行态接受且
// 运行态实现 ObservedFailureReceiptRuntime 时原子返回本次 cooldown 写入代次凭证。
// 凭据已变化或校验失败跳过写入时，必然返回 recorded=false 与零值凭证（fail-closed）。
func (recorder *ObservedAttemptRecorder) RecordFailureWithReceipt(
	ctx context.Context,
	route runtimecore.ModelRoute,
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
) (recorded bool, receipt runtimecore.CooldownReceipt, err error) {
	if !recorder.validObservation(ctx, route, observation) || !failure.IsValid() {
		return false, runtimecore.CooldownReceipt{}, ErrInvalidObservedAttempt
	}
	if observation.IsStaticSecret() {
		failure = failure.forStaticSecret()
	}
	// 必须用闭包：defer 的实参在注册时求值，而 recorded/receipt 只在返回前才有最终值。
	defer func() { emitFailureProvenance(ctx, route, failure, recorded, receipt) }()
	defer pluginruntime.ObserveAttempt(ctx, route.AccountRef().String(), route.ModelID().String(), false, string(failure.RuntimeKind()))
	eligible := observedCredentialRejection(observation, failure)
	var write CredentialRejectionWrite
	if eligible {
		if runtime, ok := recorder.attempts.(ObservedCredentialRejectionRuntime); ok {
			var err error
			write, err = runtime.BeginObservedCredentialRejection(ctx, route, observation)
			if write != nil {
				defer write.Close()
			}
			if errors.Is(err, ErrObservedCredentialRejectionUnsupported) {
				write = nil
			} else if err != nil {
				return false, runtimecore.CooldownReceipt{}, err
			} else if write == nil {
				return false, runtimecore.CooldownReceipt{}, ErrInvalidObservedAttemptRecorder
			}
		}
	}
	current, err := recorder.observations.IsCurrentCredentialObservation(
		ctx,
		observation,
	)
	if err != nil || !current {
		return false, runtimecore.CooldownReceipt{}, nil
	}
	if write != nil {
		var commitErr error
		recorded, commitErr = write.Commit(ctx, failure)
		if commitErr != nil || !recorded {
			return recorded, runtimecore.CooldownReceipt{}, commitErr
		}
	} else if receiptRuntime, ok := recorder.attempts.(ObservedFailureReceiptRuntime); ok {
		receipt, err = receiptRuntime.RecordFailureWithReceipt(ctx, route, failure)
		if err != nil {
			return false, runtimecore.CooldownReceipt{}, err
		}
		recorded = true
	} else if recordErr := recorder.attempts.RecordFailure(ctx, route, failure); recordErr != nil {
		return false, runtimecore.CooldownReceipt{}, recordErr
	} else {
		recorded = true
	}
	if eligible {
		if scheduler, ok := recorder.attempts.(CredentialRejectionScheduler); ok {
			scheduler.TryScheduleCredentialRejection(observation)
		}
	}
	return true, receipt, nil
}

// IsCurrentCredentialObservation 在使用 429 自冷却豁免派发重试前复核原始失败凭据代次仍为当前快照。
func (recorder *ObservedAttemptRecorder) IsCurrentCredentialObservation(
	ctx context.Context,
	observation accountcredentials.CredentialObservation,
) (bool, error) {
	if recorder == nil || recorder.observations == nil || ctx == nil || !observation.IsValid() {
		return false, ErrInvalidObservedAttempt
	}
	return recorder.observations.IsCurrentCredentialObservation(ctx, observation)
}

// observedCredentialRejection 只接受内置分类保留的实际 HTTP401 证据。
func observedCredentialRejection(
	observation accountcredentials.CredentialObservation,
	failure AttemptFailure,
) bool {
	status, known := failure.ObservedHTTPStatus()
	return known && status == 401 && !observation.IsStaticSecret() &&
		failure.RuntimeKind() == runtimecore.FailureCredentialRejected &&
		failure.BlockDirective().Scope() == runtimecore.BlockScopeAccount &&
		failure.BlockDirective().RecoveryTrigger() == runtimecore.RecoveryCredentialsUpdated
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
