package modelsapi

import "strings"

// 模型归属（`owned_by`）的厂商命名空间。
//
// 这些取值不是随手起的：Node 的 WebUI 会**反查**它们来把模型归到 Provider 分组
// （`lib/server/webui-openai-model-routes.js` 的 `resolveProviderFromOpenAIModel`：
// anthropic→claude、openai→codex、google→gemini、zhipu→zcode、opencode→opencode）。
// 因此 `owned_by` 必须是厂商名而不是 AIH 的 Provider ID——写 `claude`/`agy`/`zcode`
// 会让 WebUI 的分组整块落空。
const (
	ownerAnthropic   = "anthropic"
	ownerGoogle      = "google"
	ownerOpenAI      = "openai"
	ownerMoonshot    = "moonshotai"
	ownerZhipu       = "zhipu"
	ownerOpenCode    = "opencode"
	ownerOpenCodeGo  = "opencode-go"
	ownerOpenCodeZen = "opencode-zen"
	// ownerFallback 是判不出归属时的兜底，与 Node 的 `|| 'aih-server'` 一致。
	ownerFallback = "aih-server"
)

// resolveModelOwner 复刻 Node 的
// `inferModelOwnerFromId(id) || inferModelOwnerFromProvider(provider) || 'aih-server'`
// （`lib/server/models.js`）。
//
// 模型 ID 优先于 Provider：同一个模型可能被多个 Provider 服务（`shared-model` 这类），
// 按 ID 判归属才能让两端对同一个模型给出同一个答案。
func resolveModelOwner(providerID string, modelID string) string {
	if owner := inferOwnerFromModelID(modelID); owner != "" {
		return owner
	}
	if owner := inferOwnerFromProvider(providerID); owner != "" {
		return owner
	}
	return ownerFallback
}

// inferOwnerFromModelID 按模型名前缀推断厂商归属。
//
// 分支顺序与 Node 完全一致，不能重排：`opencode-go/` 必须先于 `opencode/`，
// `opencode/` 必须先于 `opencode-`，否则 `opencode-go/...` 会被后面那条抢先命中。
//
// 与 Node 的唯一差别是大小写：Node 用区分大小写的 `startsWith`，这里先转小写再判。
// 模型 ID 在两端都是规范小写（Node 的 registry 走 `normalizeModelId`，Go 的
// `runtimecore.NewModelID` 保留原样但上游返回的就是小写），因此这条差别只在
// 「上游返回了混合大小写的 ID」时显现，且方向是**多认出来**而不是认错。
func inferOwnerFromModelID(modelID string) string {
	id := strings.ToLower(strings.TrimSpace(modelID))
	switch {
	case strings.HasPrefix(id, "opencode-go/"):
		return ownerOpenCodeGo
	case strings.HasPrefix(id, "opencode/"):
		return ownerOpenCodeZen
	case strings.HasPrefix(id, "claude-"), strings.HasPrefix(id, "anthropic."):
		return ownerAnthropic
	case strings.HasPrefix(id, "gemini-"), strings.Contains(id, "google"):
		return ownerGoogle
	case strings.HasPrefix(id, "opencode-"):
		return ownerOpenCode
	case strings.HasPrefix(id, "gpt-"),
		strings.HasPrefix(id, "o1"),
		strings.HasPrefix(id, "o3"),
		strings.HasPrefix(id, "o4"):
		return ownerOpenAI
	case strings.HasPrefix(id, "kimi-"), id == "k3", strings.HasPrefix(id, "k3-"):
		return ownerMoonshot
	case strings.HasPrefix(id, "glm-"):
		return ownerZhipu
	default:
		return ""
	}
}

// inferOwnerFromProvider 在模型名认不出来时按 Provider 推断厂商归属。
//
// 只登记有稳定厂商对应的 Provider：聚合 Provider（agy / qoder / kiro / codebuddy /
// workbuddy …）承载多家模型，映射到任何单一厂商都是猜错，因此返回空，交给
// ownerFallback。
func inferOwnerFromProvider(providerID string) string {
	switch strings.ToLower(strings.TrimSpace(providerID)) {
	case "claude":
		return ownerAnthropic
	case "gemini":
		return ownerGoogle
	case "codex":
		return ownerOpenAI
	case "opencode":
		return ownerOpenCode
	case "kimi":
		return ownerMoonshot
	case "zcode":
		return ownerZhipu
	default:
		return ""
	}
}
