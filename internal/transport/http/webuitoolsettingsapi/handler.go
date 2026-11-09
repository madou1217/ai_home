// Package webuitoolsettingsapi 提供 WebUI「应用启动权限设置」的只读模型。
//
// 边界（重要）：
//   - GET /v1/management/webui/tool-apps/{appId}/settings 是唯一读入口，由本包直接读
//     Node app-state.db 的设置记录并组装 capability；
//   - PUT /v0/webui/toolkit/apps/{appId}/settings 仍在 Node：写入要经过 Provider 配置
//     工作台的校验 / 冲突检测 / 历史备份，这部分依赖尚未迁到 Go。
//
// 因此不存在「Node 自己再算一份 GET」的双路径：Node 的 GET 只代理这里，Go 不可用就是 503。
package webuitoolsettingsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
)

// Path 是应用启动权限设置的 WebUI 管理契约前缀。
//
//	GET /v1/management/webui/tool-apps/{appId}/settings
const Path = "/v1/management/webui/tool-apps"

// ErrInvalidDependencies 表示 handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("工具启动权限设置接口依赖无效")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ProviderCatalog 是 Provider 身份与合同的最小只读视图。
//
// 这里只依赖查询能力而不是具体实现：provider 是否存在、标签、权限边界都来自
// core/providers 的合同，本包不维护 provider 名单。
type ProviderCatalog interface {
	Get(id string) (providers.Definition, bool)
	List() []providers.Definition
}

// SettingsReader 读取单个 Provider 的启动权限设置（生产实现见 SettingsSource）。
type SettingsReader interface {
	Read(ctx context.Context, provider string) ToolPermissionSettings
}

// Dependencies 汇总接口依赖。
type Dependencies struct {
	Authorizer Authorizer
	Providers  ProviderCatalog
	Settings   SettingsReader
	// HostHomeDir 是宿主 CLI 配置文件所在的家目录（探测 host* 字段用）。
	HostHomeDir string
	// LookupEnv 允许测试注入 XDG_CONFIG_HOME / APPDATA；生产留空用 os.LookupEnv。
	LookupEnv func(string) string
}

type Handler struct {
	authorizer  Authorizer
	providers   ProviderCatalog
	settings    SettingsReader
	hostHomeDir string
	lookupEnv   func(string) string
}

// NewHandler 校验依赖并返回 handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Providers == nil || dependencies.Settings == nil {
		return nil, ErrInvalidDependencies
	}
	lookupEnv := dependencies.LookupEnv
	if lookupEnv == nil {
		// 只暴露单返回值的读取：调用方只关心「有没有值」，不区分未设置与空串。
		lookupEnv = func(key string) string {
			value, _ := os.LookupEnv(key)
			return value
		}
	}
	return &Handler{
		authorizer:  dependencies.Authorizer,
		providers:   dependencies.Providers,
		settings:    dependencies.Settings,
		hostHomeDir: strings.TrimSpace(dependencies.HostHomeDir),
		lookupEnv:   lookupEnv,
	}, nil
}

type settingsResponse struct {
	OK         bool                   `json:"ok"`
	AppID      string                 `json:"appId"`
	Provider   string                 `json:"provider"`
	Label      string                 `json:"label"`
	Settings   ToolPermissionSettings `json:"settings"`
	Capability capabilityView         `json:"capability"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// ServeHTTP 只接受 GET；PUT 由 Node 路由处理（见包注释）。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.providers == nil || handler.settings == nil {
		writeError(response, http.StatusServiceUnavailable,
			"tool_permission_settings_unavailable", "启动权限设置服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodGet {
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 GET")
		return
	}
	provider := normalizeProviderID(request.PathValue("appId"))
	if provider == "" {
		writeError(response, http.StatusBadRequest, "unsupported_app", "未登记该应用")
		return
	}
	definition, known := handler.providers.Get(provider)
	if !known {
		writeError(response, http.StatusBadRequest, "unsupported_app", "未登记该应用")
		return
	}
	writeJSON(response, http.StatusOK, settingsResponse{
		OK:         true,
		AppID:      definition.ID,
		Provider:   definition.ID,
		Label:      providerMenuLabel(handler.providers, definition.ID),
		Settings:   handler.settings.Read(request.Context(), definition.ID),
		Capability: describeCapability(definition, handler.providers, handler.hostHomeDir, handler.lookupEnv),
	})
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("Cache-Control", "no-store")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorResponse{OK: false, Error: code, Message: message})
}
