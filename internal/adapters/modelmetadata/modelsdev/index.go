// Package modelsdev 提供由 @opencode-ai/models SDK 离线快照生成的进程内只读模态索引。
package modelsdev

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"github.com/madou1217/ai_home/application/modelmetadata"
)

var (
	// ErrInvalidSnapshot 表示嵌入快照损坏或不满足应用层值对象合同。
	ErrInvalidSnapshot = errors.New("models.dev 嵌入模态快照无效")
	// embeddedSnapshot 由 Go 生成器从 @opencode-ai/models SDK 快照派生（npm run models:generate）。
	//go:embed modalities.json
	embeddedSnapshot []byte
)

// snapshotRecord 是生成快照的 JSON 传输形状。
type snapshotRecord struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// Index 保存启动时构建后不再修改的 O(1) 模态查找表。
type Index struct {
	models map[string]modelmetadata.Modalities
}

// 编译期确认索引满足 HTTP 模型目录所依赖的应用层端口。
var _ modelmetadata.Reader = (*Index)(nil)

// New 解码并完整校验嵌入快照；损坏时失败关闭，避免发布虚假能力。
func New() (*Index, error) {
	var records map[string]snapshotRecord
	if err := json.Unmarshal(embeddedSnapshot, &records); err != nil || len(records) == 0 {
		return nil, fmt.Errorf("%w: %v", ErrInvalidSnapshot, err)
	}
	models := make(map[string]modelmetadata.Modalities, len(records))
	for modelID, record := range records {
		if strings.TrimSpace(modelID) == "" || modelID != strings.TrimSpace(modelID) {
			return nil, ErrInvalidSnapshot
		}
		modalities, err := modelmetadata.NewModalities(record.Input, record.Output)
		if err != nil {
			return nil, fmt.Errorf("%w: %s", ErrInvalidSnapshot, modelID)
		}
		models[modelID] = modalities
	}
	return &Index{models: models}, nil
}

// LookupModalities 按 AIH Provider 和真实模型 ID 返回不可变值对象。
//
// 解析顺序与 Node 的 models-dev-metadata 一致，分三层：
//  1. 该 Provider 的候选命名空间按序精确命中（聚合 Provider 在这里才能查到自己的模型）；
//  2. 基座模型回退：按模型名前缀推断厂商命名空间；
//  3. 逐步裁掉尾段再试——provider 自定义的能力/档位后缀（…-thinking、…-high）在固定
//     目录里不存在，落到基座模型的模态即可。
//
// 任何一层都不命中时返回未命中，由调用方决定降级策略（模型目录降级为纯文本，
// vision guard 走家族兜底）。
func (index *Index) LookupModalities(
	providerID string,
	modelID string,
) (modelmetadata.Modalities, bool) {
	if index == nil || index.models == nil {
		return modelmetadata.Modalities{}, false
	}
	id := strings.TrimSpace(modelID)
	if id == "" {
		return modelmetadata.Modalities{}, false
	}
	stripped := stripKnownModelPrefix(id)
	for _, namespace := range providerNamespacesFor(providerID, id, stripped) {
		if modalities, found := index.models[namespace+"/"+stripped]; found {
			return modalities, true
		}
	}
	for _, key := range baseModelCandidates(id, stripped) {
		if modalities, found := index.models[key]; found {
			return modalities, true
		}
	}
	return modelmetadata.Modalities{}, false
}

// providerNamespacesFor 返回该 Provider 与模型组合的候选 models.dev 命名空间（按序）。
//
// 只登记「查得到才有意义」的候选：聚合 Provider 的模型 ID 来自多个厂商，因此候选是
// 一组命名空间而不是一个；没有稳定候选的 Provider 返回空，交给基座回退按模型 ID 推断。
func providerNamespacesFor(
	providerID string,
	modelID string,
	strippedModelID string,
) []string {
	// 模型 ID 自带聚合前缀时，前缀本身就是最精确的候选。
	if strings.HasPrefix(modelID, "opencode-go/") {
		return []string{"opencode-go"}
	}
	if strings.HasPrefix(modelID, "opencode/") {
		return []string{"opencode"}
	}
	switch strings.ToLower(strings.TrimSpace(providerID)) {
	case "codex":
		return []string{"openai", "github-copilot"}
	case "claude":
		return []string{"anthropic"}
	case "gemini":
		return []string{"google", "google-vertex"}
	case "opencode":
		return []string{"opencode-go", "opencode"}
	case "agy":
		// Antigravity 承载多家模型，候选按模型名前缀选择。
		switch {
		case hasPrefixFold(strippedModelID, "claude-"):
			return []string{"anthropic", "github-copilot", "google-vertex"}
		case hasPrefixFold(strippedModelID, "gemini-"),
			hasPrefixFold(strippedModelID, "gemma-"):
			return []string{"google", "github-copilot", "google-vertex"}
		case isOpenAIFamily(strippedModelID):
			return []string{"openai", "github-copilot"}
		case hasPrefixFold(strippedModelID, "grok-"):
			return []string{"xai"}
		default:
			return []string{"github-copilot"}
		}
	case "kimi":
		// OAuth 走 kimi-for-coding；api-key 走 moonshotai-cn / moonshotai。
		return []string{"kimi-for-coding", "moonshotai-cn", "moonshotai"}
	case "zcode":
		// GLM 模型挂在 Z.AI / 智谱 Coding Plan。
		return []string{"zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai"}
	default:
		return nil
	}
}

// baseModelCandidates 返回基座模型候选键（厂商前缀推断 + 逐步裁尾）。
func baseModelCandidates(modelID string, strippedModelID string) []string {
	candidates := make([]string, 0, 16)
	if strings.Contains(modelID, "/") {
		candidates = append(candidates, modelID)
	}
	// 与 Node 一致：这些判断彼此独立，不做 else 短路。
	if isOpenAIFamily(strippedModelID) {
		candidates = append(candidates, "openai/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "claude-") {
		candidates = append(candidates, "anthropic/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "gemini-") || hasPrefixFold(strippedModelID, "gemma-") {
		candidates = append(candidates, "google/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "grok-") {
		candidates = append(candidates, "xai/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "kimi-") {
		candidates = append(candidates, "moonshotai/"+strippedModelID)
	}
	if hasPrefixFold(strippedModelID, "glm-") {
		candidates = append(candidates, "zhipuai/"+strippedModelID, "zhipu/"+strippedModelID)
	}
	// 能力/档位后缀变体：逐步裁掉尾段，落到基座模型的元数据。
	trimmed := strippedModelID
	for strings.Contains(trimmed, "-") {
		trimmed = trimmed[:strings.LastIndex(trimmed, "-")]
		if trimmed == "" {
			break
		}
		for _, prefix := range baseModelNamespaces {
			candidates = append(candidates, prefix+"/"+trimmed)
		}
		if strings.Contains(trimmed, "/") {
			candidates = append(candidates, trimmed)
		}
	}
	return candidates
}

// baseModelNamespaces 是基座回退会尝试的命名空间。
var baseModelNamespaces = []string{
	"openai",
	"anthropic",
	"google",
	"xai",
	"moonshotai",
	"zhipuai",
	"zhipu",
}

// stripKnownModelPrefix 去掉模型 ID 自带的聚合前缀。
func stripKnownModelPrefix(modelID string) string {
	switch {
	case strings.HasPrefix(modelID, "opencode-go/"):
		return modelID[len("opencode-go/"):]
	case strings.HasPrefix(modelID, "opencode/"):
		return modelID[len("opencode/"):]
	default:
		return modelID
	}
}

// isOpenAIFamily 判断模型名是否属于 OpenAI 命名空间下的家族。
func isOpenAIFamily(modelID string) bool {
	lowered := strings.ToLower(modelID)
	if strings.HasPrefix(lowered, "gpt-") ||
		strings.HasPrefix(lowered, "chatgpt-") ||
		strings.HasPrefix(lowered, "text-embedding-") {
		return true
	}
	// o1 / o3 / o4 这类推理模型：o 紧跟一位数字。
	if len(lowered) >= 2 && lowered[0] == 'o' && lowered[1] >= '0' && lowered[1] <= '9' {
		return true
	}
	return false
}

// hasPrefixFold 判断是否以指定前缀开头（大小写不敏感）。
func hasPrefixFold(value string, prefix string) bool {
	return len(value) >= len(prefix) && strings.EqualFold(value[:len(prefix)], prefix)
}

//go:generate npm run --prefix ../../../.. models:generate
