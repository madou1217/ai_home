package usage

import (
	"encoding/json"
	"math"
	"strings"
)

// 本文件移植 Node lib/server/agy-account-usage-view.js：
//
//	normalizeAgyPlanType          → NormalizePlanType
//	isFreeAgyPlan                 → isFreeAgyPlan
//	isAgyUsageSnapshot            → viewDocument（比 apply 路径宽松：只看 kind + models 数组）
//	buildActiveModelCooldowns     → activeModelCooldowns（含 legacy modelFailures 迁移）
//	hasQuotaExhaustionSignal      → hasQuotaExhaustionSignal
//	cloneAgySnapshotWithPlan      → patchDocument（补 planType）
//	markAllModelsExhausted        → patchDocument（可同时把剩余比例归零）
//	buildAgyEffectiveUsageView    → BuildEffectiveUsageView
//
// 为什么免费档要「全部模型归零」：agy 免费档的额度是按模型计，但上游对免费档的限流
// 只落在单个模型上；只要还有生效的模型 cooldown，账号页就该显示成 0，而不是把
// 某个模型剩下的比例当成账号可用额度。付费档不这么做（Node 同）。

// guessedCooldownMS 与 Node lib/cli/config/constants.js 的 ACCOUNT_GUESSED_COOLDOWN_MS
// 同值，也是 DEFAULT_MODEL_QUOTA_EXHAUSTED_COOLDOWN_MS 的历史迁移冷却。
const guessedCooldownMS = int64(30_000)

// AccountPlan 是账号记录上的套餐事实（Node account.subscriptionTier / account.planType）。
type AccountPlan struct {
	SubscriptionTier string
	PlanType         string
}

// RuntimeState 是额度视图需要的运行态子集。
//
// Node 走 normalizeAccountRuntime 做全区归一；这里只保留影响额度视图的字段：
// modelCooldowns、legacy modelFailures 与三段失败文本。账号级冷却字段
// （rateLimitUntil 等）不参与 agy 额度视图，故不在此结构里。
type RuntimeState struct {
	LastFailureKind   string
	LastFailureReason string
	LastError         string
	// LastFailureAtMS 用于把 legacy modelFailures 迁移成额度 cooldown。
	LastFailureAtMS int64
	// ModelCooldowns 是 (账号, 模型) → 解除时刻（毫秒）。
	ModelCooldowns map[string]int64
	// ModelFailures 是旧版「模型失败次数」表；只在额度耗尽信号存在时用于补 cooldown。
	ModelFailures map[string]float64
}

// EffectiveUsageViewInput 是视图输入。
//
// RuntimeState 为空结构表示没有运行态（等价于 Node 的空对象）；
// 「运行态用账号还是 stateInfo」由调用方按 Node readEffectiveRuntimeState 的口径先决定。
type EffectiveUsageViewInput struct {
	// UsageSnapshot 是 usage_snapshot 文档 JSON；nil 表示没有快照。
	UsageSnapshot []byte
	Account       AccountPlan
	RuntimeState  RuntimeState
	// FallbackPlanType 对应 Node 的 input.fallbackPlanType。
	FallbackPlanType string
	// NowMS 是判定 cooldown 是否生效的时刻；<=0 时取当前时间（Node 默认 Date.now()）。
	NowMS int64
}

// EffectiveUsageView 是账号页最终使用的额度视图。
type EffectiveUsageView struct {
	PlanType string
	// UsageSnapshot 是补过 planType（必要时把全部模型 remainingPct 归零）的文档 JSON；
	// nil 表示没有快照（Node 的 null）。
	UsageSnapshot []byte
	// RemainingPct 是账号级剩余比例；nil 表示未知（Node 的 null）。
	RemainingPct          *float64
	FreeQuotaExhausted    bool
	QuotaExhaustionSignal bool
	// ActiveModelCooldowns 只保留视图时刻仍生效的 cooldown。
	ActiveModelCooldowns map[string]int64
}

// NormalizePlanType 复刻 Node normalizeAgyPlanType：
// 档位名按关键字归类（ultra / pro / free），归不出来时按 fallback 的规则回落，
// 最后才原样返回 fallback 文本；fallback 为空返回 "oauth"。
func NormalizePlanType(subscriptionTier string, fallbackPlanType string) string {
	tier := strings.ToLower(strings.TrimSpace(subscriptionTier))
	switch {
	case strings.Contains(tier, "ultra"):
		return "ultra"
	case strings.Contains(tier, "pro"):
		return "pro"
	case strings.Contains(tier, "starter"),
		strings.Contains(tier, "free"),
		strings.Contains(tier, "default"):
		return "free"
	}
	fallback := strings.ToLower(strings.TrimSpace(fallbackPlanType))
	switch fallback {
	case "ultra", "pro", "free":
		return fallback
	case "starter", "default":
		return "free"
	}
	if trimmed := strings.TrimSpace(fallbackPlanType); trimmed != "" {
		return trimmed
	}
	return "oauth"
}

// isFreeAgyPlan 复刻 Node isFreeAgyPlan（trim + 小写后等于 free）。
func isFreeAgyPlan(planType string) bool {
	return strings.EqualFold(strings.TrimSpace(planType), "free")
}

// viewDocument 复刻 Node isAgyUsageSnapshot：只要求 kind 与 models 数组。
// 它比 document.trusted() 宽松（不校验 schemaVersion/source），与 Node 两处判据的差异一致。
func viewDocument(payload []byte) (usageDocument, bool) {
	document, ok := parseUsageDocument(payload)
	if !ok || !document.modelsArray {
		return usageDocument{}, false
	}
	if readText(document.object["kind"]) != documentKind {
		return usageDocument{}, false
	}
	return document, true
}

// BuildEffectiveUsageView 复刻 Node buildAgyEffectiveUsageView。
func BuildEffectiveUsageView(input EffectiveUsageViewInput) EffectiveUsageView {
	nowMS := input.NowMS
	if nowMS <= 0 {
		nowMS = usageRefreshNow(0)
	}
	document, hasSnapshot := viewDocument(input.UsageSnapshot)
	planType := NormalizePlanType(
		firstNonEmpty(
			readText(firstField(document.account, "subscriptionTier")),
			strings.TrimSpace(input.Account.SubscriptionTier),
		),
		firstNonEmpty(
			readText(firstField(document.account, "planType")),
			strings.TrimSpace(input.Account.PlanType),
			strings.TrimSpace(input.FallbackPlanType),
			"oauth",
		),
	)
	cooldowns := activeModelCooldowns(input.RuntimeState, nowMS)
	freeQuotaExhausted := isFreeAgyPlan(planType) && len(cooldowns) > 0
	view := EffectiveUsageView{
		PlanType:              planType,
		FreeQuotaExhausted:    freeQuotaExhausted,
		QuotaExhaustionSignal: hasQuotaExhaustionSignal(input.RuntimeState.signalText()),
		ActiveModelCooldowns:  cooldowns,
	}
	if hasSnapshot {
		if payload, err := patchDocument(document, planType, freeQuotaExhausted); err == nil {
			view.UsageSnapshot = payload
		}
	}
	switch {
	case freeQuotaExhausted:
		zero := float64(0)
		view.RemainingPct = &zero
	case hasSnapshot:
		view.RemainingPct = documentMinRemainingPct(document)
	}
	return view
}

// patchDocument 复刻 Node cloneAgySnapshotWithPlan + markAllModelsExhausted：
// 顶层与 account 做浅拷贝并写入 planType；exhaustAll 时把每个模型的 remainingPct 置 0。
// 其余字段（含未知字段）原样透传，不做重新解释。
func patchDocument(document usageDocument, planType string, exhaustAll bool) ([]byte, error) {
	cloned := make(map[string]json.RawMessage, len(document.object)+2)
	for key, value := range document.object {
		cloned[key] = value
	}
	account := make(map[string]json.RawMessage, len(document.account)+1)
	for key, value := range document.account {
		account[key] = value
	}
	encodedPlan, err := json.Marshal(planType)
	if err != nil {
		return nil, err
	}
	account["planType"] = encodedPlan
	encodedAccount, err := json.Marshal(account)
	if err != nil {
		return nil, err
	}
	cloned["account"] = encodedAccount

	models := make([]json.RawMessage, 0, len(document.models))
	for _, raw := range document.models {
		entry := make(map[string]json.RawMessage)
		for key, value := range rawObject(raw) {
			entry[key] = value
		}
		if exhaustAll {
			entry["remainingPct"] = json.RawMessage("0")
		}
		encoded, err := json.Marshal(entry)
		if err != nil {
			return nil, err
		}
		models = append(models, encoded)
	}
	encodedModels, err := json.Marshal(models)
	if err != nil {
		return nil, err
	}
	cloned["models"] = encodedModels
	return json.Marshal(cloned)
}

// documentMinRemainingPct 复刻 getMinRemainingPctFromUsageSnapshot 在 models[] 上的取值。
func documentMinRemainingPct(document usageDocument) *float64 {
	models := make([]DocumentModel, 0, len(document.models))
	for _, raw := range document.models {
		object := rawObject(raw)
		if object == nil {
			continue
		}
		models = append(models, DocumentModel{
			Model:        readText(firstField(object, "model")),
			RemainingPct: optionalNumberValue(firstField(object, "remainingPct")),
		})
	}
	return minRemainingPct(models)
}

// signalText 复刻 Node hasQuotaExhaustionSignal 的文本拼装：trim + 小写 + 非空段用换行连接。
func (state RuntimeState) signalText() string {
	values := []string{state.LastFailureKind, state.LastFailureReason, state.LastError}
	parts := make([]string, 0, len(values))
	for _, value := range values {
		if text := strings.ToLower(strings.TrimSpace(value)); text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, "\n")
}

// hasQuotaExhaustionSignal 复刻 Node hasQuotaExhaustionSignal 的判据。
func hasQuotaExhaustionSignal(text string) bool {
	return strings.Contains(text, "model_quota_exhausted") ||
		strings.Contains(text, "resource has been exhausted") ||
		strings.Contains(text, "quota exhausted") ||
		strings.Contains(text, "quota exceeded") ||
		(strings.Contains(text, "resource_exhausted") &&
			(strings.Contains(text, "quota") || strings.Contains(text, "check quota")))
}

// activeModelCooldowns 复刻 Node buildActiveModelCooldowns（含 normalizeAccountRuntime
// 里影响 modelCooldowns 的那部分：清理旧表、迁移 legacy 额度冷却、删掉已到期项）。
//
// 故意不同：Node 归一用 Date.now()、过滤用 input.nowMs；Go 两处都用同一个 nowMS，
// 这样同一份输入在重放/测试里结论稳定。
func activeModelCooldowns(state RuntimeState, nowMS int64) map[string]int64 {
	cooldowns := make(map[string]int64, len(state.ModelCooldowns))
	for model, until := range state.ModelCooldowns {
		if until > 0 {
			cooldowns[model] = until
		}
	}
	legacy := make(map[string]float64, len(state.ModelFailures))
	for model, count := range state.ModelFailures {
		if math.IsNaN(count) || math.IsInf(count, 0) || count <= 0 {
			continue
		}
		legacy[model] = count
	}
	// 旧版只记失败次数、没有 cooldown：额度耗尽的账号要把这些模型按猜测冷却续上，
	// 否则历史数据在视图里会显示成「额度正常」。
	if len(legacy) > 0 && state.LastFailureAtMS > 0 && hasQuotaExhaustionSignal(state.signalText()) {
		until := state.LastFailureAtMS + guessedCooldownMS
		if until > nowMS {
			for model := range legacy {
				if cooldowns[model] < until {
					cooldowns[model] = until
				}
			}
		}
	}
	for model, until := range cooldowns {
		if until <= nowMS {
			delete(cooldowns, model)
		}
	}
	return cooldowns
}
