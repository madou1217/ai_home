package accountsapi

import (
	"context"
	"net/http"

	"github.com/madou1217/ai_home/internal/adapters/accounts/portableaccount"
)

// AihAccountsImportDocument 是 WebUI/CLI 的 aih-accounts v1 迁移文档。
type AihAccountsImportDocument struct {
	Kind       string                   `json:"kind"`
	Version    int                      `json:"version"`
	ExportedAt string                   `json:"exportedAt"`
	Source     map[string]string        `json:"source"`
	Accounts   []AihAccountsImportEntry `json:"accounts"`
}

// Public aliases preserve the HTTP/WebUI document contract.
type AihAccountsImportEntry = portableaccount.AihAccountsImportEntry
type AihAccountImportOutcome = portableaccount.AihAccountImportOutcome

type aihAccountsImportResponse struct {
	OK       bool                      `json:"ok"`
	Summary  map[string]int            `json:"summary"`
	Accounts []AihAccountImportOutcome `json:"accounts"`
}

type AihAccountsImportResult = portableaccount.AihAccountsImportResult

// handleAihAccountsImport 批量导入 aih-accounts；单条失败不影响其余条目。
func (handler *Handler) handleAihAccountsImport(
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
	var document AihAccountsImportDocument
	if err := decodeJSONRequest(response, request, &document); err != nil {
		writeRequestDecodeError(response, err)
		return
	}
	if document.Kind != "aih-accounts" || document.Version != 1 {
		writeAPIError(response, http.StatusBadRequest, "unsupported_import_document", "仅支持 aih-accounts v1")
		return
	}
	if len(document.Accounts) == 0 {
		writeAPIError(response, http.StatusBadRequest, "empty_import_document", "导入文档没有账号")
		return
	}
	result := handler.ImportAihAccounts(request.Context(), document.Accounts)
	writeJSON(response, http.StatusOK, aihAccountsImportResponse{
		OK:       result.Summary["failed"] == 0,
		Summary:  result.Summary,
		Accounts: result.Accounts,
	})
}

// ImportAihAccounts is the HTTP composition facade for the shared adapter.
func (handler *Handler) ImportAihAccounts(ctx context.Context, entries []AihAccountsImportEntry) AihAccountsImportResult {
	return portableaccount.New(handler.importer, handler.staticCredentials, handler.native).ImportAihAccounts(ctx, entries)
}
