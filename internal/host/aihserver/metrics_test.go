package aihserver

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMetricsRecorderAggregatesHTTPOutcomesByPath(t *testing.T) {
	recorder := newMetricsRecorder()
	handler := recorder.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/ok" {
			response.WriteHeader(http.StatusOK)
			return
		}
		response.WriteHeader(http.StatusGatewayTimeout)
	}))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://go.local/ok", nil))
	handler.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "http://go.local/fail", nil))
	snapshot := recorder.Snapshot()
	if snapshot.TotalRequests != 2 || snapshot.TotalSuccess != 1 || snapshot.TotalFailures != 1 || snapshot.TotalTimeouts != 1 {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	if snapshot.RouteCounts["/ok"] != 1 || snapshot.RouteCounts["/fail"] != 1 {
		t.Fatalf("route counts = %#v", snapshot.RouteCounts)
	}
}
