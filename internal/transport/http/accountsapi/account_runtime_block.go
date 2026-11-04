package accountsapi

import (
	"net/http"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
)

type replaceRuntimeBlockRequest struct {
	Kind       string `json:"kind"`
	Scope      string `json:"scope"`
	Reason     string `json:"reason"`
	ObservedAt string `json:"observed_at"`
	Until      string `json:"until"`
}

type accountRuntimeBlockView struct {
	AccountRef string `json:"account_ref"`
	Kind       string `json:"kind"`
	Scope      string `json:"scope"`
	Reason     string `json:"reason"`
	ObservedAt string `json:"observed_at"`
	Until      string `json:"until"`
}

type accountRuntimeBlockResponse struct {
	Data accountRuntimeBlockView `json:"data"`
}

type accountRuntimeBlockListResponse struct {
	Data []accountRuntimeBlockView `json:"data"`
}

// AccountRuntimeBlockCollectionPath 是账号级阻塞的批量读取路径（Node 预取用）。
const AccountRuntimeBlockCollectionPath = "/v1/management/account-runtime-blocks"

// handleAccountRuntimeBlocks 批量返回全部账号级阻塞。
func (handler *Handler) handleAccountRuntimeBlocks(
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
	blocks, err := handler.management.ListAccountBlocks(request.Context())
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	views := make([]accountRuntimeBlockView, 0, len(blocks))
	for _, block := range blocks {
		views = append(views, newAccountRuntimeBlockView(block))
	}
	writeJSON(response, http.StatusOK, accountRuntimeBlockListResponse{Data: views})
}

// handleAccountRuntimeBlock 写/删/读账号级失败阻塞；Node 是观察方，Go 是存储方。
func (handler *Handler) handleAccountRuntimeBlock(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	switch request.Method {
	case http.MethodPut:
		if rejectUnexpectedQuery(response, request) {
			return
		}
		var input replaceRuntimeBlockRequest
		if err := decodeJSONRequest(response, request, &input); err != nil {
			writeRequestDecodeError(response, err)
			return
		}
		observedAt, err := parseUsageTime(input.ObservedAt)
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_runtime_block", "账号运行态阻塞无效")
			return
		}
		until, err := parseUsageTime(input.Until)
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_runtime_block", "账号运行态阻塞无效")
			return
		}
		block, err := runtimecore.NewAccountBlock(runtimecore.AccountBlockInput{
			AccountRef: accountRef,
			Kind:       runtimecore.FailureKind(input.Kind),
			Scope:      runtimecore.BlockScope(input.Scope),
			Reason:     input.Reason,
			ObservedAt: observedAt,
			Until:      until,
		})
		if err != nil {
			writeAPIError(response, http.StatusBadRequest, "invalid_runtime_block", "账号运行态阻塞无效")
			return
		}
		if err := handler.management.ReplaceAccountBlock(request.Context(), block); err != nil {
			writeApplicationError(response, err)
			return
		}
		writeJSON(response, http.StatusOK, accountRuntimeBlockResponse{Data: newAccountRuntimeBlockView(block)})
	case http.MethodDelete:
		kind := runtimecore.FailureKind(request.URL.Query().Get("kind"))
		if kind == "" {
			writeInvalidQuery(response)
			return
		}
		if err := handler.management.DeleteAccountBlock(request.Context(), accountRef, kind); err != nil {
			writeApplicationError(response, err)
			return
		}
		response.WriteHeader(http.StatusNoContent)
	case http.MethodGet:
		if rejectUnexpectedQuery(response, request) {
			return
		}
		blocks, err := handler.management.ListAccountBlocks(request.Context())
		if err != nil {
			writeApplicationError(response, err)
			return
		}
		views := make([]accountRuntimeBlockView, 0, len(blocks))
		for _, block := range blocks {
			if block.AccountRef() != accountRef {
				continue
			}
			views = append(views, newAccountRuntimeBlockView(block))
		}
		writeJSON(response, http.StatusOK, struct {
			Data []accountRuntimeBlockView `json:"data"`
		}{Data: views})
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPut+", "+http.MethodDelete)
		writeMethodNotAllowed(response)
	}
}

func newAccountRuntimeBlockView(block runtimecore.AccountBlock) accountRuntimeBlockView {
	return accountRuntimeBlockView{
		AccountRef: block.AccountRef().String(),
		Kind:       string(block.Kind()),
		Scope:      string(block.Scope()),
		Reason:     block.Reason(),
		ObservedAt: formatTime(block.ObservedAt()),
		Until:      formatTime(block.Until()),
	}
}
