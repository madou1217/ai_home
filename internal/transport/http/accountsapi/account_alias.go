package accountsapi

import (
	"net/http"
	"strings"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// handleAccountAlias 把 Provider 数字别名解析为稳定账号公开投影。
func (handler *Handler) handleAccountAlias(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	if rejectUnexpectedQuery(response, request) ||
		rejectUnexpectedBody(response, request) {
		return
	}
	providerID, cliAccountID, err := parseAccountAliasPath(request.URL.Path)
	if err != nil {
		writeAPIError(
			response,
			http.StatusBadRequest,
			"invalid_account_alias",
			"账号数字别名格式无效",
		)
		return
	}
	overview, err := handler.management.GetAccountOverviewByCLIAccountID(
		request.Context(),
		providerID,
		cliAccountID,
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	writeJSON(
		response,
		http.StatusOK,
		accountResponse{Data: newAccountView(overview)},
	)
}

// parseAccountAliasPath 严格解析 /account-aliases/{provider}/{id}。
func parseAccountAliasPath(
	requestPath string,
) (string, accountcore.CLIAccountID, error) {
	prefix := AliasesPath + "/"
	if !strings.HasPrefix(requestPath, prefix) {
		return "", 0, accountcore.ErrInvalidAccount
	}
	parts := strings.Split(strings.TrimPrefix(requestPath, prefix), "/")
	if len(parts) != 2 ||
		parts[0] == "" ||
		parts[0] != strings.TrimSpace(parts[0]) ||
		parts[0] != strings.ToLower(parts[0]) {
		return "", 0, accountcore.ErrInvalidAccount
	}
	cliAccountID, err := accountcore.ParseCLIAccountID(parts[1])
	if err != nil {
		return "", 0, accountcore.ErrInvalidAccount
	}
	return parts[0], cliAccountID, nil
}
