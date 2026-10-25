package upstreamfailure

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestClassifyGenericHTTPFailureMatchesNode(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		wantKind   runtimecore.FailureKind
		wantRetry  time.Duration
		wantScope  runtimecore.BlockScope
	}{
		{name: "forbidden is credential rejection", statusCode: 403, wantKind: runtimecore.FailureCredentialRejected, wantScope: runtimecore.BlockScopeAccount},
		{name: "request timeout is request scoped", statusCode: 408, wantKind: runtimecore.FailureUnclassified},
		{name: "server error", statusCode: 500, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: 5 * time.Minute},
		{name: "service unavailable", statusCode: 503, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: time.Minute},
		{name: "model overloaded", statusCode: 529, wantKind: runtimecore.FailureModelOverloaded, wantRetry: 10 * time.Minute},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			classification, deferred, err := Classify(Input{StatusCode: test.statusCode})
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			if classification.Kind() != test.wantKind {
				t.Fatalf("kind = %q, want %q", classification.Kind(), test.wantKind)
			}
			if classification.RetryAfter() != test.wantRetry {
				t.Fatalf("retry after = %s, want %s", classification.RetryAfter(), test.wantRetry)
			}
			if deferred {
				t.Fatal("unexpected deferred account attribution")
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

func TestClassifyResourceExhaustedWithoutHintDefersAttribution(t *testing.T) {
	classification, deferred, err := Classify(Input{
		StatusCode: 429,
		Status:     "resource_exhausted",
		RetryAfter: 0,
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited {
		t.Fatalf("kind = %q, want %q", classification.Kind(), runtimecore.FailureRateLimited)
	}
	if !deferred {
		t.Fatal("expected deferred account attribution")
	}
}

func TestClassifyRegionDeniedUsesPolicyBlock(t *testing.T) {
	classification, deferred, err := Classify(Input{
		StatusCode:   403,
		Status:       "permission_denied",
		RegionDenied: true,
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if deferred {
		t.Fatal("unexpected deferred account attribution")
	}
	if classification.Kind() != runtimecore.FailureRegionUnsupported {
		t.Fatalf("kind = %q, want %q", classification.Kind(), runtimecore.FailureRegionUnsupported)
	}
	if classification.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
		t.Fatalf("scope = %q, want account", classification.BlockDirective().Scope())
	}
}
