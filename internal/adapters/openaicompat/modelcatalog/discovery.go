// Package modelcatalog 提供「标准 OpenAI 兼容端点」的**无客户端模型发现**。
//
// 适用范围：上游就是标准 OpenAI 形态的 Provider（`GET {base}/models` 返回
// `{"data":[{"id":"..."}]}`）。目前服务 kimi 与 grok；新增同形 Provider 只需加一条
// 注册项（端点 + 凭据取法），不必再写一份发现实现。
//
// 为什么单列一个包而不是塞进某个 Provider：模型发现是**协议形状**的能力，与 Provider
// 身份无关 —— 这与 relaycore 对「同协议透传」的判断同源。差异只在端点与鉴权头，
// 由调用方以注册项声明。
package modelcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/modelmetadata"
)

const (
	// ModelsPath 是标准 OpenAI 兼容端点的模型清单路径。
	ModelsPath = "/models"
	// maxModelsResponseBytes 限制响应正文读取上限，避免异常响应拖垮刷新 worker。
	maxModelsResponseBytes = 1 << 20
)

var (
	// ErrInvalidDependencies 表示目录源缺少 HTTP 客户端。
	ErrInvalidDependencies = errors.New("模型目录源依赖无效")
	// ErrProviderMismatch 表示凭据归属与目录源不一致。
	ErrProviderMismatch = errors.New("模型目录源凭据归属不符")
	// ErrEmptyCatalog 表示响应结构不认或清单为空。
	//
	// 与「账号真的没有可用模型」是两件事：返回错误让刷新保持旧目录（last-known-good），
	// 返回空清单会把已有目录清掉。
	ErrEmptyCatalog = errors.New("模型目录响应不含模型清单")
)

// HTTPClient 是读取模型清单所需的最小端口。
type HTTPClient interface {
	Do(request *http.Request) (*http.Response, error)
}

// TokenFunc 从凭据里取鉴权令牌。
type TokenFunc func(credential accountapp.Credential) (string, error)

// ErrUnsupportedCredentialKind 表示该账号的凭据形态不支持 HTTP 模型发现。
//
// 典型是 grok：`GET /models` 只认 API Key，OAuth 登录态会被上游 403。这类账号的目录
// 只能靠本地 CLI（Node 侧就是这么做的），因此这里**明确拒绝**而不是发一个必被 403 的
// 请求 —— 拒绝让刷新保持旧目录（last-known-good），403 会让它反复重试。
var ErrUnsupportedCredentialKind = errors.New("该凭据形态不支持 HTTP 模型发现")

// Source 是一个 Provider 的模型目录源。
type Source struct {
	client     HTTPClient
	providerID string
	endpoint   string
	token      TokenFunc
	// extraHeaders 是该 Provider 要求的额外头（如 kimi 的设备指纹）。
	extraHeaders func(credential accountapp.Credential) map[string]string
	// supportsCredential 判定凭据形态是否支持 HTTP 发现；nil 表示全部支持。
	supportsCredential func(credential accountapp.Credential) bool
	descriptors        modelmetadata.ModelDescriptorRegistrar
}

// 编译期确认实现统一 Provider 发现策略。
var _ accountapp.ProviderModelDiscoverer = (*Source)(nil)

// Options 是构造目录源的输入。
type Options struct {
	// ProviderID 是本源服务的 Provider。
	ProviderID string
	// Endpoint 是完整的模型清单 URL（含 /models）。
	Endpoint string
	// Token 从凭据取鉴权令牌。
	Token TokenFunc
	// ExtraHeaders 返回该 Provider 要求的额外请求头（可为 nil）。
	ExtraHeaders func(credential accountapp.Credential) map[string]string
	// SupportsCredential 判定该凭据形态能否走 HTTP 发现；nil 表示全部支持。
	//
	// grok 需要它：`GET /models` 只认 API Key，OAuth 账号会被 403。
	SupportsCredential func(credential accountapp.Credential) bool
	// Descriptors 是可选的运行时能力覆盖接收端；为空时只刷新模型 ID。
	Descriptors modelmetadata.ModelDescriptorRegistrar
}

// New 创建目录源。
func New(client HTTPClient, options Options) (*Source, error) {
	if client == nil || strings.TrimSpace(options.ProviderID) == "" ||
		strings.TrimSpace(options.Endpoint) == "" || options.Token == nil {
		return nil, ErrInvalidDependencies
	}
	return &Source{
		client:             client,
		providerID:         strings.TrimSpace(options.ProviderID),
		endpoint:           strings.TrimSpace(options.Endpoint),
		token:              options.Token,
		extraHeaders:       options.ExtraHeaders,
		supportsCredential: options.SupportsCredential,
		descriptors:        options.Descriptors,
	}, nil
}

// ProviderID 返回该源服务的 Provider。
func (source *Source) ProviderID() string { return source.providerID }

// DiscoverModels 拉取完整模型清单。
func (source *Source) DiscoverModels(
	ctx context.Context,
	credential accountapp.Credential,
) ([]string, error) {
	if source == nil || source.client == nil || ctx == nil || credential == nil {
		return nil, ErrInvalidDependencies
	}
	if credential.ProviderID() != source.providerID {
		return nil, ErrProviderMismatch
	}
	if source.supportsCredential != nil && !source.supportsCredential(credential) {
		return nil, ErrUnsupportedCredentialKind
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	token, err := source.token(credential)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, source.endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if source.extraHeaders != nil {
		for name, value := range source.extraHeaders(credential) {
			if strings.TrimSpace(name) != "" && strings.TrimSpace(value) != "" {
				request.Header.Set(name, value)
			}
		}
	}
	response, err := source.client.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("模型清单请求失败: HTTP %d", response.StatusCode)
	}
	payload, err := io.ReadAll(io.LimitReader(response.Body, maxModelsResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(payload)) > maxModelsResponseBytes {
		return nil, ErrEmptyCatalog
	}
	models := ParseModels(payload)
	if len(models) == 0 {
		return nil, ErrEmptyCatalog
	}
	if source.descriptors != nil {
		descriptors := ParseModelDescriptors(source.providerID, payload)
		if len(descriptors) > 0 {
			if err := source.descriptors.ReplaceModelDescriptors(source.providerID, descriptors); err != nil {
				return nil, fmt.Errorf("发布模型能力描述失败: %w", err)
			}
		}
	}
	return models, nil
}

// ParseModels 解析标准 OpenAI 模型清单（`{"data":[{"id":"..."}]}`）。
//
// 逐字段宽容：单个条目形状不符不让整份清单作废（与 Node 侧同口径）。
func ParseModels(payload []byte) []string {
	var document struct {
		Data []struct {
			ID string `json:"id"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil
	}
	models := make([]string, 0, len(document.Data))
	seen := make(map[string]struct{}, len(document.Data))
	for _, entry := range document.Data {
		id := strings.TrimSpace(entry.ID)
		if id == "" {
			continue
		}
		if _, exists := seen[id]; exists {
			continue
		}
		seen[id] = struct{}{}
		models = append(models, id)
	}
	return models
}

// ParseModelDescriptors 从标准模型清单中提取已确认的低敏模态事实。
// 模型 ID 解析保持 ParseModels 的宽容语义；能力字段必须存在且是 JSON bool。
func ParseModelDescriptors(providerID string, payload []byte) []modelmetadata.ModelDescriptor {
	var document struct {
		Data []struct {
			ID            string          `json:"id"`
			SupportsImage json.RawMessage `json:"supports_image_in"`
			SupportsVideo json.RawMessage `json:"supports_video_in"`
		} `json:"data"`
	}
	if err := json.Unmarshal(payload, &document); err != nil {
		return nil
	}
	descriptors := make([]modelmetadata.ModelDescriptor, 0, len(document.Data))
	for _, entry := range document.Data {
		image := parseBoolean(entry.SupportsImage)
		video := parseBoolean(entry.SupportsVideo)
		input := []string{"text"}
		if image {
			input = append(input, "image")
		}
		if video {
			input = append(input, "video")
		}
		modalities, err := modelmetadata.NewModalities(input, []string{"text"})
		if err != nil {
			continue
		}
		descriptor, err := modelmetadata.NewModelDescriptor(modelmetadata.ModelDescriptorInput{
			ProviderID: providerID,
			ModelID:    strings.TrimSpace(entry.ID),
			Modalities: modalities,
		})
		if err != nil {
			continue
		}
		descriptors = append(descriptors, descriptor)
	}
	return descriptors
}

func parseBoolean(raw json.RawMessage) bool {
	trimmed := strings.TrimSpace(string(raw))
	return trimmed == "true"
}
