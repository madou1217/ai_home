// Package portableaccount owns the aih-accounts document-to-domain adapter.
// It contains no HTTP, database lifecycle, or network refresh orchestration.
package portableaccount

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

type DomainImporter interface {
	Import(context.Context, accountapp.Credential, accountapp.PublicProfile) (accountapp.AccountImportResult, error)
}
type NativeDecoder interface {
	Decode(string, []byte) (accountapp.Credential, accountapp.PublicProfile, error)
}
type Importer struct {
	importer          DomainImporter
	staticCredentials StaticCredentialFactory
	native            NativeDecoder
}

func New(importer DomainImporter, static StaticCredentialFactory, native NativeDecoder) *Importer {
	return &Importer{importer: importer, staticCredentials: static, native: native}
}

type AihAccountsImportResult struct {
	Summary  map[string]int
	Accounts []AihAccountImportOutcome
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

// ImportAihAccounts 逐条导入 aih-accounts 文档；单条失败不影响其余条目。
//
// 这是导入语义的唯一实现：管理面 HTTP 端点与 WebUI 的异步导入作业都调用它。
// 每次调用都返回完整 summary，调用方只负责合并与展示。
func (handler *Importer) ImportAihAccounts(
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
func (handler *Importer) importAihAccount(
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
	status := strings.ToLower(strings.TrimSpace(entry.Status))
	if status != "" && status != "up" && status != "down" {
		outcome.Status = "failed"
		outcome.Reason = "invalid_initial_account_status"
		return outcome
	}
	credential, profile, err := handler.DecodeEntry(provider, entry)
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
	var result accountapp.AccountImportResult
	if status == "down" {
		port, ok := handler.importer.(accountapp.InitialStateImporter)
		if !ok {
			outcome.Status = "failed"
			outcome.Reason = "initial_account_state_unsupported"
			return outcome
		}
		result, err = port.ImportWithInitialState(ctx, credential, profile, accountapp.InitialAccountState{Disabled: true})
	} else {
		result, err = handler.importer.Import(ctx, credential, profile)
	}
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

// DecodeEntry accepts only catalog-declared static and verified native artifacts.
func (handler *Importer) DecodeEntry(
	provider string,
	entry AihAccountsImportEntry,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	if len(entry.NativeAuth) > 0 && string(entry.NativeAuth) != "{}" && string(entry.NativeAuth) != "null" {
		artifacts, err := NativeEnvelope(provider, entry.NativeAuth)
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
			return decodeGenericStatic(provider, env)
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
		return decodeGenericStatic(provider, env)
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
	case errors.Is(err, accountapp.ErrInitialAccountStateUnsupported):
		return "initial_account_state_unsupported"
	default:
		return "import_failed"
	}
}

func decodeGenericStatic(provider string, env map[string]string) (accountapp.Credential, accountapp.PublicProfile, error) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		return nil, nil, err
	}
	def, found := catalog.Get(provider)
	if !found || def.Credentials == nil {
		return nil, nil, nil
	}
	key, base := "", ""
	for _, name := range def.Credentials.APIKeyEnv {
		if strings.TrimSpace(env[name]) != "" {
			key = env[name]
			break
		}
	}
	for _, name := range def.Credentials.BaseURLEnv {
		if strings.TrimSpace(env[name]) != "" {
			base = env[name]
			break
		}
	}
	if key == "" {
		return nil, nil, nil
	}
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{ProviderID: provider, APIKey: key, BaseURL: base})
	return credential, nil, err
}
