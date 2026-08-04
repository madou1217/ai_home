// Package clauderelayleaseapi 提供 Claude Gateway 请求级账号与传输选择入口。
package clauderelayleaseapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	"github.com/madou1217/ai_home/application/claudegateway"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
	"github.com/madou1217/ai_home/internal/transport/http/httpjson"
)

const (
	// Path 是已认证 Claude CLI 代理获取请求级传输决策的唯一入口。
	Path = gatewaycontract.SelectionPath
	// maxRequestBodyBytes 限制只含模型和 AccountRef 的小型命令。
	maxRequestBodyBytes int64 = 4 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少客户端鉴权或传输选择端口。
var ErrInvalidDependencies = errors.New("Claude Gateway 选择 HTTP 依赖无效")

// Authorizer 复用推理客户端的 Bearer 和 x-api-key 鉴权语义。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Selector 按真实模型复用统一 Recruiter 选择账号和传输方式。
type Selector interface {
	Select(
		ctx context.Context,
		request claudegateway.Request,
	) (claudegateway.Decision, error)
}

// Dependencies 集中声明传输选择入口的最小外部端口。
type Dependencies struct {
	Authorizer Authorizer
	Selector   Selector
}

// Handler 负责编码选择命令，不读取或返回账号长期凭据。
type Handler struct {
	authorizer Authorizer
	selector   Selector
}

// NewHandler 创建依赖完整且默认失败关闭的选择 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Selector == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		selector:   dependencies.Selector,
	}, nil
}

// ServeHTTP 先校验 Server Client Key，再按正文模型生成账号绑定决策。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		handler.selector == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(
			response,
			http.StatusUnauthorized,
			"unauthorized",
			"需要有效的 Server Client Key",
		)
		return
	}
	if request.URL.Path != Path {
		writeError(
			response,
			http.StatusNotFound,
			"route_not_found",
			"Claude Gateway 选择资源不存在",
		)
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(
			response,
			http.StatusMethodNotAllowed,
			"method_not_allowed",
			"Claude Gateway 选择只接受 POST",
		)
		return
	}
	if request.URL.ForceQuery || request.URL.RawQuery != "" {
		writeError(
			response,
			http.StatusBadRequest,
			"unexpected_query",
			"Claude Gateway 选择不接受查询参数",
		)
		return
	}
	var input gatewaycontract.SelectionRequest
	if err := httpjson.DecodeRequest(
		response,
		request,
		&input,
		maxRequestBodyBytes,
	); err != nil {
		writeDecodeError(response, err)
		return
	}
	var accountRef accountcore.AccountRef
	if input.AccountRef != "" {
		var err error
		accountRef, err = accountcore.ParseAccountRef(input.AccountRef)
		if err != nil {
			writeError(
				response,
				http.StatusUnprocessableEntity,
				"invalid_account_ref",
				"账号引用格式无效",
			)
			return
		}
	}
	if len(input.ExcludedAccountRefs) > accountrouting.MaxExcludedAccounts {
		writeError(
			response,
			http.StatusUnprocessableEntity,
			"too_many_excluded_accounts",
			"排除账号数量超过单次换号上限",
		)
		return
	}
	excludedAccounts := make(
		[]accountcore.AccountRef,
		0,
		len(input.ExcludedAccountRefs),
	)
	for _, value := range input.ExcludedAccountRefs {
		excluded, parseErr := accountcore.ParseAccountRef(value)
		if parseErr != nil {
			writeError(
				response,
				http.StatusUnprocessableEntity,
				"invalid_excluded_account_ref",
				"排除账号引用格式无效",
			)
			return
		}
		excludedAccounts = append(excludedAccounts, excluded)
	}
	decision, err := handler.selector.Select(
		request.Context(),
		claudegateway.Request{
			ModelID:          input.Model,
			AccountRef:       accountRef,
			ExcludedAccounts: excludedAccounts,
		},
	)
	if err != nil || !decision.IsValid() {
		status := http.StatusServiceUnavailable
		code := "relay_selection_unavailable"
		message := "Claude Gateway 当前没有可用账号"
		if errors.Is(err, claudegateway.ErrInvalidRequest) ||
			errors.Is(err, accountrouting.ErrInvalidRequest) {
			status = http.StatusUnprocessableEntity
			code = "invalid_selection_request"
			message = "Claude 模型或账号排除集合无效"
		}
		writeError(
			response,
			status,
			code,
			message,
		)
		return
	}
	view := gatewaycontract.SelectionView{
		Transport:  string(decision.Transport()),
		AccountRef: decision.AccountRef().String(),
	}
	if lease, leased := decision.Lease(); leased {
		view.Token = lease.Token()
		view.ExpiresAt = lease.ExpiresAt().Format(time.RFC3339Nano)
	}
	writeJSON(response, http.StatusCreated, gatewaycontract.SelectionResponse{
		Data: view,
	})
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
			"Claude Gateway 选择请求体超过上限",
		)
	default:
		writeError(
			response,
			http.StatusBadRequest,
			"invalid_request",
			"Claude Gateway 选择请求无效",
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
	writeJSON(response, status, gatewaycontract.ErrorResponse{
		Error: gatewaycontract.ErrorView{
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
