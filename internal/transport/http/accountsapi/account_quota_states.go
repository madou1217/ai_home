package accountsapi

import (
	"encoding/json"
	"errors"
	"net/http"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// AccountQuotaStateCollectionPath 是账号级额度状态的批量读取路径。
//
// 状态由 Go 从「归一化额度事实 + 快照文档」派生，Node 的账号页只做展示叠加；
// 没有额度快照文档的账号不出现在结果里（由 Node 按本地信息兜底）。
const AccountQuotaStateCollectionPath = "/v1/management/account-quota-states"

type accountQuotaStateView struct {
	AccountRef          string   `json:"account_ref"`
	ProviderID          string   `json:"provider_id"`
	Status              string   `json:"status"`
	Reason              string   `json:"reason"`
	RemainingPct        *float64 `json:"remaining_pct"`
	HasNumericRemaining bool     `json:"has_numeric_remaining"`
	// CapturedAtMS 是派生该状态所用快照的采集时间；Node 用它避免用旧状态覆盖刚采集的快照。
	CapturedAtMS int64 `json:"captured_at_ms"`
}

type accountQuotaStateListResponse struct {
	Data []accountQuotaStateView `json:"data"`
}

// handleAccountQuotaStates 为每个有额度快照文档的账号派生当前额度状态。
func (handler *Handler) handleAccountQuotaStates(
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
	overviews, err := handler.listAllOverviews(request)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	documents, err := handler.usage.ListDocuments(
		request.Context(),
		usageapp.DocumentQuery{},
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	documentByRef := make(map[string]usagecore.Document, len(documents))
	for _, document := range documents {
		documentByRef[document.AccountRef().String()] = document
	}
	views := make([]accountQuotaStateView, 0, len(documentByRef))
	for _, overview := range overviews {
		account := overview.Account()
		document, found := documentByRef[account.Ref().String()]
		if !found {
			continue
		}
		remaining := usagecore.UnknownRemaining()
		result, usageErr := handler.usage.GetUsage(request.Context(), account.Ref())
		if usageErr == nil {
			remaining = result.Snapshot().MinRemaining()
		} else if !errors.Is(usageErr, usageapp.ErrSnapshotNotFound) {
			writeApplicationError(response, usageErr)
			return
		}
		payload := usageDocumentPayloadFields(document.Payload())
		state := usagecore.DeriveQuotaState(usagecore.QuotaStateInput{
			Kind:           document.Kind(),
			FallbackSource: payload.FallbackSource,
			PlanType:       payload.Account.PlanType,
			Remaining:      remaining,
		})
		// 读接口顺手物化：旧库升级后不需要单独的回填任务。
		_ = handler.usage.ReplaceDocumentQuotaState(
			request.Context(),
			usageapp.DocumentQuotaState{
				AccountRef: account.Ref(),
				Status:     state.Status,
				Reason:     state.Reason,
				Remaining:  remaining,
			},
		)
		views = append(views, accountQuotaStateView{
			AccountRef:          account.Ref().String(),
			ProviderID:          account.ProviderID(),
			Status:              state.Status,
			Reason:              state.Reason,
			RemainingPct:        state.RemainingPct,
			HasNumericRemaining: state.HasNumericRemaining,
			CapturedAtMS:        document.CapturedAt().UnixMilli(),
		})
	}
	writeJSON(response, http.StatusOK, accountQuotaStateListResponse{Data: views})
}

// usageDocumentPayloadFields 只取额度状态需要的两个降级字段，其余 Provider 字段不解释。
type usageDocumentPayload struct {
	FallbackSource string `json:"fallbackSource"`
	Account        struct {
		PlanType string `json:"planType"`
	} `json:"account"`
}

func usageDocumentPayloadFields(payload []byte) usageDocumentPayload {
	var fields usageDocumentPayload
	_ = json.Unmarshal(payload, &fields)
	return fields
}
