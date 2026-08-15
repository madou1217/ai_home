package inmemory_test

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/internal/adapters/accountruntime/inmemory"
)

// TestObservedRuntimeRejectsStaleAndOutOfOrderSuccess 验证完整运行态边界同时保护
// 凭据代次与同代事件时序：v1 迟到成功不能清 v2 失败，同代旧成功也不能清新失败。
func TestObservedRuntimeRejectsStaleAndOutOfOrderSuccess(t *testing.T) {
	t.Parallel()

	base := time.Date(2026, 8, 15, 10, 0, 0, 0, time.UTC)
	eventTime := base.Add(3 * time.Second)
	runtime, err := inmemory.New(func() time.Time { return eventTime })
	if err != nil {
		t.Fatalf("inmemory.New() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, "gpt-5.6-sol")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	v1 := newRuntimeCredentialObservation(t, accountRef, base)
	v2 := newRuntimeCredentialObservation(t, accountRef, base.Add(time.Second))
	verifier := &runtimeObservationVerifier{currentAt: v2.UpdatedAt()}
	recorder, err := inferencegateway.NewObservedAttemptRecorder(runtime, verifier)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}
	failure := newObservedRuntimeFailure(t)

	recorded, err := recorder.RecordFailure(
		context.Background(),
		route,
		v2,
		failure,
	)
	if err != nil || !recorded {
		t.Fatalf("RecordFailure(v2) recorded=%t error=%v", recorded, err)
	}
	oldSuccess := newObservedRuntimeSuccess(t, base.Add(2*time.Second))
	recorded, err = recorder.RecordSuccess(
		context.Background(),
		route,
		v1,
		oldSuccess,
	)
	if err != nil || recorded {
		t.Fatalf("RecordSuccess(v1) recorded=%t error=%v", recorded, err)
	}
	assertObservedRuntimeCooling(t, runtime, route, true)

	// 凭据仍是 v2，但成功发生在下一次失败之前，也不能清除该失败。
	eventTime = base.Add(6 * time.Second)
	recorded, err = recorder.RecordFailure(
		context.Background(),
		route,
		v2,
		failure,
	)
	if err != nil || !recorded {
		t.Fatalf("RecordFailure(v2 newer) recorded=%t error=%v", recorded, err)
	}
	recorded, err = recorder.RecordSuccess(
		context.Background(),
		route,
		v2,
		newObservedRuntimeSuccess(t, base.Add(5*time.Second)),
	)
	if err != nil || !recorded {
		t.Fatalf("RecordSuccess(v2 older) recorded=%t error=%v", recorded, err)
	}
	assertObservedRuntimeCooling(t, runtime, route, true)

	recorded, err = recorder.RecordSuccess(
		context.Background(),
		route,
		v2,
		newObservedRuntimeSuccess(t, base.Add(7*time.Second)),
	)
	if err != nil || !recorded {
		t.Fatalf("RecordSuccess(v2 current) recorded=%t error=%v", recorded, err)
	}
	assertObservedRuntimeCooling(t, runtime, route, false)
}

type runtimeObservationVerifier struct {
	mu        sync.Mutex
	currentAt time.Time
}

func (verifier *runtimeObservationVerifier) IsCurrentCredentialObservation(
	_ context.Context,
	observation accountcredentials.CredentialObservation,
) (bool, error) {
	verifier.mu.Lock()
	defer verifier.mu.Unlock()
	return observation.UpdatedAt().Equal(verifier.currentAt), nil
}

type runtimeObservationCredential struct{}

func (runtimeObservationCredential) ProviderID() string          { return "codex" }
func (runtimeObservationCredential) IdentitySeed() string        { return "api_key:runtime-observation" }
func (runtimeObservationCredential) String() string              { return "runtimeObservationCredential{codex}" }
func (credential runtimeObservationCredential) GoString() string { return credential.String() }

func newRuntimeCredentialObservation(
	t *testing.T,
	accountRef accountcore.AccountRef,
	updatedAt time.Time,
) accountcredentials.CredentialObservation {
	t.Helper()

	credential := runtimeObservationCredential{}
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

func newObservedRuntimeFailure(t *testing.T) inferencegateway.AttemptFailure {
	t.Helper()

	responseFailure, err := inference.NewResponseFailure(
		"rate_limited",
		"合成上游限流",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failure, err := inferencegateway.NewAttemptFailure(
		inferencegateway.AttemptFailureInput{
			ResponseFailure: responseFailure,
			RuntimeKind:     runtimecore.FailureRateLimited,
			RetryAfter:      time.Minute,
		},
	)
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	return failure
}

func newObservedRuntimeSuccess(
	t *testing.T,
	happenedAt time.Time,
) inferencegateway.AttemptSuccess {
	t.Helper()

	success, err := inferencegateway.NewAttemptSuccess(happenedAt)
	if err != nil {
		t.Fatalf("NewAttemptSuccess() error = %v", err)
	}
	return success
}

func assertObservedRuntimeCooling(
	t *testing.T,
	runtime *inmemory.Runtime,
	route runtimecore.ModelRoute,
	want bool,
) {
	t.Helper()

	eligibility, err := runtime.CheckEligibility(context.Background(), route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if got := !eligibility.Eligible(); got != want {
		t.Fatalf("cooling=%t eligibility=%#v want=%t", got, eligibility, want)
	}
}
