package modelmetadata

import (
	"strings"
	"time"

	"github.com/madou1217/ai_home/core/inference"
)

// ModalitiesView 是模型目录接口对外的模态投影。
//
// 它不复用值对象内部切片，避免调用方在序列化前后看到共享可变状态。
type ModalitiesView struct {
	Input  []string `json:"input"`
	Output []string `json:"output"`
}

// AliasExpander 把通配模型别名展开成具体模型 ID。
//
// 数据来自哪个目录由插件实现决定；宿主只依赖本端口，不感知具体来源。
type AliasExpander interface {
	ListWildcardAliasModels(pattern string, now time.Time) []string
}

// ResolveModalities 通过元数据端口解析模态；查不到时保留 text/text 的展示口径。
func ResolveModalities(reader Reader, providerID string, modelID string) ModalitiesView {
	if reader != nil {
		if modalities, found := reader.LookupOrInferModalities(providerID, modelID); found {
			input := modalities.Input()
			output := modalities.Output()
			if len(input) > 0 || len(output) > 0 {
				return ModalitiesView{Input: input, Output: output}
			}
		}
	}
	return ModalitiesView{Input: []string{"text"}, Output: []string{"text"}}
}

// ResolveReasoningEfforts 通过元数据端口解析推理强度档位。
//
// 未知模型返回 nil，不猜测档位：猜错会把用户明确要求的 high 静默降档。
func ResolveReasoningEfforts(reader ReasoningLadderReader, providerID string, modelID string) []string {
	if reader == nil {
		return nil
	}
	ladder, found := reader.LookupReasoningEfforts(providerID, modelID)
	if !found || len(ladder) == 0 {
		return nil
	}
	out := make([]string, 0, len(ladder))
	for _, value := range ladder {
		if value != inference.ReasoningEffort("") && value.IsValid() {
			out = append(out, string(value))
		}
	}
	return out
}

// ResolveModelOwner 按「模型 ID 优先、Provider 兜底」解析模型归属厂商。
func ResolveModelOwner(provider string, modelID string) string {
	switch {
	case strings.HasPrefix(modelID, "cline-pass/"):
		return "cline"
	case strings.HasPrefix(modelID, "opencode-go/"):
		return "opencode-go"
	case strings.HasPrefix(modelID, "opencode/"):
		return "opencode-zen"
	case strings.HasPrefix(modelID, "claude-") || strings.HasPrefix(modelID, "anthropic."):
		return "anthropic"
	case strings.HasPrefix(modelID, "gemini-") || strings.Contains(modelID, "google"):
		return "google"
	case strings.HasPrefix(modelID, "opencode-"):
		return "opencode"
	case strings.HasPrefix(modelID, "gpt-") || strings.HasPrefix(modelID, "o1") || strings.HasPrefix(modelID, "o3") || strings.HasPrefix(modelID, "o4"):
		return "openai"
	case strings.HasPrefix(modelID, "kimi-") || modelID == "k3" || strings.HasPrefix(modelID, "k3-"):
		return "moonshotai"
	case strings.HasPrefix(modelID, "glm-"):
		return "zhipu"
	}
	switch provider {
	case "claude":
		return "anthropic"
	case "gemini":
		return "google"
	case "codex":
		return "openai"
	case "opencode":
		return "opencode"
	case "kimi":
		return "moonshotai"
	case "zcode":
		return "zhipu"
	case "cline":
		return "cline"
	}
	return "aih-server"
}

// ResolveOpenAIProviderFromModel 把 OpenAI 风格模型条目映射到 AIH Provider。
//
// 返回值是 Provider 插件 ID；无法判定时返回空串，由调用方决定是否丢弃。
func ResolveOpenAIProviderFromModel(modelID string, ownedBy string) string {
	id := strings.ToLower(strings.TrimSpace(modelID))
	owner := strings.ToLower(strings.TrimSpace(ownedBy))
	switch {
	case owner == "openai" || strings.HasPrefix(id, "gpt-") || strings.HasPrefix(id, "o1") || strings.HasPrefix(id, "o3") || strings.HasPrefix(id, "o4"):
		return "codex"
	case owner == "zhipu" || strings.HasPrefix(id, "glm-"):
		return "zcode"
	case owner == "google" || strings.HasPrefix(id, "gemini-"):
		return "gemini"
	case owner == "anthropic" || strings.HasPrefix(id, "claude-") || strings.HasPrefix(id, "anthropic."):
		return "claude"
	case owner == "opencode" || strings.HasPrefix(id, "opencode-go/") || strings.HasPrefix(id, "opencode/"):
		return "opencode"
	default:
		return ""
	}
}
