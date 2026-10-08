package codexresponsesws

import "testing"

// TestDecodeCompletedUsageReadsResponsesUsage 验证完成帧 usage 投影与缺失容错。
func TestDecodeCompletedUsageReadsResponsesUsage(t *testing.T) {
	t.Parallel()

	usage, ok := decodeCompletedUsage([]byte(`{"type":"response.completed","response":{"id":"r","usage":{
		"input_tokens":1200,"input_tokens_details":{"cached_tokens":1000,"cache_write_tokens":100},
		"output_tokens":80,"output_tokens_details":{"reasoning_tokens":30},"total_tokens":1280}}}`))
	if !ok || usage.InputTokens() != 1200 || usage.CachedInputTokens() != 1000 || usage.CacheWriteInputTokens() != 100 ||
		usage.OutputTokens() != 80 || usage.ReasoningTokens() != 30 || usage.TotalTokens() != 1280 {
		t.Fatalf("usage = %+v ok=%v", usage, ok)
	}
	for _, payload := range []string{
		`{"type":"response.completed","response":{"id":"r"}}`,
		`{"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}`,
		`{"type":"response.completed","response":{"usage":{"input_tokens":1200,"input_tokens_details":{"cached_tokens":1000,"cache_write_tokens":201},"output_tokens":80}}}`,
		`not json`,
	} {
		if _, ok := decodeCompletedUsage([]byte(payload)); ok {
			t.Fatalf("decodeCompletedUsage(%s) should report missing usage", payload)
		}
	}
}
