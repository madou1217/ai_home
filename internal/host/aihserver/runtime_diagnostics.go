package aihserver

import (
	"net/http"
	"runtime"
	"time"
)

// runtimeDiagnosticsPath 暴露 Go 运行时画像（仅管理密钥）。
// 观测面只读、无副作用：优化内存与并发前先看真实数字，不靠猜。
const runtimeDiagnosticsPath = "/v1/management/diagnostics/runtime"

// processStartedAt 记录进程启动时刻，用于换算运行时长。
var processStartedAt = time.Now()

type runtimeDiagnosticsHandler struct {
	authorizer interface{ Authorized(*http.Request) bool }
}

func (h runtimeDiagnosticsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h.authorizer == nil || !h.authorizer.Authorized(request) {
		writeSystemJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if request.Method != http.MethodGet {
		writeSystemJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	writeSystemJSON(response, http.StatusOK, map[string]any{
		"ok":           true,
		"uptimeSec":    int64(time.Since(processStartedAt).Seconds()),
		"goroutines":   runtime.NumGoroutine(),
		"gomaxprocs":   runtime.GOMAXPROCS(0),
		"heapAllocMB":  bytesToMiB(stats.HeapAlloc),
		"heapInuseMB":  bytesToMiB(stats.HeapInuse),
		"heapIdleMB":   bytesToMiB(stats.HeapIdle),
		"heapSysMB":    bytesToMiB(stats.HeapSys),
		"heapObjects":  stats.HeapObjects,
		"stackInuseMB": bytesToMiB(stats.StackInuse),
		"sysMB":        bytesToMiB(stats.Sys),
		"gcCount":      stats.NumGC,
		"gcPauseMs":    float64(stats.PauseTotalNs) / 1e6,
	})
}

func bytesToMiB(value uint64) float64 {
	return float64(value) / (1 << 20)
}
