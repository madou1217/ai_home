// Package usagewindow 是"厂商额度窗口是否耗尽"这一调度门禁的共享契约。
//
// Node 来源：lib/server/model-window-gates.js。
//
// 每个厂商的额度快照形状不同（快照键、条目字段、模型命名），此前这些事实写死在传输层
// 的 provider 分支里。这里把"按 Provider 分派到该厂商的窗口策略"收敛成一个端口：
// 入站层只问"这个 (Provider, 账号快照, 模型) 现在能不能调度"，不认识任何厂商字段。
package usagewindow

import (
	"strings"

	"github.com/madou1217/ai_home/application/agymodelnames"
)

// Policy 是单个厂商的额度窗口策略。
//
// 快照是持久化的原始文档（未做类型化），因此策略需要自行做数值/形状容错；
// 无法识别的形状一律视为未耗尽，宁可多调度也不误杀账号。
type Policy interface {
	Exhausted(usageSnapshot map[string]any, model string, nowMS int64) bool
}

// Gate 是入站层依赖的门禁端口：按 Provider 分派到已注册策略。
type Gate interface {
	Exhausted(provider string, usageSnapshot map[string]any, model string, nowMS int64) bool
}

// Registry 是 Provider→Policy 的注册表；未注册的 Provider 不做门禁。
type Registry struct {
	policies map[string]Policy
}

// NewRegistry 用给定策略表构造注册表；Provider 名按小写归一。
func NewRegistry(policies map[string]Policy) Registry {
	normalized := make(map[string]Policy, len(policies))
	for provider, policy := range policies {
		key := strings.ToLower(strings.TrimSpace(provider))
		if key == "" || policy == nil {
			continue
		}
		normalized[key] = policy
	}
	return Registry{policies: normalized}
}

// DefaultRegistry 返回当前已知厂商策略的注册表。
func DefaultRegistry() Registry {
	return NewRegistry(map[string]Policy{
		"agy": AgyPolicy{},
	})
}

// Exhausted 分派到该 Provider 的策略；无策略时返回 false。
func (registry Registry) Exhausted(provider string, usageSnapshot map[string]any, model string, nowMS int64) bool {
	if len(registry.policies) == 0 || len(usageSnapshot) == 0 {
		return false
	}
	policy, found := registry.policies[strings.ToLower(strings.TrimSpace(provider))]
	if !found {
		return false
	}
	return policy.Exhausted(usageSnapshot, model, nowMS)
}

// AgyMaxSnapshotAgeMS 与 Node MODEL_WINDOW_MAX_SNAPSHOT_AGE_MS（10 分钟）一致。
const AgyMaxSnapshotAgeMS = int64(10 * 60 * 1000)

// AgyPolicy 复刻 Node lib/server/model-window-gates.js 的 agy 规则：
// 快照需在 10 分钟新鲜度内；条目 remainingPct <= 0 且重置时间未到视为窗口耗尽。
//
// 快照条目按 CLI 显示名记录（如 "Claude Sonnet 4.6 (Thinking)"），调度按内部 id 查询，
// 因此匹配时两侧都先经 agymodelnames 归一。
type AgyPolicy struct{}

// Exhausted 判定 agy 账号对某模型的额度窗口是否已耗尽。
func (AgyPolicy) Exhausted(usageSnapshot map[string]any, model string, nowMS int64) bool {
	if len(usageSnapshot) == 0 {
		return false
	}
	capturedAt := int64(numberFromAny(usageSnapshot["capturedAt"]))
	if capturedAt <= 0 || (nowMS-capturedAt) > AgyMaxSnapshotAgeMS {
		return false
	}
	entry := findAgySnapshotModelEntry(usageSnapshot, model)
	if entry == nil {
		return false
	}
	remaining, ok := optionalNumberFromAny(entry["remainingPct"])
	if !ok || remaining > 0 {
		return false
	}
	resetAtMS := int64(numberFromAny(entry["resetAtMs"]))
	if resetAtMS > 0 && resetAtMS <= nowMS {
		return false
	}
	return true
}

func findAgySnapshotModelEntry(usageSnapshot map[string]any, model string) map[string]any {
	wanted := strings.TrimSpace(model)
	wantedCLI := agymodelnames.Resolve(wanted)
	switch rawModels := usageSnapshot["models"].(type) {
	case []map[string]any:
		for _, entry := range rawModels {
			if agySnapshotEntryMatches(entry, wanted, wantedCLI) {
				return entry
			}
		}
	case []any:
		for _, item := range rawModels {
			entry, ok := item.(map[string]any)
			if ok && agySnapshotEntryMatches(entry, wanted, wantedCLI) {
				return entry
			}
		}
	}
	return nil
}

func agySnapshotEntryMatches(entry map[string]any, wanted, wantedCLI string) bool {
	if entry == nil {
		return false
	}
	id, _ := entry["model"].(string)
	id = strings.TrimSpace(id)
	if id == "" {
		return false
	}
	if id == wanted {
		return true
	}
	return wantedCLI != "" && agymodelnames.Resolve(id) == wantedCLI
}

func optionalNumberFromAny(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case jsonNumber:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}

type jsonNumber interface {
	Float64() (float64, error)
}

func numberFromAny(value any) float64 {
	number, ok := optionalNumberFromAny(value)
	if !ok {
		return 0
	}
	return number
}
