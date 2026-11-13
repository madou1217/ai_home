package webuitoolkitenvapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/toolkit/environment"
)

const (
	jobWatchHeartbeat = 30 * time.Second
)

func (handler *Handler) handleJobWatch(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	jobID := request.PathValue("jobID")
	initial, ok := handler.jobs.Get(jobID)
	if !ok {
		writeJSON(response, http.StatusNotFound, map[string]any{
			"ok": false, "error": "job_not_found", "message": "运行环境任务不存在或已清理。",
		})
		return
	}
	flusher, supportsFlush := response.(http.Flusher)
	if !supportsFlush {
		writeError(response, http.StatusInternalServerError, "sse_unsupported", "当前连接不支持事件流")
		return
	}
	events, cancel := handler.jobs.Subscribe()
	defer cancel()

	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	write := func(payload any) bool {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(response, "data: %s\n\n", encoded); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if _, err := io.WriteString(response, "data: {\"type\":\"connected\",\"job\":"+mustJSON(initial)+"}\n\n"); err != nil {
		return
	}
	flusher.Flush()
	if isJobTerminal(initial.Status) {
		return
	}
	heartbeat := time.NewTicker(jobWatchHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-events:
			if !open {
				return
			}
			if event.Job.ID != jobID {
				continue
			}
			if !write(event) {
				return
			}
			if isJobTerminal(event.Job.Status) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(response, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

// handleJobsWatch 是全局事件流：先发活动作业快照，再逐条推送变更。
// Node 的任务队列桥用它把 Go 作业投影到 /v0/webui/tasks。
func (handler *Handler) handleJobsWatch(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	flusher, supportsFlush := response.(http.Flusher)
	if !supportsFlush {
		writeError(response, http.StatusInternalServerError, "sse_unsupported", "当前连接不支持事件流")
		return
	}
	events, cancel := handler.jobs.Subscribe()
	defer cancel()
	active := handler.jobs.ListActive()

	response.Header().Set("Content-Type", "text/event-stream")
	response.Header().Set("Cache-Control", "no-cache")
	response.Header().Set("Connection", "keep-alive")
	response.Header().Set("X-Accel-Buffering", "no")
	response.WriteHeader(http.StatusOK)

	write := func(payload any) bool {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return false
		}
		if _, err := fmt.Fprintf(response, "data: %s\n\n", encoded); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	if !write(map[string]any{"type": "snapshot", "jobs": active}) {
		return
	}
	heartbeat := time.NewTicker(jobWatchHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case event, open := <-events:
			if !open {
				return
			}
			if !write(event) {
				return
			}
		case <-heartbeat.C:
			if _, err := io.WriteString(response, ": heartbeat\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func isJobTerminal(status string) bool {
	switch status {
	case "succeeded", "failed", "cancelled":
		return true
	}
	return false
}

func mustJSON(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "null"
	}
	return string(encoded)
}

var _ = environment.JobEvent{}
