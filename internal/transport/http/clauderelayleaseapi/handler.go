// Package clauderelayleaseapi 提供 Claude Native Relay 短期租约的管理入口。
package clauderelayleaseapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/clauderelay"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/claude/transportpolicy"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// Path 是管理面签发 Claude Relay 租约的唯一入口。
	Path = "/v1/management/claude-relay-leases"
	// maxRequestBodyBytes 限制只含 AccountRef 的小型命令。
	maxRequestBodyBytes int64 = 4 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少管理鉴权、凭据或租约端口。
var ErrInvalidDependencies = errors.New("Claude Relay 租约 HTTP 依赖无效")

// Authorizer 复用管理面 Bearer 鉴权语义。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// CredentialResolver 在签发前验证目标账号当前可用且属于官方 OAuth。
type CredentialResolver interface {
	ResolveCredential(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.Credential, error)
}

// LeaseIssuer 为经过管理鉴权的稳定账号签发短期租约。
type LeaseIssuer interface {
	Issue(accountRef accountcore.AccountRef) (clauderelay.Lease, error)
}

// Dependencies 集中声明租约管理入口的最小外部端口。
type Dependencies struct {
	Authorizer  Authorizer
	Credentials CredentialResolver
	Leases      LeaseIssuer
}

// Handler 负责编码管理命令，不读取或返回账号长期凭据。
type Handler struct {
	authorizer  Authorizer
	credentials CredentialResolver
	leases      LeaseIssuer
}

// NewHandler 创建依赖完整且默认失败关闭的租约 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Credentials == nil ||
		dependencies.Leases == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		credentials: dependencies.Credentials,
		leases:      dependencies.Leases,
	}, nil
}

// ServeHTTP 先校验 Management Key，再签发账号绑定租约。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		handler.credentials == nil ||
		handler.leases == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(
			response,
			http.StatusUnauthorized,
			"unauthorized",
			"需要有效的 Management Key",
		)
		return
	}
	if request.URL.Path != Path {
		writeError(
			response,
			http.StatusNotFound,
			"route_not_found",
			"Claude Relay 租约资源不存在",
		)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(
			response,
			http.StatusMethodNotAllowed,
			"method_not_allowed",
			"Claude Relay 租约只接受 POST",
		)
		return
	}
	if request.URL.RawQuery != "" {
		writeError(
			response,
			http.StatusBadRequest,
			"unexpected_query",
			"Claude Relay 租约不接受查询参数",
		)
		return
	}
	var input createLeaseRequest
	if err := httpjson.DecodeRequest(
		response,
		request,
		&input,
		maxRequestBodyBytes,
	); err != nil {
		writeDecodeError(response, err)
		return
	}
	accountRef, err := accountcore.ParseAccountRef(input.AccountRef)
	if err != nil {
		writeError(
			response,
			http.StatusUnprocessableEntity,
			"invalid_account_ref",
			"账号引用格式无效",
		)
		return
	}
	credential, err := handler.credentials.ResolveCredential(
		request.Context(),
		accountRef,
	)
	if err != nil {
		writeError(
			response,
			http.StatusUnprocessableEntity,
			"relay_account_unavailable",
			"Claude Relay 账号当前不可用",
		)
		return
	}
	if !transportpolicy.RequiresNativeOAuth(credential) {
		writeError(
			response,
			http.StatusUnprocessableEntity,
			"unsupported_relay_credential",
			"Claude Relay 账号必须使用官方 OAuth",
		)
		return
	}
	lease, err := handler.leases.Issue(accountRef)
	if err != nil || !lease.IsValid() {
		writeError(
			response,
			http.StatusServiceUnavailable,
			"relay_lease_unavailable",
			"Claude Relay 租约暂时无法签发",
		)
		return
	}
	writeJSON(response, http.StatusCreated, createLeaseResponse{
		Data: leaseView{
			Token:      lease.Token(),
			AccountRef: lease.AccountRef().String(),
			ExpiresAt:  lease.ExpiresAt().Format(time.RFC3339Nano),
		},
	})
}

// createLeaseRequest 是签发命令的严格 JSON 输入。
type createLeaseRequest struct {
	AccountRef string `json:"account_ref"`
}

// createLeaseResponse 包装一次性短期 Token。
type createLeaseResponse struct {
	Data leaseView `json:"data"`
}

// leaseView 是不包含账号长期凭据的租约投影。
type leaseView struct {
	Token      string `json:"token"`
	AccountRef string `json:"account_ref"`
	ExpiresAt  string `json:"expires_at"`
}

// errorResponse 是租约管理入口的稳定失败结构。
type errorResponse struct {
	Error errorView `json:"error"`
}

// errorView 只暴露固定错误码和安全消息。
type errorView struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// writeDecodeError 精确区分媒体类型、上限和 JSON 合同错误。
func writeDecodeError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, httpjson.ErrUnsupportedMediaType):
		writeError(
			response,
			http.StatusUnsupportedMediaType,
			"unsupported_media_type",
			"请求必须使用 application/json",
		)
	case errors.Is(err, httpjson.ErrBodyTooLarge):
		writeError(
			response,
			http.StatusRequestEntityTooLarge,
			"request_too_large",
			"Claude Relay 租约请求体超过上限",
		)
	default:
		writeError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"Claude Relay 租约请求无效",
		)
	}
}

// writeError 写入不含内部错误文本的失败响应。
func writeError(
	response http.ResponseWriter,
	status int,
	code string,
	message string,
) {
	writeJSON(response, status, errorResponse{
		Error: errorView{
			Code:    code,
			Message: message,
		},
	})
}

// writeJSON 写入禁止缓存且不被浏览器猜测类型的 JSON。
func writeJSON(
	response http.ResponseWriter,
	status int,
	payload any,
) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
