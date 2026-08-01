package accountsapi

import (
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// handleLaunchSelection 解析一次 Provider CLI 启动账号，不读取或返回凭据正文。
func (handler *Handler) handleLaunchSelection(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) {
		return
	}
	var input resolveLaunchSelectionRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	selectionRequest, valid := newLaunchSelectionRequest(response, input)
	if !valid {
		return
	}
	selection, err := handler.selections.Resolve(
		request.Context(),
		selectionRequest,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		newLaunchSelectionResponse(selection),
	)
}

// newLaunchSelectionRequest 在 HTTP 边界解析两种显式账号身份。
func newLaunchSelectionRequest(
	response http.ResponseWriter,
	input resolveLaunchSelectionRequest,
) (accountapp.LaunchSelectionRequest, bool) {
	request := accountapp.LaunchSelectionRequest{ProviderID: input.ProviderID}
	if input.AccountRef != "" {
		accountRef, err := accountcore.ParseAccountRef(input.AccountRef)
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_account_ref",
				"账号引用格式无效",
			)
			return accountapp.LaunchSelectionRequest{}, false
		}
		request.AccountRef = accountRef
	}
	if input.CLIAccountID != nil {
		cliAccountID, err := accountcore.NewCLIAccountID(*input.CLIAccountID)
		if err != nil {
			writeAPIError(
				response,
				http.StatusBadRequest,
				"invalid_cli_account_id",
				"CLI 账号数字别名无效",
			)
			return accountapp.LaunchSelectionRequest{}, false
		}
		request.CLIAccountID = cliAccountID
	}
	return request, true
}
