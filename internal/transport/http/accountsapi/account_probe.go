package accountsapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"time"

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

// ProbeStateReader 读取全部探针结果；为 nil 时账号列表不带 probe 字段。
//
// 读写分开声明：投递端点只需要写，列表只需要读，测试替身各实现一半即可。
type ProbeStateReader interface {
	LoadProbeStates(ctx context.Context) (map[string]ProbeState, error)
}

// attachProbeStates 把探针结果贴到账号视图上（只读，失败静默）。
func attachProbeStates(views []accountView, states map[string]ProbeState) []accountView {
	if len(states) == 0 {
		return views
	}
	// 复制一份再改：入参可能来自调用方复用的切片，就地修改会把它一起改掉。
	copied := make([]accountView, len(views))
	copy(copied, views)
	views = copied
	for index := range views {
		state, ok := states[views[index].AccountRef]
		if !ok {
			continue
		}
		checkedAt := ""
		if state.CheckedAtMS > 0 {
			checkedAt = time.UnixMilli(state.CheckedAtMS).UTC().Format(time.RFC3339Nano)
		}
		views[index].Probe = &accountProbeView{
			Status:    state.Status,
			Error:     state.Error,
			CheckedAt: checkedAt,
		}
	}
	return views
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
