package accountsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// AihAccountsImportDocument 是 WebUI/CLI 的 aih-accounts v1 迁移文档。
type AihAccountsImportDocument struct {
	Kind       string                   `json:"kind"`
	Version    int                      `json:"version"`
	ExportedAt string                   `json:"exportedAt"`
	Source     map[string]string        `json:"source"`
	Accounts   []AihAccountsImportEntry `json:"accounts"`
}

// AihAccountsImportEntry 是文档里的单条账号记录。
//
// 导出、CLI 管理面导入与 WebUI 导入作业共用同一份形状：env 承载静态凭据，
// nativeAuth 承载 Provider 官方 artifact，两者都为空时该条目不可导入。
type AihAccountsImportEntry struct {
	Provider     string            `json:"provider"`
	AccountRef   string            `json:"accountRef"`
	CLIAccountID string            `json:"cliAccountId"`
	Status       string            `json:"status"`
	Env          map[string]string `json:"env"`
	NativeAuth   json.RawMessage   `json:"nativeAuth"`
}

// AihAccountImportOutcome 是单条账号的导入结论。
type AihAccountImportOutcome struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Status     string `json:"status"`
	Reason     string `json:"reason,omitempty"`
}

type aihAccountsImportResponse struct {
	OK       bool                      `json:"ok"`
	Summary  map[string]int            `json:"summary"`
	Accounts []AihAccountImportOutcome `json:"accounts"`
}

// AihAccountsImportResult 汇总一次文档导入：summary 的键与旧响应体一致
// (total/created/updated/failed/skipped)，Accounts 保留逐条结论。
//
// WebUI 的导入作业与 HTTP 端点共用本结果，避免两处各算一份计数。
type AihAccountsImportResult struct {
	Summary  map[string]int
	Accounts []AihAccountImportOutcome
}

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

// ImportAihAccounts 逐条导入 aih-accounts 文档；单条失败不影响其余条目。
//
// 这是导入语义的唯一实现：管理面 HTTP 端点与 WebUI 的异步导入作业都调用它。
// 每次调用都返回完整 summary，调用方只负责合并与展示。
func (handler *Handler) ImportAihAccounts(
	ctx context.Context,
	entries []AihAccountsImportEntry,
) AihAccountsImportResult {
	summary := map[string]int{"total": len(entries), "created": 0, "updated": 0, "failed": 0, "skipped": 0}
	outcomes := make([]AihAccountImportOutcome, 0, len(entries))
	for _, entry := range entries {
		outcome := handler.importAihAccount(ctx, entry)
		outcomes = append(outcomes, outcome)
		switch outcome.Status {
		case "created":
			summary["created"] += 1
		case "unchanged", "updated":
			summary["updated"] += 1
		case "unsupported":
			summary["skipped"] += 1
		default:
			summary["failed"] += 1
		}
	}
	return AihAccountsImportResult{Summary: summary, Accounts: outcomes}
}

// importAihAccount 单条导入：静态 env → 静态凭据；nativeAuth → 原生 artifact。
func (handler *Handler) importAihAccount(
	ctx context.Context,
	entry AihAccountsImportEntry,
) AihAccountImportOutcome {
	provider := strings.ToLower(strings.TrimSpace(entry.Provider))
	outcome := AihAccountImportOutcome{Provider: provider, AccountRef: strings.TrimSpace(entry.AccountRef)}
	if provider == "" {
		outcome.Status = "failed"
		outcome.Reason = "provider_missing"
		return outcome
	}
	credential, profile, err := handler.importCredentialForEntry(provider, entry)
	if err != nil {
		outcome.Status = "failed"
		outcome.Reason = importReason(err)
		return outcome
	}
	if credential == nil {
		outcome.Status = "unsupported"
		outcome.Reason = "credential_shape_unsupported"
		return outcome
	}
	result, err := handler.importer.Import(ctx, credential, profile)
	if err != nil {
		outcome.Status = "failed"
		outcome.Reason = importReason(err)
		return outcome
	}
	account := result.Account()
	outcome.AccountRef = account.Ref().String()
	if result.Created() {
		outcome.Status = "created"
	} else {
		outcome.Status = "unchanged"
	}
	return outcome
}

// importCredentialForEntry 只接受 Go 已研究的静态/native 形态；未知形态返回 nil。
func (handler *Handler) importCredentialForEntry(
	provider string,
	entry AihAccountsImportEntry,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	if len(entry.NativeAuth) > 0 && string(entry.NativeAuth) != "{}" && string(entry.NativeAuth) != "null" {
		artifacts, err := json.Marshal(map[string]json.RawMessage{"native_auth_json": entry.NativeAuth})
		if err != nil {
			return nil, nil, err
		}
		return handler.native.Decode(provider, artifacts)
	}
	env := entry.Env
	if len(env) == 0 {
		return nil, nil, nil
	}
	switch provider {
	case "codex":
		apiKey := strings.TrimSpace(env["OPENAI_API_KEY"])
		if apiKey == "" {
			return nil, nil, nil
		}
		credential, err := handler.staticCredentials.BuildStatic(
			provider, "api_key", apiKey, "", strings.TrimSpace(env["OPENAI_BASE_URL"]),
		)
		return credential, nil, err
	case "claude":
		baseURL := strings.TrimSpace(env["ANTHROPIC_BASE_URL"])
		if token := strings.TrimSpace(env["ANTHROPIC_AUTH_TOKEN"]); token != "" {
			credential, err := handler.staticCredentials.BuildStatic(
				provider, "auth_token", "", token, baseURL,
			)
			return credential, nil, err
		}
		apiKey := strings.TrimSpace(env["ANTHROPIC_API_KEY"])
		if apiKey == "" {
			return nil, nil, nil
		}
		credential, err := handler.staticCredentials.BuildStatic(
			provider, "api_key", apiKey, "", baseURL,
		)
		return credential, nil, err
	case "gemini":
		projectID := strings.TrimSpace(env["VERTEX_AI_PROJECT_ID"])
		if projectID == "" && strings.TrimSpace(env["VERTEX_AI_PLACEHOLDER"]) == "" {
			return nil, nil, nil
		}
		apiKey := strings.TrimSpace(env["GEMINI_API_KEY"])
		if apiKey == "" {
			apiKey = strings.TrimSpace(env["GOOGLE_API_KEY"])
		}
		credential, err := handler.staticCredentials.BuildVertex(
			provider,
			projectID,
			strings.TrimSpace(env["VERTEX_AI_LOCATION"]),
			apiKey,
			strings.TrimSpace(env["GEMINI_BASE_URL"]),
			strings.TrimSpace(env["VERTEX_AI_PLACEHOLDER"]) == "true",
		)
		return credential, nil, err
	default:
		// 其他 env-only 形态 Go 还没有对应凭据构造器。
		return nil, nil, nil
	}
}

// importReason 只返回稳定错误码，不回显凭据内容。
func importReason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, accountapp.ErrAccountConflict):
		return "account_conflict"
	case errors.Is(err, accountapp.ErrInvalidAccountImport):
		return "invalid_account_import"
	default:
		return "import_failed"
	}
}
