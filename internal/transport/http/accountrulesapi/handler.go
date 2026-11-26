// Package accountrulesapi 是账号级上游错误规则的管理 HTTP 边界。
//
// 账号级配置 = 账号自身规则 + 挂载的映射组 id 顺序；有效规则由 Go 在读取时直接拼装，
// 以 aih.db 作为权威单源真值。
//
//	GET    /v1/management/accounts/{ref}/upstream-error-rules     读取配置与拼装结果
//	PUT    /v1/management/accounts/{ref}/upstream-error-rules     整体替换配置
//	DELETE /v1/management/accounts/{ref}/upstream-error-rules     清空配置（幂等）
//	GET    /v1/management/account-upstream-error-rules            列出全部账号配置（诊断/对账）
//	POST   /v1/management/account-upstream-error-rules/import     批量导入或从 app-state 一次性迁入账号级规则
package accountrulesapi

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
)

const (
	// CollectionPath 是全部账号配置的只读诊断路径。
	CollectionPath = "/v1/management/account-upstream-error-rules"
	// ImportPath 是账号级规则批量导入/迁移路径。
	ImportPath = CollectionPath + "/import"
	// MemberPattern 是账号级配置路径的方法无关模式，供路由注册使用。
	MemberPattern = "/v1/management/accounts/{ref}/upstream-error-rules"
	// maxBodyBytes 限制一次配置写入的正文大小。
	maxBodyBytes = 1 << 20
)

// ErrInvalidDependencies 表示 Handler 缺少服务或鉴权。
var ErrInvalidDependencies = errors.New("账号级上游错误规则 Handler 依赖无效")

// Authorizer 是管理密钥鉴权端口。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Service 是账号规则用例端口（由 application/upstreamrules.Service 实现）。
type Service interface {
	Effective(ctx context.Context, accountRef string) (rulesapp.AccountView, error)
	ReplaceAccount(ctx context.Context, accountRef string, input rulesapp.AccountInput) (rulesapp.AccountView, error)
	DeleteAccount(ctx context.Context, accountRef string) (bool, error)
	ListAccounts(ctx context.Context) ([]rulesapp.AccountView, error)
	SupportedProviders() []string
	Generation() int64
}

// Dependencies 汇总账号规则接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Service    Service
	// AIHomeDir 可选：用于填充历史映射引用及承接 app-state.db 账号规则迁入。
	AIHomeDir string
}

// Handler 提供账号级上游错误规则的读写与批量迁入。
type Handler struct {
	authorizer Authorizer
	service    Service
	aiHomeDir  string
}

// NewHandler 创建账号级规则管理接口。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Service == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		service:    dependencies.Service,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
	}, nil
}

// accountRulesPayload 是整体替换的请求体；缺席字段按空集合处理。
type accountRulesPayload struct {
	GroupIDs []string         `json:"group_ids"`
	Rules    []rulescore.Rule `json:"rules"`
}

// accountRulesView 是单个账号的配置与拼装结果。
type accountRulesView struct {
	AccountRef     string           `json:"account_ref"`
	NodeAccountRef string           `json:"node_account_ref"`
	Provider       string           `json:"provider"`
	Source         string           `json:"source"`
	GroupIDs       []string         `json:"group_ids"`
	Rules          []rulescore.Rule `json:"rules"`
	EffectiveRules []rulescore.Rule `json:"effective_rules"`
	Supported      bool             `json:"supported"`
}

type importAccountItem struct {
	AccountRef string          `json:"account_ref"`
	GroupIDs   []string        `json:"group_ids"`
	Rules      json.RawMessage `json:"rules"`
}

// ServeHTTP 只接受 Management Key 鉴权过的请求。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.service == nil {
		writeError(response, http.StatusServiceUnavailable, "account_rules_unavailable", "账号规则服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.URL.Path == CollectionPath {
		if request.Method != http.MethodGet {
			response.Header().Set("Allow", "GET")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 GET")
			return
		}
		handler.list(response, request)
		return
	}
	if request.URL.Path == ImportPath {
		if request.Method != http.MethodPost {
			response.Header().Set("Allow", "POST")
			writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "只支持 POST")
			return
		}
		handler.importRules(response, request)
		return
	}
	accountRef := strings.TrimSpace(request.PathValue("ref"))
	if accountRef == "" {
		writeError(response, http.StatusNotFound, "route_not_found", "请求的账号规则资源不存在")
		return
	}
	switch request.Method {
	case http.MethodGet:
		handler.get(response, request, accountRef)
	case http.MethodPut:
		handler.put(response, request, accountRef)
	case http.MethodDelete:
		handler.remove(response, request, accountRef)
	default:
		response.Header().Set("Allow", "GET, PUT, DELETE")
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "不支持的账号规则操作")
	}
}

func (handler *Handler) list(response http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	source, ok := handler.service.(interface {
		Collection(context.Context) (rulesapp.Collection, error)
	})
	if !ok {
		writeError(response, http.StatusServiceUnavailable, "account_rules_unavailable", "Go authority unavailable")
		return
	}
	collection, err := source.Collection(ctx)
	if err != nil {
		writeError(response, http.StatusServiceUnavailable, "account_rules_unavailable", "Go authority unavailable")
		return
	}
	accounts := collection.Accounts
	refTable := handler.loadRefTable(ctx)
	views := make([]accountRulesView, 0, len(accounts))
	for _, account := range accounts {
		views = append(views, toView(account, refTable))
	}
	supported := nonNilStrings(handler.service.SupportedProviders())
	generation := handler.service.Generation()
	writeJSON(response, http.StatusOK, map[string]any{
		"source": collection.Source, "authority_version": collection.Version, "authority_revision": collection.Revision, "accepted_refs": collection.AcceptedRefs,
		"ok":                  true,
		"accounts":            views,
		"supported_providers": supported,
		"generation":          generation,
		"data": map[string]any{
			"source": collection.Source, "authority_version": collection.Version, "authority_revision": collection.Revision, "accepted_refs": collection.AcceptedRefs,
			"accounts":            views,
			"supported_providers": supported,
			"generation":          generation,
		},
	})
}

func (handler *Handler) get(response http.ResponseWriter, request *http.Request, accountRef string) {
	ctx := request.Context()
	view, err := handler.service.Effective(ctx, accountRef)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"data": toView(view, handler.loadRefTable(ctx))})
}

func (handler *Handler) put(response http.ResponseWriter, request *http.Request, accountRef string) {
	ctx := request.Context()
	payload, ok := decodePayload(response, request)
	if !ok {
		return
	}
	view, err := handler.service.ReplaceAccount(ctx, accountRef, rulesapp.AccountInput{
		GroupIDs: payload.GroupIDs,
		Rules:    payload.Rules,
	})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"data": toView(view, handler.loadRefTable(ctx))})
}

func (handler *Handler) remove(response http.ResponseWriter, request *http.Request, accountRef string) {
	deleted, err := handler.service.DeleteAccount(request.Context(), accountRef)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"data": map[string]any{"account_ref": accountRef, "deleted": deleted},
	})
}

func (handler *Handler) importRules(response http.ResponseWriter, request *http.Request) {
	ctx := request.Context()
	items, force, ok := handler.parseImportPayload(ctx, response, request)
	if !ok {
		return
	}

	// Resolve links and make nonforce/cleared decisions only in the repository
	// transaction, not through ListAccounts (which admits every account).
	records := make([]rulesapp.Record, 0, len(items))
	for _, item := range items {
		rawRef := strings.TrimSpace(item.AccountRef)
		if _, err := accountcore.ParseAccountRef(rawRef); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_account_ref", "Invalid account reference in batch")
			return
		}
		var rules []rulescore.Rule
		raw := bytes.TrimSpace(item.Rules)
		if len(raw) > 0 && !bytes.Equal(raw, []byte("null")) {
			if err := json.Unmarshal(raw, &rules); err != nil {
				writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", "Invalid rules batch")
				return
			}
		}
		// Empty configurations still cross the transaction mapping/validation gate.
		records = append(records, rulesapp.Record{AccountRef: rawRef, GroupIDs: item.GroupIDs, Rules: rules})
	}
	batch, available := handler.service.(interface {
		ImportAccounts(context.Context, rulesapp.ImportRequest) (rulesapp.ImportResult, error)
	})
	if !available {
		writeError(response, http.StatusServiceUnavailable, "account_rules_unavailable", "Atomic import unavailable")
		return
	}
	result, err := batch.ImportAccounts(ctx, rulesapp.ImportRequest{Accounts: records, Force: force})
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{
		"ok": true, "pushed": len(result.AcceptedRefs), "accepted": len(result.AcceptedRefs),
		"failed": 0, "dropped": 0, "droppedReasons": []map[string]string{},
		"skippedAccounts": result.SkippedRefs, "generation": handler.service.Generation(),
		"authority_revision": result.Revision,
	})
}

func (handler *Handler) parseImportPayload(
	ctx context.Context,
	response http.ResponseWriter,
	request *http.Request,
) ([]importAccountItem, bool, bool) {
	var body []byte
	if request.Body != nil && request.Body != http.NoBody {
		readBytes, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
		if err != nil || int64(len(readBytes)) > maxBodyBytes {
			writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体无效")
			return nil, false, false
		}
		body = bytes.TrimSpace(readBytes)
	}
	if len(body) == 0 {
		writeError(response, http.StatusConflict, "legacy_source_confirmation_required", "Explicit accounts payload required")
		return nil, false, false
	}
	if body[0] != '{' {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体须为 JSON 对象")
		return nil, false, false
	}
	var envelope struct {
		Force    bool                 `json:"force"`
		Accounts *[]importAccountItem `json:"accounts"`
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体不是合法 JSON")
		return nil, false, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体包含多余内容")
		return nil, false, false
	}
	if envelope.Accounts != nil {
		return *envelope.Accounts, envelope.Force, true
	}
	writeError(response, http.StatusConflict, "legacy_source_confirmation_required", "Explicit accounts payload required")
	return nil, false, false
}

func unwrapEnvJSONValue(raw json.RawMessage) json.RawMessage {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil
	}
	var encoded string
	if err := json.Unmarshal(trimmed, &encoded); err == nil {
		inner := bytes.TrimSpace([]byte(encoded))
		if len(inner) == 0 || bytes.Equal(inner, []byte("null")) {
			return nil
		}
		return json.RawMessage(inner)
	}
	return json.RawMessage(trimmed)
}

func decodeStringSlice(raw json.RawMessage) []string {
	if len(raw) == 0 {
		return nil
	}
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil
	}
	return values
}

func parsePermissiveRules(raw json.RawMessage, accountRef string) ([]rulescore.Rule, []map[string]string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return nil, nil
	}
	var rawElements []json.RawMessage
	if err := json.Unmarshal(trimmed, &rawElements); err != nil {
		return nil, []map[string]string{{"account_ref": accountRef, "reason": err.Error()}}
	}
	valid := make([]rulescore.Rule, 0, len(rawElements))
	drops := make([]map[string]string, 0)
	for _, elem := range rawElements {
		var rule rulescore.Rule
		if err := json.Unmarshal(elem, &rule); err != nil {
			drops = append(drops, map[string]string{"account_ref": accountRef, "reason": err.Error()})
			continue
		}
		validated, err := rulescore.Validate([]rulescore.Rule{rule})
		if err != nil {
			drops = append(drops, map[string]string{"account_ref": accountRef, "reason": err.Error()})
			continue
		}
		valid = append(valid, validated...)
	}
	return valid, drops
}

func (handler *Handler) loadRefTable(ctx context.Context) accountrefmap.Table {
	if handler == nil || handler.aiHomeDir == "" {
		return accountrefmap.Table{}
	}
	table, err := accountrefmap.Load(ctx, handler.aiHomeDir)
	if err != nil {
		return accountrefmap.Table{}
	}
	return table
}

// toView 把应用层视图转成稳定的 JSON 形状。
func toView(view rulesapp.AccountView, refTable accountrefmap.Table) accountRulesView {
	nodeRef := refTable.NodeRef(view.AccountRef)
	if nodeRef == "" {
		nodeRef = view.AccountRef
	}
	return accountRulesView{
		AccountRef:     view.AccountRef,
		NodeAccountRef: nodeRef,
		Provider:       view.Provider,
		Source:         string(view.Source),
		GroupIDs:       nonNilStrings(view.GroupIDs),
		Rules:          nonNilRules(view.Rules),
		EffectiveRules: nonNilRules(view.EffectiveRules),
		Supported:      view.Supported,
	}
}

func decodePayload(response http.ResponseWriter, request *http.Request) (accountRulesPayload, bool) {
	if request.Body == nil || request.Body == http.NoBody {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体无效")
		return accountRulesPayload{}, false
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxBodyBytes+1))
	if err != nil || int64(len(body)) > maxBodyBytes {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体无效")
		return accountRulesPayload{}, false
	}
	trimmed := bytes.TrimSpace(body)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体不是合法 JSON")
		return accountRulesPayload{}, false
	}
	decoder := json.NewDecoder(bytes.NewReader(trimmed))
	decoder.DisallowUnknownFields()
	var payload accountRulesPayload
	if err := decoder.Decode(&payload); err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体不是合法 JSON")
		return accountRulesPayload{}, false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "请求体不是合法 JSON")
		return accountRulesPayload{}, false
	}
	return payload, true
}

func writeServiceError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, rulesapp.ErrInvalidImport):
		writeError(response, http.StatusBadRequest, "invalid_account_rules", "Invalid atomic import")
	case errors.Is(err, rulesapp.ErrLegacySourceConfirmationRequired), errors.Is(err, rulesapp.ErrSourcePlanChanged):
		writeError(response, http.StatusConflict, "legacy_source_confirmation_required", "Canonical authority requires explicit source confirmation")
	case errors.Is(err, rulesapp.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
	case errors.Is(err, rulesapp.ErrInvalidAccountRef):
		writeError(response, http.StatusBadRequest, "invalid_account_ref", "账号引用无效")
	case errors.Is(err, rulesapp.ErrInvalidGroupIDs):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_group", err.Error())
	case errors.Is(err, rulescore.ErrInvalidRules):
		writeError(response, http.StatusBadRequest, "invalid_upstream_error_rules", err.Error())
	default:
		writeError(response, http.StatusInternalServerError, "account_rules_failed", "账号规则操作失败")
	}
}

func nonNilRules(rules []rulescore.Rule) []rulescore.Rule {
	if rules == nil {
		return []rulescore.Rule{}
	}
	return rules
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{
		"error": map[string]any{
			"message": message,
			"type":    "invalid_request_error",
			"param":   nil,
			"code":    code,
		},
	})
}
