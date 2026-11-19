// Package webuiaccount429retryapi exposes GET/POST management endpoints for
// per-account upstream HTTP 429 retry override settings.
package webuiaccount429retryapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	corepolicy "github.com/madou1217/ai_home/core/upstreamretry"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	runtimeupstreamretry "github.com/madou1217/ai_home/internal/runtime/upstreamretry"
)

const (
	// Path is the management prefix for account-scoped upstream 429 retry endpoints.
	Path = "/v1/management/webui/accounts"
	// PublicAccountPrefix is the browser-facing WebUI alias prefix.
	PublicAccountPrefix = "/v0/webui/accounts"
	// RouteSuffix is the account resource suffix.
	RouteSuffix = "/upstream-429-retry"
)

// ErrInvalidDependencies indicates missing required ports during handler wiring.
var ErrInvalidDependencies = errors.New("账号 429 重试设置接口依赖无效")

// Authorizer validates management bearer auth.
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store persists and hot-reloads account upstream 429 retry overrides.
type Store interface {
	GetAccountPolicy(ctx context.Context, accountRef string) (runtimeupstreamretry.AccountPolicyView, error)
	SaveAccountOverride(ctx context.Context, accountRef string, override corepolicy.AccountOverride) (runtimeupstreamretry.AccountPolicyView, error)
}

// Dependencies collects handler ports.
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Store      Store
}

// Handler serves GET/POST /v1/management/webui/accounts/{provider}/{accountRef}/upstream-429-retry.
type Handler struct {
	authorizer   Authorizer
	databasePath string
	store        Store
}

// NewHandler constructs a fail-closed per-account 429 retry settings handler.
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	databasePath, err := appstate.DatabasePath(dependencies.AIHomeDir)
	if err != nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:   dependencies.Authorizer,
		databasePath: databasePath,
		store:        dependencies.Store,
	}, nil
}

// NewPublicAlias adapts /v0/webui/accounts/{provider}/{accountRef}/upstream-429-retry
// to the canonical management handler.
func NewPublicAlias(target http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		cloned := request.Clone(request.Context())
		cloned.URL.Path = strings.Replace(request.URL.Path, PublicAccountPrefix, Path, 1)
		cloned.URL.RawPath = ""
		target.ServeHTTP(response, cloned)
	})
}

type policyResponse struct {
	OK         bool                       `json:"ok"`
	AccountRef string                     `json:"accountRef"`
	Override   corepolicy.AccountOverride `json:"override"`
	Global     corepolicy.GlobalPolicy    `json:"global"`
	Effective  corepolicy.EffectivePolicy `json:"effective"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP handles GET (fresh read with effective preview) and POST (strictly validated save).
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "upstream_429_retry_unavailable", "账号 429 重试设置服务不可用")
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
	storedProvider, found, err := appstate.LookupAccountProvider(request.Context(), handler.databasePath, accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "lookup_account_failed", "")
		return
	}
	if !found || !strings.EqualFold(strings.TrimSpace(storedProvider), provider) {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}

	if request.Method == http.MethodGet {
		view, getErr := handler.store.GetAccountPolicy(request.Context(), accountRef)
		if getErr != nil {
			writeError(response, http.StatusInternalServerError, "get_upstream_429_retry_failed", "")
			return
		}
		writeJSON(response, http.StatusOK, policyResponse{
			OK:         true,
			AccountRef: accountRef,
			Override:   view.Override,
			Global:     view.Global,
			Effective:  view.Effective,
		})
		return
	}

	var payload map[string]any
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, 64*1024))
	if err := decoder.Decode(&payload); err != nil || payload == nil {
		writeError(response, http.StatusBadRequest, corepolicy.ErrCodeInvalidConfig, "请求体必须是合法 JSON 对象")
		return
	}
	override, err := corepolicy.ValidateAccountOverrideRaw(payload)
	if err != nil {
		code := corepolicy.ErrCodeInvalidConfig
		msg := err.Error()
		var validationErr *corepolicy.ValidationError
		if errors.As(err, &validationErr) {
			code = validationErr.Code
			msg = validationErr.Message
		}
		writeError(response, http.StatusBadRequest, code, msg)
		return
	}
	view, err := handler.store.SaveAccountOverride(request.Context(), accountRef, override)
	if err != nil {
		var validationErr *corepolicy.ValidationError
		if errors.As(err, &validationErr) {
			writeError(response, http.StatusBadRequest, validationErr.Code, validationErr.Message)
			return
		}
		writeError(response, http.StatusInternalServerError, "save_upstream_429_retry_failed", "")
		return
	}
	writeJSON(response, http.StatusOK, policyResponse{
		OK:         true,
		AccountRef: accountRef,
		Override:   view.Override,
		Global:     view.Global,
		Effective:  view.Effective,
	})
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{
		OK:      false,
		Error:   code,
		Message: message,
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
