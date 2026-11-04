package accountsapi

import (
	"net/http"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type replaceUIStateRequest struct {
	Status      string `json:"status"`
	DisplayName string `json:"display_name"`
	AuthMode    string `json:"auth_mode"`
	APIKeyMode  bool   `json:"api_key_mode"`
	Configured  bool   `json:"configured"`
	BaseURL     string `json:"base_url"`
	UpdatedAt   string `json:"updated_at"`
}

type accountUIStateView struct {
	AccountRef   string `json:"account_ref"`
	Status       string `json:"status"`
	DisplayName  string `json:"display_name"`
	AuthMode     string `json:"auth_mode"`
	APIKeyMode   bool   `json:"api_key_mode"`
	Configured   bool   `json:"configured"`
	OauthPending bool   `json:"oauth_pending"`
	BaseURL      string `json:"base_url"`
	UpdatedAt    string `json:"updated_at"`
}

type accountUIStateResponse struct {
	Data accountUIStateView `json:"data"`
}

type accountUIStateListResponse struct {
	Data []accountUIStateView `json:"data"`
}

// AccountUIStateCollectionPath 是账号页展示状态的批量读取路径（Node 账号 watch 预取用）。
const AccountUIStateCollectionPath = "/v1/management/account-ui-states"

// handleAccountUIStates 批量返回展示状态；账号页轮询一次取全量，避免按账号打 43 次。
func (handler *Handler) handleAccountUIStates(
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
	states, err := handler.management.ListAccountUIStates(request.Context())
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	views := make([]accountUIStateView, 0, len(states))
	for _, state := range states {
		views = append(views, newAccountUIStateView(state))
	}
	writeJSON(response, http.StatusOK, accountUIStateListResponse{Data: views})
}

// handleAccountUIState 读写账号页展示状态；Node 是写方，Go 负责持久化与后续读取。
func (handler *Handler) handleAccountUIState(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	switch request.Method {
	case http.MethodPut:
		var input replaceUIStateRequest
		if err := decodeJSONRequest(response, request, &input); err != nil {
			writeRequestDecodeError(response, err)
			return
		}
		updatedAt, err := parseUsageTime(input.UpdatedAt)
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_ui_state", "账号展示状态无效")
			return
		}
		state, err := accountcore.NewUIState(accountcore.UIStateInput{
			AccountRef:  accountRef,
			Status:      input.Status,
			DisplayName: input.DisplayName,
			AuthMode:    input.AuthMode,
			APIKeyMode:  input.APIKeyMode,
			Configured:  input.Configured,
			BaseURL:     input.BaseURL,
			UpdatedAt:   updatedAt,
		})
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_ui_state", "账号展示状态无效")
			return
		}
		if err := handler.management.ReplaceAccountUIState(request.Context(), state); err != nil {
			writeApplicationError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, accountUIStateResponse{Data: newAccountUIStateView(state)})
	case http.MethodGet:
		states, err := handler.management.ListAccountUIStates(request.Context())
		if err != nil {
			writeApplicationError(response, err)
			return
		}
		for _, state := range states {
			if state.AccountRef() != accountRef {
				continue
			}
			writeJSON(response, http.StatusOK, accountUIStateResponse{Data: newAccountUIStateView(state)})
			return
		}
		writeAPIError(response, http.StatusNotFound, "ui_state_not_found", "账号还没有展示状态")
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPut)
		writeMethodNotAllowed(response)
	}
}

func newAccountUIStateView(state accountcore.UIState) accountUIStateView {
	return accountUIStateView{
		AccountRef:   state.AccountRef().String(),
		Status:       state.Status(),
		DisplayName:  state.DisplayName(),
		AuthMode:     state.AuthMode(),
		APIKeyMode:   state.APIKeyMode(),
		Configured:   state.Configured(),
		OauthPending: state.OauthPending(),
		BaseURL:      state.BaseURL(),
		UpdatedAt:    formatTime(state.UpdatedAt()),
	}
}
