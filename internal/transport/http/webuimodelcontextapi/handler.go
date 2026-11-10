// Package webuimodelcontextapi 提供账号 × 模型的上下文窗口读模型。
//
// 解析优先级与 Node model-context-overrides 一致：
//
//	手动覆盖（app-state config:model-context-overrides）
//	> 上游探测（app-state cache:webui-models-snapshot.json 的 contextLimits）
//	> models.dev 目录（Go 嵌入索引）
//	> unknown。
//
// GET 还会返回同 provider 下的同类型账号（供前端提示「是否一并设置」）。
package webuimodelcontextapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"sort"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// Path 是账号级上下文窗口的管理契约前缀。
	//
	//	GET /v1/management/webui/accounts/{provider}/{accountRef}/model-context?models=a,b
	Path = "/v1/management/webui/accounts"

	overrideKey = "config:model-context-overrides"
	snapshotKey = "cache:webui-models-snapshot.json"

	minContextTokens = 1024
	maxContextTokens = 2000000
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("模型上下文接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Metadata 是 models.dev 上下文目录的最小端口。
type Metadata interface {
	LookupContextWindow(providerID string, modelID string) (int, bool)
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Catalog    *providers.Catalog
	Metadata   Metadata
}

// Handler 处理模型上下文读取。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	catalog    *providers.Catalog
	metadata   Metadata
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" || dependencies.Catalog == nil || dependencies.Metadata == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		catalog:    dependencies.Catalog,
		metadata:   dependencies.Metadata,
	}, nil
}

// ModelView 是单个模型的一行。
type ModelView struct {
	Model    string `json:"model"`
	Tokens   int    `json:"tokens"`
	Source   string `json:"source"`
	Override int    `json:"override"`
}

// LimitsView 是窗口合法范围。
type LimitsView struct {
	Min int `json:"min"`
	Max int `json:"max"`
}

// SiblingView 是同 provider 下的同类型账号。
type SiblingView struct {
	AccountRef     string `json:"accountRef"`
	Provider       string `json:"provider"`
	CredentialType string `json:"credentialType"`
	DisplayName    string `json:"displayName"`
	Disabled       bool   `json:"disabled"`
}

type responseView struct {
	OK               bool          `json:"ok"`
	AccountRef       string        `json:"accountRef"`
	Provider         string        `json:"provider"`
	Models           []ModelView   `json:"models"`
	Limits           LimitsView    `json:"limits"`
	SameTypeAccounts []SiblingView `json:"sameTypeAccounts"`
	CredentialType   string        `json:"credentialType"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

type apiError struct {
	status  int
	code    string
	message string
}

func (err *apiError) Error() string { return err.code }

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "model_context_unavailable", "模型上下文服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "无效的账号路径")
		return
	}
	result, failure := handler.readModelContext(request.Context(), provider, accountRef, request.URL.Query().Get("models"))
	if failure != nil {
		writeError(response, failure.status, failure.code, failure.message)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (handler *Handler) readModelContext(ctx context.Context, provider string, accountRef string, requested string) (responseView, *apiError) {
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "model_context_read_failed", message: err.Error()}
	}
	owner, found, err := appstate.LookupAccountProvider(ctx, databasePath, accountRef)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "model_context_read_failed", message: err.Error()}
	}
	if !found || strings.ToLower(strings.TrimSpace(owner)) != provider {
		return responseView{}, &apiError{status: 404, code: "account_not_found", message: "未找到 " + provider + " 账号 " + accountRef}
	}

	overrides, err := readOverrides(ctx, databasePath)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "model_context_read_failed", message: err.Error()}
	}
	probed, err := readProbedLimits(ctx, databasePath)
	if err != nil {
		return responseView{}, &apiError{status: 500, code: "model_context_read_failed", message: err.Error()}
	}

	accountOverrides := overrides[accountRef]
	models := splitModels(requested)
	if len(models) == 0 {
		for modelID := range accountOverrides {
			models = append(models, modelID)
		}
		sort.Strings(models)
	}
	rows := make([]ModelView, 0, len(models))
	for _, modelID := range models {
		override := accountOverrides[modelID]
		tokens, source := 0, "unknown"
		if override > 0 {
			tokens, source = override, "override"
		} else if probedValue := probed[accountRef][modelID]; probedValue > 0 {
			tokens, source = probedValue, "probed"
		} else if catalogValue, ok := handler.metadata.LookupContextWindow(provider, modelID); ok && catalogValue > 0 {
			tokens, source = catalogValue, "catalog"
		}
		rows = append(rows, ModelView{Model: modelID, Tokens: tokens, Source: source, Override: override})
	}

	siblings, credentialType := handler.sameTypeAccounts(ctx, databasePath, provider, accountRef)

	return responseView{
		OK:               true,
		AccountRef:       accountRef,
		Provider:         provider,
		Models:           rows,
		Limits:           LimitsView{Min: minContextTokens, Max: maxContextTokens},
		SameTypeAccounts: siblings,
		CredentialType:   credentialType,
	}, nil
}

func (handler *Handler) sameTypeAccounts(ctx context.Context, databasePath string, provider string, accountRef string) ([]SiblingView, string) {
	accounts, err := listProviderAccounts(ctx, databasePath, handler.catalog, provider)
	if err != nil {
		return []SiblingView{}, ""
	}
	selfType := ""
	for _, account := range accounts {
		if account.AccountRef == accountRef {
			selfType = account.CredentialType
			break
		}
	}
	if selfType == "" {
		return []SiblingView{}, ""
	}
	siblings := make([]SiblingView, 0, len(accounts))
	for _, account := range accounts {
		if account.AccountRef == accountRef || account.CredentialType != selfType {
			continue
		}
		siblings = append(siblings, account)
	}
	return siblings, selfType
}

func listProviderAccounts(ctx context.Context, databasePath string, catalog *providers.Catalog, provider string) ([]SiblingView, error) {
	db, err := appstate.OpenReadOnly(ctx, databasePath)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = db.Close() }()

	rows, err := db.QueryContext(ctx, "SELECT account_ref FROM account_refs WHERE provider = ? ORDER BY account_ref", provider)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return nil, nil
		}
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	refs := make([]string, 0, 8)
	for rows.Next() {
		var ref string
		if err := rows.Scan(&ref); err != nil {
			return nil, err
		}
		refs = append(refs, ref)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	apiKeyEnv := []string(nil)
	if definition, ok := catalog.Get(provider); ok && definition.Credentials != nil {
		apiKeyEnv = definition.Credentials.APIKeyEnv
	}
	accounts := make([]SiblingView, 0, len(refs))
	for _, ref := range refs {
		env, err := readCredentialEnv(ctx, db, ref)
		if err != nil {
			env = map[string]any{}
		}
		displayName, disabled := readAccountState(ctx, db, ref)
		accounts = append(accounts, SiblingView{
			AccountRef:     ref,
			Provider:       provider,
			CredentialType: inferCredentialType(env, apiKeyEnv),
			DisplayName:    displayName,
			Disabled:       disabled,
		})
	}
	return accounts, nil
}

func readCredentialEnv(ctx context.Context, db *sql.DB, accountRef string) (map[string]any, error) {
	var envJSON string
	err := db.QueryRowContext(ctx, "SELECT env_json FROM account_credentials WHERE account_ref = ? LIMIT 1", accountRef).Scan(&envJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return map[string]any{}, nil
	}
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "no such table") {
			return map[string]any{}, nil
		}
		return nil, err
	}
	var parsed any
	if json.Unmarshal([]byte(envJSON), &parsed) != nil {
		return map[string]any{}, nil
	}
	if object, ok := parsed.(map[string]any); ok {
		return object, nil
	}
	return map[string]any{}, nil
}

func readAccountState(ctx context.Context, db *sql.DB, accountRef string) (string, bool) {
	var displayName string
	var configured sql.NullInt64
	err := db.QueryRowContext(ctx, "SELECT display_name, configured FROM account_state WHERE account_ref = ? LIMIT 1", accountRef).Scan(&displayName, &configured)
	if err != nil {
		return "", false
	}
	return strings.TrimSpace(displayName), configured.Valid && configured.Int64 == 0
}

func inferCredentialType(env map[string]any, apiKeyEnv []string) string {
	for _, key := range []string{"authMode", "authType", "credentialType"} {
		if value, ok := env[key].(string); ok && strings.EqualFold(strings.TrimSpace(value), "auth-token") {
			return "auth-token"
		}
	}
	for _, key := range apiKeyEnv {
		if value, ok := env[key].(string); ok && strings.TrimSpace(value) != "" {
			return "api-key"
		}
	}
	return "oauth"
}

func readOverrides(ctx context.Context, databasePath string) (map[string]map[string]int, error) {
	raw, found, err := appstate.ReadKV(ctx, databasePath, overrideKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return map[string]map[string]int{}, err
	}
	var decoded any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return map[string]map[string]int{}, nil
	}
	object, ok := decoded.(map[string]any)
	if !ok {
		return map[string]map[string]int{}, nil
	}
	result := map[string]map[string]int{}
	for accountRef, byModel := range object {
		ref := strings.TrimSpace(accountRef)
		models, ok := byModel.(map[string]any)
		if ref == "" || !ok {
			continue
		}
		normalized := map[string]int{}
		for modelID, value := range models {
			id := strings.TrimSpace(modelID)
			tokens := normalizeTokens(value)
			if id != "" && tokens > 0 {
				normalized[id] = tokens
			}
		}
		if len(normalized) > 0 {
			result[ref] = normalized
		}
	}
	return result, nil
}

func readProbedLimits(ctx context.Context, databasePath string) (map[string]map[string]int, error) {
	raw, found, err := appstate.ReadKV(ctx, databasePath, snapshotKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return map[string]map[string]int{}, err
	}
	var snapshot struct {
		ContextLimits map[string]map[string]any `json:"contextLimits"`
	}
	if err := json.Unmarshal([]byte(raw), &snapshot); err != nil {
		return map[string]map[string]int{}, nil
	}
	result := map[string]map[string]int{}
	for accountRef, byModel := range snapshot.ContextLimits {
		ref := strings.TrimSpace(accountRef)
		if ref == "" || byModel == nil {
			continue
		}
		normalized := map[string]int{}
		for modelID, value := range byModel {
			id := strings.TrimSpace(modelID)
			tokens := normalizeTokens(value)
			if id != "" && tokens > 0 {
				normalized[id] = tokens
			}
		}
		if len(normalized) > 0 {
			result[ref] = normalized
		}
	}
	return result, nil
}

func normalizeTokens(value any) int {
	var number float64
	switch typed := value.(type) {
	case float64:
		number = typed
	case int:
		number = float64(typed)
	case int64:
		number = float64(typed)
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return 0
		}
		number = parsed
	default:
		return 0
	}
	if number < minContextTokens || number > maxContextTokens {
		return 0
	}
	return int(number)
}

func splitModels(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	seen := map[string]struct{}{}
	for _, part := range parts {
		modelID := strings.TrimSpace(part)
		if modelID == "" {
			continue
		}
		if _, exists := seen[modelID]; exists {
			continue
		}
		seen[modelID] = struct{}{}
		result = append(result, modelID)
	}
	return result
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	encoder := json.NewEncoder(response)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
