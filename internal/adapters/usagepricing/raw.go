package usagepricing

import (
	"encoding/json"
	"strings"
)

// RawRecord 是目录里的原始定价行。
//
// 为什么用指针而不是 float64：Node 用「属性是否存在」区分「声明为 0」与「未声明」，
// 前者是明确免费、后者是漏填。用 float64 会把两者都读成 0，于是「只有分档定价、
// 基础价未填」的记录会被误判成有效记录，算出一笔 0 元账单。
type RawRecord struct {
	Model                       *string   `json:"model"`
	InputCostPerToken           *float64  `json:"input_cost_per_token"`
	OutputCostPerToken          *float64  `json:"output_cost_per_token"`
	CacheReadInputTokenCost     *float64  `json:"cache_read_input_token_cost"`
	CacheCreationInputTokenCost *float64  `json:"cache_creation_input_token_cost"`
	ReasoningOutputTokenCost    *float64  `json:"reasoning_output_token_cost"`
	ContextCostTiers            []RawTier `json:"context_cost_tiers"`
}

// RawTier 是原始分档行。字段同样用指针表达「未声明」。
type RawTier struct {
	Size                        *float64 `json:"size"`
	InputCostPerToken           *float64 `json:"input_cost_per_token"`
	OutputCostPerToken          *float64 `json:"output_cost_per_token"`
	CacheReadInputTokenCost     *float64 `json:"cache_read_input_token_cost"`
	CacheCreationInputTokenCost *float64 `json:"cache_creation_input_token_cost"`
	ReasoningOutputTokenCost    *float64 `json:"reasoning_output_token_cost"`
}

// 目录同时存在 camelCase 与 snake_case 两种写法（LiteLLM 与本地导出各一份），
// 这里在解码前把 camelCase 归一成 snake_case，避免为每个字段写两套 tag。
var camelToSnakeKeys = map[string]string{
	"inputCostPerToken":           "input_cost_per_token",
	"outputCostPerToken":          "output_cost_per_token",
	"cacheReadInputTokenCost":     "cache_read_input_token_cost",
	"cacheCreationInputTokenCost": "cache_creation_input_token_cost",
	"reasoningOutputTokenCost":    "reasoning_output_token_cost",
	"contextCostTiers":            "context_cost_tiers",
	// 分档大小有三种历史写法，全归一到 size。
	"contextSize":  "size",
	"context_size": "size",
}

// UnmarshalJSON 同时接受 camelCase 与 snake_case 键。
func (record *RawRecord) UnmarshalJSON(payload []byte) error {
	fields, err := decodeObject(payload)
	if err != nil {
		return err
	}
	type alias RawRecord
	var decoded alias
	if err := json.Unmarshal(fields, &decoded); err != nil {
		return err
	}
	*record = RawRecord(decoded)
	return nil
}

// UnmarshalJSON 让分档行也接受 camelCase。
func (tier *RawTier) UnmarshalJSON(payload []byte) error {
	fields, err := decodeObject(payload)
	if err != nil {
		return err
	}
	type alias RawTier
	var decoded alias
	if err := json.Unmarshal(fields, &decoded); err != nil {
		return err
	}
	*tier = RawTier(decoded)
	return nil
}

// decodeObject 把对象里的 camelCase 键改写成 snake_case。
func decodeObject(payload []byte) ([]byte, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(payload, &raw); err != nil {
		return nil, err
	}
	normalized := make(map[string]json.RawMessage, len(raw))
	for key, value := range raw {
		if snake, ok := camelToSnakeKeys[key]; ok {
			if _, exists := raw[snake]; !exists {
				normalized[snake] = value
				continue
			}
		}
		normalized[key] = value
	}
	return json.Marshal(normalized)
}

// Normalize 把原始行规整成定价记录；没有任何成本字段也没有分档时返回 nil。
func (raw RawRecord) Normalize(model string) *Record {
	modelID := strings.TrimSpace(model)
	if modelID == "" && raw.Model != nil {
		modelID = strings.TrimSpace(*raw.Model)
	}
	if modelID == "" {
		return nil
	}
	hasDeclaredCost := raw.InputCostPerToken != nil ||
		raw.OutputCostPerToken != nil ||
		raw.CacheReadInputTokenCost != nil ||
		raw.CacheCreationInputTokenCost != nil ||
		raw.ReasoningOutputTokenCost != nil
	tiers := normalizeRawTiers(raw.ContextCostTiers)
	if !hasDeclaredCost && len(tiers) == 0 {
		return nil
	}
	return &Record{
		Model:                       modelID,
		InputCostPerToken:           valueOrZero(raw.InputCostPerToken),
		OutputCostPerToken:          valueOrZero(raw.OutputCostPerToken),
		CacheReadInputTokenCost:     valueOrZero(raw.CacheReadInputTokenCost),
		CacheCreationInputTokenCost: valueOrZero(raw.CacheCreationInputTokenCost),
		ReasoningOutputTokenCost:    raw.ReasoningOutputTokenCost,
		ContextCostTiers:            tiers,
	}
}

// ParseCatalog 解析 {模型: 定价行} 形式的目录，跳过无效行。
func ParseCatalog(payload map[string]RawRecord) map[string]Record {
	out := make(map[string]Record, len(payload))
	for model, raw := range payload {
		if record := raw.Normalize(model); record != nil {
			out[record.Model] = *record
		}
	}
	return out
}

func normalizeRawTiers(tiers []RawTier) []Tier {
	out := make([]Tier, 0, len(tiers))
	for _, tier := range tiers {
		if tier.Size == nil || *tier.Size <= 0 {
			continue
		}
		out = append(out, Tier{
			Size:                        *tier.Size,
			InputCostPerToken:           tier.InputCostPerToken,
			OutputCostPerToken:          tier.OutputCostPerToken,
			CacheReadInputTokenCost:     tier.CacheReadInputTokenCost,
			CacheCreationInputTokenCost: tier.CacheCreationInputTokenCost,
			ReasoningOutputTokenCost:    tier.ReasoningOutputTokenCost,
		})
	}
	return normalizeTiers(out)
}

func valueOrZero(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}
