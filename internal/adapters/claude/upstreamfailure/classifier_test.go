package upstreamfailure

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestClassifyHTTP451AsRegionUnsupported(t *testing.T) {
	classification, err := Classify(Input{StatusCode: 451})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureRegionUnsupported {
		t.Fatalf("kind = %q, want %q", classification.Kind(), runtimecore.FailureRegionUnsupported)
	}
	if classification.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
		t.Fatalf("scope = %q, want account", classification.BlockDirective().Scope())
	}
}

func TestClassifyForbiddenAsAccountCredentialRejection(t *testing.T) {
	tests := []Input{
		{StatusCode: 403},
		{StatusCode: 403, ErrorType: "permission_error"},
	}
	for _, input := range tests {
		classification, err := Classify(input)
		if err != nil {
			t.Fatalf("Classify(%+v) error = %v", input, err)
		}
		if classification.Kind() != runtimecore.FailureCredentialRejected {
			t.Fatalf("Classify(%+v) kind = %q, want %q", input, classification.Kind(), runtimecore.FailureCredentialRejected)
		}
		if classification.BlockDirective().Scope() != runtimecore.BlockScopeAccount {
			t.Fatalf("Classify(%+v) scope = %q, want account", input, classification.BlockDirective().Scope())
		}
	}
}

func TestClassifyWorkspaceDeactivatedRequiresPaymentRequiredStatus(t *testing.T) {
	for _, status := range []int{200, 400, 401, 403, 500} {
		classification, err := Classify(Input{StatusCode: status, ErrorCode: "deactivated_workspace"})
		if err != nil {
			t.Fatalf("status %d: Classify() error = %v", status, err)
		}
		if classification.Kind() == runtimecore.FailureWorkspaceDeactivated {
			t.Fatalf("status %d: classified deactivated workspace without HTTP 402", status)
		}
	}

	classification, err := Classify(Input{StatusCode: 402, ErrorCode: "deactivated_workspace"})
	if err != nil {
		t.Fatalf("HTTP 402: Classify() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureWorkspaceDeactivated {
		t.Fatalf("HTTP 402: kind = %q, want %q", classification.Kind(), runtimecore.FailureWorkspaceDeactivated)
	}
}

func TestClassifyHTTPStatusCooldownMatchesNode(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		wantKind   runtimecore.FailureKind
		wantRetry  time.Duration
	}{
		{name: "request timeout is request scoped", statusCode: 408, wantKind: runtimecore.FailureUnclassified},
		{name: "server error", statusCode: 500, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: runtimecore.GuessedCooldown},
		{name: "service unavailable", statusCode: 503, wantKind: runtimecore.FailureUpstreamUnavailable, wantRetry: runtimecore.GuessedCooldown},
		{name: "model overloaded", statusCode: 529, wantKind: runtimecore.FailureModelOverloaded, wantRetry: runtimecore.GuessedCooldown},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			classification, err := Classify(Input{StatusCode: test.statusCode})
			if err != nil {
				t.Fatalf("Classify() error = %v", err)
			}
			if classification.Kind() != test.wantKind {
				t.Fatalf("kind = %q, want %q", classification.Kind(), test.wantKind)
			}
			if classification.RetryAfter() != test.wantRetry {
				t.Fatalf("retry after = %s, want %s", classification.RetryAfter(), test.wantRetry)
			}
		})
	}
}
