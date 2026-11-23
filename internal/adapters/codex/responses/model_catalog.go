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

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
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

// modelCatalog 保存排序、去重后的账号模型标识与上游声明的推理档位。
//
// 排序切片让管理写侧可直接持久化稳定快照，并允许测试执行二分校验。
// ladders 只保存上游明确声明了档位的模型；缺失表示该端点没有声明，而不是“没有档位”。
type modelCatalog struct {
	models []string
	// facts 是上游目录声明的低敏能力事实（档位、模态、上下文、显示名）。
	facts []modelmetadata.ModelFacts
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
		catalogErr := fmt.Errorf(
			"%w: status=%d media_type=%s",
			ErrModelCatalogUnavailable,
			response.StatusCode,
			mediaType,
		)
		if response.StatusCode == http.StatusUnauthorized {
			return modelCatalog{}, fmt.Errorf("%w: %w", accountapp.ErrModelAuthenticationRejected, catalogErr)
		}
		return modelCatalog{}, catalogErr
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

// buildModelsRequest 对齐官方 Codex rust-v0.146.0 ModelsClient 请求合同。
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
		// OAuth 目录按 client_version 过滤模型：写死旧版本会让新模型（gpt-6-*）永远不可见。
		// 只按真实观测到的版本过滤；拿不到就不带该参数，而不是用一个过期版本。
		if version := strings.TrimSpace(auth.clientVersion); version != "" {
			query.Set("client_version", version)
			parsed.RawQuery = query.Encode()
		}
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
	// Visibility 与 SupportedInAPI 是上游对目录项的公开性声明；与 Node 的
	// filterCodexModelEntries 一致，隐藏项与不支持 API 的项不进入账号目录。
	Visibility     string `json:"visibility"`
	SupportedInAPI *bool  `json:"supported_in_api"`
	// SupportedReasoningLevels 是 Codex 官方目录（OAuth）声明的推理档位。
	SupportedReasoningLevels []modelReasoningLevelDTO `json:"supported_reasoning_levels"`
	// AIHReasoningEfforts 是 AI Home 兼容目录（API Key 端点）声明的推理档位。
	AIHReasoningEfforts []string `json:"aih_reasoning_efforts"`
	// InputModalities 是官方 Codex 目录声明的输入模态；输出按 Responses 合同为纯文本。
	InputModalities []string `json:"input_modalities"`
	// AIHModalities 是 AI Home 兼容目录声明的完整模态对。
	AIHModalities *modelModalitiesDTO `json:"aih_modalities"`
	// ContextWindow 是官方目录声明的输入上下文窗口；0 表示未声明。
	ContextWindow int64 `json:"context_window"`
	// DisplayName 是官方目录声明的显示名。
	DisplayName string `json:"display_name"`
}

// modelModalitiesDTO 是 AI Home 兼容目录的模态对。
type modelModalitiesDTO struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// modelReasoningLevelDTO 是官方 Codex 目录的单个推理档位项。
type modelReasoningLevelDTO struct {
	Effort string `json:"effort"`
}

// modelFacts 把目录项转换成能力事实；未声明的字段保持零值。
func modelFacts(entry modelIdentityDTO, model string) modelmetadata.ModelFacts {
	facts := modelmetadata.ModelFacts{ModelID: model, DisplayName: entry.DisplayName}
	if ladder, ok := reasoningLadder(entry); ok {
		facts.ReasoningEfforts = ladder
	}
	if entry.ContextWindow > 0 {
		facts.ContextWindow = int(entry.ContextWindow)
	}
	input, output := entry.InputModalities, []string(nil)
	if entry.AIHModalities != nil {
		input, output = entry.AIHModalities.Input, entry.AIHModalities.Output
	} else if len(input) > 0 && len(output) == 0 {
		output = []string{"text"}
	}
	if len(input) > 0 && len(output) > 0 {
		if modalities, err := modelmetadata.NewModalities(input, output); err == nil {
			facts.HasModalities = true
			facts.Modalities = modalities
		}
	}
	return facts
}

// reasoningLadder 只读取上游明确声明的档位；未知档位丢弃，空结果表示未声明。
//
// 两个字段形状不同但语义相同：官方目录给对象数组，AI Home 兼容目录给字符串数组。
// 同时出现时合并，由统一规范化去重并排序，绝不按目录书写顺序推断强弱。
func reasoningLadder(entry modelIdentityDTO) ([]inference.ReasoningEffort, bool) {
	values := make(
		[]inference.ReasoningEffort,
		0,
		len(entry.SupportedReasoningLevels)+len(entry.AIHReasoningEfforts),
	)
	for _, level := range entry.SupportedReasoningLevels {
		values = append(values, inference.ReasoningEffort(strings.TrimSpace(level.Effort)))
	}
	for _, effort := range entry.AIHReasoningEfforts {
		values = append(values, inference.ReasoningEffort(strings.TrimSpace(effort)))
	}
	return modelmetadata.NormalizeReasoningLadder(values)
}

// listedModelIdentity 判断目录项是否对客户端公开：显式 supported_in_api=false 或
// 非 list/default/public 的 visibility 都视为隐藏（缺省视为公开）。
func listedModelIdentity(entry modelIdentityDTO) bool {
	if entry.SupportedInAPI != nil && !*entry.SupportedInAPI {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(entry.Visibility)) {
	case "", "list", "default", "public":
		return true
	default:
		return false
	}
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
	facts := make([]modelmetadata.ModelFacts, 0, len(entries))
	seen := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		model := entry.ID
		if authKind == codexauth.AuthKindOAuth {
			model = entry.Slug
		}
		if !validModelCatalogID(model) {
			return modelCatalog{}, ErrInvalidModelCatalog
		}
		if !listedModelIdentity(entry) {
			continue
		}
		if _, found := seen[model]; found {
			return modelCatalog{}, ErrInvalidModelCatalog
		}
		seen[model] = struct{}{}
		models = append(models, model)
		facts = append(facts, modelFacts(entry, model))
	}
	if len(models) == 0 {
		return modelCatalog{}, ErrInvalidModelCatalog
	}
	sort.Strings(models)
	return modelCatalog{models: models, facts: facts}, nil
}

// validModelCatalogID 复用运行态真实模型 ID 的统一校验合同。
func validModelCatalogID(model string) bool {
	parsed, err := runtimecore.NewModelID(model)
	return err == nil && parsed.String() == model
}
