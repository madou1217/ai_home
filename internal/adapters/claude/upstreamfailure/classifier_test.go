package upstreamfailure

import (
	"testing"

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
