package responses

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"sort"
	"strings"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	// maxModelCatalogBytes 限制单次模型目录响应占用的内存。
	maxModelCatalogBytes = 8 * 1024 * 1024
	// maxModelCatalogModels 限制单次账号管理刷新可接收的模型数量。
	maxModelCatalogModels = 1024
	// maxModelCatalogErrorDrainBytes 有界排空小型错误响应以复用连接。
	maxModelCatalogErrorDrainBytes = 64 * 1024
	// maxDiagnosticModels 限制安全诊断中展示的模型标识数量。
	maxDiagnosticModels = 32
)

var (
	// errModelUnavailable 表示目标模型不在当前账号目录中。
	errModelUnavailable = errors.New("当前 Codex 账号不支持目标模型")
)

// modelCatalog 保存排序、去重后的账号模型标识。
//
// 排序切片让管理写侧可直接持久化稳定快照，并允许测试执行二分校验。
type modelCatalog struct {
	models []string
}

// count 返回当前目录中的模型数量。
func (catalog modelCatalog) count() int {
	return len(catalog.models)
}

// contains 使用二分查找判断账号是否拥有目标模型。
func (catalog modelCatalog) contains(model string) bool {
	if !validModelCatalogID(model) || len(catalog.models) == 0 {
		return false
	}
	index := sort.SearchStrings(catalog.models, model)
	return index < len(catalog.models) && catalog.models[index] == model
}

// diagnosticModels 返回排序且有界的模型标识副本。
func (catalog modelCatalog) diagnosticModels() []string {
	count := min(len(catalog.models), maxDiagnosticModels)
	return append([]string(nil), catalog.models[:count]...)
}

// require 精确校验目标 wire model，禁止静默别名或回退。
func (catalog modelCatalog) require(model string) error {
	if !validModelCatalogID(model) || len(catalog.models) == 0 {
		return ErrInvalidModelCatalog
	}
	if !catalog.contains(model) {
		return fmt.Errorf("%w: model=%s", errModelUnavailable, model)
	}
	return nil
}

// fetchModelCatalog 读取当前凭据对应的远端模型目录，不发起推理请求。
func fetchModelCatalog(
	ctx context.Context,
	client HTTPClient,
	auth authProjection,
) (modelCatalog, error) {
	if ctx == nil || client == nil {
		return modelCatalog{}, ErrInvalidDependencies
	}
	request, err := buildModelsRequest(ctx, auth)
	if err != nil {
		return modelCatalog{}, err
	}
	response, err := client.Do(request)
	if err != nil {
		closeResponse(response)
		if ctxErr := ctx.Err(); ctxErr != nil {
			return modelCatalog{}, ctxErr
		}
		return modelCatalog{}, ErrModelCatalogUnavailable
	}
	if response == nil || response.Body == nil {
		closeResponse(response)
		return modelCatalog{}, ErrInvalidModelCatalog
	}
	defer response.Body.Close()
	mediaType := classifyModelsMediaType(response.Header.Get("Content-Type"))
	if response.StatusCode < http.StatusOK ||
		response.StatusCode >= http.StatusMultipleChoices {
		drainModelCatalogResponse(response.Body)
		return modelCatalog{}, fmt.Errorf(
			"%w: status=%d media_type=%s",
			ErrModelCatalogUnavailable,
			response.StatusCode,
			mediaType,
		)
	}
	if mediaType != "application/json" {
		drainModelCatalogResponse(response.Body)
		return modelCatalog{}, fmt.Errorf(
			"%w: media_type=%s",
			ErrInvalidModelCatalog,
			mediaType,
		)
	}
	payload, err := io.ReadAll(io.LimitReader(
		response.Body,
		maxModelCatalogBytes+1,
	))
	if err != nil || len(payload) > maxModelCatalogBytes {
		clear(payload)
		return modelCatalog{}, ErrInvalidModelCatalog
	}
	defer clear(payload)
	return decodeModelCatalog(payload, auth.kind)
}

// drainModelCatalogResponse 有界丢弃正文，绝不把 Provider 错误内容写入日志。
func drainModelCatalogResponse(body io.Reader) {
	if body == nil {
		return
	}
	_, _ = io.Copy(
		io.Discard,
		io.LimitReader(body, maxModelCatalogErrorDrainBytes),
	)
}

// buildModelsRequest 对齐官方 Codex rust-v0.145.0 ModelsClient 请求合同。
func buildModelsRequest(
	ctx context.Context,
	auth authProjection,
) (*http.Request, error) {
	if ctx == nil {
		return nil, ErrInvalidInvocation
	}
	endpoint, err := modelsEndpoint(auth)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, ErrInvalidInvocation
	}
	request.Header.Set("Accept", "application/json")
	if err := applyAuthenticationHeaders(request, auth); err != nil {
		return nil, err
	}
	return request, nil
}

// modelsEndpoint 区分 ChatGPT OAuth 目录和标准 API Key 模型列表。
func modelsEndpoint(auth authProjection) (string, error) {
	parsed, err := url.Parse(auth.baseURL)
	if err != nil ||
		parsed.Scheme == "" ||
		parsed.Host == "" ||
		parsed.RawQuery != "" ||
		parsed.Fragment != "" {
		return "", ErrInvalidInvocation
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/") + "/models"
	parsed.RawPath = ""
	if auth.kind == codexauth.AuthKindOAuth {
		query := parsed.Query()
		query.Set("client_version", codexProtocolVersion)
		parsed.RawQuery = query.Encode()
	}
	return parsed.String(), nil
}

// classifyModelsMediaType 返回不包含 Provider 原始文本的安全类型。
func classifyModelsMediaType(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return "missing"
	}
	mediaType, _, err := mime.ParseMediaType(strings.TrimSpace(raw))
	if err != nil {
		return "invalid"
	}
	if mediaType == "application/json" || strings.HasSuffix(mediaType, "+json") {
		return "application/json"
	}
	return "other"
}

// modelIdentityDTO 是两类官方模型目录共享的最小只读投影。
type modelIdentityDTO struct {
	Slug string `json:"slug"`
	ID   string `json:"id"`
}

// modelCatalogEnvelopeDTO 同时覆盖 ChatGPT OAuth 和 OpenAI API Key 响应。
type modelCatalogEnvelopeDTO struct {
	Models *[]modelIdentityDTO `json:"models"`
	Data   *[]modelIdentityDTO `json:"data"`
}

// decodeModelCatalog 按认证类型选择唯一合法的目录字段。
func decodeModelCatalog(
	payload []byte,
	authKind codexauth.AuthKind,
) (modelCatalog, error) {
	var envelope modelCatalogEnvelopeDTO
	decoder := json.NewDecoder(bytes.NewReader(payload))
	if err := decoder.Decode(&envelope); err != nil ||
		decoder.Decode(&struct{}{}) != io.EOF {
		return modelCatalog{}, ErrInvalidModelCatalog
	}
	var entries []modelIdentityDTO
	switch authKind {
	case codexauth.AuthKindOAuth:
		if envelope.Models == nil || envelope.Data != nil {
			return modelCatalog{}, ErrInvalidModelCatalog
		}
		entries = *envelope.Models
	case codexauth.AuthKindAPIKey:
		if envelope.Data == nil || envelope.Models != nil {
			return modelCatalog{}, ErrInvalidModelCatalog
		}
		entries = *envelope.Data
	default:
		return modelCatalog{}, ErrInvalidModelCatalog
	}
	if len(entries) == 0 || len(entries) > maxModelCatalogModels {
		return modelCatalog{}, ErrInvalidModelCatalog
	}
	models := make([]string, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		model := entry.ID
		if authKind == codexauth.AuthKindOAuth {
			model = entry.Slug
		}
		if !validModelCatalogID(model) {
			return modelCatalog{}, ErrInvalidModelCatalog
		}
		if _, found := seen[model]; found {
			return modelCatalog{}, ErrInvalidModelCatalog
		}
		seen[model] = struct{}{}
		models = append(models, model)
	}
	sort.Strings(models)
	return modelCatalog{models: models}, nil
}

// validModelCatalogID 复用运行态真实模型 ID 的统一校验合同。
func validModelCatalogID(model string) bool {
	parsed, err := runtimecore.NewModelID(model)
	return err == nil && parsed.String() == model
}
