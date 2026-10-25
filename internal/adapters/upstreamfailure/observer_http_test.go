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
		{name: "server error", statusCode: http.StatusInternalServerError, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: 5 * time.Minute},
		{name: "service unavailable", statusCode: http.StatusServiceUnavailable, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: time.Minute},
		{name: "model overloaded", statusCode: 529, wantKind: runtimecore.FailureModelOverloaded, wantRetry: 10 * time.Minute},
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
