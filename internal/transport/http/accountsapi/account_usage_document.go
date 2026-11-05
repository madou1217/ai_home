package accountsapi

import (
	"encoding/json"
	"net/http"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// AccountUsageDocumentCollectionPath 是账号额度快照文档的批量读取路径。
//
// 文档由采集方原样写入，WebUI 直接渲染；批量读取供 Node 做增量对账与读缓存修复。
const AccountUsageDocumentCollectionPath = "/v1/management/account-usage-documents"

// handleAccountUsageDocument 读写单账号的完整 Provider 快照文档。
func (handler *Handler) handleAccountUsageDocument(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) {
	if rejectUnexpectedQuery(response, request) {
		return
	}
	switch request.Method {
	case http.MethodGet:
	case http.MethodPut:
		if err := handler.replaceUsageDocument(response, request, accountRef); err != nil {
			return
		}
	default:
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPut)
		writeMethodNotAllowed(response)
		return
	}
	documents, err := handler.usage.ListDocuments(
		request.Context(),
		usageapp.DocumentQuery{AccountRefs: []accountcore.AccountRef{accountRef}},
	)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	if len(documents) == 0 {
		writeApplicationError(response, usageapp.ErrSnapshotNotFound)
		return
	}
	writeJSON(response, http.StatusOK, usageDocumentResponse{
		Data: newUsageDocumentView(documents[0], true),
	})
}

// replaceUsageDocument 校验文档并写入；账号 Provider 由账号记录决定，请求不能自报。
func (handler *Handler) replaceUsageDocument(
	response http.ResponseWriter,
	request *http.Request,
	accountRef accountcore.AccountRef,
) error {
	overview, err := handler.management.GetAccountOverview(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeApplicationError(response, err)
		return err
	}
	var input replaceUsageDocumentRequest
	if err := decodeJSONRequest(response, request, &input); err != nil {
		writeRequestDecodeError(response, err)
		return err
	}
	capturedAt, err := parseUsageTime(input.CapturedAt)
	if err != nil {
		writeAPIError(response, http.StatusBadRequest, "invalid_usage_document", "账号额度快照文档无效")
		return err
	}
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: overview.Account().ProviderID(),
		Kind:       input.Kind,
		Source:     input.Source,
		CapturedAt: capturedAt,
		Payload:    []byte(input.Payload),
	})
	if err != nil {
		writeApplicationError(response, err)
		return err
	}
	if err := handler.usage.ReplaceDocument(request.Context(), document); err != nil {
		writeApplicationError(response, err)
		return err
	}
	return nil
}

// handleAccountUsageDocuments 批量读取文档；provider/account_ref 过滤与导出一致。
func (handler *Handler) handleAccountUsageDocuments(
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
		writeInvalidQuery(response)
		return
	}
	query := usageapp.DocumentQuery{
		Providers:   make([]string, 0, len(providers)),
		AccountRefs: make([]accountcore.AccountRef, 0, len(refs)),
	}
	for providerID := range providers {
		query.Providers = append(query.Providers, providerID)
	}
	for ref := range refs {
		accountRef, parseErr := accountcore.ParseAccountRef(ref)
		if parseErr != nil {
			writeInvalidQuery(response)
			return
		}
		query.AccountRefs = append(query.AccountRefs, accountRef)
	}
	documents, err := handler.usage.ListDocuments(request.Context(), query)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	views := make([]usageDocumentView, 0, len(documents))
	for _, document := range documents {
		views = append(views, newUsageDocumentView(document, true))
	}
	writeJSON(response, http.StatusOK, usageDocumentListResponse{Data: views})
}

// newUsageDocumentView 原样返回 payload；Go 不重排 Provider 字段。
func newUsageDocumentView(
	document usagecore.Document,
	includePayload bool,
) usageDocumentView {
	view := usageDocumentView{
		AccountRef:   document.AccountRef().String(),
		ProviderID:   document.ProviderID(),
		Kind:         document.Kind(),
		Source:       document.Source(),
		CapturedAt:   formatTime(document.CapturedAt()),
		CapturedAtMS: document.CapturedAt().UnixMilli(),
	}
	if includePayload {
		view.Payload = json.RawMessage(document.Payload())
	}
	return view
}
