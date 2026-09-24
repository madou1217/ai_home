// Package modelsapi 提供完全由本地账号模型倒排驱动的 OpenAI 模型目录。
package modelsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
)

const (
	// Path 是 OpenAI 兼容模型目录的规范路径。
	Path = "/v1/models"
	// PathPrefix 是单模型查询的路径前缀，对应 OpenAI GET /v1/models/{model}。
	//
	// 写成字面量而不是 Path + "/"：仓库的路由采集器（scripts/collect-gateway-routes.js）
	// 只解析 Go 的字符串字面量常量，拼接式常量会让这条路由在对齐矩阵里凭空消失。
	// 与 Path 的一致性由 TestPathPrefixMatchesPath 守住。
	PathPrefix = "/v1/models/"
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

// ServeHTTP 完成客户端鉴权，并按请求形态选择单模型、标准 OpenAI 或 Codex 目录投影。
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
	modelID, isSingleModel := singleModelID(request.URL.Path)
	if !isSingleModel && request.URL.Path != Path {
		writeError(response, http.StatusNotFound, "route_not_found")
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", http.MethodGet+", "+http.MethodHead)
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if isSingleModel {
		writeSingleModel(response, request, modelID)
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
	// created 与 Node 的 `buildOpenAIModelsList` 一致：整个响应共用同一个「当前秒」。
	// 目录项没有真实创建时间，此前这里固定输出 0，而同文件的单模型回显用的是 now——
	// 同一个字段在同一个包里两种语义。0 是 JS 的 falsy 值，客户端 `created || fallback`
	// 会静默丢掉它；契约要求的又恰好是 unix 秒。
	now := time.Now().Unix()
	views, err := newModelViews(
		models,
		handler.modalities,
		options.includeModalities,
		options.capability,
		now,
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

// singleModelID 从 /v1/models/{model} 提取模型 ID。
//
// 只接受恰好一段路径，因此 /v1/models/ 与 /v1/models/a/b 都不算单模型查询；
// 提取失败时返回 false，由调用方按未命中路由处理。
func singleModelID(path string) (string, bool) {
	if !strings.HasPrefix(path, PathPrefix) {
		return "", false
	}
	remainder := path[len(PathPrefix):]
	if remainder == "" || strings.Contains(remainder, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(remainder)
	if err != nil {
		return "", false
	}
	id := strings.TrimSpace(decoded)
	if id == "" {
		return "", false
	}
	return id, true
}

// writeSingleModel 按 OpenAI 合同回显单个模型对象。
//
// 与 Node 的 GET /v1/models/{id} 逐字段一致：不校验本地目录，任何非空 ID 都返回 200，
// owned_by 固定为 aih-server，created 取当前秒。因此这里不读取 ModelReader，
// 单模型查询也不会因为目录未就绪而失败。
func writeSingleModel(
	response http.ResponseWriter,
	request *http.Request,
	modelID string,
) {
	if request.Method == http.MethodHead {
		writeJSONHeaders(response, http.StatusOK)
		return
	}
	writeJSON(response, http.StatusOK, modelView{
		ID:      modelID,
		Object:  "model",
		Created: time.Now().Unix(),
		OwnedBy: "aih-server",
	})
}

// catalogOptions 保存一次请求选择的目录协议和显式扩展。
type catalogOptions struct {
	protocol          catalogProtocol
	includeModalities bool
	// capability 是按能力过滤的条件；空表示不过滤。
	//
	// 取值与 Node 一致：`vision` / `image_out`。未知取值不过滤（与 Node 的
	// modelMatchesCapability 一样失败开放），避免拼错的能力名把整个目录隐藏掉。
	capability string
}

// catalogProtocol 表示同一路径上的客户端目录合同。
type catalogProtocol uint8

const (
	// catalogProtocolOpenAI 是标准 object/data 模型列表。
	catalogProtocolOpenAI catalogProtocol = iota
	// catalogProtocolCodex 是 Codex ModelsClient 使用的 models 列表。
	catalogProtocolCodex
)

// parseCatalogOptions 严格区分标准扩展与 Codex 目录，不接受重复、未知或混合参数。
// client_version 的值不比较、不参与目录计算，也不会触发上游刷新。
//
// `capability` 可以与 `include=modalities` 组合（两者都是显式意图，互不冲突），
// 但不能与 `client_version` 组合：Codex 目录合同有自己的形状，Node 那条路径会把
// capability 静默丢掉（`isCodexNativeModelsRequest` 分支不套过滤器），Go 选择报错而不是
// 假装过滤生效。
//
// `capability` 取空值时等同「没有要求过滤」——与 Node 的
// `if (!capability) return bodyText` 一致：客户端把变量拼进 query 而变量为空是常见形态，
// 不该因此拿到 400。真正未知的键仍然报错（见下方白名单），这是 Go 侧既有的严格合同。
func parseCatalogOptions(rawQuery string) (catalogOptions, bool) {
	// aih_modalities 与 Node 的 buildOpenAIModelsList 一致默认输出；include=modalities
	// 仍被接受（历史客户端会带），只是不再改变结果。
	options := catalogOptions{protocol: catalogProtocolOpenAI, includeModalities: true}
	if rawQuery == "" {
		return options, true
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil || len(values) == 0 || len(values) > 2 {
		return catalogOptions{}, false
	}
	if clientVersions, found := values["client_version"]; found {
		if len(clientVersions) != 1 || len(values) != 1 {
			return catalogOptions{}, false
		}
		return catalogOptions{protocol: catalogProtocolCodex}, true
	}
	for key := range values {
		if key != "include" && key != "capability" {
			return catalogOptions{}, false
		}
	}
	if includes, found := values["include"]; found {
		if len(includes) != 1 || includes[0] != "modalities" {
			return catalogOptions{}, false
		}
		options.includeModalities = true
	}
	if capabilities, found := values["capability"]; found {
		if len(capabilities) != 1 {
			return catalogOptions{}, false
		}
		options.capability = strings.ToLower(strings.TrimSpace(capabilities[0]))
	}
	return options, true
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

// modelModalitiesView 是 AIH 模态扩展（与 Node 一致总是输出）。
type modelModalitiesView struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// newModelViews 校验有序唯一元组并按模型 ID 去重。
//
// `owned_by` 由 resolveModelOwner 按「模型 ID 优先、Provider 兜底」解析成**厂商名**，
// 与 Node 的 `buildOpenAIModelsList` 一致。早先这里直接输出 Provider ID 并在同名冲突时
// 改写为 `aih`，两者都是 AIH 内部词汇：OpenAI 合同里 `owned_by` 是「拥有该模型的组织」，
// 而 Node 的 WebUI 依赖厂商名反查 Provider 分组，写内部 ID 会让分组整块落空。
//
// `created` 由调用方传入，整个响应共用同一个值（Node 在 map 之外取一次 now）。
//
// capability 过滤刻意放在去重**之后**：Node 的 `filterOpenAIModelsBodyByCapability` 作用在
// 已经去重的 `data` 数组上，每个模型项只按 `item.aih_modalities` 判一次——也就是首个
// Provider 的记录。若在去重前逐 (Provider, 模型) 过滤，同名模型会因为不同 Provider 的模态
// 不同而在两端得到不同的结果。
func newModelViews(
	models []accountapp.RoutableModel,
	modalities modelmetadata.Reader,
	includeModalities bool,
	capability string,
	created int64,
) ([]modelView, error) {
	if modalities == nil {
		return nil, errInvalidModelSnapshot
	}
	views := make([]modelView, 0, len(models))
	// owners 与 views 一一对应，记录每个模型项的首个 Provider，供能力过滤判定使用。
	owners := make([]string, 0, len(models))
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
			previousProviderID = model.ProviderID()
			continue
		}
		if len(views) > 0 && modelID < views[len(views)-1].ID {
			return nil, errInvalidModelSnapshot
		}
		view := modelView{
			ID:      modelID,
			Object:  "model",
			Created: created,
			OwnedBy: resolveModelOwner(model.ProviderID(), modelID),
		}
		if includeModalities {
			view.AIHModalities = newModelModalitiesView(
				modalities,
				model.ProviderID(),
				modelID,
			)
		}
		views = append(views, view)
		owners = append(owners, model.ProviderID())
		previousProviderID = model.ProviderID()
	}
	return filterViewsByCapability(views, owners, modalities, capability), nil
}

// filterViewsByCapability 按能力过滤已去重的模型项；空或未知能力不过滤（失败开放）。
func filterViewsByCapability(
	views []modelView,
	owners []string,
	reader modelmetadata.Reader,
	capability string,
) []modelView {
	normalized := normalizeCapability(capability)
	if normalized == "" {
		return views
	}
	filtered := make([]modelView, 0, len(views))
	for index, view := range views {
		if modelMatchesCapability(reader, owners[index], view.ID, normalized) {
			filtered = append(filtered, view)
		}
	}
	return filtered
}

// normalizeCapability 归一化能力名，并让未知取值退化为「不过滤」。
//
// 与 Node 的 modelMatchesCapability 一致：拼错的能力名应该让目录原样返回，而不是把整个
// 目录隐藏掉——客户端拿到空列表比拿到未过滤列表更难排查。
func normalizeCapability(capability string) string {
	normalized := strings.ToLower(strings.TrimSpace(capability))
	switch normalized {
	case "vision", "image_out":
		return normalized
	default:
		return ""
	}
}

// modelMatchesCapability 判断模型是否满足能力过滤；capability 必须是已知取值。
//
// 判定走 LookupOrInferModalities：它总是给出答案（未收录时按保守家族兜底），因此这里不需要
// 再区分「未命中」——把判不出来的模型当成不满足，与 vision guard 的保守方向一致。
func modelMatchesCapability(
	reader modelmetadata.Reader,
	providerID string,
	modelID string,
	capability string,
) bool {
	modalities, found := reader.LookupOrInferModalities(providerID, modelID)
	if !found {
		return false
	}
	target := modalities.Input()
	if capability == "image_out" {
		target = modalities.Output()
	}
	return containsModality(target, "image")
}

// containsModality 判断模态列表是否包含 image。
func containsModality(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

// newModelModalitiesView 从本地索引读取能力；未命中时按保守家族兜底，仍无答案才降级为纯文本。
func newModelModalitiesView(
	reader modelmetadata.Reader,
	providerID string,
	modelID string,
) *modelModalitiesView {
	modalities, found := reader.LookupOrInferModalities(providerID, modelID)
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
