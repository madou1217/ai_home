package images

import (
	"encoding/json"
	"math"
)

// 本文件把上游的用量对象归一到可记账的 token 快照。
//
// 上游有三种形状：
//   - OpenAI：{input_tokens, output_tokens, total_tokens}，兼容端点也可能用
//     prompt_tokens / completion_tokens；cached 在 *_tokens_details.cached_tokens，
//     reasoning 在 completion_tokens_details.reasoning_tokens，两者都已计入对应总数。
//   - Gemini usageMetadata：promptTokenCount / candidatesTokenCount / thoughtsTokenCount /
//     cachedContentTokenCount / totalTokenCount。注意 candidatesTokenCount **不含** thoughts，
//     totalTokenCount 才把三者相加，所以 output 必须补上 thoughts 才与上游总量一致。
//
// 与 Node 的 readImageApiUsage + readOpenAIImageUsage 同一口径：拿不到用量就不记账，绝不伪造 0。

// TokenUsage 是上游报告的一次生图 token 用量；cached 是 input 的子集，reasoning 是 output 的子集。
type TokenUsage struct {
	// InputTokens 是全部输入 token。
	InputTokens uint64
	// OutputTokens 是全部输出 token（Gemini 口径已含 thoughts）。
	OutputTokens uint64
	// CachedTokens 是 InputTokens 中命中缓存的子集。
	CachedTokens uint64
	// ReasoningTokens 是 OutputTokens 中用于思考的子集。
	ReasoningTokens uint64
}

// UsageTokens 返回这次产出可记账的 token 数；上游没给用量时 found=false。
func (result Result) UsageTokens() (TokenUsage, bool) {
	if counts, ok := usageTokenCounts(result.Usage); ok {
		return counts, true
	}
	// 透传口径的用量在上游原体里（Result.Usage 由策略解析，原体可能保留更多字段）。
	if len(result.PassthroughBody) > 0 {
		var document struct {
			Usage json.RawMessage `json:"usage"`
		}
		if err := json.Unmarshal(result.PassthroughBody, &document); err == nil {
			return usageTokenCounts(document.Usage)
		}
	}
	return TokenUsage{}, false
}

// usageTokenCounts 从用量对象里读出输入、输出、缓存与思考 token。
func usageTokenCounts(raw json.RawMessage) (TokenUsage, bool) {
	if len(raw) == 0 {
		return TokenUsage{}, false
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return TokenUsage{}, false
	}
	read := func(names ...string) (uint64, bool) {
		for _, name := range names {
			value, found := fields[name]
			if !found {
				continue
			}
			var number uint64
			if err := json.Unmarshal(value, &number); err == nil {
				return number, true
			}
		}
		return 0, false
	}
	readNested := func(parent string, names ...string) (uint64, bool) {
		value, found := fields[parent]
		if !found {
			return 0, false
		}
		var inner map[string]json.RawMessage
		if err := json.Unmarshal(value, &inner); err != nil {
			return 0, false
		}
		for _, name := range names {
			number, ok := inner[name]
			if !ok {
				continue
			}
			var parsed uint64
			if err := json.Unmarshal(number, &parsed); err == nil {
				return parsed, true
			}
		}
		return 0, false
	}

	input, hasInput := read("input_tokens", "prompt_tokens", "promptTokenCount", "prompt_token_count")
	output, hasOutput := read("output_tokens", "completion_tokens", "candidatesTokenCount", "candidates_token_count")
	if !hasInput && !hasOutput {
		return TokenUsage{}, false
	}
	counts := TokenUsage{InputTokens: input, OutputTokens: output}
	if thoughts, ok := read("thoughtsTokenCount", "thoughts_token_count"); ok && thoughts > 0 {
		// Gemini 的思考 token 单独计、且算进 totalTokenCount：不补进 output 会少记。
		if output <= math.MaxUint64-thoughts {
			counts.OutputTokens = output + thoughts
			counts.ReasoningTokens = thoughts
		}
	} else if reasoning, ok := readNested("completion_tokens_details", "reasoning_tokens"); ok {
		counts.ReasoningTokens = reasoning
	} else if reasoning, ok := readNested("output_tokens_details", "reasoning_tokens"); ok {
		counts.ReasoningTokens = reasoning
	}
	if cached, ok := read("cachedContentTokenCount", "cached_content_token_count"); ok {
		counts.CachedTokens = cached
	} else if cached, ok := readNested("prompt_tokens_details", "cached_tokens"); ok {
		counts.CachedTokens = cached
	} else if cached, ok := readNested("input_tokens_details", "cached_tokens"); ok {
		counts.CachedTokens = cached
	}
	return counts, true
}
