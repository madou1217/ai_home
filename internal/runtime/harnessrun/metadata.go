package harnessrun

import (
	"encoding/json"
	"strconv"
	"strings"
	"sync"
)

// modelCost 是 models.dev 的每百万 token 价格投影。
type modelCost struct {
	Input      float64 `json:"input"`
	Output     float64 `json:"output"`
	CacheRead  float64 `json:"cacheRead"`
	CacheWrite float64 `json:"cacheWrite"`
}

type modelMetadata struct {
	Name      string     `json:"name,omitempty"`
	Reasoning bool       `json:"reasoning,omitempty"`
	Context   int64      `json:"context,omitempty"`
	Output    int64      `json:"output,omitempty"`
	Input     []string   `json:"input,omitempty"`
	Cost      *modelCost `json:"cost,omitempty"`
}

type rawMetadataDocument struct {
	Providers map[string]map[string]modelMetadata `json:"providers"`
	Models    map[string]modelMetadata            `json:"models"`
}

var (
	metadataOnce     sync.Once
	metadataDocument modelMetadataDocument
)

type modelMetadataDocument struct {
	providers map[string]map[string]modelMetadata
	models    map[string]modelMetadata
}

func loadModelMetadata() *modelMetadataDocument {
	metadataOnce.Do(func() {
		var document rawMetadataDocument
		if json.Unmarshal(modelsDevMetadataSource, &document) == nil {
			metadataDocument.providers = document.Providers
			metadataDocument.models = document.Models
		}
		if metadataDocument.providers == nil {
			metadataDocument.providers = map[string]map[string]modelMetadata{}
		}
		if metadataDocument.models == nil {
			metadataDocument.models = map[string]modelMetadata{}
		}
	})
	return &metadataDocument
}

// providerMetadataCandidates 与 Node models-dev-metadata.js 的
// MODELS_DEV_PROVIDER_CANDIDATES 同序；未知 Provider 走 canonical 基座回退。
var providerMetadataCandidates = map[string][]string{
	"codex":       {"openai", "github-copilot"},
	"claude":      {"anthropic"},
	"gemini":      {"google", "google-vertex"},
	"opencode":    {"opencode-go", "opencode"},
	"cline":       {"cline-pass"},
	"grok":        {"xai", "github-copilot"},
	"kimi":        {"kimi-code-plan-global", "kimi-code-plan-cn", "moonshotai-cn", "moonshotai", "kimi-for-coding"},
	"zcode":       {"zai-coding-plan", "zhipuai-coding-plan", "zai", "zhipuai"},
	"codebuddy":   {"opencode-go", "tencent-token-plan"},
	"codebuddycn": {"opencode-go", "tencent-token-plan"},
	"workbuddy":   {"opencode-go", "tencent-token-plan"},
	"workbuddycn": {"opencode-go", "tencent-token-plan"},
	"agy":         {"anthropic", "github-copilot", "google", "google-vertex", "openai", "xai"},
}

var metadataBasePrefixes = []string{
	"openai", "anthropic", "google", "xai", "moonshotai", "zhipuai", "zhipu",
	"deepseek", "minimax", "alibaba", "qwen", "xiaomi", "stepfun", "nvidia", "mistralai",
}

// lookupModelMetadata 按与 Node createModelsDevReader 相同的顺序找元数据：
// provider 目录精确命中 → canonical 基座模型 → 逐段裁掉能力/档位后缀。
func lookupModelMetadata(provider, modelID string) (modelMetadata, bool) {
	index := loadModelMetadata()
	provider = strings.ToLower(strings.TrimSpace(provider))
	modelID = strings.TrimSpace(modelID)
	if modelID == "" {
		return modelMetadata{}, false
	}
	for _, namespace := range providerMetadataCandidates[provider] {
		if metadata, found := lookupProviderMetadata(index, namespace, modelID); found {
			return metadata, true
		}
	}
	for _, candidate := range metadataBaseCandidates(modelID) {
		if metadata, found := index.models[normalizeMetadataID(candidate)]; found {
			if metadata.Cost == nil {
				if slash := strings.Index(candidate, "/"); slash > 0 {
					if providerMetadata, ok := lookupProviderMetadata(index, candidate[:slash], candidate[slash+1:]); ok && providerMetadata.Cost != nil {
						metadata.Cost = providerMetadata.Cost
					}
				}
			}
			return metadata, true
		}
	}
	return modelMetadata{}, false
}

func lookupProviderMetadata(index *modelMetadataDocument, namespace, modelID string) (modelMetadata, bool) {
	models := index.providers[strings.ToLower(strings.TrimSpace(namespace))]
	if len(models) == 0 {
		return modelMetadata{}, false
	}
	for _, variant := range metadataModelVariants(modelID) {
		if metadata, found := models[normalizeMetadataID(variant)]; found {
			return metadata, true
		}
	}
	return modelMetadata{}, false
}

func normalizeMetadataID(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func metadataModelVariants(modelID string) []string {
	stripped := strings.TrimSpace(modelID)
	stripped = strings.TrimPrefix(stripped, "opencode-go/")
	stripped = strings.TrimPrefix(stripped, "opencode/")
	variants := []string{stripped}
	versionNormalized := replaceVersionDots(stripped)
	if versionNormalized != stripped {
		variants = append(variants, versionNormalized)
	}
	if withoutBracket := stripBracketSuffix(stripped); withoutBracket != stripped {
		variants = append(variants, withoutBracket)
	}
	if withoutDate := stripDateTag(stripped); withoutDate != stripped {
		variants = append(variants, withoutDate)
	}
	return uniqueStrings(variants)
}

func metadataBaseCandidates(modelID string) []string {
	modelID = strings.TrimSpace(modelID)
	candidates := make([]string, 0, 16)
	if strings.Contains(modelID, "/") {
		candidates = append(candidates, modelID)
	}
	for _, variant := range metadataModelVariants(modelID) {
		for _, prefix := range metadataBasePrefixes {
			for _, base := range metadataBaseForPrefix(variant, prefix) {
				candidates = append(candidates, prefix+"/"+base)
			}
		}
		trimmed := variant
		for strings.Contains(trimmed, "-") {
			index := strings.LastIndex(trimmed, "-")
			trimmed = trimmed[:index]
			if trimmed == "" {
				break
			}
			for _, prefix := range metadataBasePrefixes {
				candidates = append(candidates, prefix+"/"+trimmed)
			}
			if strings.Contains(trimmed, "/") {
				candidates = append(candidates, trimmed)
			}
		}
	}
	return uniqueStrings(candidates)
}

func metadataBaseForPrefix(variant, prefix string) []string {
	lower := strings.ToLower(variant)
	switch prefix {
	case "openai":
		if strings.HasPrefix(lower, "gpt-") || strings.HasPrefix(lower, "chatgpt-") || strings.HasPrefix(lower, "text-embedding-") {
			return []string{variant}
		}
		if len(lower) > 1 && lower[0] == 'o' && lower[1] >= '0' && lower[1] <= '9' {
			return []string{variant}
		}
	case "anthropic":
		if strings.HasPrefix(lower, "claude-") {
			return []string{variant}
		}
	case "google":
		if strings.HasPrefix(lower, "gemini-") || strings.HasPrefix(lower, "gemma-") {
			return []string{variant}
		}
	case "xai":
		if strings.HasPrefix(lower, "grok-") {
			return []string{variant}
		}
	case "moonshotai":
		if strings.HasPrefix(lower, "kimi-") {
			return []string{variant}
		}
	case "zhipuai":
		if strings.HasPrefix(lower, "glm-") {
			return []string{variant}
		}
	case "deepseek":
		if strings.HasPrefix(lower, "deepseek-") {
			return []string{variant}
		}
	case "minimax":
		if strings.HasPrefix(lower, "minimax-") {
			return []string{variant}
		}
	case "alibaba", "qwen":
		if strings.HasPrefix(lower, "qwen") {
			return []string{variant}
		}
	case "xiaomi":
		if strings.HasPrefix(lower, "mimo-") {
			return []string{variant}
		}
	case "stepfun":
		if strings.HasPrefix(lower, "step-") {
			return []string{variant}
		}
	case "nvidia":
		if strings.HasPrefix(lower, "nemotron-") {
			return []string{variant}
		}
	case "mistralai":
		if strings.HasPrefix(lower, "mistral-") {
			return []string{variant}
		}
	}
	return nil
}

func replaceVersionDots(value string) string {
	var builder strings.Builder
	for index := 0; index < len(value); index++ {
		if value[index] == '.' && index > 0 && index+1 < len(value) &&
			value[index-1] >= '0' && value[index-1] <= '9' && value[index+1] >= '0' && value[index+1] <= '9' {
			builder.WriteByte('-')
			continue
		}
		builder.WriteByte(value[index])
	}
	return builder.String()
}

func stripBracketSuffix(value string) string {
	if index := strings.LastIndex(value, "["); index > 0 && strings.HasSuffix(value, "]") {
		return value[:index]
	}
	return value
}

func stripDateTag(value string) string {
	if index := strings.LastIndex(value, ":"); index > 0 && index+5 == len(value) {
		if _, err := strconv.Atoi(value[index+1:]); err == nil {
			return value[:index]
		}
	}
	return value
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	result := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}
