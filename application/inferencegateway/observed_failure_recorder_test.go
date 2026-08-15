package inferencegateway

import (
	"context"
	"errors"
	"testing"
	"time"
)

// TestObservedFailureRecorderSkipsStaleCredential 验证旧凭据的迟到失败不会写入
// 当前账号运行态，但调用方仍能继续处理原始上游终态。
func TestObservedFailureRecorderSkipsStaleCredential(t *testing.T) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime().Add(-time.Hour))
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}

	recorded, err := recorder.RecordFailure(
		context.Background(),
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil || recorded {
		t.Fatalf("RecordFailure() recorded=%t error=%v", recorded, err)
	}
	if attempts.FailureCount() != 0 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

// TestObservedFailureRecorderWritesCurrentCredential 验证当前凭据的失败仍由既有
// AttemptRecorder 原样落入运行态。
func TestObservedFailureRecorderWritesCurrentCredential(t *testing.T) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime())
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}

	recorded, err := recorder.RecordFailure(
		context.Background(),
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil || !recorded {
		t.Fatalf("RecordFailure() recorded=%t error=%v", recorded, err)
	}
	if attempts.FailureCount() != 1 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

// TestObservedFailureRecorderFailsClosedWhenUnverifiable 验证存储异常只关闭状态
// 写入，不把校验异常冒充成上游请求失败。
func TestObservedFailureRecorderFailsClosedWhenUnverifiable(t *testing.T) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime())
	verifier := &credentialObservationVerifierStub{
		err: errors.New("synthetic verifier failure"),
	}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}

	recorded, err := recorder.RecordFailure(
		context.Background(),
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil || recorded {
		t.Fatalf("RecordFailure() recorded=%t error=%v", recorded, err)
	}
	if attempts.FailureCount() != 0 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

// TestObservedAttemptRecorderSkipsStaleCredentialSuccess 验证 v1 请求迟到成功时，
// v2 已写入的运行态不会被旧凭据代次清除。
func TestObservedAttemptRecorderSkipsStaleCredentialSuccess(t *testing.T) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime().Add(-time.Hour))
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}
	success, err := NewAttemptSuccess(failureTestTime().Add(time.Second))
	if err != nil {
		t.Fatalf("NewAttemptSuccess() error = %v", err)
	}

	recorded, err := recorder.RecordSuccess(
		context.Background(),
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		success,
	)
	if err != nil || recorded {
		t.Fatalf("RecordSuccess() recorded=%t error=%v", recorded, err)
	}
	if attempts.SuccessCount() != 0 || verifier.CallCount() != 1 {
		t.Fatalf(
			"successes=%d verification_calls=%d",
			attempts.SuccessCount(),
			verifier.CallCount(),
		)
	}
}

// TestObservedAttemptRecorderWritesCurrentCredentialSuccess 验证当前凭据成功携带
// 发生时间进入运行态，允许它清除同代更早的瞬态失败。
func TestObservedAttemptRecorderWritesCurrentCredentialSuccess(t *testing.T) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime())
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}
	success, err := NewAttemptSuccess(failureTestTime().Add(time.Second))
	if err != nil {
		t.Fatalf("NewAttemptSuccess() error = %v", err)
	}

	recorded, err := recorder.RecordSuccess(
		context.Background(),
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		success,
	)
	if err != nil || !recorded {
		t.Fatalf("RecordSuccess() recorded=%t error=%v", recorded, err)
	}
	if attempts.SuccessCount() != 1 || verifier.CallCount() != 1 {
		t.Fatalf(
			"successes=%d verification_calls=%d",
			attempts.SuccessCount(),
			verifier.CallCount(),
		)
	}
}
