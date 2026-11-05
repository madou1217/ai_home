package accountsapi

import (
	"errors"
	"net/http"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
)

const AccountUsageCollectionPath = "/v1/management/account-usage"

type accountUsageCollectionResponse struct {
	Data []accountUsageView `json:"data"`
}

// handleAccountUsageCollection 批量读取账号额度快照；Node 的 WebUI 读路径迁入 Go 时用。
func (handler *Handler) handleAccountUsageCollection(
	response http.ResponseWriter,
	request *http.Request,
) {
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeMethodNotAllowed(response)
		return
	}
	providers, refs, err := parseExportFilters(request)
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_usage_query", "额度查询参数无效")
		return
	}
	overviews, err := handler.listAllOverviews(request)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	items := make([]accountUsageView, 0, len(overviews))
	for _, overview := range overviews {
		account := overview.Account()
		if len(providers) > 0 {
			if _, ok := providers[account.ProviderID()]; !ok {
				continue
			}
		}
		if len(refs) > 0 {
			if _, ok := refs[account.Ref().String()]; !ok {
				continue
			}
		}
		result, usageErr := handler.usage.GetUsage(request.Context(), account.Ref())
		if usageErr != nil {
			if errors.Is(usageErr, usageapp.ErrSnapshotNotFound) {
				continue
			}
			writeApplicationError(response, usageErr)
			return
		}
		items = append(items, newAccountUsageResponse(result).Data)
	}
	writeJSON(response, http.StatusOK, accountUsageCollectionResponse{Data: items})
}
