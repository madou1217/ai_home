package accountsapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// AccountRuntimeStateCollectionPath 是账号运行态文档的批量读取路径。
//
// Node 账号页与 CLI 一次取全量派生状态，避免按账号逐个请求。
const AccountRuntimeStateCollectionPath = "/v1/management/account-runtime-states"

type replaceRuntimeStateRequest struct {
	// State 是 Node account_state.runtime_state 的原始 JSON；null 表示没有运行态。
	State     json.RawMessage `json:"state"`
	UpdatedAt string          `json:"updated_at"`
}

type runtimeStateView struct {
	AccountRef string          `json:"account_ref"`
	State      json.RawMessage `json:"state,omitempty"`
	Status     string          `json:"status"`
	Reason     string          `json:"reason"`
	UntilMS    int64           `json:"until_ms"`
	UpdatedAt  string          `json:"updated_at"`
}

type runtimeStateResponse struct {
	Data runtimeStateView `json:"data"`
}

type runtimeStateListResponse struct {
	Data []runtimeStateView `json:"data"`
}

// handleAccountRuntimeStates 批量返回所有账号的派生运行态。
func (handler *Handler) handleAccountRuntimeStates(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	states, err := handler.management.ListAccountStates(request.Context())
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	now := time.Now()
	views := make([]runtimeStateView, 0, len(states))
	for _, state := range states {
		views = append(views, newRuntimeStateView(state, now))
	}
	writeJSON(response, http.StatusOK, runtimeStateListResponse{Data: views})
}

// handleAccountRuntimeState 读写单个账号的运行态文档。
//
// PUT 是 Node 事件转移后的唯一写入口：写入成功后立即返回派生状态，
// 调用方无需再拉一次批量接口。state=null 表示清除（账号回到 healthy）。
func (handler *Handler) handleAccountRuntimeState(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	switch request.Method {
	case http.MethodPut:
		var input replaceRuntimeStateRequest
		if err := decodeJSONRequest(response, request, &input); err != nil {
			writeRequestDecodeError(response, err)
			return
		}
		updatedAt, err := parseUsageTime(input.UpdatedAt)
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_runtime_state", "账号运行态无效")
			return
		}
		if isJSONNull(input.State) {
			if err := handler.management.DeleteAccountState(request.Context(), accountRef); err != nil {
				writeApplicationError(response, err)
				return
			}
			writeJSON(response, http.StatusOK, runtimeStateResponse{Data: runtimeStateView{
				AccountRef: accountRef.String(),
				Status:     "healthy",
				UpdatedAt:  formatTime(updatedAt),
			}})
			return
		}
		state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
			AccountRef: accountRef,
			Document:   input.State,
			UpdatedAt:  updatedAt,
		})
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_runtime_state", "账号运行态无效")
			return
		}
		if err := handler.management.ReplaceAccountState(request.Context(), state); err != nil {
			writeApplicationError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, runtimeStateResponse{
			Data: newRuntimeStateView(state, time.Now()),
		})
	case http.MethodGet:
		state, err := handler.management.GetAccountState(request.Context(), accountRef)
		if err != nil {
			writeApplicationError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, runtimeStateResponse{
			Data: newRuntimeStateView(state, time.Now()),
		})
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPut)
		writeMethodNotAllowed(response)
	}
}

func newRuntimeStateView(state runtimecore.AccountState, now time.Time) runtimeStateView {
	status := state.DeriveStatus(now)
	view := runtimeStateView{
		AccountRef: state.AccountRef().String(),
		State:      state.Document(),
		Status:     status.Status(),
		Reason:     status.Reason(),
		UpdatedAt:  formatTime(state.UpdatedAt()),
	}
	if until := status.Until(); !until.IsZero() {
		view.UntilMS = until.UnixMilli()
	}
	return view
}

func isJSONNull(value json.RawMessage) bool {
	switch strings.TrimSpace(string(value)) {
	case "", "null":
		return true
	default:
		return false
	}
}
