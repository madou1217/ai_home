package relaycore

import (
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestRetryableKindTreatsCredentialRejectionAsAccountFailover(t *testing.T) {
	if !retryableKind(runtimecore.FailureCredentialRejected) {
		t.Fatalf("credential rejection should allow another account attempt")
	}
}
