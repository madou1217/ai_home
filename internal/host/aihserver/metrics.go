package aihserver

import (
	"net/http"
	"sync"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/managementmetricsapi"
)

type metricsSnapshot struct {
	TotalRequests uint64
	TotalSuccess  uint64
	TotalFailures uint64
	TotalTimeouts uint64
	SuccessRate   float64
	TimeoutRate   float64
	RouteCounts   map[string]uint64
}

type metricsRecorder struct {
	mu                                                        sync.Mutex
	totalRequests, totalSuccess, totalFailures, totalTimeouts uint64
	routeCounts                                               map[string]uint64
}

type metricsSource struct{ recorder *metricsRecorder }

func (source metricsSource) Snapshot() managementmetricsapi.Snapshot {
	snapshot := source.recorder.Snapshot()
	return managementmetricsapi.Snapshot{
		TotalRequests: snapshot.TotalRequests,
		TotalSuccess:  snapshot.TotalSuccess,
		TotalFailures: snapshot.TotalFailures,
		TotalTimeouts: snapshot.TotalTimeouts,
		SuccessRate:   snapshot.SuccessRate,
		TimeoutRate:   snapshot.TimeoutRate,
		RouteCounts:   snapshot.RouteCounts,
	}
}

func newMetricsRecorder() *metricsRecorder { return &metricsRecorder{routeCounts: map[string]uint64{}} }

func (recorder *metricsRecorder) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		writer := &metricsResponseWriter{ResponseWriter: response, status: http.StatusOK}
		started := time.Now()
		next.ServeHTTP(writer, request)
		recorder.observe(request.URL.Path, writer.status, time.Since(started))
	})
}

type metricsResponseWriter struct {
	http.ResponseWriter
	status int
}

// Unwrap preserves the underlying writer's upgrade and deadline capabilities
// for WebSocket and http.ResponseController without bypassing status recording.
func (writer *metricsResponseWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func (writer *metricsResponseWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}
func (writer *metricsResponseWriter) Write(payload []byte) (int, error) {
	if writer.status == 0 {
		writer.status = http.StatusOK
	}
	return writer.ResponseWriter.Write(payload)
}

// Flush 必须显式转发，否则包装后的 writer 不再满足 http.Flusher。
// Go Core 的 SSE 处理器（例如 openairesponsesapi.NewSSEStream）直接做类型断言，
// 断言失败就返回 500 streaming_unavailable；表现为 codex chat harness 的
// /v1/responses 全部 500，codex 再报「high demand」。
func (writer *metricsResponseWriter) Flush() {
	if flusher, ok := writer.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (recorder *metricsRecorder) observe(path string, status int, elapsed time.Duration) {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.totalRequests++
	recorder.routeCounts[path]++
	if status >= 200 && status < 400 {
		recorder.totalSuccess++
	} else {
		recorder.totalFailures++
	}
	if status == http.StatusRequestTimeout || status == http.StatusGatewayTimeout || elapsed >= 30*time.Second {
		recorder.totalTimeouts++
	}
}

func (recorder *metricsRecorder) Snapshot() metricsSnapshot {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	routes := make(map[string]uint64, len(recorder.routeCounts))
	for path, count := range recorder.routeCounts {
		routes[path] = count
	}
	requests := recorder.totalRequests
	denom := float64(requests)
	if denom == 0 {
		denom = 1
	}
	return metricsSnapshot{TotalRequests: requests, TotalSuccess: recorder.totalSuccess, TotalFailures: recorder.totalFailures, TotalTimeouts: recorder.totalTimeouts, SuccessRate: float64(recorder.totalSuccess) / denom, TimeoutRate: float64(recorder.totalTimeouts) / denom, RouteCounts: routes}
}
