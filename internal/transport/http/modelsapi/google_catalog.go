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
	// googleAPIKeyHeader 是 Google GenAI SDK / 原生 Gemini REST 客户端使用的
	// 鉴权头。它同时是 /v1/models 上的协议信号：带这个头的请求回答 Google
	// Models API 形状，而不是 OpenAI 形状。
	googleAPIKeyHeader = "x-goog-api-key"

	// Google Models API 的分页默认值与上限。
	googleDefaultPageSize = 50
	googleMaxPageSize     = 1000
)

// googleCatalogOptions 是 Google Models API 的列表查询参数。
type googleCatalogOptions struct {
	pageSize int
	offset   int
}

// ViewOptions 让 Google 分支只构建响应真正需要的字段；Google Model 对象
// 不输出 AIH 的 aih_modalities / supported_endpoints 扩展。
func (googleCatalogOptions) ViewOptions() catalogViewOptions {
	return catalogViewOptions{}
}

// googleCatalogDialect 实现 Google Gemini Models API 的列表与单模型合同。
//
// Google GenAI SDK 在 base_url 指向网关根路径时请求 /v1/models；原生 REST
// 客户端（或显式 /v1beta 基址）请求 /v1beta/models。两条路径都归本 dialect，
// 因此标准 SDK 不需要改代码就能拿到 Google 的 {models,nextPageToken} 形状。
type googleCatalogDialect struct{}

func (googleCatalogDialect) Matches(request *http.Request) bool {
	if request == nil {
		return false
	}
	if strings.TrimSpace(request.Header.Get(googleAPIKeyHeader)) != "" {
		return true
	}
	return request.URL.Path == BetaPath || strings.HasPrefix(request.URL.Path, BetaPathPrefix)
}

func (googleCatalogDialect) ParseQuery(rawQuery string) (catalogQuery, error) {
	options, err := parseGoogleCatalogOptions(rawQuery)
	if err != nil {
		return nil, err
	}
	return options, nil
}

func (dialect googleCatalogDialect) RenderList(
	response http.ResponseWriter,
	context catalogRenderContext,
) {
	options, ok := context.query.(googleCatalogOptions)
	if !ok {
		dialect.WriteProblem(response, catalogProblemInternal, errInvalidCatalogQuery)
		return
	}
	var windows map[string]modelmetadata.ContextWindow
	if context.handler.contextWindows != nil {
		windows, _ = context.handler.contextWindows.ReadContextWindows(context.request.Context())
	}
	start := options.offset
	if start > len(context.views) {
		start = len(context.views)
	}
	end := min(start+options.pageSize, len(context.views))
	models := make([]googleModel, 0, end-start)
	for _, view := range context.views[start:end] {
		models = append(models, newGoogleModel(view, windows))
	}
	payload := googleModelList{Models: models}
	if end < len(context.views) {
		payload.NextPageToken = strconv.Itoa(end)
	}
	writeJSON(response, http.StatusOK, payload)
}

func (googleCatalogDialect) RenderModel(
	response http.ResponseWriter,
	request *http.Request,
	modelID string,
) {
	if request.Method == http.MethodHead {
		writeJSONHeaders(response, http.StatusOK)
		return
	}
	writeJSON(response, http.StatusOK, newGoogleModel(modelView{ID: modelID}, nil))
}

func (googleCatalogDialect) WriteProblem(
	response http.ResponseWriter,
	problem catalogProblem,
	cause error,
) {
	status := http.StatusInternalServerError
	statusName := "INTERNAL"
	message := "Model catalog is unavailable"
	switch problem {
	case catalogProblemInvalidQuery:
		status = http.StatusBadRequest
		statusName = "INVALID_ARGUMENT"
		message = "Invalid query parameters"
		if cause != nil && strings.TrimSpace(cause.Error()) != "" {
			message = cause.Error()
		}
	case catalogProblemUnauthorized:
		status = http.StatusUnauthorized
		statusName = "UNAUTHENTICATED"
		message = "Invalid API key"
	case catalogProblemForbidden:
		status = http.StatusForbidden
		statusName = "PERMISSION_DENIED"
		message = coreclientkeys.MessageModelNotAllowed
	case catalogProblemMethodNotAllowed:
		status = http.StatusMethodNotAllowed
		statusName = "FAILED_PRECONDITION"
		message = "Method not allowed"
	case catalogProblemNotFound:
		status = http.StatusNotFound
		statusName = "NOT_FOUND"
		message = "Resource not found"
	}
	writeGoogleError(response, status, statusName, message)
}

// parseGoogleCatalogOptions 只接受 Google Models API 的分页参数。
func parseGoogleCatalogOptions(rawQuery string) (googleCatalogOptions, error) {
	options := googleCatalogOptions{pageSize: googleDefaultPageSize}
	if rawQuery == "" {
		return options, nil
	}
	values, err := url.ParseQuery(rawQuery)
	if err != nil || len(values) == 0 {
		return googleCatalogOptions{}, errors.New("invalid query string")
	}
	for key, list := range values {
		switch key {
		case "pageSize", "pageToken":
			if len(list) != 1 {
				return googleCatalogOptions{}, fmt.Errorf("%s must appear exactly once", key)
			}
		default:
			return googleCatalogOptions{}, fmt.Errorf("unsupported query parameter %q", key)
		}
	}
	if list, found := values["pageSize"]; found {
		value, convertErr := strconv.Atoi(strings.TrimSpace(list[0]))
		if convertErr != nil || value < 1 || value > googleMaxPageSize {
			return googleCatalogOptions{}, errors.New("pageSize must be an integer between 1 and 1000")
		}
		options.pageSize = value
	}
	if list, found := values["pageToken"]; found {
		value, convertErr := strconv.Atoi(strings.TrimSpace(list[0]))
		if convertErr != nil || value < 0 {
			return googleCatalogOptions{}, errors.New("invalid pageToken")
		}
		options.offset = value
	}
	return options, nil
}

// googleModel 是 Gemini Models API 的模型对象。目录没有的输出上限、
// 采样参数等字段保持缺省，不用猜测值填充。
type googleModel struct {
	Name                       string   `json:"name"`
	DisplayName                string   `json:"displayName,omitempty"`
	InputTokenLimit            *int64   `json:"inputTokenLimit,omitempty"`
	SupportedGenerationMethods []string `json:"supportedGenerationMethods,omitempty"`
}

// googleModelList 是 Gemini Models API 的列表 envelope。
type googleModelList struct {
	Models        []googleModel `json:"models"`
	NextPageToken string        `json:"nextPageToken,omitempty"`
}

func newGoogleModel(
	view modelView,
	windows map[string]modelmetadata.ContextWindow,
) googleModel {
	displayName := strings.TrimSpace(view.DisplayName)
	if displayName == "" {
		displayName = view.ID
	}
	model := googleModel{
		Name:        "models/" + view.ID,
		DisplayName: displayName,
		// 这两个入口都由网关承接；countTokens 尚未实现，不能在这里冒充。
		SupportedGenerationMethods: []string{"generateContent", "streamGenerateContent"},
	}
	if window, found := windows[view.ID]; found && window.IsValid() && window.Tokens > 0 {
		tokens := window.Tokens
		model.InputTokenLimit = &tokens
	}
	return model
}

func writeGoogleError(
	response http.ResponseWriter,
	status int,
	statusName string,
	message string,
) {
	writeJSON(response, status, map[string]any{
		"error": map[string]any{
			"code":    status,
			"message": message,
			"status":  statusName,
		},
	})
}
