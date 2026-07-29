package responses

import (
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// newAttemptFailure 把运行态分类转换为客户端安全失败。
func newAttemptFailure(
	classification sharedfailure.Classification,
) (inferencegateway.AttemptFailure, error) {
	if !classification.IsValid() {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	kind := classification.Kind()
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	responseFailure, err := inference.NewResponseFailure(
		string(kind),
		safeFailureMessage(kind),
		policy.Action() != runtimecore.ActionNoStateChange,
	)
	if err != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	failure, err := inferencegateway.NewAttemptFailure(
		responseFailure,
		kind,
		classification.RetryAfter(),
	)
	if err != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return failure, nil
}

// newClassifiedFailure 创建不携带 Provider 正文的本地稳定失败。
func newClassifiedFailure(
	kind runtimecore.FailureKind,
) (inferencegateway.AttemptFailure, error) {
	classification, err := sharedfailure.NewClassification(kind, 0)
	if err != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return newAttemptFailure(classification)
}

// newTransportFailure 按 Go 错误身份分类，不读取错误文本。
func newTransportFailure(
	err error,
) (inferencegateway.AttemptFailure, error) {
	classification, classifyErr := sharedfailure.ClassifyTransportError(err)
	if classifyErr != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return newAttemptFailure(classification)
}

// newIncompleteStreamFailure 区分超时、取消、重置和普通提前断流。
func newIncompleteStreamFailure(
	err error,
) (inferencegateway.AttemptFailure, error) {
	classification, classifyErr := sharedfailure.ClassifyIncompleteStream(err)
	if classifyErr != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return newAttemptFailure(classification)
}

// safeFailureMessage 只返回稳定中文说明，不拼接上游 message。
func safeFailureMessage(kind runtimecore.FailureKind) string {
	switch kind {
	case runtimecore.FailureRateLimited:
		return "上游请求频率受限"
	case runtimecore.FailureModelOverloaded:
		return "目标模型暂时容量不足"
	case runtimecore.FailureUpstreamUnavailable:
		return "上游服务暂时不可用"
	case runtimecore.FailureRequestTimeout:
		return "上游请求超时"
	case runtimecore.FailureConnectionReset:
		return "上游连接被重置"
	case runtimecore.FailureStreamDisconnected:
		return "上游流在完成前中断"
	case runtimecore.FailureCredentialRejected:
		return "上游拒绝当前凭据"
	case runtimecore.FailureReauthenticationRequired:
		return "账号需要重新认证"
	case runtimecore.FailureQuotaExhausted:
		return "账号可用额度已耗尽"
	case runtimecore.FailureBillingBlocked:
		return "账号账单状态不可用"
	case runtimecore.FailureWorkspaceDeactivated:
		return "账号工作区已停用"
	case runtimecore.FailureModelUnsupported:
		return "当前账号不支持目标模型"
	case runtimecore.FailureRegionUnsupported:
		return "当前地区不支持目标能力"
	case runtimecore.FailureInvalidRequest:
		return "上游拒绝当前请求参数"
	case runtimecore.FailureNotFound:
		return "上游资源不存在"
	case runtimecore.FailureSafetyRejected:
		return "请求被上游安全策略拒绝"
	case runtimecore.FailureMalformedResponse:
		return "上游响应结构无效"
	case runtimecore.FailureRequestCancelled:
		return "请求已取消"
	case runtimecore.FailureUnclassified:
		return "上游请求失败"
	default:
		return "上游请求失败"
	}
}
