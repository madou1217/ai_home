// Package webuiaccountmcppolicyapi exposes the per-account MCP policy.
package webuiaccountmcppolicyapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/application/mcpscope"
)

const (
	// Path is the management prefix for account resources.
	Path = "/v1/management/webui/accounts"
	// RouteSuffix is the MCP policy suffix.
	RouteSuffix = "/mcp-policy"
)

// ErrInvalidDependencies indicates missing ports during wiring.
var ErrInvalidDependencies = errors.New("账号 MCP 设置接口依赖无效")

// Authorizer validates management bearer auth.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store persists account policies and resolves ownership.
type Store interface {
	Get(ctx context.Context, accountRef string) (mcpscope.Policy, error)
	Save(ctx context.Context, accountRef string, policy mcpscope.Policy) error
	LookupProvider(ctx context.Context, accountRef string) (string, bool, error)
}

// Dependencies collects handler ports.
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler serves GET/POST /v1/management/webui/accounts/{provider}/{accountRef}/mcp-policy.
type Handler struct {
	authorizer Authorizer
	store      Store
}

// NewHandler constructs a fail-closed handler.
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, store: dependencies.Store}, nil
}

type resolvedEntry struct {
	ID           string   `json:"id"`
	DisplayName  string   `json:"displayName"`
	Capabilities []string `json:"capabilities,omitempty"`
	Source       string   `json:"source"`
	Reason       string   `json:"reason"`
}

type policyResponse struct {
	OK         bool            `json:"ok"`
	AccountRef string          `json:"accountRef"`
	Policy     mcpscope.Policy `json:"policy"`
	Resolved   []resolvedEntry `json:"resolved"`
}

type requestBody struct {
	Mode  mcpscope.Mode `json:"mode"`
	Allow []string      `json:"allow"`
}

func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "mcp_policy_unavailable", "")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET/POST")
		return
	}
	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	accountRef := strings.TrimSpace(request.PathValue("accountRef"))
	if provider == "" || accountRef == "" {
		writeError(response, http.StatusBadRequest, "invalid_account_ref", "缺少 provider 或 accountRef")
		return
	}
	storedProvider, found, err := handler.store.LookupProvider(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "lookup_account_failed", "")
		return
	}
	if !found || !strings.EqualFold(strings.TrimSpace(storedProvider), provider) {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}

	policy, err := handler.store.Get(request.Context(), accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "get_mcp_policy_failed", "")
		return
	}
	if request.Method == http.MethodPost {
		var body requestBody
		if err := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024)).Decode(&body); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_body", "")
			return
		}
		policy = mcpscope.Policy{Mode: body.Mode, Allow: body.Allow}
		if err := handler.store.Save(request.Context(), accountRef, policy); err != nil {
			writeError(response, http.StatusBadRequest, "invalid_mcp_policy", err.Error())
			return
		}
	}
	if policy.Mode == "" {
		policy.Mode = mcpscope.ModeAuto
	}
	resolved, err := mcpscope.Resolve(mcpscope.Builtins(), policy, mcpscope.Context{Provider: provider})
	if err != nil {
		writeError(response, http.StatusBadRequest, "invalid_mcp_policy", err.Error())
		return
	}
	entries := make([]resolvedEntry, 0, len(resolved))
	for _, item := range resolved {
		entries = append(entries, resolvedEntry{
			ID: item.ID, DisplayName: item.DisplayName,
			Capabilities: item.Capabilities, Source: item.Source, Reason: item.Reason,
		})
	}
	writeJSON(response, http.StatusOK, policyResponse{OK: true, AccountRef: accountRef, Policy: policy, Resolved: entries})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code, message string) {
	writeJSON(response, status, map[string]any{"ok": false, "error": code, "message": message})
}
