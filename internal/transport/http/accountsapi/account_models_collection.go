package accountsapi

import (
	"context"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	// AccountModelsCollectionPath 是批量读取账号模型关系的规范路径。
	//
	// 单个账号的模型在 /v1/management/accounts/{ref}/models；这条是给 WebUI 模型缓存
	// 用的批量入口：一次 JOIN 读出全部账号，避免 N 个账号打 N 次请求。
	AccountModelsCollectionPath = "/v1/management/account-models"
)

// AccountModelReader 是批量模型关系的只读端口。
type AccountModelReader interface {
	ListAllAccountModels(ctx context.Context) ([]accountapp.AccountModelSet, error)
}

// accountModelSetView 是单个账号的模型关系投影。
type accountModelSetView struct {
	AccountRef string             `json:"account_ref"`
	ProviderID string             `json:"provider_id"`
	Models     []accountModelView `json:"models"`
}

type accountModelsCollectionResponse struct {
	Data []accountModelSetView `json:"data"`
}

// handleAccountModelsCollection 批量返回账号模型关系。
//
// 过滤参数与账号导出/额度集合保持一致（provider / account_ref，逗号分隔）。
// 未装配读端口时返回 503：WebUI 应回落到本地缓存，而不是把空目录当成「没有模型」。
func (handler *Handler) handleAccountModelsCollection(
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
		writeAPIError(response, http.StatusBadRequest, "invalid_models_query", "模型查询参数无效")
		return
	}
	if handler.accountModels == nil {
		writeAPIError(response, http.StatusServiceUnavailable, "model_store_unavailable", "模型关系存储不可用")
		return
	}
	sets, err := handler.accountModels.ListAllAccountModels(request.Context())
	if err != nil {
		writeAPIError(response, http.StatusInternalServerError, "model_store_failed", "模型关系读取失败")
		return
	}
	items := make([]accountModelSetView, 0, len(sets))
	for _, set := range sets {
		if len(providers) > 0 {
			if _, ok := providers[set.ProviderID]; !ok {
				continue
			}
		}
		if len(refs) > 0 {
			if _, ok := refs[set.AccountRef.String()]; !ok {
				continue
			}
		}
		items = append(items, accountModelSetView{
			AccountRef: set.AccountRef.String(),
			ProviderID: set.ProviderID,
			Models:     newAccountModelViews(set.Models),
		})
	}
	writeJSON(response, http.StatusOK, accountModelsCollectionResponse{Data: items})
}
