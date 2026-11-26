package geminiapi

import (
	"bytes"
	"encoding/json"
)

// countTokensPayload 生成 Gemini countTokens 的标准响应。
//
// 网关没有 Google 的 tokenizer，采用按 UTF-8 字节数的保守估算；这与
// Anthropic Messages count_tokens 的本地估算口径一致。响应形状是标准的
// {totalTokens}，标准 SDK 可以直接解析。
func countTokensPayload(body []byte) []byte {
	count := estimateTokenCount(body)
	payload, err := json.Marshal(map[string]any{"totalTokens": count})
	if err != nil {
		return []byte(`{"totalTokens":1}`)
	}
	return payload
}

func estimateTokenCount(body []byte) int {
	var compact bytes.Buffer
	if err := json.Compact(&compact, body); err != nil {
		return 1
	}
	tokens := (compact.Len() + 3) / 4
	if tokens < 1 {
		return 1
	}
	return tokens
}
