package modelsapi

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

var errInvalidCatalogQuery = errors.New("invalid catalog query")

// openAICatalogDialect 持有既有 OpenAI / Codex 目录合同。
//
// 它是 catalogDialects 的兜底：没有 anthropic-version 头的请求继续走这里，
// 因此 OpenAI 客户端与 Codex ModelsClient 的行为完全不变。
type openAICatalogDialect struct{}

func (openAICatalogDialect) Matches(*http.Request) bool { return true }

func (openAICatalogDialect) ParseQuery(rawQuery string) (catalogQuery, error) {
	options, valid := parseCatalogOptions(rawQuery)
	if !valid {
		return nil, errInvalidCatalogQuery
	}
	return options, nil
}

func (dialect openAICatalogDialect) RenderList(
	response http.ResponseWriter,
	context catalogRenderContext,
) {
	options, ok := context.query.(catalogOptions)
	if !ok {
		dialect.WriteProblem(response, catalogProblemInternal, errInvalidCatalogQuery)
		return
	}
	switch options.protocol {
	case catalogProtocolOpenAI:
		writeJSON(response, http.StatusOK, modelList{
			Object: "list",
			Data:   context.views,
		})
	case catalogProtocolCodex:
		payload := newCodexModelList(context.views)
		if err := context.handler.applyContextWindows(context.request.Context(), &payload); err != nil {
			response.Header().Set("X-AIH-Model-Context", "unavailable")
		}
		if context.handler.serviceTiers != nil {
			for index := range payload.Models {
				model := &payload.Models[index]
				tiers := context.handler.serviceTiers.LookupServiceTiers(context.request.Context(), "codex", model.Slug)
				if len(tiers) == 0 {
					continue
				}
				model.ServiceTiers = tiers
				hasUltrafast := false
				for _, tier := range tiers {
					switch tier.ID {
					case "priority":
						model.AdditionalSpeedTiers = appendUniqueString(model.AdditionalSpeedTiers, "fast")
					case "ultrafast":
						hasUltrafast = true
						model.AdditionalSpeedTiers = appendUniqueString(model.AdditionalSpeedTiers, "ultrafast")
					}
				}
				// Codex 首方目录当前不给 Sol / Astra 的 ultrafast 条目（官方文档声明两者支持），
				// 这里按 Fast 的同一形状补齐，避免 TUI 只显示 Fast。
				if !hasUltrafast && codexSupportsUltrafast(model.Slug) {
					model.ServiceTiers = append(model.ServiceTiers, modelmetadata.ServiceTier{
						ID:          "ultrafast",
						Name:        "Ultrafast",
						Description: "The fastest available responses for latency-sensitive work.",
					})
					model.AdditionalSpeedTiers = appendUniqueString(model.AdditionalSpeedTiers, "ultrafast")
				}
			}
		}
		writeJSON(response, http.StatusOK, payload)
	default:
		dialect.WriteProblem(response, catalogProblemInternal, errInvalidCatalogQuery)
	}
}

func (openAICatalogDialect) RenderModel(
	response http.ResponseWriter,
	request *http.Request,
	modelID string,
) {
	writeSingleModel(response, request, modelID)
}

func (openAICatalogDialect) WriteProblem(
	response http.ResponseWriter,
	problem catalogProblem,
	_ error,
) {
	switch problem {
	case catalogProblemUnauthorized:
		writeUnauthorized(response)
	case catalogProblemForbidden:
		writeModelForbidden(response)
	case catalogProblemInvalidQuery:
		writeError(response, http.StatusBadRequest, "invalid_query")
	case catalogProblemMethodNotAllowed:
		writeError(response, http.StatusMethodNotAllowed, "method_not_allowed")
	case catalogProblemNotFound:
		writeError(response, http.StatusNotFound, "route_not_found")
	default:
		writeError(response, http.StatusInternalServerError, "internal_error")
	}
}

// ViewOptions 让 OpenAI/Codex 继续使用既有的 modalities 与 capability 开关。
func (options catalogOptions) ViewOptions() catalogViewOptions {
	return catalogViewOptions{
		IncludeModalities: options.includeModalities,
		Capability:        options.capability,
	}
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
