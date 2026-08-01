package accountsapi

import (
	"net/http"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// handleProviderDefault 分发单个 Provider 默认账号的查询、替换和清除操作。
func (handler *Handler) handleProviderDefault(
	response http.ResponseWriter,
	request *http.Request,
) {
	providerID, valid := parseProviderDefaultPath(request.URL.Path)
	if !valid {
		writeAPIError(
			response,
			http.StatusNotFound,
			"route_not_found",
			"请求的默认账号资源不存在",
		)
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.getProviderDefault(response, request, providerID)
	case http.MethodPut:
		handler.setProviderDefault(response, request, providerID)
	case http.MethodDelete:
		handler.clearProviderDefault(response, request, providerID)
	default:
		response.Header().Set(
			"Allow",
			http.MethodGet+", "+http.MethodPut+", "+http.MethodDelete,
		)
		writeMethodNotAllowed(response)
	}
}

// getProviderDefault 返回指定 Provider 当前默认启动账号。
func (handler *Handler) getProviderDefault(
	response http.ResponseWriter,
	request *http.Request,
	providerID string,
) {
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	providerDefault, err := handler.defaults.Get(request.Context(), providerID)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		newProviderDefaultResponse(providerDefault),
	)
}

// setProviderDefault 使用 PUT 完整替换指定 Provider 的默认启动账号。
func (handler *Handler) setProviderDefault(
	response http.ResponseWriter,
	request *http.Request,
	providerID string,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input updateProviderDefaultRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	accountRef, err := accountcore.ParseAccountRef(input.AccountRef)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_account_ref",
			"账号引用格式无效",
		)
		return
	}
	providerDefault, err := handler.defaults.Set(
		request.Context(),
		providerID,
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		newProviderDefaultResponse(providerDefault),
	)
}

// clearProviderDefault 幂等清除指定 Provider 的默认启动账号。
func (handler *Handler) clearProviderDefault(
	response http.ResponseWriter,
	request *http.Request,
	providerID string,
) {
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	if err := handler.defaults.Clear(request.Context(), providerID); err != nil {
		writeApplicationError(response, err)
		return
	}
	writeNoContent(response)
}

// parseProviderDefaultPath 只接受一个无转义斜杠的 Provider 路径段。
func parseProviderDefaultPath(path string) (string, bool) {
	prefix := DefaultsPath + "/"
	if !strings.HasPrefix(path, prefix) {
		return "", false
	}
	providerID := strings.TrimPrefix(path, prefix)
	if providerID == "" || strings.Contains(providerID, "/") {
		return "", false
	}
	return providerID, true
}
