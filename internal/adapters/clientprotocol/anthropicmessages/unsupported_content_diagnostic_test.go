package anthropicmessages

import (
	"strings"
	"testing"
)

// 未支持的内容块类型要在诊断里带上（清洗后的）判别值，go-core.log 才能指出是哪种新块。
func TestUnsupportedContentBlocksNameTheirType(t *testing.T) {
	t.Parallel()
	for name, testCase := range map[string]struct {
		body  string
		field string
	}{
		"message block": {`{"model":"m","max_tokens":8,"messages":[{"role":"user","content":"a"},{"role":"system","content":[{"type":"text","text":"x"},{"type":"tool_additions","tools":[]}]}]}`, "messages[1].content[1].type=tool_additions"},
		"system block":  {`{"model":"m","max_tokens":8,"system":[{"type":"image"}],"messages":[{"role":"user","content":"a"}]}`, "system[0].type=image"},
		"sanitized":     {`{"model":"m","max_tokens":8,"messages":[{"role":"user","content":[{"type":"we ird\n<x>"}]}]}`, "messages[0].content[0].type=we?ird??x?"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := NewRequestDecoder().Decode([]byte(testCase.body))
			if err == nil || !strings.Contains(err.Error(), testCase.field) {
				t.Fatalf("Decode() error = %v, want %s", err, testCase.field)
			}
		})
	}
}
