package accountruntime

import (
	"context"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// TestRuntimeObservesProductionTransitionsWithoutReadingPrivateState 验证装饰器
// 通过公开端口观察分类，并由生产 Runtime 决定目标模型与兄弟模型资格。
func TestRuntimeObservesProductionTransitionsWithoutReadingPrivateState(t *testing.T) {
	t.Parallel()

	runtime, err := New(func() time.Time { return testRuntimeTime })
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	target, err := runtimecore.NewModelRoute(accountRef, "gpt-target")
	if err != nil {
		t.Fatalf("NewModelRoute(target) error = %v", err)
	}
	sibling, err := runtimecore.NewModelRoute(accountRef, "gpt-sibling")
	if err != nil {
		t.Fatalf("NewModelRoute(sibling) error = %v", err)
	}
	failure := newTestFailure(t, runtimecore.FailureModelOverloaded)
	if err := runtime.RecordFailure(context.Background(), target, failure); err != nil {
		t.Fatalf("RecordFailure() error = %v", err)
	}

	failures := runtime.Failures()
	if len(failures) != 1 || failures[0].Route() != target ||
		failures[0].Kind() != runtimecore.FailureModelOverloaded {
		t.Fatalf("Failures() = %#v", failures)
	}
	assertTestEligibility(t, runtime, target, runtimecore.EligibilityModelCooldown)
	assertTestEligibility(t, runtime, sibling, runtimecore.EligibilityAvailable)
	targetExpected, err := ExpectedEligibility(failures[0], true)
	if err != nil || targetExpected != runtimecore.EligibilityModelCooldown {
		t.Fatalf("ExpectedEligibility(target) = %s, %v", targetExpected, err)
	}
	siblingExpected, err := ExpectedEligibility(failures[0], false)
	if err != nil || siblingExpected != runtimecore.EligibilityAvailable {
		t.Fatalf("ExpectedEligibility(sibling) = %s, %v", siblingExpected, err)
	}
}

// TestExpectedEligibilityHonorsAccountBlockScope 验证账号级凭据阻塞覆盖兄弟模型。
func TestExpectedEligibilityHonorsAccountBlockScope(t *testing.T) {
	t.Parallel()

	directive, err := runtimecore.DefaultBlockDirective(
		runtimecore.FailureCredentialRejected,
	)
	if err != nil {
		t.Fatalf("DefaultBlockDirective() error = %v", err)
	}
	observation := FailureObservation{
		kind:      runtimecore.FailureCredentialRejected,
		directive: directive,
	}
	for _, targetModel := range []bool{true, false} {
		status, expectedErr := ExpectedEligibility(observation, targetModel)
		if expectedErr != nil || status != runtimecore.EligibilityCredentialBlocked {
			t.Fatalf(
				"ExpectedEligibility(target=%t) = %s, %v",
				targetModel,
				status,
				expectedErr,
			)
		}
	}
}

func newTestFailure(
	t *testing.T,
	kind runtimecore.FailureKind,
) inferencegateway.AttemptFailure {
	t.Helper()
	response, err := inference.NewResponseFailure(
		string(kind),
		"安全失败",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failure, err := inferencegateway.NewAttemptFailure(
		inferencegateway.AttemptFailureInput{
			ResponseFailure: response,
			RuntimeKind:     kind,
		},
	)
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	return failure
}

func assertTestEligibility(
	t *testing.T,
	runtime *Runtime,
	route runtimecore.ModelRoute,
	want runtimecore.EligibilityStatus,
) {
	t.Helper()
	eligibility, err := runtime.CheckEligibility(context.Background(), route)
	if err != nil || eligibility.Status() != want {
		t.Fatalf("CheckEligibility() = %#v, %v, want %s", eligibility, err, want)
	}
}

var testRuntimeTime = time.Date(2026, 8, 13, 12, 0, 0, 0, time.UTC)
