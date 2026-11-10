// Package webuimodelsettingsapi 提供模型目录设置文档（model-catalog-settings）的整体写入接口。
//
// 写入口是 `PUT|POST /v1/management/webui/model-catalog-settings`：请求体是完整文档，
// 交给 modelcatalogsettings.Save 归一成 v5 形状后落盘。正常化在存储层完成，本包只做
// 传输层校验——顶层必须是对象、已知集合字段必须是数组、版本字段必须是数字，避免
// 客户端把拼错的键（例如 {"accountModel": []}）当成合法文档静默清空设置。
package webuimodelsettingsapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

// Path 是模型目录设置的完整管理契约路径。
const Path = "/v1/management/webui/model-catalog-settings"

// maxBodyBytes 限制请求体大小。模型目录包含每个账号的全部模型，正常量级远小于此值。
const maxBodyBytes = 4 << 20

// ErrInvalidDependencies 表示 Handler 缺少必需端口。
var ErrInvalidDependencies = errors.New("模型目录设置接口依赖无效")

// Authorizer 校验管理密钥。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// Store 保存整份设置文档并返回实际落盘的 v5 形状。
type Store interface {
	Save(ctx context.Context, document any) (modelcatalogsettings.Settings, error)
}

// DatabaseStore 把 app-state.db 路径绑定成 Store。
type DatabaseStore struct {
	DatabasePath string
}

// Save 调用适配层：normalize 到 v5、刷新 updatedAt、整份写回 app_kv。
func (store DatabaseStore) Save(ctx context.Context, document any) (modelcatalogsettings.Settings, error) {
	return modelcatalogsettings.Save(ctx, store.DatabasePath, document)
}

// Dependencies 汇总写入依赖。
type Dependencies struct {
	Authorizer Authorizer
	Store      Store
}

// Handler 处理模型目录设置的写入。
type Handler struct {
	authorizer Authorizer
	store      Store
}

// NewHandler 创建默认失败关闭的 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Authorizer == nil || dependencies.Store == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{authorizer: dependencies.Authorizer, store: dependencies.Store}, nil
}

type responseView struct {
	OK                bool                          `json:"ok"`
	Settings          modelcatalogsettings.Settings `json:"settings"`
	SettingsUpdatedAt int64                         `json:"settingsUpdatedAt"`
}

type errorView struct {
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
	Message string `json:"message,omitempty"`
}

// ServeHTTP 接受 PUT/POST 写入整份设置文档。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.authorizer == nil || handler.store == nil {
		writeError(response, http.StatusServiceUnavailable, "model_catalog_settings_unavailable", "模型目录设置服务不可用")
		return
	}
	if !handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized", "需要管理密钥")
		return
	}
	if request.Method != http.MethodPut && request.Method != http.MethodPost {
		response.Header().Set("Allow", http.MethodPut+", "+http.MethodPost)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed", "仅支持 PUT/POST")
		return
	}
	document, ok := decodeDocument(response, request)
	if !ok {
		return
	}
	saved, err := handler.store.Save(request.Context(), document)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "save_model_catalog_settings_failed", "模型目录设置保存失败")
		return
	}
	writeJSON(response, http.StatusOK, responseView{
		OK:                true,
		Settings:          saved,
		SettingsUpdatedAt: saved.UpdatedAtMS,
	})
}

// decodeDocument 读取并校验请求体；失败时已经写好响应。
func decodeDocument(response http.ResponseWriter, request *http.Request) (map[string]any, bool) {
	decoder := json.NewDecoder(http.MaxBytesReader(response, request.Body, maxBodyBytes))
	// 保留数字原文，避免大时间戳经 float64 往返丢精度。
	decoder.UseNumber()
	var payload any
	if err := decoder.Decode(&payload); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeError(response, http.StatusRequestEntityTooLarge, "request_body_too_large", "")
			return nil, false
		}
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return nil, false
	}
	if err := decoder.Decode(new(any)); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "invalid_json_body", "")
		return nil, false
	}
	document, ok := payload.(map[string]any)
	if !ok || document == nil {
		writeError(response, http.StatusBadRequest, "invalid_request_body", "请求体必须是设置文档对象")
		return nil, false
	}
	if code := validateDocument(document); code != "" {
		writeError(response, http.StatusBadRequest, code, "")
		return nil, false
	}
	return document, true
}

// validateDocument 校验文档骨架：
//
//   - 至少出现一个集合键，避免 `{}` 或拼错键把既有设置整份清空；
//   - 出现的集合键必须是数组（单条记录用数组包一层）；
//   - version 允许缺省（旧文档），出现时必须是数字。
//
// 记录内部字段的容错由 modelcatalogsettings 归一化负责，不在这里重复。
func validateDocument(document map[string]any) string {
	collections := []struct {
		key  string
		code string
	}{
		{"accountModels", "invalid_account_models"},
		{"legacyModels", "invalid_legacy_models"},
		{"models", "invalid_models"},
	}
	present := false
	for _, collection := range collections {
		value, exists := document[collection.key]
		if !exists {
			continue
		}
		present = true
		if _, ok := value.([]any); !ok {
			return collection.code
		}
	}
	if !present {
		return "missing_settings_document"
	}
	if value, exists := document["version"]; exists {
		if _, ok := value.(json.Number); !ok {
			return "invalid_version"
		}
	}
	return ""
}

func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}

func writeError(response http.ResponseWriter, status int, code string, message string) {
	writeJSON(response, status, errorView{OK: false, Error: code, Message: message})
}
