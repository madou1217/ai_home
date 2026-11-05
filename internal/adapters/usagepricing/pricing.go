package usagepricing

import (
	"sort"
	"strings"
)

// providerPrefixes 是所有可能出现在目录键上的 Provider 前缀（兜底集合）。
//
// 为什么需要一个全局兜底：目录键由上游供应商命名（google/、anthropic/…），
// 与 aih 自己的 Provider ID 不是一一对应；执行 Provider 没有专属映射时，
// 仍要能按供应商前缀命中定价。
var providerPrefixes = []string{
	"anthropic/",
	"openai/",
	"github-copilot/",
	"deepseek/",
	"gemini/",
	"google/",
	"google-vertex/",
	"mistral/",
	"cohere/",
	"azure_ai/",
}

// providerPrefixesByAIHProvider 是 aih Provider → 目录前缀的显式映射。
//
// 未登记的 Provider 不会失败：候选前缀退化成全局集合。这样新增 Provider 时
// 只有在「目录前缀与 Provider ID 不一致」时才需要加一条，而不是必须登记。
var providerPrefixesByAIHProvider = map[string][]string{
	"codex":    {"openai/", "github-copilot/"},
	"claude":   {"anthropic/"},
	"gemini":   {"google/", "google-vertex/"},
	"agy":      {"github-copilot/", "google/", "google-vertex/", "anthropic/", "openai/"},
	"opencode": {"opencode-go/", "opencode/"},
}

// Tier 是上下文长度分档定价：超过 size 时整单改用该档单价。
type Tier struct {
	Size                        float64
	InputCostPerToken           *float64
	OutputCostPerToken          *float64
	CacheReadInputTokenCost     *float64
	CacheCreationInputTokenCost *float64
	ReasoningOutputTokenCost    *float64
}

// Record 是单个模型的定价记录。零值表示「该字段未声明」，与「声明为 0」不同：
// 未声明时按 0 计价，但整个 Record 必须至少声明一个成本字段才有效。
type Record struct {
	Model                       string
	InputCostPerToken           float64
	OutputCostPerToken          float64
	CacheReadInputTokenCost     float64
	CacheCreationInputTokenCost float64
	// ReasoningOutputTokenCost 未声明时按输出单价计费。
	ReasoningOutputTokenCost *float64
	ContextCostTiers         []Tier
}

// Usage 是一次请求的可计费 token 明细。
type Usage struct {
	InputTokens              int64
	OutputTokens             int64
	CacheReadInputTokens     int64
	CacheCreationInputTokens int64
	ReasoningOutputTokens    int64
}

// Catalog 是不可变的定价索引。零值可用（等价于空目录）。
type Catalog struct {
	exact  map[string]*Record
	folded map[string]*Record
}

// NewCatalog 用「目录键 → 定价记录」构造索引。
//
// 两张表保存同一份指针：精确键优先，小写键兜底。构造函数之后不再写入，
// 因此并发读安全，也不需要 Node 那份 WeakMap 缓存。
func NewCatalog(pricingByModel map[string]Record) *Catalog {
	catalog := &Catalog{
		exact:  make(map[string]*Record, len(pricingByModel)),
		folded: make(map[string]*Record, len(pricingByModel)),
	}
	for key, record := range pricingByModel {
		trimmed := strings.TrimSpace(key)
		if trimmed == "" {
			continue
		}
		value := record
		if value.Model == "" {
			value.Model = trimmed
		}
		// 与 Node 一致：先写入的键胜出，后写入的同名键不覆盖。
		if _, exists := catalog.exact[trimmed]; !exists {
			catalog.exact[trimmed] = &value
		}
		lowered := strings.ToLower(trimmed)
		if _, exists := catalog.folded[lowered]; !exists {
			catalog.folded[lowered] = &value
		}
	}
	return catalog
}

// Match 按计费身份查定价：先试「前缀 + 模型变体」，再试裸模型名。
//
// 只查表、不构造候选集——Node 每次匹配都要重建两张 Map 并拼接前缀列表，
// 这里是纯查表，因此可以放在每次推理的热路径上。
func (catalog *Catalog) Match(identity BillingIdentity) *Record {
	if catalog == nil || len(catalog.exact) == 0 {
		return nil
	}
	prefixes := UniqueItems(append(
		append([]string(nil), identity.ProviderPrefixes...),
		candidatePrefixes(identity.ExecutionProvider)...,
	))
	for _, prefix := range prefixes {
		for _, modelID := range identity.ModelIDs {
			if record := catalog.find(prefix + modelID); record != nil {
				return record
			}
		}
	}
	for _, modelID := range identity.ModelIDs {
		if record := catalog.find(modelID); record != nil {
			return record
		}
	}
	return nil
}

// candidatePrefixes 返回执行 Provider 的候选目录前缀。
func candidatePrefixes(provider string) []string {
	normalized := strings.ToLower(strings.TrimSpace(provider))
	dedicated := providerPrefixesByAIHProvider[normalized]
	return UniqueItems(append(append([]string(nil), dedicated...), providerPrefixes...))
}

func (catalog *Catalog) find(candidate string) *Record {
	trimmed := strings.TrimSpace(candidate)
	if trimmed == "" {
		return nil
	}
	if record, ok := catalog.exact[trimmed]; ok {
		return record
	}
	return catalog.folded[strings.ToLower(trimmed)]
}

// CalculateCostUSD 按定价记录算一次请求的成本（美元）。
//
// 上下文分档按「输入 + 缓存读 + 缓存写」判定：这三者共同占用上下文窗口。
// 推理 token 未单独定价时按输出单价计费——这是上游的通行做法，而不是 0。
func CalculateCostUSD(usage Usage, pricing *Record) float64 {
	if pricing == nil {
		return 0
	}
	effective := selectContextPricing(usage, *pricing)
	outputPrice := effective.OutputCostPerToken
	reasoningPrice := outputPrice
	if effective.ReasoningOutputTokenCost != nil {
		reasoningPrice = *effective.ReasoningOutputTokenCost
	}
	return float64(usage.InputTokens)*effective.InputCostPerToken +
		float64(usage.OutputTokens)*outputPrice +
		float64(usage.CacheReadInputTokens)*effective.CacheReadInputTokenCost +
		float64(usage.CacheCreationInputTokens)*effective.CacheCreationInputTokenCost +
		float64(usage.ReasoningOutputTokens)*reasoningPrice
}

// selectContextPricing 选出命中的最大分档，未声明的字段回落到基础价。
//
// 注意「未声明」与「声明为 0」的区别：*float64 为 nil 才回落，
// 指向 0 表示该档明确免费。
func selectContextPricing(usage Usage, pricing Record) Record {
	if len(pricing.ContextCostTiers) == 0 {
		return pricing
	}
	contextTokens := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	var selected *Tier
	for index := range pricing.ContextCostTiers {
		tier := &pricing.ContextCostTiers[index]
		if tier.Size <= 0 || float64(contextTokens) < tier.Size {
			continue
		}
		if selected == nil || tier.Size > selected.Size {
			selected = tier
		}
	}
	if selected == nil {
		return pricing
	}
	if selected.InputCostPerToken != nil {
		pricing.InputCostPerToken = *selected.InputCostPerToken
	}
	if selected.OutputCostPerToken != nil {
		pricing.OutputCostPerToken = *selected.OutputCostPerToken
	}
	if selected.CacheReadInputTokenCost != nil {
		pricing.CacheReadInputTokenCost = *selected.CacheReadInputTokenCost
	}
	if selected.CacheCreationInputTokenCost != nil {
		pricing.CacheCreationInputTokenCost = *selected.CacheCreationInputTokenCost
	}
	if selected.ReasoningOutputTokenCost != nil {
		pricing.ReasoningOutputTokenCost = selected.ReasoningOutputTokenCost
	}
	return pricing
}

// NormalizeRecord 把「可能是 snake_case、可能缺字段」的目录行规整成定价记录。
// 没有任何成本字段、也没有分档时返回 nil：这条记录不能用来计价。
func NormalizeRecord(model string, value Record) *Record {
	modelID := strings.TrimSpace(model)
	if modelID == "" {
		modelID = strings.TrimSpace(value.Model)
	}
	if modelID == "" {
		return nil
	}
	hasDeclaredCost := value.InputCostPerToken != 0 ||
		value.OutputCostPerToken != 0 ||
		value.CacheReadInputTokenCost != 0 ||
		value.CacheCreationInputTokenCost != 0 ||
		value.ReasoningOutputTokenCost != nil
	record := value
	record.Model = modelID
	record.ContextCostTiers = normalizeTiers(value.ContextCostTiers)
	if !hasDeclaredCost && len(record.ContextCostTiers) == 0 {
		return nil
	}
	return &record
}

// normalizeTiers 去掉无效分档并按 size 升序排列。
func normalizeTiers(tiers []Tier) []Tier {
	out := make([]Tier, 0, len(tiers))
	for _, tier := range tiers {
		if tier.Size <= 0 {
			continue
		}
		out = append(out, tier)
	}
	sort.SliceStable(out, func(left, right int) bool { return out[left].Size < out[right].Size })
	return out
}
