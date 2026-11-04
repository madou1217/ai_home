package accountsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

// aihAccountsImportDocument 是 WebUI/CLI 的 aih-accounts v1 迁移文档。
type aihAccountsImportDocument struct {
	Kind       string                   `json:"kind"`
	Version    int                      `json:"version"`
	ExportedAt string                   `json:"exportedAt"`
	Source     map[string]string        `json:"source"`
	Accounts   []aihAccountsImportEntry `json:"accounts"`
}

type aihAccountsImportEntry struct {
	Provider     string            `json:"provider"`
	AccountRef   string            `json:"accountRef"`
	CLIAccountID string            `json:"cliAccountId"`
	Status       string            `json:"status"`
	Env          map[string]string `json:"env"`
	NativeAuth   json.RawMessage   `json:"nativeAuth"`
}

type aihAccountImportOutcome struct {
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
	Status     string `json:"status"`
	Reason     string `json:"reason,omitempty"`
}

type aihAccountsImportResponse struct {
	OK       bool                      `json:"ok"`
	Summary  map[string]int            `json:"summary"`
	Accounts []aihAccountImportOutcome `json:"accounts"`
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
	var document aihAccountsImportDocument
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
	summary := map[string]int{"total": len(document.Accounts), "created": 0, "updated": 0, "failed": 0, "skipped": 0}
	outcomes := make([]aihAccountImportOutcome, 0, len(document.Accounts))
	for _, entry := range document.Accounts {
		outcome := handler.importAihAccount(request.Context(), entry)
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
	writeJSON(response, http.StatusOK, aihAccountsImportResponse{
		OK:       summary["failed"] == 0,
		Summary:  summary,
		Accounts: outcomes,
	})
}

// importAihAccount 单条导入：静态 env → 静态凭据；nativeAuth → 原生 artifact。
func (handler *Handler) importAihAccount(
	ctx context.Context,
	entry aihAccountsImportEntry,
) aihAccountImportOutcome {
	provider := strings.ToLower(strings.TrimSpace(entry.Provider))
	outcome := aihAccountImportOutcome{Provider: provider, AccountRef: strings.TrimSpace(entry.AccountRef)}
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
	entry aihAccountsImportEntry,
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
