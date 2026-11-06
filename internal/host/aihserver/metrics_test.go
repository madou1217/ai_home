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

// 回归守卫（2026-11-06）：中间件包装后的 writer 必须保留 http.Flusher。
// 丢掉它会让所有 Go 侧的 SSE 直出（codex harness /v1/responses）500。
func TestMetricsMiddlewarePreservesFlusher(t *testing.T) {
	recorder := newMetricsRecorder()
	var flusher http.Flusher
	handler := recorder.Middleware(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		flusher, _ = response.(http.Flusher)
	}))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodPost, "http://go.local/v1/responses", nil))
	if flusher == nil {
		t.Fatal("metricsResponseWriter 不再实现 http.Flusher")
	}
	flusher.Flush()
	if !response.Flushed {
		t.Fatal("Flush 没有透传到底层 writer")
	}
}
