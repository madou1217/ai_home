// Package webuitoolappsettingswriteapi 提供 WebUI「应用启动权限设置」的写入接口。
//
// 路由（管理面，只接受 PUT）：
//
//	PUT /v1/management/webui/tool-apps/{appId}/settings
//
// 与只读模型 webuitoolsettingsapi 共用同一份事实：app-state.db 的 app_kv 里
// toolkit:tool-permission-settings 这条记录（CLI 启动时读的也是它）。写路径必须是
// BEGIN IMMEDIATE 事务里的读改写（appstate.UpdateKV）：先读再单独写会把 Node 或另一
// 个并发请求刚写进去的字段覆盖回旧值。
//
// 合并语义（与 Node 的 saveToolPermissionSettings 一致，但更宽容）：
//   - 请求里出现的字段才改，没出现的保持原值；permissionArgs 显式给 null 视为没带。
//   - 每次写入都会刷新 updatedAt（与 Node 的 updatedAt: Date.now() 同义）。
//   - 交叉约束按**合并后**的取值判定：applyToHost=true 要求 maxPermission=true；
//     permissionArgs 非空同样要求 maxPermission=true。
//
// 白名单：appId 只接受 Provider 合同里登记过的 ID（Node 侧对应 isKnownProvider /
// managedAppId，Go 的合同就是 core/providers 的 Definition，没有第二份应用名单）。
// 未登记的 appId 返回 404，避免把设置写到一个永远不会被读的键上。
//
// 本包只返回写入结果（ok / appId / provider / settings）。label 与 capability 属于
// 读模型（同路径 GET）的事实，由代理层在写成功后复用读模型组装，不在本包重复推导：
// 权限目录只存在于 webuitoolsettingsapi 内，复制一份就是第二份真值。
//
// permissionArgs 的结构（字符串数组）在这里校验，旗标是否登记 / 取值是否合法仍由
// Node 代理层按同一份权限目录判定——那部分数据同样只存在于读模型包里。
package webuitoolappsettingswriteapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/transport/http/webuitoolsettingsapi"
)

const (
	// Path 是应用启动权限设置的 WebUI 管理契约前缀（与只读模型同一前缀）。
	Path = "/v1/management/webui/tool-apps"
	// SettingsSuffix 是单个应用的设置后缀。
	SettingsSuffix = "/{appId}/settings"
	// SettingsPath 是完整的写入契约路径。
	SettingsPath = Path + SettingsSuffix

	// maxBodyBytes 与 Node 的 parseJsonBody 默认上限一致。
	maxBodyBytes = 64 * 1024
)

// ErrInvalidDependencies 表示 Handler 缺少必需依赖。
var ErrInvalidDependencies = errors.New("工具启动权限设置写入接口依赖无效")

// ErrStoreUnavailable 表示数据源没有可用的数据库路径。
var ErrStoreUnavailable = errors.New("工具启动权限设置数据源不可用")

// Authorizer 校验管理密钥（与其它 /v1/management 接口同一权限域）。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ProviderCatalog 是 Provider 合同的最小只读视图。
//
// 只依赖按 ID 查询：appId 白名单就是合同本身，本包不维护第二份应用名单。
type ProviderCatalog interface {
	Get(id string) (providers.Definition, bool)
}

// SettingsStore 在立即事务里合并写入单个 Provider 的设置并返回写入后的记录。
//
// mutate 在事务内被调用，收到的是磁盘上的当前记录（没有记录时是默认值）；
// 返回错误即整笔回滚，因此交叉字段校验可以直接放在 mutate 里而不引入竞态。
type SettingsStore interface {
	Update(
		ctx context.Context,
		provider string,
		mutate func(current webuitoolsettingsapi.ToolPermissionSettings) (webuitoolsettingsapi.ToolPermissionSettings, error),
	) (webuitoolsettingsapi.ToolPermissionSettings, error)
}

// Dependencies 汇总写入依赖。
//
// Store 与 AIHomeDir 二选一：显式 Store 优先，否则按 AIHomeDir 推导 app-state.db。
type Dependencies struct {
	Authorizer Authorizer
	Providers  ProviderCatalog
	AIHomeDir  string
	Store      SettingsStore
}

// Handler 处理单个应用的启动权限设置写入。
type Handler struct {
	authorizer Authorizer
	providers  ProviderCatalog
	store      SettingsStore
}

// NewHandler 校验依赖并创建 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Providers == nil {
		return nil, ErrInvalidDependencies
	}
	store := dependencies.Store
	if store == nil {
		if strings.TrimSpace(dependencies.AIHomeDir) == "" {
			return nil, ErrInvalidDependencies
		}
		databasePath, err := appstate.DatabasePath(dependencies.AIHomeDir)
		if err != nil {
			return nil, ErrInvalidDependencies
		}
		store = DatabaseStore{DatabasePath: databasePath}
	}
	return &Handler{
		authorizer: dependencies.Authorizer,
		providers:  dependencies.Providers,
		store:      store,
	}, nil
}

// patch 是本次请求里真正出现的字段；nil 表示没带该字段，保持原值。
type patch struct {
	maxPermission  *bool
	applyToHost    *bool
	permissionArgs *[]string
}

// settingsResponse 是写入成功的响应。
//
// 字段与 Node 写路径的响应同名同义，但不含 label / capability / hostApply：
// 前两者由读模型提供，hostApply 是宿主配置写入的结果，仍在代理层组装。
type settingsResponse struct {
	OK       bool                                        `json:"ok"`
	AppID    string                                      `json:"appId"`
	Provider string                                      `json:"provider"`
	Settings webuitoolsettingsapi.ToolPermissionSettings `json:"settings"`
}

type errorResponse struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message"`
}

// validationError 是请求语义不合法（400）；它在事务回调里产生，用于回滚整笔写入。
type validationError struct {
	code    string
	message string
}

func (err validationError) Error() string { return err.message }

// ServeHTTP 只接受 PUT。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.providers == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable,
			"tool_permission_settings_unavailable", "启动权限设置服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPut {
		response.Header().Set("Allow", http.MethodPut)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 PUT")
		return
	}
	definition, known := handler.providers.Get(request.PathValue("appId"))
	if !known {
		writeError(response, http.StatusNotFound, "unsupported_app", "未登记该应用")
		return
	}
	object, ok := decodeObject(response, request)
	if !ok {
		return
	}
	changes, err := parsePatch(object)
	if err != nil {
		var invalid validationError
		_ = errors.As(err, &invalid)
		writeError(response, http.StatusBadRequest, invalid.code, invalid.message)
		return
	}
	saved, err := handler.store.Update(request.Context(), definition.ID, func(current webuitoolsettingsapi.ToolPermissionSettings) (webuitoolsettingsapi.ToolPermissionSettings, error) {
		return mergeSettings(current, changes)
	})
	if err != nil {
		var invalid validationError
		if errors.As(err, &invalid) {
			writeError(response, http.StatusBadRequest, invalid.code, invalid.message)
			return
		}
		writeError(response, http.StatusInternalServerError,
			"tool_permission_settings_write_failed", "启动权限设置保存失败")
		return
	}
	writeJSON(response, http.StatusOK, settingsResponse{
		OK:       true,
		AppID:    definition.ID,
		Provider: definition.ID,
		Settings: saved,
	})
}

// decodeObject 读取请求体为 JSON 对象；空体按空对象处理（等价于「什么都没改」）。
func decodeObject(response http.ResponseWriter, request *http.Request) (map[string]any, bool) {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		if errors.Is(err, io.EOF) {
			payload = map[string]any{}
		} else {
			writeError(response, http.StatusBadRequest, "invalid_json", "请求体不是合法 JSON")
			return nil, false
		}
	}
	object, ok := payload.(map[string]any)
	if !ok || object == nil {
		writeError(response, http.StatusBadRequest, "invalid_json", "请求体必须是 JSON 对象")
		return nil, false
	}
	return object, true
}

// parsePatch 校验字段类型并取出本次出现的字段。
//
// 与 Node 的差别：Node 强制要求 maxPermission 与 applyToHost 两个布尔字段都在，
// 这里允许只带其中一部分（部分合并），但一个可写字段都没有时仍然 400，
// 避免一次空写入白白刷新 updatedAt。
func parsePatch(object map[string]any) (patch, error) {
	var changes patch
	if value, present := object["maxPermission"]; present {
		flag, isBool := value.(bool)
		if !isBool {
			return patch{}, validationError{code: "invalid_permission_payload", message: "maxPermission 必须是布尔值"}
		}
		changes.maxPermission = &flag
	}
	if value, present := object["applyToHost"]; present {
		flag, isBool := value.(bool)
		if !isBool {
			return patch{}, validationError{code: "invalid_permission_payload", message: "applyToHost 必须是布尔值"}
		}
		changes.applyToHost = &flag
	}
	if value, present := object["permissionArgs"]; present && value != nil {
		list, isList := value.([]any)
		if !isList {
			return patch{}, validationError{code: "invalid_permission_payload", message: "permissionArgs 必须是字符串数组"}
		}
		args := make([]string, 0, len(list))
		for _, item := range list {
			text, isText := item.(string)
			if !isText {
				return patch{}, validationError{code: "invalid_permission_payload", message: "permissionArgs 必须是字符串数组"}
			}
			if trimmed := strings.TrimSpace(text); trimmed != "" {
				args = append(args, trimmed)
			}
		}
		changes.permissionArgs = &args
	}
	if changes.maxPermission == nil && changes.applyToHost == nil && changes.permissionArgs == nil {
		return patch{}, validationError{code: "invalid_permission_payload", message: "请求体没有任何可写入的字段"}
	}
	return changes, nil
}

// mergeSettings 把请求字段叠加到当前记录上，并按合并后的取值校验交叉约束。
func mergeSettings(current webuitoolsettingsapi.ToolPermissionSettings, changes patch) (webuitoolsettingsapi.ToolPermissionSettings, error) {
	next := current
	if changes.maxPermission != nil {
		next.MaxPermission = *changes.maxPermission
	}
	if changes.applyToHost != nil {
		next.ApplyToHost = *changes.applyToHost
	}
	if changes.permissionArgs != nil {
		next.PermissionArgs = *changes.permissionArgs
	}
	if next.ApplyToHost && !next.MaxPermission {
		return webuitoolsettingsapi.ToolPermissionSettings{},
			validationError{code: "apply_to_host_requires_max_permission", message: "关闭最大权限时不能写入宿主配置"}
	}
	if len(next.PermissionArgs) > 0 && !next.MaxPermission {
		return webuitoolsettingsapi.ToolPermissionSettings{},
			validationError{code: "permission_args_requires_max_permission", message: "选择具体权限参数时请保持「最大权限」开启"}
	}
	return next, nil
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
