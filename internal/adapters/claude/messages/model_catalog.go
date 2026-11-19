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
	vendorendpoints "github.com/madou1217/ai_home/contracts/vendor-endpoints"
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
	// alternateHeaderName/Value 是同一凭据在另一门认证风格下的投影。
	// Claude 账号用 x-api-key，而第三方厂商的模型目录几乎都挂在 OpenAI 兼容
	// 端点上、只认 Authorization: Bearer（见 contracts/vendor-endpoints）。
	// 没有可用投影时保持零值，按该风格请求的候选会被跳过而不是发错头。
	alternateHeaderName  string
	alternateHeaderValue string
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
			claudeauth.EffectiveDefaultAPIBaseURL(),
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
		projection, err := newModelCatalogAuth(
			auth.BaseURL(),
			"x-api-key",
			auth.APIKey(),
			false,
		)
		if err != nil {
			return modelCatalogAuth{}, err
		}
		// 同一个 API Key 在厂商的 OpenAI 兼容端点上必须用 Bearer 发送。
		if auth.APIKey() != "" {
			projection.alternateHeaderName = "Authorization"
			projection.alternateHeaderValue = "Bearer " + auth.APIKey()
		}
		return projection, nil
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

// header 返回指定认证风格下的 Header；该风格没有可用投影时报告 false。
//
// 空风格沿用账号协议的原生头；"bearer" / "x-api-key" 是厂商目录端点声明的风格。
func (auth modelCatalogAuth) header(style string) (string, string, bool) {
	switch strings.ToLower(strings.TrimSpace(style)) {
	case "", "inherit", "native":
		if auth.headerName == "" || auth.headerValue == "" {
			return "", "", false
		}
		return auth.headerName, auth.headerValue, true
	case "bearer":
		if strings.EqualFold(auth.headerName, "Authorization") {
			return auth.headerName, auth.headerValue, true
		}
		if strings.EqualFold(auth.alternateHeaderName, "Authorization") &&
			auth.alternateHeaderValue != "" {
			return auth.alternateHeaderName, auth.alternateHeaderValue, true
		}
		return "", "", false
	case "x-api-key":
		if strings.EqualFold(auth.headerName, "x-api-key") {
			return auth.headerName, auth.headerValue, true
		}
		if strings.EqualFold(auth.alternateHeaderName, "x-api-key") &&
			auth.alternateHeaderValue != "" {
			return auth.alternateHeaderName, auth.alternateHeaderValue, true
		}
		return "", "", false
	default:
		return "", "", false
	}
}

// modelCatalogCandidate 是一个目录探测候选：端点、认证风格与条目过滤。
type modelCatalogCandidate struct {
	endpoint      string
	authStyle     string
	excludesModel func(string) bool
}

func (candidate modelCatalogCandidate) excludes(modelID string) bool {
	return candidate.excludesModel != nil && candidate.excludesModel(modelID)
}

// fetchModelCatalog 依次探测候选端点，第一个返回非空目录的端点胜出。
//
// 候选顺序：厂商契约声明的目录端点（如千问 Anthropic 兼容 base 的模型目录挂在
// 同厂商 OpenAI 兼容端点上），再复刻 Node 的 generic-models-probe：<base>/models、
// <base>/v1/models，最后由 origin 根路径兜底。每个候选只发一次请求，响应同时按
// Anthropic 分页形状与 OpenAI 形状解析 —— 第三方代理常见的 {object,data:[{id}]}
// 不会先失败再重试。
func fetchModelCatalog(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
) (modelCatalog, error) {
	if ctx == nil || client == nil {
		return modelCatalog{}, ErrInvalidDependencies
	}
	candidates := modelCatalogPlan(auth.baseURL)
	failures := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if _, _, usable := auth.header(candidate.authStyle); !usable {
			continue
		}
		models, err := fetchCatalogAt(ctx, client, auth, candidate)
		if err != nil {
			failures = append(failures, candidate.endpoint+" -> "+err.Error())
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

// modelCatalogPlan 组装探测计划：厂商契约目录端点优先，再走通用兜底。
func modelCatalogPlan(baseURL string) []modelCatalogCandidate {
	candidates := vendorModelCatalogCandidates(baseURL)
	for _, endpoint := range modelCatalogCandidates(baseURL) {
		candidates = append(candidates, modelCatalogCandidate{endpoint: endpoint})
	}
	// 同一端点可能以不同认证风格各试一次（厂商目录端点恰好等于通用兜底端点时），
	// 按「端点 + 风格」去重并保持先厂商后通用的顺序。
	seen := make(map[string]struct{}, len(candidates))
	deduped := make([]modelCatalogCandidate, 0, len(candidates))
	for _, candidate := range candidates {
		key := candidate.endpoint + "\x00" + candidate.authStyle
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		deduped = append(deduped, candidate)
	}
	return deduped
}

// vendorModelCatalogCandidates 读取厂商契约声明的目录端点。
//
// 典型场景：千问/百炼的 Anthropic 兼容 base 上没有任何 /models 端点，模型目录
// 挂在同厂商的 OpenAI 兼容端点上、且只认 Bearer。厂商事实见
// contracts/vendor-endpoints/endpoints.json。
func vendorModelCatalogCandidates(baseURL string) []modelCatalogCandidate {
	resolution, found := vendorendpoints.Resolve(baseURL)
	if !found {
		return nil
	}
	entries := resolution.CatalogEndpoints()
	candidates := make([]modelCatalogCandidate, 0, len(entries))
	for _, entry := range entries {
		endpoint := strings.TrimSpace(entry.URL)
		if endpoint == "" {
			continue
		}
		candidates = append(candidates, modelCatalogCandidate{
			endpoint:      endpoint,
			authStyle:     strings.TrimSpace(entry.Auth),
			excludesModel: entry.ExcludesModel,
		})
	}
	return candidates
}

// modelCatalogCandidates 复刻 Node 的候选顺序（base 优先，其次 origin 根路径）。
func modelCatalogCandidates(baseURL string) []string {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil
	}
	base := strings.TrimRight(parsed.String(), "/")
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	// base 本身就是 Models 端点（显式 /models 结尾）：先原样请求，再试 origin。
	// 这与重构前的 modelsEndpoint 行为一致，避免把端点拼成 /models/models。
	candidates := make([]string, 0, 4)
	if strings.HasSuffix(strings.ToLower(path), "/models") {
		candidates = append(candidates, base)
	} else {
		// 与 Node 的 pathStyle 一致：base 已经以 /vN 结尾时只拼 /models，
		// 否则同时试 /models 与 /v1/models。
		candidates = append(candidates, base+"/models")
		if !endsWithVersionSegment(path) {
			candidates = append(candidates, base+"/v1/models")
		}
	}
	if path != "" {
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

// endsWithVersionSegment 判断路径是否已经带 API 版本段（如 /v1、/v1beta）。
func endsWithVersionSegment(path string) bool {
	last := path
	if index := strings.LastIndex(path, "/"); index >= 0 {
		last = path[index+1:]
	}
	if len(last) < 2 || last[0] != 'v' {
		return false
	}
	for _, character := range last[1:] {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

// fetchCatalogAt 读取单个候选端点的目录；Anthropic 分页形状会继续翻页。
func fetchCatalogAt(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
	candidate modelCatalogCandidate,
) ([]string, error) {
	payload, err := fetchCatalogPayload(ctx, client, auth, candidate, "")
	if err != nil {
		return nil, err
	}
	page, anthropicShape := decodeAnthropicCatalogPage(payload)
	if anthropicShape {
		return collectAnthropicPages(ctx, client, auth, candidate, page)
	}
	models, hadEntries, excluded := parseOpenAIModels(payload, candidate)
	if len(models) == 0 {
		// 目录有条目、却既没有可用 ID 也不是被厂商规则过滤掉的，才算合同无效；
		// 全被规则过滤（如 Anthropic 端点下的图片模型）保持「无可用模型」语义。
		if hadEntries > 0 && excluded == 0 {
			return nil, ErrInvalidModelCatalog
		}
		return nil, nil
	}
	return models, nil
}

func collectAnthropicPages(
	ctx context.Context,
	client HTTPClient,
	auth modelCatalogAuth,
	candidate modelCatalogCandidate,
	first modelCatalogPageDTO,
) ([]string, error) {
	models := make([]string, 0, modelCatalogPageLimit)
	seenModels := make(map[string]struct{}, modelCatalogPageLimit)
	seenCursors := make(map[string]struct{}, maxModelCatalogPages)
	page := first
	cursor := ""
	entries := 0
	excluded := 0
	for range maxModelCatalogPages {
		for _, entry := range *page.Data {
			entries++
			// 第三方 Anthropic 兼容中转会在这份分页目录里混入不能作为运行态键的
			// 条目（如带空格的 “claude fable 5.2”）。单个不可用条目不应作废整份
			// 目录：跳过它，与 OpenAI 形状解析的过滤规则保持一致。
			if !validModelCatalogID(entry.ID) {
				continue
			}
			// 厂商契约声明的过滤（如 Anthropic 兼容端点只服务文本生成类模型）。
			if candidate.excludes(entry.ID) {
				excluded++
				continue
			}
			if len(models) >= maxModelCatalogModels {
				return nil, ErrInvalidModelCatalog
			}
			if _, found := seenModels[entry.ID]; found {
				continue
			}
			seenModels[entry.ID] = struct{}{}
			models = append(models, entry.ID)
		}
		if !*page.HasMore {
			// 目录有条目但全部不可用才算合同无效；空目录、以及全部被厂商规则
			// 过滤掉（非文本模型）都保持「无可用模型」语义。
			if entries > 0 && len(models) == 0 && excluded == 0 {
				return nil, ErrInvalidModelCatalog
			}
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
		payload, err := fetchCatalogPayload(ctx, client, auth, candidate, cursor)
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
	candidate modelCatalogCandidate,
	cursor string,
) ([]byte, error) {
	headerName, headerValue, usable := auth.header(candidate.authStyle)
	if !usable {
		return nil, ErrInvalidInvocation
	}
	parsed, err := url.Parse(candidate.endpoint)
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
	request.Header.Set(headerName, headerValue)
	// oauth beta 头只对 Bearer 投影有意义：厂商目录端点的 Bearer 是 API Key，
	// 带上 oauth beta 只会让不认识它的服务端困惑。
	if auth.oauthBeta && strings.EqualFold(headerName, "Authorization") {
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
//
// 返回值除模型外还带两个计数：目录里是否有条目（hadEntries）与有多少条被厂商
// 规则过滤掉（excluded）。调用方据此区分「合同无效」与「有效目录但没有可服务
// 的模型」，不把厂商的过滤规则误报成解析失败。
func parseOpenAIModels(
	payload []byte,
	candidate modelCatalogCandidate,
) (models []string, hadEntries int, excluded int) {
	var document openAIModelListDTO
	if json.Unmarshal(payload, &document) != nil {
		return nil, 0, 0
	}
	entries := document.Data
	if len(entries) == 0 {
		entries = document.Models
	}
	hadEntries = len(entries)
	seen := make(map[string]struct{}, len(entries))
	models = make([]string, 0, len(entries))
	for _, entry := range entries {
		id := strings.TrimSpace(firstModelID(entry.ID, entry.Model, entry.Name))
		if !validModelCatalogID(id) {
			continue
		}
		if candidate.excludes(id) {
			excluded++
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
		if len(models) > maxModelCatalogModels {
			return nil, hadEntries, excluded
		}
	}
	if len(models) == 0 {
		return nil, hadEntries, excluded
	}
	sort.Strings(models)
	return models, hadEntries, excluded
}

func firstModelID(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}
