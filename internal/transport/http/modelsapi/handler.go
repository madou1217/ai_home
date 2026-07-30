// Package modelsapi 提供完全由本地账号模型倒排驱动的 OpenAI 模型目录。
package modelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

const (
	// Path 是 OpenAI 兼容模型目录的规范路径。
	Path = "/v1/models"
)

var (
	// ErrInvalidDependencies 表示模型目录缺少本地读取或鉴权端口。
	ErrInvalidDependencies = errors.New("模型目录 HTTP Handler 依赖无效")
	// errInvalidModelSnapshot 表示本地读取端口违反排序、唯一性或值对象合同。
	errInvalidModelSnapshot = errors.New("本地模型目录快照无效")
)

// Authorizer 判断客户端是否允许读取标准模型目录。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// ModelReader 是 Handler 所需的本地物化目录最小端口。
type ModelReader interface {
	ListRoutableModels(ctx context.Context) ([]accountapp.RoutableModel, error)
}

// Dependencies 声明标准模型目录的只读依赖。
type Dependencies struct {
	Models     ModelReader
	Authorizer Authorizer
}

// Handler 把本地 Provider 模型元组渲染为 OpenAI 模型列表。
type Handler struct {
	models     ModelReader
	authorizer Authorizer
}

// NewHandler 创建不会访问 SQLite、凭据或上游的标准模型目录 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Models == nil || dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		models:     dependencies.Models,
		authorizer: dependencies.Authorizer,
	}, nil
}

// ServeHTTP 完成客户端鉴权，并仅允许无查询参数的 GET 或 HEAD。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeError(response, http.StatusUnauthorized, "unauthorized_client")
		return
	}
	if request.URL.Path != Path {
		writeError(response, http.StatusNotFound, "route_not_found")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if request.URL.RawQuery != "" {
		writeError(response, http.StatusBadRequest, "invalid_query")
		return
	}
	models, err := handler.models.ListRoutableModels(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error")
		return
	}
	views, err := newModelViews(models)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error")
		return
	}
	payload := modelList{
		Object: "list",
		Data:   views,
	}
	if request.Method == http.MethodHead {
		writeJSONHeaders(response, http.StatusOK)
		return
	}
	writeJSON(response, http.StatusOK, payload)
}

// modelList 是 OpenAI 兼容模型列表 envelope。
type modelList struct {
	Object string      `json:"object"`
	Data   []modelView `json:"data"`
}

// modelView 是不会暴露账号数量或身份的标准模型项。
type modelView struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	OwnedBy string `json:"owned_by"`
}

// newModelViews 校验有序唯一元组并按模型 ID 去重；跨 Provider 同名归属显示为 aih。
func newModelViews(
	models []accountapp.RoutableModel,
) ([]modelView, error) {
	views := make([]modelView, 0, len(models))
	previousProviderID := ""
	for _, model := range models {
		if !model.IsValid() {
			return nil, errInvalidModelSnapshot
		}
		modelID := model.ModelID().String()
		if len(views) > 0 && views[len(views)-1].ID == modelID {
			if model.ProviderID() <= previousProviderID {
				return nil, errInvalidModelSnapshot
			}
			if views[len(views)-1].OwnedBy != model.ProviderID() {
				views[len(views)-1].OwnedBy = "aih"
			}
			previousProviderID = model.ProviderID()
			continue
		}
		if len(views) > 0 && modelID < views[len(views)-1].ID {
			return nil, errInvalidModelSnapshot
		}
		views = append(views, modelView{
			ID:      modelID,
			Object:  "model",
			Created: 0,
			OwnedBy: model.ProviderID(),
		})
		previousProviderID = model.ProviderID()
	}
	return views, nil
}

// writeError 输出不包含内部错误文本的标准错误 envelope。
func writeError(response http.ResponseWriter, status int, code string) {
	writeJSON(response, status, map[string]any{
		"error": map[string]string{
			"code":    code,
			"message": "请求模型目录失败",
		},
	})
}

// writeJSON 写入禁止缓存且不可嗅探的单个 JSON 文档。
func writeJSON(response http.ResponseWriter, status int, payload any) {
	writeJSONHeaders(response, status)
	_ = json.NewEncoder(response).Encode(payload)
}

// writeJSONHeaders 写入标准安全响应头和状态码。
func writeJSONHeaders(response http.ResponseWriter, status int) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
}
