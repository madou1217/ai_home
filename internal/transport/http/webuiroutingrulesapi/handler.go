// Package webuiroutingrulesapi 是账号调度规则（上游错误映射）的 WebUI 写入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/routing-rules
//
// 写入链路以 Go aih.db 为网关运行态单源真值，同时兼容更新 app-state.db 凭据扩展字段：
//  1. 自动双向解析规范 Go accountRef 与历史映射 nodeRef；
//  2. clearErrorBlock=true 时按规范 Go accountRef 清理运行态人工阻塞；
//  3. 将验证通过的账号自身规则与映射组挂载原子写入 aih.db，使网关实时生效；
//  4. 同步更新 app-state.db（若该账号为纯 Go 原生账号、在 app-state.db 无历史行，则直接以 aih.db 写入为准）。
package webuiroutingrulesapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

const (
	// Path 是账号调度规则写入的管理契约路径模式。
	Path = "/v1/management/webui/accounts/{provider}/{accountRef}/routing-rules"

	// maxBodyBytes 限制请求体最大为 64 KiB。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("调度规则接口依赖无效")

var (
	// errRuntimeBlockClearUnavailable 表示宿主没有装配运行态端口。
	errRuntimeBlockClearUnavailable = errors.New("运行态阻塞清理端口未装配")
	// errInvalidAccountPath 表示路径里的账号引用不是规范格式，无法作为运行态键。
	errInvalidAccountPath = errors.New("账号引用无效")
	// errRuntimeBlockClear 表示运行态清理失败或实现回报了非预期证据名。
	errRuntimeBlockClear = errors.New("运行态阻塞清理失败")
)

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountResolver 返回账号在台账中的真实 Provider。
type AccountResolver interface {
	ProviderOf(ctx context.Context, accountRef string) (string, bool, error)
}

// AccountIdentityResolver 是可选增强端口：同时返回规范 Go 引用与历史 app-state 引用。
type AccountIdentityResolver interface {
	ResolveAccountIdentity(ctx context.Context, accountRef string) (provider string, goRef string, nodeRef string, exists bool, err error)
}

// GoRulesSyncer 是可选增强端口：将规则直接写入 Go 权威数据库（aih.db）。
type GoRulesSyncer interface {
	SyncAccountRules(ctx context.Context, goRef string, rules []rulescore.Rule, groupIDs []string) (bool, error)
}

// AppStateResolver 用 app-state.db 的 account_refs 实现账号归属查询。
type AppStateResolver struct {
	DatabasePath string
}

// ProviderOf 实现 AccountResolver。
func (resolver AppStateResolver) ProviderOf(ctx context.Context, accountRef string) (string, bool, error) {
	if strings.TrimSpace(resolver.DatabasePath) == "" {
		return "", false, appstate.ErrInvalidRoot
	}
	return appstate.LookupAccountProvider(ctx, resolver.DatabasePath, accountRef)
}

// RulesStore 是 app-state 规则键的写入口（由 *rulesenv.Store 实现）。
type RulesStore interface {
	Update(ctx context.Context, accountRef string, change rulesenv.Change) (rulesenv.Result, error)
}

// RuntimeBlockClearer 是运行态门禁的人工清空端口（*inmemory.Runtime 实现）。
type RuntimeBlockClearer interface {
	ClearManualAdminBlocks(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountcore.StatusEventKind, error)
}

// Dependencies 汇总调度规则写入依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      RulesStore
	Accounts   AccountResolver
	Catalog    *providers.Catalog
	Runtime    RuntimeBlockClearer
}

// Handler 处理账号调度规则写入。
type Handler struct {
	authorizer Authorizer
	store      RulesStore
	accounts   AccountResolver
	catalog    *providers.Catalog
	runtime    RuntimeBlockClearer
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil ||
		dependencies.Accounts == nil || dependencies.Catalog == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		store:      dependencies.Store,
		accounts:   dependencies.Accounts,
		catalog:    dependencies.Catalog,
		runtime:    dependencies.Runtime,
	}, nil
}

// routingRulesPayload 是已解析的写入请求。
type routingRulesPayload struct {
	Rules           []rulescore.Rule
	GroupIDs        []string
	ClearErrorBlock bool
}

// wirePayload 只负责顶层 JSON 形状；规则单独解码以区分语法错误与领域规则错误。
type wirePayload struct {
	UpstreamErrorRules    json.RawMessage `json:"upstreamErrorRules"`
	UpstreamErrorGroupIDs []string        `json:"upstreamErrorGroupIds"`
	ClearErrorBlock       bool            `json:"clearErrorBlock"`
}

type successView struct {
	OK                    bool              `json:"ok"`
	Provider              string            `json:"provider"`
	AccountRef            string            `json:"accountRef"`
	UpstreamErrorRules    []json.RawMessage `json:"upstreamErrorRules"`
	UpstreamErrorGroupIDs []string          `json:"upstreamErrorGroupIds"`
	Changed               bool              `json:"changed"`
	EnvUpdatedAt          int64             `json:"envUpdatedAt"`
	ClearEvidence         string            `json:"clearEvidence,omitempty"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil ||
		handler.accounts == nil || handler.catalog == nil {
		writeError(response, http.StatusServiceUnavailable, "routing_rules_unavailable", "调度规则服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST")
		return
	}
	providerInput := strings.TrimSpace(request.PathValue("provider"))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if providerInput == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "账号路径无效")
		return
	}
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	provider, supported := handler.catalog.CanonicalID(providerInput)
	if !supported {
		writeError(response, http.StatusBadRequest, "unsupported_provider", "不支持的 Provider")
		return
	}

	ctx := request.Context()
	storedProvider, goRef, nodeRef, exists, err := handler.resolveAccount(ctx, accountRef)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "routing_rules_unavailable", "账号归属查询失败")
		return
	}
	if !exists || !strings.EqualFold(strings.TrimSpace(storedProvider), provider) {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}

	validatedRules, rulesJSON, err := canonicalRules(payload.Rules)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
		return
	}
	groupIDs, err := normalizeGroupIDs(payload.GroupIDs)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_group", err.Error())
		return
	}

	var clearEvidence accountcore.StatusEventKind
	if payload.ClearErrorBlock {
		clearRef := goRef
		if clearRef == "" {
			clearRef = accountRef
		}
		evidence, clearErr := handler.clearRuntimeBlocks(ctx, clearRef)
		if clearErr != nil {
			writeRuntimeClearError(response, clearErr)
			return
		}
		clearEvidence = evidence
	}

	syncedToGo := false
	if syncer, ok := handler.accounts.(GoRulesSyncer); ok {
		synced, syncErr := syncer.SyncAccountRules(ctx, goRef, validatedRules, groupIDs)
		if syncErr != nil {
			writeStoreError(response, syncErr)
			return
		}
		syncedToGo = synced
	}

	storeTargetRef := nodeRef
	if storeTargetRef == "" {
		storeTargetRef = accountRef
	}
	result, err := handler.store.Update(ctx, storeTargetRef, rulesenv.Change{
		Rules:    rulesJSON,
		GroupIDs: groupIDs,
	})
	if errors.Is(err, rulesenv.ErrAccountNotFound) && storeTargetRef != accountRef {
		result, err = handler.store.Update(ctx, accountRef, rulesenv.Change{
			Rules:    rulesJSON,
			GroupIDs: groupIDs,
		})
	}
	if err != nil {
		if errors.Is(err, rulesenv.ErrAccountNotFound) && syncedToGo {
			// Go 原生账号只存在于 aih.db、不在历史 app-state.db 中：aih.db 已完成权威持久化。
			result = rulesenv.Result{
				Changed:      true,
				EnvUpdatedAt: time.Now().UnixMilli(),
			}
		} else {
			writeStoreError(response, err)
			return
		}
	}

	writeJSON(response, http.StatusOK, successView{
		OK:                    true,
		Provider:              provider,
		AccountRef:            accountRef,
		UpstreamErrorRules:    rulesJSON,
		UpstreamErrorGroupIDs: groupIDs,
		Changed:               result.Changed,
		EnvUpdatedAt:          result.EnvUpdatedAt,
		ClearEvidence:         string(clearEvidence),
	})
}

func (handler *Handler) resolveAccount(
	ctx context.Context,
	accountRef string,
) (string, string, string, bool, error) {
	if resolver, ok := handler.accounts.(AccountIdentityResolver); ok {
		return resolver.ResolveAccountIdentity(ctx, accountRef)
	}
	provider, exists, err := handler.accounts.ProviderOf(ctx, accountRef)
	return provider, accountRef, accountRef, exists, err
}

// decodePayload 严格解析请求体：未知字段、超限正文、非对象 JSON 都整体拒绝。
func decodePayload(response http.ResponseWriter, request *http.Request) (routingRulesPayload, bool) {
	if request.Body == nil || request.Body == http.NoBody {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体无效")
		return routingRulesPayload{}, false
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体无效")
		return routingRulesPayload{}, false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体不是合法 JSON")
		return routingRulesPayload{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var wire wirePayload
	if err := decoder.Decode(&wire); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体不是合法 JSON")
		return routingRulesPayload{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体不是合法 JSON")
		return routingRulesPayload{}, false
	}
	rules, err := decodeRules(wire.UpstreamErrorRules)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
		return routingRulesPayload{}, false
	}
	return routingRulesPayload{
		Rules:           rules,
		GroupIDs:        wire.UpstreamErrorGroupIDs,
		ClearErrorBlock: wire.ClearErrorBlock,
	}, true
}

// decodeRules 解析规则数组；缺席与 null 都表示空集合。
func decodeRules(raw json.RawMessage) ([]rulescore.Rule, error) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var rules []rulescore.Rule
	if err := json.Unmarshal(trimmed, &rules); err != nil {
		if errors.Is(err, rulescore.ErrInvalidRules) {
			return nil, err
		}
		return nil, fmt.Errorf("%w: %v", rulescore.ErrInvalidRules, err)
	}
	return rules, nil
}

// canonicalRules 用领域校验验证规则并规范化编码。
func canonicalRules(rules []rulescore.Rule) ([]rulescore.Rule, []json.RawMessage, error) {
	validated, err := rulescore.Validate(rules)
	if err != nil {
		return nil, nil, err
	}
	encoded := make([]json.RawMessage, 0, len(validated))
	for _, rule := range validated {
		if err := assertNodeReaderCompatible(rule); err != nil {
			return nil, nil, err
		}
		payload, err := json.Marshal(rule)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: %v", rulescore.ErrInvalidRules, err)
		}
		encoded = append(encoded, payload)
	}
	return validated, encoded, nil
}

// normalizeGroupIDs 去空白、去重、保持顺序，并复用应用层的挂载上限与 id 校验。
func normalizeGroupIDs(groupIDs []string) ([]string, error) {
	if len(groupIDs) > rulesapp.MaxGroupIDs {
		return nil, fmt.Errorf("%w: 挂载组最多 %d 个", rulesapp.ErrInvalidGroupIDs, rulesapp.MaxGroupIDs)
	}
	normalized := make([]string, 0, len(groupIDs))
	seen := make(map[string]struct{}, len(groupIDs))
	for _, groupID := range groupIDs {
		parsed, err := mappingcore.ParseID(groupID)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", rulesapp.ErrInvalidGroupIDs, err)
		}
		if _, exists := seen[parsed]; exists {
			continue
		}
		seen[parsed] = struct{}{}
		normalized = append(normalized, parsed)
	}
	return normalized, nil
}

// clearRuntimeBlocks 执行 clearErrorBlock 的领域动作，返回实现实际使用的证据名。
func (handler *Handler) clearRuntimeBlocks(
	ctx context.Context,
	accountRef string,
) (accountcore.StatusEventKind, error) {
	if handler.runtime == nil {
		return "", errRuntimeBlockClearUnavailable
	}
	reference, err := accountcore.ParseAccountRef(accountRef)
	if err != nil {
		return "", errInvalidAccountPath
	}
	evidence, err := handler.runtime.ClearManualAdminBlocks(ctx, reference)
	if err != nil {
		return "", errors.Join(errRuntimeBlockClear, err)
	}
	if evidence != accountcore.StatusEventManualAdminClear {
		return "", errRuntimeBlockClear
	}
	return evidence, nil
}

func writeRuntimeClearError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errRuntimeBlockClearUnavailable):
		writeError(response, http.StatusNotImplemented, "runtime_block_clear_unavailable",
			"运行态阻塞清理端口未装配；请取消 clearErrorBlock 后重试")
	case errors.Is(err, errInvalidAccountPath):
		writeError(response, http.StatusBadRequest, "invalid_account_path", "账号引用无效")
	default:
		writeError(response, http.StatusInternalServerError, "runtime_block_clear_failed",
			"运行态阻塞清理失败")
	}
}

func writeStoreError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, rulesenv.ErrAccountNotFound), errors.Is(err, rulesapp.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
	case errors.Is(err, rulesenv.ErrInvalidAccountRef), errors.Is(err, rulesapp.ErrInvalidAccountRef):
		writeError(response, http.StatusBadRequest, "invalid_account_path", "账号引用无效")
	case errors.Is(err, rulescore.ErrInvalidRules), errors.Is(err, rulesenv.ErrInvalidRules):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
	case errors.Is(err, rulesapp.ErrInvalidGroupIDs), errors.Is(err, rulesenv.ErrInvalidGroupIDs):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_group", err.Error())
	case errors.Is(err, rulesenv.ErrInvalidEnvJSON):
		writeError(response, http.StatusConflict, "account_env_invalid", "账号 env_json 不是 JSON 对象，拒绝写入")
	default:
		writeError(response, http.StatusInternalServerError, "routing_rules_failed", "调度规则写入失败")
	}
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
