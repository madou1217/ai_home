// Package modelsapi 提供完全由本地账号模型倒排驱动的 OpenAI 模型目录。
package modelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
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
	Modalities modelmetadata.Reader
	Authorizer Authorizer
}

// Handler 把本地 Provider 模型元组渲染为 OpenAI 模型列表。
type Handler struct {
	models     ModelReader
	modalities modelmetadata.Reader
	authorizer Authorizer
}

// NewHandler 创建不会访问 SQLite、凭据或上游的标准模型目录 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Models == nil ||
		dependencies.Modalities == nil ||
		dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		models:     dependencies.Models,
		modalities: dependencies.Modalities,
		authorizer: dependencies.Authorizer,
	}, nil
}

// ServeHTTP 完成客户端鉴权，并按请求形态选择标准 OpenAI 或 Codex 目录投影。
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
	options, valid := parseCatalogOptions(request.URL.RawQuery)
	if !valid {
		writeError(response, http.StatusBadRequest, "invalid_query")
		return
	}
	models, err := handler.models.ListRoutableModels(request.Context())
	if err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error")
		return
	}
	views, err := newModelViews(
		models,
		handler.modalities,
		options.includeModalities,
	)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "internal_error")
		return
	}
	if request.Method == http.MethodHead {
		writeJSONHeaders(response, http.StatusOK)
		return
	}
	switch options.protocol {
	case catalogProtocolOpenAI:
		writeJSON(response, http.StatusOK, modelList{
			Object: "list",
			Data:   views,
		})
	case catalogProtocolCodex:
		writeJSON(response, http.StatusOK, newCodexModelList(views))
	}
}

// catalogOptions 保存一次请求选择的目录协议和显式扩展。
type catalogOptions struct {
	protocol          catalogProtocol
	includeModalities bool
}

// catalogProtocol 表示同一路径上的客户端目录合同。
type catalogProtocol uint8

const (
	// catalogProtocolOpenAI 是标准 object/data 模型列表。
	catalogProtocolOpenAI catalogProtocol = iota
	// catalogProtocolCodex 是 Codex ModelsClient 使用的 models 列表。
	catalogProtocolCodex
)

// parseCatalogOptions 严格区分标准扩展与 Codex 目录，不接受重复或混合参数。
// client_version 的值不比较、不参与目录计算，也不会触发上游刷新。
func parseCatalogOptions(rawQuery string) (catalogOptions, bool) {
	if rawQuery == "" {
		return catalogOptions{protocol: catalogProtocolOpenAI}, true
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil || len(values) != 1 {
		return catalogOptions{}, false
	}
	if clientVersions, found := values["client_version"]; found && len(clientVersions) == 1 {
		return catalogOptions{protocol: catalogProtocolCodex}, true
	}
	if includes, found := values["include"]; found && len(includes) == 1 && includes[0] == "modalities" {
		return catalogOptions{
			protocol:          catalogProtocolOpenAI,
			includeModalities: true,
		}, true
	}
	return catalogOptions{}, false
}

// modelList 是 OpenAI 兼容模型列表 envelope。
type modelList struct {
	Object string      `json:"object"`
	Data   []modelView `json:"data"`
}

// modelView 是不会暴露账号数量或身份的标准模型项。
type modelView struct {
	ID            string               `json:"id"`
	Object        string               `json:"object"`
	Created       int64                `json:"created"`
	OwnedBy       string               `json:"owned_by"`
	AIHModalities *modelModalitiesView `json:"aih_modalities,omitempty"`
}

// modelModalitiesView 是显式 opt-in 才输出的 AIH 模态扩展。
type modelModalitiesView struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// newModelViews 校验有序唯一元组并按模型 ID 去重；跨 Provider 同名归属显示为 aih。
func newModelViews(
	models []accountapp.RoutableModel,
	modalities modelmetadata.Reader,
	includeModalities bool,
) ([]modelView, error) {
	if modalities == nil {
		return nil, errInvalidModelSnapshot
	}
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
		view := modelView{
			ID:      modelID,
			Object:  "model",
			Created: 0,
			OwnedBy: model.ProviderID(),
		}
		if includeModalities {
			view.AIHModalities = newModelModalitiesView(
				modalities,
				model.ProviderID(),
				modelID,
			)
		}
		views = append(views, view)
		previousProviderID = model.ProviderID()
	}
	return views, nil
}

// newModelModalitiesView 从本地索引读取能力，未命中时明确降级为纯文本。
func newModelModalitiesView(
	reader modelmetadata.Reader,
	providerID string,
	modelID string,
) *modelModalitiesView {
	modalities, found := reader.LookupModalities(providerID, modelID)
	if !found {
		modalities = modelmetadata.TextOnly()
	}
	return &modelModalitiesView{
		Input:  modalities.Input(),
		Output: modalities.Output(),
	}
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
