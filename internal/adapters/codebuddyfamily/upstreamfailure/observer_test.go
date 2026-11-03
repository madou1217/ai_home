package upstreamfailure

import (
	"net/http"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

func TestObserveHTTPIgnoresRetryAfterForRequestScopedStatuses(t *testing.T) {
	header := http.Header{}
	header.Set("Retry-After", "2")
	for _, statusCode := range []int{http.StatusBadRequest, http.StatusRequestTimeout} {
		classification, err := ObserveHTTP(
			statusCode,
			header,
			[]byte(`{"message":"request invalid"}`),
			time.Unix(1_700_000_000, 0),
		)
		if err != nil {
			t.Fatalf("status %d ObserveHTTP() error = %v", statusCode, err)
		}
		wantKind := runtimecore.FailureInvalidRequest
		if statusCode == http.StatusRequestTimeout {
			wantKind = runtimecore.FailureUnclassified
		}
		if classification.Kind() != wantKind {
			t.Fatalf("status %d kind = %q, want %q", statusCode, classification.Kind(), wantKind)
		}
		if classification.RetryAfter() != 0 {
			t.Fatalf("status %d retry after = %s, want 0", statusCode, classification.RetryAfter())
		}
	}
}
