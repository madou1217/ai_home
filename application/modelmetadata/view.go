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

// 模型归属（`owned_by`）的厂商命名空间。
//
// 这些取值是跨契约的稳定词表，不是随手起的：WebUI 会反查它们把模型归到 Provider 分组
// （anthropic→claude、openai→codex、google→gemini、zhipu→zcode、opencode→opencode）。
// 因此 `owned_by` 必须是厂商名而不是 AIH 的 Provider ID——写 `claude`/`agy`/`zcode`
// 会让 WebUI 的分组整块落空。词表只在 application/modelmetadata 定义一次，调用方不要再写字面量。
const (
	OwnerAnthropic   = "anthropic"
	OwnerGoogle      = "google"
	OwnerOpenAI      = "openai"
	OwnerMoonshot    = "moonshotai"
	OwnerZhipu       = "zhipu"
	OwnerOpenCode    = "opencode"
	OwnerOpenCodeGo  = "opencode-go"
	OwnerOpenCodeZen = "opencode-zen"
	// OwnerCline 是 cline 插件的自有模型前缀归属。
	OwnerCline = "cline"
	// OwnerFallback 是判不出归属时的兜底（聚合 Provider 承载多家模型时即如此）。
	OwnerFallback = "aih-server"
)

// ResolveModelOwner 按「模型 ID 优先、Provider 兜底」解析模型归属厂商。
//
// 模型 ID 优先于 Provider：同一个模型可能被多个 Provider 服务，按 ID 判归属才能让
// 所有契约对同一个模型给出同一个答案。两侧输入都先归一为小写：上游偶尔返回混合
// 大小写的 ID，归一后是「多认出来」而不是认错。
func ResolveModelOwner(provider string, modelID string) string {
	owner := resolveOwnerFromModel(modelID)
	if owner != "" {
		return owner
	}
	if owner := resolveOwnerFromProvider(provider); owner != "" {
		return owner
	}
	return OwnerFallback
}

// resolveOwnerFromModel 按模型名前缀推断厂商归属。
//
// 分支顺序不能重排：`opencode-go/` 必须先于 `opencode/`，`opencode/` 必须先于
// `opencode-`，否则 `opencode-go/...` 会被后面那条抢先命中。
func resolveOwnerFromModel(modelID string) string {
	modelID = strings.ToLower(strings.TrimSpace(modelID))
	switch {
	case strings.HasPrefix(modelID, "cline-pass/"):
		return OwnerCline
	case strings.HasPrefix(modelID, "opencode-go/"):
		return OwnerOpenCodeGo
	case strings.HasPrefix(modelID, "opencode/"):
		return OwnerOpenCodeZen
	case strings.HasPrefix(modelID, "claude-") || strings.HasPrefix(modelID, "anthropic."):
		return OwnerAnthropic
	case strings.HasPrefix(modelID, "gemini-") || strings.Contains(modelID, "google"):
		return OwnerGoogle
	case strings.HasPrefix(modelID, "opencode-"):
		return OwnerOpenCode
	case strings.HasPrefix(modelID, "gpt-") || strings.HasPrefix(modelID, "o1") || strings.HasPrefix(modelID, "o3") || strings.HasPrefix(modelID, "o4"):
		return OwnerOpenAI
	case strings.HasPrefix(modelID, "kimi-") || modelID == "k3" || strings.HasPrefix(modelID, "k3-"):
		return OwnerMoonshot
	case strings.HasPrefix(modelID, "glm-"):
		return OwnerZhipu
	default:
		return ""
	}
}

// resolveOwnerFromProvider 在模型名认不出来时按 Provider 推断厂商归属。
//
// 只登记有稳定厂商对应的 Provider：聚合 Provider（agy / qoder / kiro / codebuddy /
// workbuddy …）承载多家模型，映射到任何单一厂商都是猜错，留给 OwnerFallback。
func resolveOwnerFromProvider(provider string) string {
	return ownerByProvider[strings.ToLower(strings.TrimSpace(provider))]
}

// ownerByProvider 只登记有稳定厂商对应的 Provider；聚合 Provider
// （agy / qoder / kiro / codebuddy / workbuddy 等）刻意不在此表里。
var ownerByProvider = map[string]string{
	"claude":   OwnerAnthropic,
	"gemini":   OwnerGoogle,
	"codex":    OwnerOpenAI,
	"opencode": OwnerOpenCode,
	"kimi":     OwnerMoonshot,
	"zcode":    OwnerZhipu,
	"cline":    OwnerCline,
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
