package modelsapi

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
)

const (
	// anthropicVersionHeader 是 Anthropic 客户端（含官方 SDK）在每次
	// /v1/models 请求上都会带的协议版本头。它只用于选择响应方言，
	// 不参与鉴权，也不要求版本号等于某个固定值。
	anthropicVersionHeader = "anthropic-version"

	// Anthropic Models API 的分页默认值与上限。
	anthropicDefaultPageLimit = 20
	anthropicMaxPageLimit     = 1000
	anthropicMaxLifecycles    = 3

	// 本地目录没有真实发布时间。Anthropic 允许未知日期使用 epoch，
	// 固定值可以避免同一模型在不同页里显示不同的 created_at。
	anthropicUnknownCreatedAt = "1970-01-01T00:00:00Z"
)

// anthropicCatalogOptions 是 Anthropic Models API 的查询参数。
type anthropicCatalogOptions struct {
	limit      int
	afterID    string
	beforeID   string
	lifecycles []string
}

// ViewOptions 让 Anthropic 分支只构建响应真正需要的字段；AIH 扩展
// （aih_modalities / supported_endpoints）不会出现在 Anthropic 模型对象里。
func (anthropicCatalogOptions) ViewOptions() catalogViewOptions {
	return catalogViewOptions{}
}

// anthropicCatalogDialect 实现 Anthropic Models API 的列表与单模型合同。
type anthropicCatalogDialect struct{}

func (anthropicCatalogDialect) Matches(request *http.Request) bool {
	return request != nil && strings.TrimSpace(request.Header.Get(anthropicVersionHeader)) != ""
}

func (anthropicCatalogDialect) ParseQuery(rawQuery string) (catalogQuery, error) {
	options, err := parseAnthropicCatalogOptions(rawQuery)
	if err != nil {
		return nil, err
	}
	return options, nil
}

func (dialect anthropicCatalogDialect) RenderList(
	response http.ResponseWriter,
	context catalogRenderContext,
) {
	options, ok := context.query.(anthropicCatalogOptions)
	if !ok {
		dialect.WriteProblem(response, catalogProblemInternal, errInvalidCatalogQuery)
		return
	}
	var windows map[string]modelmetadata.ContextWindow
	if context.handler.contextWindows != nil {
		// 上下文窗口是可选增强：读取失败时仍返回完整目录，只是 max_input_tokens 为 null。
		windows, _ = context.handler.contextWindows.ReadContextWindows(context.request.Context())
	}
	page, found := buildAnthropicModelPage(context.views, options, windows)
	if !found {
		dialect.WriteProblem(response, catalogProblemInvalidQuery, errors.New("model cursor not found"))
		return
	}
	writeJSON(response, http.StatusOK, page)
}

func (anthropicCatalogDialect) RenderModel(
	response http.ResponseWriter,
	request *http.Request,
	modelID string,
) {
	if request.Method == http.MethodHead {
		writeJSONHeaders(response, http.StatusOK)
		return
	}
	writeJSON(response, http.StatusOK, newAnthropicModel(modelView{ID: modelID}, nil))
}

func (anthropicCatalogDialect) WriteProblem(
	response http.ResponseWriter,
	problem catalogProblem,
	cause error,
) {
	status := http.StatusInternalServerError
	errorType := "api_error"
	message := "model catalog unavailable"
	switch problem {
	case catalogProblemInvalidQuery:
		status = http.StatusBadRequest
		errorType = "invalid_request_error"
		message = "invalid query parameters"
		if cause != nil && strings.TrimSpace(cause.Error()) != "" {
			message = cause.Error()
		}
	case catalogProblemUnauthorized:
		status = http.StatusUnauthorized
		errorType = "authentication_error"
		message = "invalid x-api-key"
	case catalogProblemForbidden:
		status = http.StatusForbidden
		errorType = "permission_error"
		message = coreclientkeys.MessageModelNotAllowed
	case catalogProblemMethodNotAllowed:
		status = http.StatusMethodNotAllowed
		errorType = "invalid_request_error"
		message = "method not allowed"
	case catalogProblemNotFound:
		status = http.StatusNotFound
		errorType = "not_found_error"
		message = "not found"
	}
	writeAnthropicError(response, status, errorType, message)
}

// parseAnthropicCatalogOptions 只接受官方 Models API 的四个查询参数。
// 未知键、重复键与非法枚举都显式报错，避免把拼写错误静默成“全量目录”。
func parseAnthropicCatalogOptions(rawQuery string) (anthropicCatalogOptions, error) {
	options := anthropicCatalogOptions{limit: anthropicDefaultPageLimit}
	if rawQuery == "" {
		return options, nil
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil || len(values) == 0 {
		return anthropicCatalogOptions{}, errors.New("invalid query string")
	}
	for key, list := range values {
		switch key {
		case "limit", "after_id", "before_id":
			if len(list) != 1 {
				return anthropicCatalogOptions{}, fmt.Errorf("%s must appear exactly once", key)
			}
		case "lifecycle":
			if len(list) == 0 || len(list) > anthropicMaxLifecycles {
				return anthropicCatalogOptions{}, errors.New("lifecycle accepts 1 to 3 values")
			}
		default:
			return anthropicCatalogOptions{}, fmt.Errorf("unsupported query parameter %q", key)
		}
	}
	if list, found := values["limit"]; found {
		value, convertErr := strconv.Atoi(strings.TrimSpace(list[0]))
		if convertErr != nil || value < 1 || value > anthropicMaxPageLimit {
			return anthropicCatalogOptions{}, errors.New("limit must be an integer between 1 and 1000")
		}
		options.limit = value
	}
	if list, found := values["after_id"]; found {
		value := strings.TrimSpace(list[0])
		if value == "" {
			return anthropicCatalogOptions{}, errors.New("after_id must not be empty")
		}
		options.afterID = value
	}
	if list, found := values["before_id"]; found {
		value := strings.TrimSpace(list[0])
		if value == "" {
			return anthropicCatalogOptions{}, errors.New("before_id must not be empty")
		}
		options.beforeID = value
	}
	if options.afterID != "" && options.beforeID != "" {
		return anthropicCatalogOptions{}, errors.New("after_id and before_id cannot be combined")
	}
	if list, found := values["lifecycle"]; found {
		seen := make(map[string]struct{}, len(list))
		for _, raw := range list {
			value := strings.ToLower(strings.TrimSpace(raw))
			switch value {
			case "active", "deprecated", "retired":
			default:
				return anthropicCatalogOptions{}, errors.New("lifecycle must be active, deprecated, or retired")
			}
			if _, duplicate := seen[value]; duplicate {
				return anthropicCatalogOptions{}, errors.New("lifecycle values must be unique")
			}
			seen[value] = struct{}{}
			options.lifecycles = append(options.lifecycles, value)
		}
	}
	return options, nil
}

// anthropicModel 是 Anthropic Models API 的标准模型对象。
//
// 本地目录没有的生命周期、发布时间、输出上限等字段保持 null，而不是
// 用 OpenAI 的 created/owned_by 或其他猜测值填充。
type anthropicModel struct {
	Type           string  `json:"type"`
	ID             string  `json:"id"`
	DisplayName    string  `json:"display_name"`
	CreatedAt      string  `json:"created_at"`
	DeprecatedAt   *string `json:"deprecated_at"`
	Lifecycle      string  `json:"lifecycle"`
	Line           *string `json:"line"`
	MaxInputTokens *int64  `json:"max_input_tokens"`
	MaxTokens      *int64  `json:"max_tokens"`
	RetiresAt      *string `json:"retires_at"`
	Capabilities   any     `json:"capabilities"`
}

// anthropicModelList 是 Anthropic Models API 的分页 envelope。
type anthropicModelList struct {
	Data    []anthropicModel `json:"data"`
	HasMore bool             `json:"has_more"`
	FirstID *string          `json:"first_id"`
	LastID  *string          `json:"last_id"`
}

// buildAnthropicModelPage 先按生命周期筛选，再应用 after_id / before_id
// 游标，最后生成当前页。目录本身是稳定有序的，因此游标只依赖模型 ID。
func buildAnthropicModelPage(
	views []modelView,
	options anthropicCatalogOptions,
	windows map[string]modelmetadata.ContextWindow,
) (anthropicModelList, bool) {
	candidates := filterAnthropicLifecycle(views, options.lifecycles)
	start, end, found := anthropicPageBounds(candidates, options)
	if !found {
		return anthropicModelList{}, false
	}
	data := make([]anthropicModel, 0, end-start)
	for _, view := range candidates[start:end] {
		data = append(data, newAnthropicModel(view, windows))
	}
	page := anthropicModelList{
		Data:    data,
		HasMore: anthropicHasMore(len(candidates), options, start, end),
	}
	if len(data) > 0 {
		firstID := data[0].ID
		lastID := data[len(data)-1].ID
		page.FirstID = &firstID
		page.LastID = &lastID
	}
	return page, true
}

func anthropicPageBounds(
	views []modelView,
	options anthropicCatalogOptions,
) (int, int, bool) {
	limit := options.limit
	if limit <= 0 {
		limit = anthropicDefaultPageLimit
	}
	switch {
	case options.afterID != "":
		index, found := indexOfAnthropicModel(views, options.afterID)
		if !found {
			return 0, 0, false
		}
		start := index + 1
		return start, min(start+limit, len(views)), true
	case options.beforeID != "":
		index, found := indexOfAnthropicModel(views, options.beforeID)
		if !found {
			return 0, 0, false
		}
		end := index
		start := max(0, end-limit)
		return start, end, true
	default:
		return 0, min(limit, len(views)), true
	}
}

func anthropicHasMore(
	total int,
	options anthropicCatalogOptions,
	start int,
	end int,
) bool {
	if options.beforeID != "" {
		return start > 0
	}
	return end < total
}

func indexOfAnthropicModel(views []modelView, modelID string) (int, bool) {
	for index, view := range views {
		if view.ID == modelID {
			return index, true
		}
	}
	return 0, false
}

// filterAnthropicLifecycle 只支持 active 状态：本地目录没有 deprecated /
// retired 记录，因此请求只含后两者时返回空页，而不是把 active 模型冒充成
// 已弃用或已退役。
func filterAnthropicLifecycle(views []modelView, lifecycles []string) []modelView {
	if len(lifecycles) == 0 {
		return views
	}
	for _, value := range lifecycles {
		if value == "active" {
			return views
		}
	}
	return nil
}

func newAnthropicModel(
	view modelView,
	windows map[string]modelmetadata.ContextWindow,
) anthropicModel {
	displayName := strings.TrimSpace(view.DisplayName)
	if displayName == "" {
		displayName = view.ID
	}
	model := anthropicModel{
		Type:        "model",
		ID:          view.ID,
		DisplayName: displayName,
		CreatedAt:   anthropicUnknownCreatedAt,
		Lifecycle:   "active",
	}
	if window, found := windows[view.ID]; found && window.IsValid() && window.Tokens > 0 {
		tokens := window.Tokens
		model.MaxInputTokens = &tokens
	}
	return model
}

func writeAnthropicError(
	response http.ResponseWriter,
	status int,
	errorType string,
	message string,
) {
	writeJSON(response, status, map[string]any{
		"type": "error",
		"error": map[string]string{
			"type":    errorType,
			"message": message,
		},
	})
}
