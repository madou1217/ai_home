// Package webuiroutingrulesapi 是账号调度规则（上游错误映射）的 WebUI 写入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/routing-rules
//
// 边界与 Node 的 handleUpdateAccountRoutingRulesRequest 对齐：校验路径、规则与
// 分组挂载，只写 app-state.db account_credentials.env_json 的两个规则键，并保留
// 同一 env 内的其它凭据键与 env_updated_at（rulesenv 负责读改写）。
//
// 本包刻意不做两件事，避免制造假成功：
//   - 不清理运行态阻塞：请求 clearErrorBlock=true 时整次拒绝（501），不写 env；
//   - 不刷新实时账号、不通知 Node 运行池/Go core 投影：响应只描述 env 写入结果。
//
// 这两项都需要宿主运行态端口，属于接线阶段的阻塞项，不能在此假装完成。
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

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/core/providers"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/appstate/rulesenv"
)

const (
	// Path 是账号调度规则写入的管理契约路径模式。
	Path = "/v1/management/webui/accounts/{provider}/{accountRef}/routing-rules"

	// maxBodyBytes 与 Node 的 readRequestBody({maxBytes: 64 * 1024}) 一致。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("调度规则接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// AccountResolver 返回账号在 Node 账号台账中的真实 Provider。
//
// 存在性以 Node 的 account_refs 为准：Go 的 accounts 表可能缺少未同步/停用账号，
// 用它做校验会把真实历史账号判成 404。
type AccountResolver interface {
	ProviderOf(ctx context.Context, accountRef string) (string, bool, error)
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

// Dependencies 汇总调度规则写入依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      RulesStore
	Accounts   AccountResolver
	Catalog    *providers.Catalog
}

// Handler 处理账号调度规则写入。
type Handler struct {
	authorizer Authorizer
	store      RulesStore
	accounts   AccountResolver
	catalog    *providers.Catalog
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
	}, nil
}

// routingRulesPayload 是已解析的写入请求。
type routingRulesPayload struct {
	Rules           []rulescore.Rule
	GroupIDs        []string
	ClearErrorBlock bool
}

// wirePayload 只负责顶层 JSON 形状；规则单独解码，才能把「正文不是 JSON」
// 与「规则内容不合法」映射成 Node 同名的两个错误码。
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
	storedProvider, exists, err := handler.accounts.ProviderOf(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "routing_rules_unavailable", "账号归属查询失败")
		return
	}
	if !exists || !strings.EqualFold(strings.TrimSpace(storedProvider), provider) {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}
	rules, err := canonicalRules(payload.Rules)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
		return
	}
	groupIDs, err := normalizeGroupIDs(payload.GroupIDs)
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_group", err.Error())
		return
	}
	if payload.ClearErrorBlock {
		// 运行态阻塞清理需要宿主运行态端口，本包不承接。写 env 后再返回成功会让调用方
		// 误以为阻塞已清；因此整次拒绝且不产生任何写入。
		writeError(response, http.StatusNotImplemented, "runtime_block_clear_unavailable",
			"调度规则已校验，但运行态阻塞清理未在 Go 侧实现；请取消 clearErrorBlock 后重试")
		return
	}
	result, err := handler.store.Update(request.Context(), accountRef, rulesenv.Change{
		Rules:    rules,
		GroupIDs: groupIDs,
	})
	if err != nil {
		writeStoreError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, successView{
		OK:                    true,
		Provider:              provider,
		AccountRef:            accountRef,
		UpstreamErrorRules:    rules,
		UpstreamErrorGroupIDs: groupIDs,
		Changed:               result.Changed,
		EnvUpdatedAt:          result.EnvUpdatedAt,
	})
}

// decodePayload 严格解析请求体：未知字段、超限正文都整体拒绝。
//
// 规则内容错误（而不是 JSON 语法错误）必须回 invalid_upstream_error_rules，
// 与 Node 的 validateUpstreamErrorRules 错误码保持一致。
func decodePayload(response http.ResponseWriter, request *http.Request) (routingRulesPayload, bool) {
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体无效")
		return routingRulesPayload{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var wire wirePayload
	if err := decoder.Decode(&wire); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_routing_rules", "请求体不是合法 JSON")
		return routingRulesPayload{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		// JSON.parse 会拒绝尾随内容；这里同样不接受「一个合法对象 + 垃圾」。
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

// decodeRules 解析规则数组；缺席与 null 都表示空集合（Node 的 `|| []`）。
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

// canonicalRules 用领域校验（与 application/upstreamrules 同一套）验证规则，
// 再按 Node 读侧契约检查正则，最后规范化成 env 值的 JSON 数组。
//
// 规范化而不是原样回写：Node 读侧每次都会重新归一化，写侧先归一可以避免一次保存
// 产生无意义的配置 diff，也保证 env 里不会留下 Node 会整份丢弃的规则。
func canonicalRules(rules []rulescore.Rule) ([]json.RawMessage, error) {
	validated, err := rulescore.Validate(rules)
	if err != nil {
		return nil, err
	}
	encoded := make([]json.RawMessage, 0, len(validated))
	for _, rule := range validated {
		if err := assertNodeReaderCompatible(rule); err != nil {
			return nil, err
		}
		payload, err := json.Marshal(rule)
		if err != nil {
			return nil, fmt.Errorf("%w: %v", rulescore.ErrInvalidRules, err)
		}
		encoded = append(encoded, payload)
	}
	return encoded, nil
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

// writeStoreError 把存储失败映射成稳定的错误码。
func writeStoreError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, rulesenv.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
	case errors.Is(err, rulesenv.ErrInvalidAccountRef):
		writeError(response, http.StatusBadRequest, "invalid_account_path", "账号引用无效")
	case errors.Is(err, rulescore.ErrInvalidRules), errors.Is(err, rulesenv.ErrInvalidRules):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
	case errors.Is(err, rulesapp.ErrInvalidGroupIDs), errors.Is(err, rulesenv.ErrInvalidGroupIDs):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_group", err.Error())
	case errors.Is(err, rulesenv.ErrInvalidEnvJSON):
		// 已存 env 不是 JSON 对象：拒绝覆盖未知数据，交由人工修复。
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
