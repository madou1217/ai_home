// Package webuiaccountconfigapi 提供账号级配置文件的只读查看。
//
// 数据来自两处：app-state.db 的 account_credentials（账号真相）与
// run/auth-projections/<provider>/<accountRef> 下的原生投影文件。候选路径全部由
// 服务端声明，用户不能传任意路径；默认脱敏，raw 模式才返回原值。
//
// 与 Node 的边界：JSON/JSONC 走结构遍历脱敏（逐键匹配）；TOML/YAML/INI 走保守
// 行级脱敏（不解析重排，但不会返回未脱敏的秘密值）；SQLite 导出 key/value 表。
package webuiaccountconfigapi

import (
	"errors"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

const (
	// Path 是账号配置查看的管理契约前缀。
	//
	//	GET /v1/management/webui/accounts/{provider}/{accountRef}/config-files?mode=redacted|raw
	Path = "/v1/management/webui/accounts"

	// maxFileBytes / maxSQLiteBytes 与 Node account-config-view 一致。
	maxFileBytes   = 1024 * 1024
	maxSQLiteBytes = 32 * 1024 * 1024

	// passwordMask 用于配置文件中被判定为秘密的字段。
	passwordMask = "<redacted>"
)

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("账号配置查看接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Dependencies 汇总只读依赖。
type Dependencies struct {
	Authorizer Authorizer
	AIHomeDir  string
	Catalog    *providers.Catalog
}

// Handler 处理账号配置查看。
type Handler struct {
	authorizer Authorizer
	aiHomeDir  string
	catalog    *providers.Catalog
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || strings.TrimSpace(dependencies.AIHomeDir) == "" {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		aiHomeDir:  strings.TrimSpace(dependencies.AIHomeDir),
		catalog:    dependencies.Catalog,
	}, nil
}

// FileView 是单个可查看文件的公开形状。
type FileView struct {
	ID             string   `json:"id"`
	Label          string   `json:"label"`
	Source         string   `json:"source"`
	Location       string   `json:"location"`
	Format         string   `json:"format"`
	UpdatedAt      int64    `json:"updatedAt"`
	Size           *int64   `json:"size,omitempty"`
	Content        string   `json:"content"`
	RedactedFields []string `json:"redactedFields"`
}

type responseView struct {
	OK               bool       `json:"ok"`
	Provider         string     `json:"provider"`
	AccountRef       string     `json:"accountRef"`
	Mode             string     `json:"mode"`
	RuntimeDirExists bool       `json:"runtimeDirExists"`
	Files            []FileView `json:"files"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// apiError 把领域失败映射成与 Node 同名的状态/错误码。
type apiError struct {
	status  int
	code    string
	message string
}

func (err *apiError) Error() string { return err.code }

// ServeHTTP 只接受 GET。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil {
		writeError(response, http.StatusServiceUnavailable, "account_config_unavailable", "账号配置查看服务不可用")
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
		writeError(response, http.StatusBadRequest, "invalid_account_config_path", "无效的账号配置路径")
		return
	}
	mode := "redacted"
	if strings.ToLower(strings.TrimSpace(request.URL.Query().Get("mode"))) == "raw" {
		mode = "raw"
	}
	result, failure := handler.readConfigFiles(request.Context(), provider, accountRef, mode)
	if failure != nil {
		writeError(response, failure.status, failure.code, failure.message)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Pragma", "no-cache")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = encodeJSON(response, payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
