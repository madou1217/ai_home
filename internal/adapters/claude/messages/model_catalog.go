package messages

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

const (
	// modelCatalogPageLimit 与 Anthropic Models API 的显式分页合同一致。
	modelCatalogPageLimit = 100
	// maxModelCatalogPages 防止异常游标制造无界目录请求。
	maxModelCatalogPages = 16
	// maxModelCatalogModels 限制单次账号管理刷新可接收的模型数量。
	maxModelCatalogModels = 1024
	// maxModelCatalogPageBytes 限制单页目录响应的内存占用。
	maxModelCatalogPageBytes = 8 * 1024 * 1024
	// maxModelCatalogErrorDrainBytes 有界排空错误响应以帮助连接复用。
	maxModelCatalogErrorDrainBytes = 64 * 1024
)

// modelCatalog 保存排序、去重后的 Claude 管理写侧模型快照。
type modelCatalog struct {
	models []string
}

// modelCatalogAuth 是模型目录所需的最小端点和认证投影。
//
// 该值包含进程内明文凭据，禁止进入日志、错误文本或持久化。
type modelCatalogAuth struct {
	baseURL     string
	headerName  string
	headerValue string
	oauthBeta   bool
}

// projectModelCatalogAuth 把四类 Claude 领域凭据投影成 Models API 合同。
func projectModelCatalogAuth(
	credential accountapp.Credential,
) (modelCatalogAuth, error) {
	switch auth := credential.(type) {
	case *claudeauth.OAuthAuth:
		if auth == nil {
			return modelCatalogAuth{}, ErrInvalidInvocation
		}
		return newModelCatalogBearerAuth(
			claudeauth.DefaultAPIBaseURL,
			auth.AccessToken(),
			true,
		)
	case *claudeauth.OAuthTokenAuth:
		if auth == nil {
			return modelCatalogAuth{}, ErrInvalidInvocation
		}
		return newModelCatalogBearerAuth(
			auth.BaseURL(),
			auth.AccessToken(),
			true,
		)
	case *claudeauth.APIKeyAuth:
		if auth == nil {
			return modelCatalogAuth{}, ErrInvalidInvocation
		}
		return newModelCatalogAuth(
			auth.BaseURL(),
			"x-api-key",
			auth.APIKey(),
			false,
		)
	case *claudeauth.AuthTokenAuth:
		if auth == nil {
			return modelCatalogAuth{}, ErrInvalidInvocation
		}
		return newModelCatalogBearerAuth(
			auth.BaseURL(),
			auth.AuthToken(),
			false,
		)
	default:
		return modelCatalogAuth{}, ErrInvalidInvocation
	}
}

// newModelCatalogBearerAuth 创建 Authorization Bearer 目录投影。
func newModelCatalogBearerAuth(
	baseURL string,
	token string,
	oauthBeta bool,
) (modelCatalogAuth, error) {
	if token == "" {
		return modelCatalogAuth{}, ErrInvalidInvocation
	}
	return newModelCatalogAuth(
		baseURL,
		"Authorization",
		"Bearer "+token,
		oauthBeta,
	)
}

// newModelCatalogAuth 校验模型目录端点和认证 Header。
func newModelCatalogAuth(
	baseURL string,
	headerName string,
	headerValue string,
	oauthBeta bool,
) (modelCatalogAuth, error) {
	if _, err := modelsEndpoint(baseURL); err != nil ||
		headerName == "" ||
		headerValue == "" {
		return modelCatalogAuth{}, ErrInvalidInvocation
	}
	return modelCatalogAuth{
		baseURL:     baseURL,
		headerName:  headerName,
		headerValue: headerValue,
		oauthBeta:   oauthBeta,
	}, nil
}

// fetchModelCatalog 依次探测候选端点，第一个返回非空目录的端点胜出。
//
// 候选顺序复刻 Node 的 generic-models-probe：<base>/models、<base>/v1/models，
// 再由 origin 根路径兜底。每个候选只发一次请求，响应同时按 Anthropic 分页形状
// 与 OpenAI 形状解析 —— 第三方代理常见的 {object,data:[{id}]} 不会先失败再重试。
func fetchModelCatalog(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
) (modelCatalog, error) {
	if ctx == nil || client == nil {
		return modelCatalog{}, ErrInvalidDependencies
	}
	candidates := modelCatalogCandidates(auth.baseURL)
	failures := make([]string, 0, len(candidates))
	for _, endpoint := range candidates {
		models, err := fetchCatalogAt(ctx, client, auth, endpoint)
		if err != nil {
			failures = append(failures, endpoint+" -> "+err.Error())
			if ctxErr := ctx.Err(); ctxErr != nil {
				return modelCatalog{}, ctxErr
			}
			continue
		}
		if len(models) == 0 {
			continue
		}
		return modelCatalog{models: models}, nil
	}
	if len(failures) == 0 {
		return modelCatalog{}, ErrModelCatalogUnavailable
	}
	// 错误里带上每个候选的端点与原因：401/429/超时不能再被报成 404。
	return modelCatalog{}, fmt.Errorf(
		"%w: %s",
		ErrModelCatalogUnavailable,
		strings.Join(failures, " | "),
	)
}

// modelCatalogCandidates 复刻 Node 的候选顺序（base 优先，其次 origin 根路径）。
func modelCatalogCandidates(baseURL string) []string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil
	}
	base := strings.TrimRight(parsed.String(), "/")
	candidates := []string{base + "/models", base + "/v1/models"}
	if path := strings.TrimRight(parsed.EscapedPath(), "/"); path != "" {
		origin := parsed.Scheme + "://" + parsed.Host
		candidates = append(candidates, origin+"/v1/models", origin+"/models")
	}
	seen := make(map[string]struct{}, len(candidates))
	endpoints := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if _, exists := seen[candidate]; exists {
			continue
		}
		seen[candidate] = struct{}{}
		endpoints = append(endpoints, candidate)
	}
	return endpoints
}

// fetchCatalogAt 读取单个候选端点的目录；Anthropic 分页形状会继续翻页。
func fetchCatalogAt(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
	endpoint string,
) ([]string, error) {
	payload, err := fetchCatalogPayload(ctx, client, auth, endpoint, "")
	if err != nil {
		return nil, err
	}
	page, anthropicShape := decodeAnthropicCatalogPage(payload)
	if anthropicShape {
		return collectAnthropicPages(ctx, client, auth, endpoint, page)
	}
	models := parseOpenAIModels(payload)
	if len(models) == 0 {
		return nil, ErrInvalidModelCatalog
	}
	return models, nil
}

func collectAnthropicPages(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
	endpoint string,
	first modelCatalogPageDTO,
) ([]string, error) {
	models := make([]string, 0, modelCatalogPageLimit)
	seenModels := make(map[string]struct{}, modelCatalogPageLimit)
	seenCursors := make(map[string]struct{}, maxModelCatalogPages)
	page := first
	cursor := ""
	for range maxModelCatalogPages {
		for _, entry := range *page.Data {
			if !validModelCatalogID(entry.ID) || len(models) >= maxModelCatalogModels {
				return nil, ErrInvalidModelCatalog
			}
			if _, found := seenModels[entry.ID]; found {
				return nil, ErrInvalidModelCatalog
			}
			seenModels[entry.ID] = struct{}{}
			models = append(models, entry.ID)
		}
		if !*page.HasMore {
			sort.Strings(models)
			return models, nil
		}
		if page.LastID == nil || !validModelCatalogID(*page.LastID) || len(*page.Data) == 0 {
			return nil, ErrInvalidModelCatalog
		}
		cursor = *page.LastID
		if _, found := seenCursors[cursor]; found {
			return nil, ErrInvalidModelCatalog
		}
		seenCursors[cursor] = struct{}{}
		payload, err := fetchCatalogPayload(ctx, client, auth, endpoint, cursor)
		if err != nil {
			return nil, err
		}
		next, ok := decodeAnthropicCatalogPage(payload)
		if !ok {
			return nil, ErrInvalidModelCatalog
		}
		page = next
	}
	return nil, ErrInvalidModelCatalog
}

// fetchCatalogPayload 执行一次 GET 并返回 JSON 正文。
func fetchCatalogPayload(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
	endpoint string,
	cursor string,
) ([]byte, error) {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	query := parsed.Query()
	query.Set("limit", strconv.Itoa(modelCatalogPageLimit))
	if cursor != "" {
		query.Set("after_id", cursor)
	}
	parsed.RawQuery = query.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("anthropic-version", anthropicVersion)
	request.Header.Set(auth.headerName, auth.headerValue)
	if auth.oauthBeta {
		request.Header.Set("anthropic-beta", betaOAuth)
	}
	response, err := client.Do(request)
	if err != nil {
		closeResponse(response)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		return nil, ErrModelCatalogUnavailable
	}
	if response == nil || response.Body == nil {
		closeResponse(response)
		return nil, ErrInvalidModelCatalog
	}
	defer response.Body.Close()
	mediaType := classifyModelCatalogMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		drainModelCatalogResponse(response.Body)
		return nil, fmt.Errorf(
			"%w: status=%d media_type=%s",
			ErrModelCatalogUnavailable,
			response.StatusCode,
			mediaType,
		)
	}
	if mediaType != "application/json" {
		drainModelCatalogResponse(response.Body)
		return nil, fmt.Errorf("%w: media_type=%s", ErrInvalidModelCatalog, mediaType)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxModelCatalogPageBytes+1))
	if err != nil || len(payload) == 0 || len(payload) > maxModelCatalogPageBytes {
		clear(payload)
		return nil, ErrInvalidModelCatalog
	}
	return payload, nil
}

func decodeAnthropicCatalogPage(payload []byte) (modelCatalogPageDTO, bool) {
	page, err := decodeModelCatalogPage(payload)
	if err != nil {
		return modelCatalogPageDTO{}, false
	}
	return page, true
}

// modelIdentityDTO 是 Models API 条目的最小账号权限投影。
type modelIdentityDTO struct {
	ID string `json:"id"`
}

// modelCatalogPageDTO 保留判断分页完整性所需的字段存在性。
type modelCatalogPageDTO struct {
	Data    *[]modelIdentityDTO `json:"data"`
	HasMore *bool               `json:"has_more"`
	FirstID *string             `json:"first_id"`
	LastID  *string             `json:"last_id"`
}

// modelsEndpoint 同时支持 host、带 /v1 的基址和显式 Models 端点。
func modelsEndpoint(baseURL string) (string, error) {
	parsed, err := url.Parse(baseURL)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidInvocation
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	switch {
	case strings.HasSuffix(path, "/v1/models"):
	case strings.HasSuffix(path, "/v1"):
		path += "/models"
	default:
		path += "/v1/models"
	}
	parsed.RawPath = path
	parsed.Path, err = url.PathUnescape(path)
	if err != nil {
		return "", ErrInvalidInvocation
	}
	return parsed.String(), nil
}

// decodeModelCatalogPage 拒绝缺字段、无效 JSON 和尾随内容。
func decodeModelCatalogPage(
	payload []byte,
) (modelCatalogPageDTO, error) {
	var page modelCatalogPageDTO
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(&page); err != nil ||
		decoder.Decode(&struct{}{}) != io.EOF ||
		page.Data == nil ||
		page.HasMore == nil ||
		!validModelCatalogPageCursors(page) {
		return modelCatalogPageDTO{}, ErrInvalidModelCatalog
	}
	return page, nil
}

// validModelCatalogPageCursors 复核非空页的首尾游标与条目顺序一致。
func validModelCatalogPageCursors(page modelCatalogPageDTO) bool {
	if page.Data == nil || page.HasMore == nil {
		return false
	}
	entries := *page.Data
	if len(entries) == 0 {
		return !*page.HasMore
	}
	return page.FirstID != nil &&
		page.LastID != nil &&
		*page.FirstID == entries[0].ID &&
		*page.LastID == entries[len(entries)-1].ID
}

// classifyModelCatalogMediaType 返回不包含 Provider 原始文本的安全分类。
func classifyModelCatalogMediaType(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "missing"
	}
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(raw))
	if err != nil {
		return "invalid"
	}
	if isJSONMediaType(mediaType) {
		return "application/json"
	}
	return "other"
}

// drainModelCatalogResponse 有界丢弃正文，禁止记录 Provider 错误文本。
func drainModelCatalogResponse(body io.Reader) {
	if body == nil {
		return
	}
	_, _ = io.Copy(
		io.Discard,
		io.LimitReader(body, maxModelCatalogErrorDrainBytes),
	)
}

// validModelCatalogID 复用运行态真实模型 ID 的统一校验合同。
func validModelCatalogID(model string) bool {
	parsed, err := runtimecore.NewModelID(model)
	return err == nil && parsed.String() == model
}

// openAIModelListDTO 是第三方 Anthropic 兼容代理常见的 OpenAI 风格清单。
type openAIModelListDTO struct {
	Data []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Model string `json:"model"`
	} `json:"data"`
	Models []struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Model string `json:"model"`
	} `json:"models"`
}

// parseOpenAIModels 解析 {data:[{id}]} 或 {models:[{id|name}]} 形状。
func parseOpenAIModels(payload []byte) []string {
	var document openAIModelListDTO
	if json.Unmarshal(payload, &document) != nil {
		return nil
	}
	entries := document.Data
	if len(entries) == 0 {
		entries = document.Models
	}
	seen := make(map[string]struct{}, len(entries))
	models := make([]string, 0, len(entries))
	for _, entry := range entries {
		id := strings.TrimSpace(firstModelID(entry.ID, entry.Model, entry.Name))
		if !validModelCatalogID(id) {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
		if len(models) > maxModelCatalogModels {
			return nil
		}
	}
	if len(models) == 0 {
		return nil
	}
	sort.Strings(models)
	return models
}

func firstModelID(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
