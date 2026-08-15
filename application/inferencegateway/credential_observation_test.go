package inferencegateway

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// TestRequestAccountFailureRecorderSkipsStaleCredentialFailure 验证旧凭据请求在
// 重登或轮换完成后迟到的失败不会污染新凭据运行态。
func TestRequestAccountFailureRecorderSkipsStaleCredentialFailure(t *testing.T) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime().Add(-time.Hour))
	verifier := &credentialObservationVerifierStub{currentAt: failureTestTime()}
	attempts := &credentialObservationAttemptRecorder{}
	recorder := newFailureTestRequestRecorder(t, attempts, verifier)

	err := recorder.Record(
		context.Background(),
		"codex",
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	if attempts.FailureCount() != 0 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

// TestRequestAccountFailureRecorderWritesCurrentCredentialFailure 验证当前凭据观察仍
// 按原失败策略更新运行态。
func TestRequestAccountFailureRecorderWritesCurrentCredentialFailure(t *testing.T) {
	t.Parallel()

	observedAt := failureTestTime()
	observation := newFailureTestObservation(t, observedAt)
	verifier := &credentialObservationVerifierStub{currentAt: observedAt}
	attempts := &credentialObservationAttemptRecorder{}
	recorder := newFailureTestRequestRecorder(t, attempts, verifier)

	err := recorder.Record(
		context.Background(),
		"claude",
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	if attempts.FailureCount() != 1 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

// TestRequestAccountFailureRecorderRechecksDeferredFailureAtFinalization 验证模糊失败
// 暂存时不提前判断；真正提交前若凭据已经变化则必须跳过状态写入。
func TestRequestAccountFailureRecorderRechecksDeferredFailureAtFinalization(
	t *testing.T,
) {
	t.Parallel()

	observedAt := failureTestTime().Add(-time.Hour)
	observation := newFailureTestObservation(t, observedAt)
	verifier := &credentialObservationVerifierStub{currentAt: observedAt}
	attempts := &credentialObservationAttemptRecorder{}
	recorder := newFailureTestRequestRecorder(t, attempts, verifier)
	route := newFailureTestRoute(t, observation.AccountRef())

	if err := recorder.Record(
		context.Background(),
		"codex",
		route,
		observation,
		newFailureTestAttempt(t, true),
	); err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	if verifier.CallCount() != 0 {
		t.Fatalf("暂存阶段 verification calls = %d, want 0", verifier.CallCount())
	}
	verifier.SetCurrentAt(failureTestTime())

	if err := recorder.FinalizeFailure(context.Background()); err != nil {
		t.Fatalf("FinalizeFailure() error = %v", err)
	}
	if attempts.FailureCount() != 0 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

// TestRequestAccountFailureRecorderFailsClosedWhenObservationIsUnverifiable 验证冷路径
// 存储异常时保留真实上游终态编排，但不允许写入无法证明归属的账号状态。
func TestRequestAccountFailureRecorderFailsClosedWhenObservationIsUnverifiable(
	t *testing.T,
) {
	t.Parallel()

	observation := newFailureTestObservation(t, failureTestTime())
	verifier := &credentialObservationVerifierStub{
		err: errors.New("synthetic observation verification failure"),
	}
	attempts := &credentialObservationAttemptRecorder{}
	recorder := newFailureTestRequestRecorder(t, attempts, verifier)

	err := recorder.Record(
		context.Background(),
		"claude",
		newFailureTestRoute(t, observation.AccountRef()),
		observation,
		newFailureTestAttempt(t, false),
	)
	if err != nil {
		t.Fatalf("Record() error = %v", err)
	}
	if attempts.FailureCount() != 0 || verifier.CallCount() != 1 {
		t.Fatalf(
			"failures=%d verification_calls=%d",
			attempts.FailureCount(),
			verifier.CallCount(),
		)
	}
}

type credentialObservationVerifierStub struct {
	mu        sync.Mutex
	currentAt time.Time
	err       error
	calls     int
}

func newFailureTestRequestRecorder(
	t *testing.T,
	attempts AttemptRecorder,
	verifier CredentialObservationVerifier,
) *requestAccountFailureRecorder {
	t.Helper()

	failures, err := NewObservedAttemptRecorder(attempts, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}
	return newRequestAccountFailureRecorder(failures)
}

func (verifier *credentialObservationVerifierStub) IsCurrentCredentialObservation(
	_ context.Context,
	observation accountcredentials.CredentialObservation,
) (bool, error) {
	verifier.mu.Lock()
	defer verifier.mu.Unlock()
	verifier.calls++
	if verifier.err != nil {
		return false, verifier.err
	}
	return observation.UpdatedAt().Equal(verifier.currentAt), nil
}

func (verifier *credentialObservationVerifierStub) SetCurrentAt(currentAt time.Time) {
	verifier.mu.Lock()
	verifier.currentAt = currentAt
	verifier.mu.Unlock()
}

func (verifier *credentialObservationVerifierStub) CallCount() int {
	verifier.mu.Lock()
	defer verifier.mu.Unlock()
	return verifier.calls
}

type credentialObservationAttemptRecorder struct {
	mu        sync.Mutex
	successes int
	failures  int
}

func (recorder *credentialObservationAttemptRecorder) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
	AttemptSuccess,
) error {
	recorder.mu.Lock()
	recorder.successes++
	recorder.mu.Unlock()
	return nil
}

func (recorder *credentialObservationAttemptRecorder) RecordFailure(
	context.Context,
	runtimecore.ModelRoute,
	AttemptFailure,
) error {
	recorder.mu.Lock()
	recorder.failures++
	recorder.mu.Unlock()
	return nil
}

func (recorder *credentialObservationAttemptRecorder) FailureCount() int {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.failures
}

func (recorder *credentialObservationAttemptRecorder) SuccessCount() int {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.successes
}

type failureTestCredential struct{}

func (failureTestCredential) ProviderID() string { return "codex" }

func (failureTestCredential) IdentitySeed() string {
	return "api_key:codex:credential-observation"
}

func (failureTestCredential) String() string { return "failureTestCredential{codex}" }

func (credential failureTestCredential) GoString() string { return credential.String() }

func newFailureTestObservation(
	t *testing.T,
	updatedAt time.Time,
) accountcredentials.CredentialObservation {
	t.Helper()

	credential := failureTestCredential{}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential.ProviderID(),
		credential,
		updatedAt,
	)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	if err != nil {
		t.Fatalf("NewCredentialObservation() error = %v", err)
	}
	return observation
}

func newFailureTestRoute(
	t *testing.T,
	accountRef accountcore.AccountRef,
) runtimecore.ModelRoute {
	t.Helper()

	route, err := runtimecore.NewModelRoute(accountRef, "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	return route
}

func newFailureTestAttempt(t *testing.T, deferred bool) AttemptFailure {
	t.Helper()

	response, err := inference.NewResponseFailure(
		"rate_limited",
		"Upstream request was rate limited",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failure, err := NewAttemptFailure(AttemptFailureInput{
		ResponseFailure:                        response,
		RuntimeKind:                            runtimecore.FailureRateLimited,
		RetryAfter:                             time.Second,
		DeferAccountFailureUntilRequestOutcome: deferred,
	})
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	return failure
}

func failureTestTime() time.Time {
	return time.Date(2026, 8, 15, 8, 0, 0, 0, time.UTC)
}
