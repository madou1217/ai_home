package messages

import (
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// newAttemptFailure 保留 Claude 包内错误边界并复用共享失败映射。
func newAttemptFailure(
	classification sharedfailure.Classification,
) (inferencegateway.AttemptFailure, error) {
	failure, err := attemptfailure.New(classification)
	if err != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return failure, nil
}

// newClassifiedFailure 创建不携带 Claude 正文的本地稳定失败。
func newClassifiedFailure(
	kind runtimecore.FailureKind,
) (inferencegateway.AttemptFailure, error) {
	failure, err := attemptfailure.NewClassified(kind)
	if err != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return failure, nil
}

// newTransportFailure 按 Go 错误身份分类，不读取错误文本。
func newTransportFailure(
	err error,
) (inferencegateway.AttemptFailure, error) {
	failure, classifyErr := attemptfailure.NewTransport(err)
	if classifyErr != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return failure, nil
}

// newIncompleteStreamFailure 分类提前断流并保留 Claude 包错误边界。
func newIncompleteStreamFailure(
	err error,
) (inferencegateway.AttemptFailure, error) {
	failure, classifyErr := attemptfailure.NewIncompleteStream(err)
	if classifyErr != nil {
		return inferencegateway.AttemptFailure{}, ErrInvalidUpstreamResponse
	}
	return failure, nil
}
