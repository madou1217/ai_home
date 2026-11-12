package accountauthapi

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
)

const (
	// defaultJobWatchHeartbeat 与其它 WebUI SSE 一致：只保活，不轮询状态。
	defaultJobWatchHeartbeat = 30 * time.Second
	// jobWatchEventType 是快照帧的类型标记，客户端可忽略未知类型。
	jobWatchEventType = "job"
)

// JobEvents 是 OAuth Job 公开快照的变更订阅端口。
//
// 返回初始快照、后续变更流与取消函数。终态 Job 返回已关闭的流：
// 调用方交付初始快照后直接结束，不需要等一个永远不会到来的变化。
type JobEvents interface {
	Subscribe(
		jobID string,
	) (accountauth.Job, <-chan accountauth.Job, func(), error)
}

// jobProgressView 是 Node WebUI 展示进度所需的公开字段。
//
// Go 只执行 OAuth 交换，不启动 Provider CLI，也不监听浏览器回调：
// installRequired 恒为 false，callbackCaptureStatus 留空并由 Node 的
// loopback 捕获合并到同一条 auth-job 事件里。authProgressState 由
// 作业状态（与 Flow 形态）派生，不是按 Provider 猜测。
type jobProgressView struct {
	AuthProgressState     string `json:"auth_progress_state"`
	CallbackCaptureStatus string `json:"callback_capture_status"`
	InstallRequired       bool   `json:"install_required"`
}

// jobWatchEvent 是 SSE 的单帧负载：类型 + 公开快照 + 展示进度。
type jobWatchEvent struct {
	Type     string          `json:"type"`
	Job      jobView         `json:"job"`
	Progress jobProgressView `json:"progress"`
}

// handleJobWatch 是 OAuth Job 快照 SSE：
//
//	GET /v1/management/account-auth-jobs/{jobID}/watch
//
// 只在状态变化时写帧（外加 30s 注释心跳），进入终态后关闭连接。
// 不做轮询：事件来自 accountauth.Service 的状态迁移。
func (handler *Handler) handleJobWatch(
	response http.ResponseWriter,
	request *http.Request,
	jobID string,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	if handler.jobEvents == nil {
		writeAPIError(
			response,
			http.StatusServiceUnavailable,
			"job_stream_unavailable",
			"OAuth Job 事件流不可用",
		)
		return
	}
	flusher, ok := response.(http.Flusher)
	if !ok {
		writeAPIError(
			response,
			http.StatusInternalServerError,
			"sse_unsupported",
			"当前连接不支持事件流",
		)
		return
	}
	// 先订阅再写响应头：作业不存在时仍然能返回普通 JSON 404，
	// 而不是让客户端把错误响应当成事件流永久重连。
	snapshot, updates, cancel, err := handler.jobEvents.Subscribe(jobID)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
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
	if _, err := io.WriteString(response, "data: {\"type\":\"connected\"}\n\n"); err != nil {
		return
	}
	flusher.Flush()

	if !write(newJobWatchEvent(snapshot)) {
		return
	}
	if snapshot.IsTerminal() {
		return
	}

	heartbeat := time.NewTicker(defaultJobWatchHeartbeat)
	defer heartbeat.Stop()
	for {
		select {
		case <-request.Context().Done():
			return
		case job, open := <-updates:
			if !open {
				return
			}
			if !write(newJobWatchEvent(job)) {
				return
			}
			if job.IsTerminal() {
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

// newJobWatchEvent 把应用快照投影成稳定的事件帧。
func newJobWatchEvent(job accountauth.Job) jobWatchEvent {
	return jobWatchEvent{
		Type:     jobWatchEventType,
		Job:      newJobView(job),
		Progress: newJobProgress(job),
	}
}

// newJobProgress 只从 Job 自己陈述的事实派生展示进度。
func newJobProgress(job accountauth.Job) jobProgressView {
	return jobProgressView{
		AuthProgressState:     authProgressState(job),
		CallbackCaptureStatus: "",
		InstallRequired:       false,
	}
}

// authProgressState 与 Node 的 AUTH_PROGRESS_STATES 同词表。
func authProgressState(job accountauth.Job) string {
	switch job.Status() {
	case accountauth.StatusPending:
		if job.AuthMode() == "oauth-device" {
			return "awaiting_code"
		}
		return "auth_url_ready"
	case accountauth.StatusProcessing:
		return "submitted_code"
	case accountauth.StatusCompleted:
		return "completed"
	case accountauth.StatusFailed:
		return "failed"
	case accountauth.StatusCancelled:
		return "cancelled"
	case accountauth.StatusExpired:
		return "expired"
	default:
		return ""
	}
}
