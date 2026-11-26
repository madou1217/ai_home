package upstreamfailure

// 本文件把失败语义契约的命中结果转换成共享分类值对象。
//
// 契约只回答"这次证据命中哪条语义、作用域是什么"；冷却时长、阻塞指令与来源
// 证据的拼装集中在这里，Provider 分类器不再各写一份。

import (
	"time"

	failurecontract "github.com/madou1217/ai_home/contracts/upstream-failure"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/failureprovenance"
)

// ClassifySignal 把契约命中结果转换为运行态分类。
//
// retryAfter 只在语义属于有限时间冷却时保留；阻塞与无状态语义必须归零。
// 来源证据里的 Provider 使用命中行声明的 Provider（"all" 表示通用行），错误
// 标识使用本次真实观察值。
func ClassifySignal(
	match failurecontract.Match,
	statusCode int,
	retryAfter time.Duration,
) (Classification, error) {
	kind := runtimecore.FailureKind(match.Semantic)
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil {
		return Classification{}, ErrInvalidClassification
	}
	provenance := failureprovenance.New(
		failureprovenance.Source(match.Source),
		match.SignalID,
		match.Provider,
		match.ErrorType,
		match.ErrorCode,
		statusCode,
	)
	if policy.BlocksRouting() {
		scope := runtimecore.BlockScope(match.BlockScope)
		if scope == "" {
			defaultScope, ok := policy.DefaultBlockScope()
			if !ok {
				return Classification{}, ErrInvalidClassification
			}
			scope = defaultScope
		}
		classification, blockErr := NewBlockingClassification(kind, scope)
		if blockErr != nil {
			return Classification{}, blockErr
		}
		return classification.WithProvenance(provenance), nil
	}
	if !policy.EntersCooldown() {
		retryAfter = 0
	}
	classification, classifyErr := NewClassification(kind, retryAfter)
	if classifyErr != nil {
		return Classification{}, classifyErr
	}
	return classification.WithProvenance(provenance), nil
}

// SignalRetryAfter 计算契约命中后应写入分类的恢复提示。
//
// 只有有限时间冷却语义保留提示；显式 Retry-After 优先，超过领域上限时归零
// （不能把"几小时"伪装成短冷却），缺失时按状态码补与旧分类器相同的猜测值。
func SignalRetryAfter(
	kind runtimecore.FailureKind,
	statusCode int,
	explicit time.Duration,
) time.Duration {
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil || !policy.EntersCooldown() {
		return 0
	}
	if explicit > 0 {
		if explicit > runtimecore.MaxCooldownHint {
			return 0
		}
		return explicit
	}
	switch {
	case statusCode == 503 && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.ConfiguredGuessedCooldown()
	case statusCode >= 500 && kind == runtimecore.FailureUpstreamUnavailable:
		return runtimecore.ConfiguredGuessedCooldown()
	case statusCode == 529 && kind == runtimecore.FailureModelOverloaded:
		return runtimecore.ConfiguredGuessedCooldown()
	default:
		return 0
	}
}

// SignalInputFrom 按真实观察拼装契约输入。
func SignalInputFrom(
	provider string,
	statusCode int,
	errorType string,
	errorCode string,
	retryAfter time.Duration,
	conditions map[string]bool,
) failurecontract.SignalInput {
	return SignalInputFromSurface(provider, "", statusCode, errorType, errorCode, retryAfter, conditions)
}

// SignalInputFromSurface 在 SignalInputFrom 的基础上带上端点/协议面键。
//
// 同一 Provider 的不同上游端点（例如 zcode 的 plan 与 ultra）对同名 code
// 可能有不同语义；只有调用方明确知道端点时才传 surface，其余调用保持空。
func SignalInputFromSurface(
	provider string,
	surface string,
	statusCode int,
	errorType string,
	errorCode string,
	retryAfter time.Duration,
	conditions map[string]bool,
) failurecontract.SignalInput {
	millis := int64(0)
	if retryAfter > 0 {
		millis = retryAfter.Milliseconds()
	}
	return failurecontract.SignalInput{
		Provider:   provider,
		Surface:    surface,
		StatusCode: statusCode,
		ErrorType:  errorType,
		ErrorCode:  errorCode,
		RetryAfter: millis,
		Conditions: conditions,
	}
}
