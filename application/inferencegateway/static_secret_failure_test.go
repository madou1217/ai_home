package inferencegateway

import (
	"context"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
)

// TestObservedAttemptRecorderCoolsDownRejectedStaticSecret 验证静态密钥被拒只进
// 有限 cooldown：它没有刷新路径，硬阻塞会把一次偶发 401 变成永久锁死。
func TestObservedAttemptRecorderCoolsDownRejectedStaticSecret(t *testing.T) {
	t.Parallel()

	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "sk-static-secret-test",
		BaseURL: "https://relay.example.com/v1",
	})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	kind := recordCredentialRejection(t, credential)
	if kind != runtimecore.FailureStaticCredentialRejected {
		t.Fatalf("recorded kind = %q, want %q", kind, runtimecore.FailureStaticCredentialRejected)
	}
	policy, err := runtimecore.PolicyFor(kind)
	if err != nil || !policy.EntersCooldown() || policy.BlocksRouting() ||
		policy.DefaultCooldown() != runtimecore.StaticCredentialRejectedCooldown {
		t.Fatalf("policy = %#v err = %v", policy, err)
	}
}

// TestObservedAttemptRecorderKeepsCredentialBlockForRefreshableCredential 验证可刷新
// 凭据仍是硬阻塞：由 Node 刷新并推送新凭据后解除。
func TestObservedAttemptRecorderKeepsCredentialBlockForRefreshableCredential(t *testing.T) {
	t.Parallel()

	kind := recordCredentialRejection(t, failureTestCredential{})
	if kind != runtimecore.FailureCredentialRejected {
		t.Fatalf("recorded kind = %q, want %q", kind, runtimecore.FailureCredentialRejected)
	}
}

func recordCredentialRejection(
	t *testing.T,
	credential accountapp.Credential,
) runtimecore.FailureKind {
	t.Helper()

	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	updatedAt := failureTestTime()
	snapshot, err := accountapp.NewCredentialSnapshot(accountRef, "codex", credential, updatedAt)
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	observation, err := accountcredentials.NewCredentialObservation(snapshot)
	if err != nil {
		t.Fatalf("NewCredentialObservation() error = %v", err)
	}
	attempts := &kindCapturingAttemptRecorder{}
	recorder, err := NewObservedAttemptRecorder(
		attempts,
		&credentialObservationVerifierStub{currentAt: updatedAt},
	)
	if err != nil {
		t.Fatalf("NewObservedAttemptRecorder() error = %v", err)
	}
	recorded, err := recorder.RecordFailure(
		context.Background(),
		newFailureTestRoute(t, accountRef),
		observation,
		newCredentialRejectedAttempt(t),
	)
	if err != nil || !recorded {
		t.Fatalf("RecordFailure() recorded = %v err = %v", recorded, err)
	}
	return attempts.Kind()
}

func newCredentialRejectedAttempt(t *testing.T) AttemptFailure {
	t.Helper()

	response, err := inference.NewResponseFailure(
		string(runtimecore.FailureCredentialRejected),
		"Upstream rejected the credential",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	directive, err := runtimecore.NewBlockDirective(
		runtimecore.FailureCredentialRejected,
		runtimecore.BlockScopeAccount,
	)
	if err != nil {
		t.Fatalf("NewBlockDirective() error = %v", err)
	}
	failure, err := NewAttemptFailure(AttemptFailureInput{
		ResponseFailure: response,
		RuntimeKind:     runtimecore.FailureCredentialRejected,
		BlockDirective:  directive,
	})
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	return failure
}

type kindCapturingAttemptRecorder struct {
	mu   sync.Mutex
	kind runtimecore.FailureKind
}

func (*kindCapturingAttemptRecorder) RecordSuccess(
	context.Context,
	runtimecore.ModelRoute,
	AttemptSuccess,
) error {
	return nil
}

func (recorder *kindCapturingAttemptRecorder) RecordFailure(
	_ context.Context,
	_ runtimecore.ModelRoute,
	failure AttemptFailure,
) error {
	recorder.mu.Lock()
	recorder.kind = failure.RuntimeKind()
	recorder.mu.Unlock()
	return nil
}

func (recorder *kindCapturingAttemptRecorder) Kind() runtimecore.FailureKind {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return recorder.kind
}
