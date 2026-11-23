package aihserver

import (
	"encoding/json"
	"net/http"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sessionreclaim"
)

// runtimeDiagnosticsPath 暴露 Go 运行时画像（仅管理密钥）。
// 观测面只读、无副作用：优化内存与并发前先看真实数字，不靠猜。
const (
	runtimeDiagnosticsPath = "/v1/management/diagnostics/runtime"
	// sessionDiagnosticsPath 是空闲回收的只读判定面：只报结论与理由，不执行终止。
	sessionDiagnosticsPath = "/v1/management/diagnostics/sessions"
	// sessionReclaimPath 执行回收；默认 dry-run，只有显式 apply=true 才真的终止。
	sessionReclaimPath = "/v1/management/diagnostics/sessions/reclaim"
)

// processStartedAt 记录进程启动时刻，用于换算运行时长。
var processStartedAt = time.Now()

type runtimeDiagnosticsHandler struct {
	authorizer interface{ Authorized(*http.Request) bool }
}

type sessionDiagnosticsHandler struct {
	authorizer interface{ Authorized(*http.Request) bool }
	aiHomeDir  string
}

func (h sessionDiagnosticsHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h.authorizer == nil || !h.authorizer.Authorized(request) {
		writeSystemJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if request.Method != http.MethodGet {
		writeSystemJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	options := sessionreclaim.Options{IdleThreshold: idleThresholdFromQuery(request)}
	reports, err := sessionreclaim.Detect(request.Context(), h.aiHomeDir, options)
	if err != nil {
		writeSystemJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	eligible := 0
	for _, report := range reports {
		if report.Eligible {
			eligible++
		}
	}
	writeSystemJSON(response, http.StatusOK, map[string]any{
		"ok":       true,
		"sessions": reports,
		"eligible": eligible,
		"total":    len(reports),
	})
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
		"memLimitMB":   float64(debug.SetMemoryLimit(-1)) / (1 << 20),
	})
}

type sessionReclaimHandler struct {
	authorizer interface{ Authorized(*http.Request) bool }
	aiHomeDir  string
}

func (h sessionReclaimHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if h.authorizer == nil || !h.authorizer.Authorized(request) {
		writeSystemJSON(response, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	if request.Method != http.MethodPost {
		writeSystemJSON(response, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method_not_allowed"})
		return
	}
	var body struct {
		Apply       bool `json:"apply"`
		IdleMinutes int  `json:"idleMinutes,omitempty"`
	}
	if request.ContentLength > 0 {
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writeSystemJSON(response, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid_body"})
			return
		}
	}
	options := sessionreclaim.Options{}
	if body.IdleMinutes > 0 {
		options.IdleThreshold = time.Duration(body.IdleMinutes) * time.Minute
	}
	result, err := sessionreclaim.Reclaim(request.Context(), h.aiHomeDir, sessionreclaim.ReclaimOptions{
		Options: options,
		Apply:   body.Apply,
	})
	if err != nil {
		writeSystemJSON(response, http.StatusInternalServerError, map[string]any{"ok": false, "error": err.Error()})
		return
	}
	writeSystemJSON(response, http.StatusOK, map[string]any{
		"ok":        true,
		"applied":   result.Applied,
		"eligible":  result.Eligible,
		"reclaimed": result.Reclaimed,
		"skipped":   result.Skipped,
	})
}

// idleThresholdFromQuery 读取 ?idleMinutes=，只用于诊断/验收；非法值交给默认值。
func idleThresholdFromQuery(request *http.Request) time.Duration {
	raw := strings.TrimSpace(request.URL.Query().Get("idleMinutes"))
	if raw == "" {
		return 0
	}
	minutes, err := strconv.Atoi(raw)
	if err != nil || minutes <= 0 {
		return 0
	}
	return time.Duration(minutes) * time.Minute
}

func bytesToMiB(value uint64) float64 {
	return float64(value) / (1 << 20)
}
