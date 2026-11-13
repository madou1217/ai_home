// Package webuiaccountupdateapi 提供账号配置编辑的 WebUI 写入口。
//
//	POST /v1/management/webui/accounts/{provider}/{accountRef}/update
//
// 本包只做路径/正文翻译与错误映射：真正的编辑语义（空 apiKey 沿用当前密钥、
// 未携带 baseUrl 沿用当前地址、显式 baseUrl 覆盖或清空、CAS 与持久化）由
// accountsapi.StaticCredentialRotation 的 Edit 用例承担，避免 WebUI 与 CLI
// 各写一套凭据规则。
//
// 装配（路由注册、Node 代理切换、运行池刷新）不在本包内：本切片只提供可挂载的
// http.Handler，未接线前不会改变现有入口。
package webuiaccountupdateapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/transport/http/accountsapi"
)

const (
	// Path 是账号管理 WebUI 契约前缀。
	Path = "/v1/management/webui/accounts"
	// UpdatePath 是账号配置编辑的路由模式。
	UpdatePath = Path + "/{provider}/{accountRef}/update"
	// maxBodyBytes 与 Node 的 readRequestBody({maxBytes: 64 * 1024}) 一致。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少鉴权、账号目录或编辑用例。
var ErrInvalidDependencies = errors.New("账号配置编辑接口依赖无效")

var (
	errInvalidRequestBody  = errors.New("请求体不是合法的 JSON 对象")
	errRequestBodyTooLarge = errors.New("请求体超过允许大小")
)

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// CredentialEditor 是账号配置编辑依赖的最小用例端口。
//
// 该接口由 accountsapi.StaticCredentialRotation 满足：WebUI 入口与账号管理
// API 共用同一个 Edit 用例，空字段沿用当前值的语义只实现一次。
type CredentialEditor interface {
	Edit(
		ctx context.Context,
		accountRef accountcore.AccountRef,
		edit accountapp.StaticCredentialEdit,
	) (accountcore.Account, error)
}

// 编译期确认共享用例端口仍然满足本包的最小依赖。
var _ CredentialEditor = (accountsapi.StaticCredentialRotation)(nil)

// AccountDirectory 提供账号归属校验，避免路径里的 provider 与真实账号不一致时
// 仍然改到另一个 Provider 的凭据。
type AccountDirectory interface {
	GetAccountOverview(
		ctx context.Context,
		accountRef accountcore.AccountRef,
	) (accountapp.AccountOverview, error)
}

// Dependencies 汇总账号配置编辑的依赖。
type Dependencies struct {
	Authorizer Authorizer
	Accounts   AccountDirectory
	Editor     CredentialEditor
}

// Handler 是账号配置编辑的 HTTP 入站适配器。
type Handler struct {
	authorizer Authorizer
	accounts   AccountDirectory
	editor     CredentialEditor
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil ||
		dependencies.Accounts == nil ||
		dependencies.Editor == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		accounts:   dependencies.Accounts,
		editor:     dependencies.Editor,
	}, nil
}

// updateRequest 是 WebUI 形态的编辑 DTO。
//
// apiKey 为空表示沿用当前密钥；baseUrl 只用「是否出现」决定覆盖，出现空串或
// null 表示清空地址。未出现的字段完全不动。
type updateRequest struct {
	APIKey         string         `json:"apiKey"`
	BaseURL        optionalString `json:"baseUrl"`
	AuthKind       string         `json:"authKind"`
	CredentialType string         `json:"credentialType"`
	AuthType       string         `json:"authType"`
	AuthMode       string         `json:"authMode"`
}

// optionalString 区分「字段缺失」与「字段显式为空」。
type optionalString struct {
	Set   bool
	Value string
}

// UnmarshalJSON 把 null 也视为显式清空，与 Node 的 hasOwnProperty 语义一致。
func (value *optionalString) UnmarshalJSON(data []byte) error {
	value.Set = true
	if string(data) == "null" {
		value.Value = ""
		return nil
	}
	var text string
	if err := json.Unmarshal(data, &text); err != nil {
		return err
	}
	value.Value = text
	return nil
}

type successResponse struct {
	OK         bool   `json:"ok"`
	Provider   string `json:"provider"`
	AccountRef string `json:"accountRef"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 只接受 POST，并把编辑意图交给共享静态凭据编辑用例。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil ||
		handler.authorizer == nil ||
		handler.accounts == nil ||
		handler.editor == nil {
		writeError(response, http.StatusServiceUnavailable,
			"account_update_unavailable", "账号配置编辑服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 POST")
		return
	}
	writeNoStoreHeaders(response)

	provider := strings.ToLower(strings.TrimSpace(request.PathValue("provider")))
	rawRef := strings.TrimSpace(request.PathValue("accountRef"))
	accountRef, err := accountcore.ParseAccountRef(rawRef)
	if !validProviderToken(provider) || err != nil {
		writeError(response, http.StatusBadRequest, "invalid_account_path", "无效的账号路径")
		return
	}

	input, err := decodeUpdateRequest(response, request)
	if err != nil {
		if errors.Is(err, errRequestBodyTooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge,
				"request_too_large", "请求体超过允许大小")
			return
		}
		writeError(response, http.StatusBadRequest, "invalid_request", "JSON 请求体无效")
		return
	}

	current, err := handler.accounts.GetAccountOverview(request.Context(), accountRef)
	if err != nil {
		writeApplicationError(response, err)
		return
	}
	if current.Account().ProviderID() != provider {
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
		return
	}

	authKind := firstNonEmptyString(input.AuthKind, input.CredentialType, input.AuthType, input.AuthMode)
	if _, err := handler.editor.Edit(
		request.Context(),
		accountRef,
		accountapp.StaticCredentialEdit{
			APIKey:         input.APIKey,
			BaseURL:        input.BaseURL.Value,
			IncludeBaseURL: input.BaseURL.Set,
			AuthKind:       authKind,
		},
	); err != nil {
		writeApplicationError(response, err)
		return
	}

	writeJSON(response, http.StatusOK, successResponse{
		OK:         true,
		Provider:   provider,
		AccountRef: accountRef.String(),
	})
}

// decodeUpdateRequest 限制正文大小并允许空正文等价于「不修改任何字段」。
func decodeUpdateRequest(
	response http.ResponseWriter,
	request *http.Request,
) (updateRequest, error) {
	body := http.MaxBytesReader(response, request.Body, maxBodyBytes)
	decoder := json.NewDecoder(body)
	var input updateRequest
	if err := decoder.Decode(&input); err != nil {
		if errors.Is(err, io.EOF) {
			return updateRequest{}, nil
		}
		var maxBytesError *http.MaxBytesError
		if errors.As(err, &maxBytesError) {
			return updateRequest{}, errRequestBodyTooLarge
		}
		return updateRequest{}, errInvalidRequestBody
	}
	// 只允许一个完整 JSON 值，避免「合法前缀 + 垃圾」被静默接受。
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return updateRequest{}, errInvalidRequestBody
	}
	return input, nil
}

// writeApplicationError 把用例错误收敛成 WebUI 稳定错误码，不泄漏内部细节。
func writeApplicationError(response http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, accountapp.ErrAccountNotFound):
		writeError(response, http.StatusNotFound, "account_not_found", "账号不存在")
	case errors.Is(err, accountapp.ErrStaticCredentialEditIncomplete):
		writeError(response, http.StatusBadRequest,
			"invalid_static_credential_edit", "编辑静态凭据需要完整密钥")
	case errors.Is(err, accountapp.ErrStaticBaseURLUnsupported):
		writeError(response, http.StatusBadRequest,
			"base_url_unsupported", "Gemini API Key 模式不支持自定义 Base URL")
	case errors.Is(err, accountcore.ErrInvalidStaticBaseURL):
		writeError(response, http.StatusBadRequest,
			"invalid_base_url", "Base URL 格式无效")
	case errors.Is(err, accountcore.ErrInvalidStaticAPIKey):
		writeError(response, http.StatusBadRequest,
			"invalid_api_key", "API Key 格式无效")
	case errors.Is(err, accountapp.ErrStaticCredentialRotationUnsupported):
		writeError(response, http.StatusUnprocessableEntity,
			"static_credential_rotation_unsupported", "当前凭据类型不支持该接口编辑")
	case errors.Is(err, accountapp.ErrStaticCredentialRotationConflict):
		writeError(response, http.StatusConflict,
			"static_credential_rotation_conflict", "账号已变化或当前凭据已被其他账号使用")
	case errors.Is(err, accountapp.ErrInvalidStaticCredentialRotation),
		errors.Is(err, accountapp.ErrInvalidOverview),
		errors.Is(err, accountcore.ErrInvalidAccount):
		writeError(response, http.StatusUnprocessableEntity, "invalid_account", "账号数据无效")
	default:
		writeError(response, http.StatusInternalServerError, "internal_error", "账号配置编辑失败")
	}
}

// validProviderToken 只校验结构，不维护 provider 名单：上游新增 provider 时零改动通过。
func validProviderToken(value string) bool {
	if value == "" || len(value) > 64 {
		return false
	}
	for index, character := range value {
		isLower := character >= 'a' && character <= 'z'
		isDigit := character >= '0' && character <= '9'
		if isLower || isDigit {
			continue
		}
		if index == 0 {
			return false
		}
		if character != '-' && character != '_' && character != '.' {
			return false
		}
	}
	return true
}

func writeNoStoreHeaders(response http.ResponseWriter) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}
