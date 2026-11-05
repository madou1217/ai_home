// Package usagepricing 负责「一次推理的计费归属与成本」：把客户端模型名归一到
// 计费模型身份，再按定价表算出美元成本。
//
// 与 Node 实现（lib/usage/model-usage-identity.js / model-usage-pricing.js）的差异：
//   - Node 用 WeakMap 缓存「定价表 → 匹配器」，因为每次匹配都要重建两张 Map；Go 这里是
//     不可变 Catalog，构造时一次性建索引，匹配只做查表——没有缓存失效问题。
//   - Node 把 Provider 列表放在模块级 Set 里（listProviderIds()），改 Provider 需要重新
//     加载模块；Go 由调用方把 Provider ID 列表注进来，来源仍是同一个真值源，但可测试。
//   - 别名与版本分隔符是**数据**，不是白名单：新增别名只加一条记录，不改判定逻辑。
package usagepricing

import "strings"

// AttributionIndex 判定「模型名的点号前缀是不是 Provider」，并解析计费别名。
//
// 未知 Provider 不会出错：ParseAttributedModel 只决定是否把前缀当作 Provider，
// 未登记的 Provider 走「整体当模型名」的分支，与 Node 的 USAGE_PROVIDERS 行为一致。
type AttributionIndex struct {
	providers map[string]struct{}
}

// BillingAlias 把一个展示用的模型名映射到计费模型与候选 Provider 前缀。
type BillingAlias struct {
	ModelID          string
	ProviderPrefixes []string
}

// billingAliases 是展示名 → 计费模型的别名表。
//
// 只放「目录里没有、但必须按同档计费」的展示型号；正常模型靠前缀匹配即可，
// 不需要在这里登记（否则这张表会变成第二份模型目录）。
var billingAliases = map[string]BillingAlias{
	"gemini-3-flash-agent": {
		ModelID:          "gemini-3.5-flash",
		ProviderPrefixes: []string{"google/", "google-vertex/", "github-copilot/"},
	},
	"gemini-3-flash-a": {
		ModelID:          "gemini-3.5-flash",
		ProviderPrefixes: []string{"google/", "google-vertex/", "github-copilot/"},
	},
	"gemini-default": {
		ModelID:          "gemini-3.5-flash",
		ProviderPrefixes: []string{"google/", "google-vertex/", "github-copilot/"},
	},
	"claude-opus-4-6-thinking": {
		ModelID:          "claude-opus-4-6",
		ProviderPrefixes: []string{"anthropic/", "github-copilot/"},
	},
	// Cline Pass 目录尚未单列 deepseek-v4.1-flash；同档的 flash 型号是
	// deepseek-v4-flash。这是估算口径的别名，不影响实际请求路由。
	"cline-pass/deepseek-v4.1-flash": {
		ModelID:          "cline-pass/deepseek-v4-flash",
		ProviderPrefixes: []string{"cline-pass/"},
	},
}

// NewAttributionIndex 用 Provider ID 列表构造索引。空列表也是合法输入：
// 所有带点号前缀的模型都会被当成普通模型名。
func NewAttributionIndex(providerIDs []string) *AttributionIndex {
	providers := make(map[string]struct{}, len(providerIDs))
	for _, id := range providerIDs {
		normalized := strings.ToLower(strings.TrimSpace(id))
		if normalized != "" {
			providers[normalized] = struct{}{}
		}
	}
	return &AttributionIndex{providers: providers}
}

// AttributedModel 是模型名的归属解析结果。
type AttributedModel struct {
	// Attributed 为 true 表示点号前缀是已登记的 Provider。
	Attributed bool
	// ExecutionProvider 是实际执行该请求的 Provider（前缀或兜底值）。
	ExecutionProvider string
	// ModelID 保留原始大小写，只去掉首尾空白。
	ModelID string
}

// ParseAttributedModel 解析 "<provider>.<model>" 形式的归属模型名。
//
// 为什么只认已登记 Provider：模型名本身可能带点号（如 gpt-4.1），
// 不查表就会把 "gpt-4" 当成 Provider。
func (index *AttributionIndex) ParseAttributedModel(value, fallbackProvider string) AttributedModel {
	raw := strings.TrimSpace(value)
	separator := strings.Index(raw, ".")
	if separator > 0 {
		prefix := strings.ToLower(strings.TrimSpace(raw[:separator]))
		if _, known := index.providers[prefix]; known {
			return AttributedModel{
				Attributed:        true,
				ExecutionProvider: prefix,
				ModelID:           strings.TrimSpace(raw[separator+1:]),
			}
		}
	}
	return AttributedModel{
		Attributed:        false,
		ExecutionProvider: strings.ToLower(strings.TrimSpace(fallbackProvider)),
		ModelID:           raw,
	}
}

// BillingIdentity 是计费匹配所需的全部候选。
type BillingIdentity struct {
	AttributedModel
	// ModelIDs 是用于查表的模型名变体（小写、版本分隔符已归一），保持优先级顺序。
	ModelIDs []string
	// ProviderPrefixes 只来自别名；为空表示按前缀表逐个尝试。
	ProviderPrefixes []string
}

// Resolve 解析计费身份：先剥 Provider 前缀，再展开别名与版本分隔符变体。
func (index *AttributionIndex) Resolve(value, fallbackProvider string) BillingIdentity {
	attributed := index.ParseAttributedModel(value, fallbackProvider)
	variants := UniqueItems([]string{
		strings.ToLower(attributed.ModelID),
		NormalizeVersionSeparators(attributed.ModelID),
	})
	identity := BillingIdentity{AttributedModel: attributed, ModelIDs: variants}
	alias, ok := lookupAlias(variants)
	if !ok {
		return identity
	}
	identity.ModelIDs = UniqueItems([]string{
		alias.ModelID,
		NormalizeVersionSeparators(alias.ModelID),
	})
	identity.ProviderPrefixes = append([]string(nil), alias.ProviderPrefixes...)
	return identity
}

// lookupAlias 按变体顺序取第一个命中的别名。
func lookupAlias(variants []string) (BillingAlias, bool) {
	for _, variant := range variants {
		if alias, ok := billingAliases[variant]; ok {
			return alias, true
		}
	}
	return BillingAlias{}, false
}

// FormatAttributedModel 生成 "<execution>.<model>"；客户端与执行 Provider 相同时只返回模型名。
func (index *AttributionIndex) FormatAttributedModel(clientProvider, executionProvider, model string) string {
	client := strings.ToLower(strings.TrimSpace(clientProvider))
	parsed := index.ParseAttributedModel(model, executionProvider)
	execution := strings.ToLower(strings.TrimSpace(executionProvider))
	if execution == "" {
		execution = parsed.ExecutionProvider
	}
	modelID := strings.TrimSpace(parsed.ModelID)
	if modelID == "" {
		return ""
	}
	if client != "" && execution != "" && client != execution {
		return execution + "." + modelID
	}
	return modelID
}

// NormalizeVersionSeparators 把 "4.6" 这类版本号写法折成 "4-6"。
//
// 为什么需要：目录键与上游返回的模型名对同一版本的写法不一致（4.6 / 4-6），
// 不折叠就会漏配定价。
func NormalizeVersionSeparators(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	replacer := strings.NewReplacer(
		"4.6", "4-6",
		"4.5", "4-5",
		"3.5", "3-5",
		"5.4", "5-4",
	)
	return replacer.Replace(normalized)
}

// UniqueItems 去掉空值并保序去重。
func UniqueItems(items []string) []string {
	seen := make(map[string]struct{}, len(items))
	out := make([]string, 0, len(items))
	for _, item := range items {
		if item == "" {
			continue
		}
		if _, duplicate := seen[item]; duplicate {
			continue
		}
		seen[item] = struct{}{}
		out = append(out, item)
	}
	return out
}
