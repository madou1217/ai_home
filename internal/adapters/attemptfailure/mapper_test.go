package attemptfailure

import (
	"errors"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// TestNewBuildsSafeCanonicalFailure 验证 Provider 共用映射同时保留
// 运行态分类、有限恢复提示和客户端安全文本。
func TestNewBuildsSafeCanonicalFailure(t *testing.T) {
	t.Parallel()

	classification, err := sharedfailure.NewClassification(
		runtimecore.FailureRateLimited,
		2*time.Second,
	)
	if err != nil {
		t.Fatalf("NewClassification() error = %v", err)
	}
	failure, err := New(classification)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if failure.RuntimeKind() != runtimecore.FailureRateLimited ||
		failure.RetryAfter() != 2*time.Second ||
		failure.ResponseFailure().Code() != "rate_limited" ||
		failure.ResponseFailure().SafeMessage() != "上游请求频率受限" ||
		!failure.ResponseFailure().Retryable() {
		t.Fatalf("failure = %#v", failure)
	}
}

// TestNewRejectsZeroClassification 验证零值分类不能伪装成运行态事件。
func TestNewRejectsZeroClassification(t *testing.T) {
	t.Parallel()

	if _, err := New(sharedfailure.Classification{}); !errors.Is(
		err,
		sharedfailure.ErrInvalidClassification,
	) {
		t.Fatalf("New(zero) error = %v", err)
	}
}
