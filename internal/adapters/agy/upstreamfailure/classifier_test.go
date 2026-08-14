package upstreamfailure

import (
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestResourceExhaustedWithoutResetIsDeferredShortRateLimit(t *testing.T) {
	t.Parallel()

	classification, deferred, err := Classify(Input{
		StatusCode: httpStatusTooManyRequests,
		Status:     "RESOURCE_EXHAUSTED",
		Code:       "429",
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited ||
		classification.RetryAfter() != 0 || !deferred ||
		!classification.BlockDirective().IsZero() {
		t.Fatalf("classification=%#v deferred=%t", classification, deferred)
	}
}

func TestResourceExhaustedWithReliableShortRetryIsNotAmbiguous(t *testing.T) {
	t.Parallel()

	classification, deferred, err := Classify(Input{
		StatusCode: httpStatusTooManyRequests,
		Status:     "RESOURCE_EXHAUSTED",
		Code:       "429",
		RetryAfter: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("Classify() error = %v", err)
	}
	if classification.Kind() != runtimecore.FailureRateLimited ||
		classification.RetryAfter() != 2*time.Second || deferred {
		t.Fatalf("classification=%#v deferred=%t", classification, deferred)
	}
}
