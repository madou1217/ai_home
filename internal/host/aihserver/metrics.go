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
