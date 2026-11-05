package accountsapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// ProbeState 是账号最近一次额度探针的结果。
type ProbeState struct {
	Status      string
	Error       string
	CheckedAtMS int64
}

// ProbeStateWriter 持久化探针结果；为 nil 时该端点返回 503。
type ProbeStateWriter interface {
	UpsertProbeState(ctx context.Context, accountRef string, state ProbeState) error
}

const maxProbePayloadBytes = 16 * 1024

type accountProbeRequest struct {
	Status      string `json:"status"`
	Error       string `json:"error"`
	CheckedAtMS int64  `json:"checked_at_ms"`
}

// handleAccountProbe 接收 Node 推送的额度探针结果。
//
// 为什么由 Node 推：探针要读 Provider 凭据并处理各家差异，这部分仍在 Node；
// 但「最近一次探测结果」是账号页的事实，必须落库才能跨重启保留。
func (handler *Handler) handleAccountProbe(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if handler.probeStates == nil {
		writeAPIError(response, http.StatusServiceUnavailable, "probe_state_unavailable", "探针状态存储不可用")
		return
	}
	if request.Method != http.MethodPatch {
		response.Header().Set("Allow", http.MethodPatch)
		writeMethodNotAllowed(response)
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxProbePayloadBytes+1))
	if err != nil || len(body) > maxProbePayloadBytes {
		writeAPIError(response, http.StatusBadRequest, "invalid_probe_state", "探针状态无效")
		return
	}
	var payload accountProbeRequest
	if err := json.Unmarshal(body, &payload); err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_probe_state", "探针状态无效")
		return
	}
	if err := handler.probeStates.UpsertProbeState(request.Context(), accountRef.String(), ProbeState{
		Status:      payload.Status,
		Error:       payload.Error,
		CheckedAtMS: payload.CheckedAtMS,
	}); err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true})
}
