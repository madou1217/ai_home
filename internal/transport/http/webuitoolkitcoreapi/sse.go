package webuitoolkitcoreapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/terminals"
	"github.com/madou1217/ai_home/internal/runtime/toolkit/tools"
)

const sseHeartbeatInterval = 30 * time.Second

func openSSEHeaders(w http.ResponseWriter) (http.Flusher, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, "sse_unsupported", "当前连接不支持事件流")
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	return flusher, true
}

func writeSSEPayload(w http.ResponseWriter, flusher http.Flusher, payload any) bool {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", encoded); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

func isTerminalState(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "succeeded", "failed", "cancelled":
		return true
	default:
		return false
	}
}

func (h *Handler) handleToolsJobWatchWithID(w http.ResponseWriter, r *http.Request, jobID string) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	jobID = strings.TrimSpace(jobID)
	initial, ok := h.toolJobs.Get(jobID)
	if !ok {
		writeError(w, http.StatusNotFound, "job_not_found", "网络工具任务不存在或已清理。")
		return
	}
	events, cancel := h.toolJobs.Subscribe()
	defer cancel()

	flusher, okFlush := openSSEHeaders(w)
	if !okFlush {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "connected", "job": initial}) {
		return
	}
	if !writeSSEPayload(w, flusher, tools.ToolJobEvent{Type: "managed-tool-job", Job: initial}) {
		return
	}
	if isTerminalState(initial.Status) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-events:
			if !open {
				return
			}
			if ev.Job.ID != jobID {
				continue
			}
			if !writeSSEPayload(w, flusher, ev) {
				return
			}
			if isTerminalState(ev.Job.Status) {
				h.toolsCache.clear()
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) handleToolsJobsWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	events, cancel := h.toolJobs.Subscribe()
	defer cancel()
	active := h.toolJobs.ListActive()

	flusher, okFlush := openSSEHeaders(w)
	if !okFlush {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "snapshot", "jobs": active}) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-events:
			if !open {
				return
			}
			if !writeSSEPayload(w, flusher, ev) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) handleTerminalsJobWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	initial := h.terminalJobs.Get(jobID)
	if initial == nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "job_not_found"})
		return
	}
	events, cancel, found := h.terminalJobs.Subscribe(jobID)
	if !found {
		writeJSON(w, http.StatusNotFound, map[string]any{"ok": false, "error": "job_not_found"})
		return
	}
	defer cancel()

	flusher, okFlush := openSSEHeaders(w)
	if !okFlush {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "connected", "job": initial}) {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "terminal-job", "job": initial}) {
		return
	}
	if isTerminalState(initial.Status) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case job, open := <-events:
			if !open {
				return
			}
			if !writeSSEPayload(w, flusher, map[string]any{"type": "terminal-job", "job": job}) {
				return
			}
			if isTerminalState(job.Status) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) handleTerminalsJobsWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	events, cancel := h.terminalJobs.SubscribeAll()
	defer cancel()
	active := h.terminalJobs.ListActive()

	flusher, okFlush := openSSEHeaders(w)
	if !okFlush {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "snapshot", "jobs": active}) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case job, open := <-events:
			if !open {
				return
			}
			if !writeSSEPayload(w, flusher, map[string]any{"type": "terminal-job", "job": job}) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) handleAppInstallJobWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	jobID := strings.TrimSpace(r.PathValue("jobId"))
	events, initial, cancel := h.appInstallJobs.Subscribe(jobID)
	if initial == nil {
		writeError(w, http.StatusNotFound, "job_not_found", "安装任务不存在或已清理。")
		return
	}
	defer cancel()

	flusher, okFlush := openSSEHeaders(w)
	if !okFlush {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "connected", "job": initial}) {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "install-job", "job": initial}) {
		return
	}
	if isTerminalState(initial.Status) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-events:
			if !open {
				return
			}
			if !writeSSEPayload(w, flusher, ev) {
				return
			}
			if ev.Job != nil && isTerminalState(ev.Job.Status) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func (h *Handler) handleAppInstallJobsWatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeMethodNotAllowed(w, http.MethodGet)
		return
	}
	events, cancel := h.appInstallJobs.SubscribeAll()
	defer cancel()
	active := h.appInstallJobs.ListActive()

	flusher, okFlush := openSSEHeaders(w)
	if !okFlush {
		return
	}
	if !writeSSEPayload(w, flusher, map[string]any{"type": "snapshot", "jobs": active}) {
		return
	}
	heartbeat := time.NewTicker(sseHeartbeatInterval)
	defer heartbeat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, open := <-events:
			if !open {
				return
			}
			if !writeSSEPayload(w, flusher, ev) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

var _ = terminals.Job{}
