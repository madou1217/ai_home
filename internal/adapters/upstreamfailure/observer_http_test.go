package upstreamfailure

import (
	"net/http"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestObserveHTTPUsesNodeGenericStatusSemantics(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		wantKind   runtimecore.FailureKind
		wantRetry  time.Duration
		wantScope  runtimecore.BlockScope
	}{
		{name: "forbidden is credential rejection", statusCode: http.StatusForbidden, wantKind: runtimecore.FailureCredentialRejected, wantScope: runtimecore.BlockScopeAccount},
		{name: "legal restriction is region policy", statusCode: http.StatusUnavailableForLegalReasons, wantKind: runtimecore.FailureRegionUnsupported, wantScope: runtimecore.BlockScopeAccount},
		{name: "request timeout is request scoped", statusCode: http.StatusRequestTimeout, wantKind: runtimecore.FailureUnclassified},
		{name: "ordinary payment required is permanent", statusCode: http.StatusPaymentRequired, wantKind: runtimecore.FailurePermissionDenied, wantScope: runtimecore.BlockScopeAccountModel},
		{name: "server error", statusCode: http.StatusInternalServerError, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: runtimecore.GuessedCooldown},
		{name: "service unavailable", statusCode: http.StatusServiceUnavailable, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: runtimecore.GuessedCooldown},
		{name: "model overloaded", statusCode: 529, wantKind: runtimecore.FailureModelOverloaded, wantRetry: runtimecore.GuessedCooldown},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			classification, err := ObserveHTTP(
				test.statusCode,
				http.Header{},
				[]byte(`{"error":{"type":"upstream_error"}}`),
				time.Unix(1_700_000_000, 0),
			)
			if err != nil {
				t.Fatalf("ObserveHTTP() error = %v", err)
			}
			if classification.Kind() != test.wantKind {
				t.Fatalf("kind = %q, want %q", classification.Kind(), test.wantKind)
			}
			if classification.RetryAfter() != test.wantRetry {
				t.Fatalf("retry after = %s, want %s", classification.RetryAfter(), test.wantRetry)
			}
			if test.wantScope == "" {
				if !classification.BlockDirective().IsZero() {
					t.Fatalf("unexpected block directive for %q", classification.Kind())
				}
			} else if classification.BlockDirective().Scope() != test.wantScope {
				t.Fatalf("scope = %q, want %q", classification.BlockDirective().Scope(), test.wantScope)
			}
		})
	}
}

func TestObserveHTTPRetryAfterOverridesStatusDefault(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "2")
	classification, err := ObserveHTTP(
		http.StatusServiceUnavailable,
		header,
		[]byte(`{"error":{"type":"upstream_error"}}`),
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		t.Fatalf("ObserveHTTP() error = %v", err)
	}
	if classification.RetryAfter() != 2*time.Second {
		t.Fatalf("retry after = %s, want 2s", classification.RetryAfter())
	}
}

func TestObserveHTTPPaymentRequiredUsesExplicitSemantics(t *testing.T) {
	creditsExhausted, err := ObserveHTTP(
		http.StatusPaymentRequired,
		http.Header{},
		[]byte(`{"error":{"code":"insufficient_credits"}}`),
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		t.Fatalf("credits 402 ObserveHTTP() error = %v", err)
	}
	if creditsExhausted.Kind() != runtimecore.FailureQuotaExhausted {
		t.Fatalf("credits 402 kind = %q, want %q", creditsExhausted.Kind(), runtimecore.FailureQuotaExhausted)
	}
	if creditsExhausted.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
		t.Fatalf("credits 402 scope = %q, want %q", creditsExhausted.BlockDirective().Scope(), runtimecore.BlockScopeAccount)
	}
	if creditsExhausted.RetryAfter() != 0 {
		t.Fatalf("credits 402 retry after = %s, want 0", creditsExhausted.RetryAfter())
	}

	ordinary, err := ObserveHTTP(
		http.StatusPaymentRequired,
		http.Header{},
		[]byte(`{"error":{"type":"upstream_error"}}`),
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		t.Fatalf("ordinary 402 ObserveHTTP() error = %v", err)
	}
	if ordinary.Kind() != runtimecore.FailurePermissionDenied {
		t.Fatalf("ordinary 402 kind = %q, want %q", ordinary.Kind(), runtimecore.FailurePermissionDenied)
	}
	if ordinary.BlockDirective().Scope() != runtimecore.BlockScopeAccountModel {
		t.Fatalf("ordinary 402 scope = %q, want %q", ordinary.BlockDirective().Scope(), runtimecore.BlockScopeAccountModel)
	}
	if ordinary.RetryAfter() != 0 {
		t.Fatalf("ordinary 402 retry after = %s, want 0", ordinary.RetryAfter())
	}

	deactivated, err := ObserveHTTP(
		http.StatusPaymentRequired,
		http.Header{},
		[]byte(`{"error":{"code":"deactivated_workspace"}}`),
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		t.Fatalf("deactivated 402 ObserveHTTP() error = %v", err)
	}
	if deactivated.Kind() != runtimecore.FailureWorkspaceDeactivated {
		t.Fatalf("deactivated 402 kind = %q, want %q", deactivated.Kind(), runtimecore.FailureWorkspaceDeactivated)
	}
	if deactivated.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
		t.Fatalf("deactivated 402 scope = %q, want %q", deactivated.BlockDirective().Scope(), runtimecore.BlockScopeAccount)
	}
}

func TestObserveHTTPIgnoresRetryAfterForRequestScopedStatuses(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "2")

	// 402 现在是显式的永久语义（permission_denied，账号+模型作用域）：
	// Retry-After 仍然必须被忽略，且不能进入 cooldown。
	paymentRequired, err := ObserveHTTP(
		http.StatusPaymentRequired,
		header,
		[]byte(`{"error":{"type":"upstream_error"}}`),
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		t.Fatalf("status 402 ObserveHTTP() error = %v", err)
	}
	if paymentRequired.Kind() != runtimecore.FailurePermissionDenied {
		t.Fatalf("status 402 kind = %q, want %q", paymentRequired.Kind(), runtimecore.FailurePermissionDenied)
	}
	if paymentRequired.BlockDirective().Scope() != runtimecore.BlockScopeAccountModel {
		t.Fatalf("status 402 scope = %q, want %q", paymentRequired.BlockDirective().Scope(), runtimecore.BlockScopeAccountModel)
	}
	if paymentRequired.RetryAfter() != 0 {
		t.Fatalf("status 402 retry after = %s, want 0", paymentRequired.RetryAfter())
	}

	classification, err := ObserveHTTP(
		http.StatusRequestTimeout,
		header,
		[]byte(`{"error":{"type":"upstream_error"}}`),
		time.Unix(1_700_000_000, 0),
	)
	if err != nil {
		t.Fatalf("status 408 ObserveHTTP() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureUnclassified {
		t.Fatalf("status 408 kind = %q, want %q", classification.Kind(), runtimecore.FailureUnclassified)
	}
	if classification.RetryAfter() != 0 {
		t.Fatalf("status 408 retry after = %s, want 0", classification.RetryAfter())
	}
}
