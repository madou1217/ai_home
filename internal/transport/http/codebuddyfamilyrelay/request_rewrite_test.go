package codebuddyfamilyrelay

import (
	"encoding/json"
	"errors"
	"slices"
	"strings"
	"testing"
)

const pinToolsJSON = `[{"type":"function","function":{"name":"get_weather"}},{"type":"function","function":{"name":"read_file"}}]`

// rewriteCase 一行 = 一种客户端能表达的 tool_choice 形态 + 我们承诺的结局。
// expectToolChoice 为空串表示「该字段必须从 body 里消失」（不是被置 null）。
type rewriteCase struct {
	name                 string
	body                 string
	expectToolChoice     string
	expectNormalized     bool
	expectDowngraded     bool
	expectPin            string
	expectPinPreserved   bool
	expectPinMissing     bool
	expectUnsupported    string
	expectNarrowedTools  int
	expectSystemInjected bool
	expectDegradations   []string
}

func rewriteCases() []rewriteCase {
	return []rewriteCase{
		{
			name: "absent",
			body: `{"model":"m","messages":[{"role":"system","content":"s"}]}`,
		},
		{
			name:             "string auto",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":"auto"}`,
			expectToolChoice: `"auto"`,
		},
		{
			name:             "string required",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":"required"}`,
			expectToolChoice: `"required"`,
		},
		{
			name:             "string none",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":"none"}`,
			expectToolChoice: `"none"`,
		},
		{
			name:             "string uppercase is normalised",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":"AUTO"}`,
			expectToolChoice: `"auto"`,
			expectNormalized: true,
		},
		{
			name:             "alias any is equivalent, not a downgrade",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":"any"}`,
			expectToolChoice: `"required"`,
			expectNormalized: true,
		},
		{
			name:              "unknown string relaxes to auto and is marked",
			body:              `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":"bogus","tools":` + pinToolsJSON + `}`,
			expectToolChoice:  `"auto"`,
			expectNormalized:  true,
			expectDowngraded:  true,
			expectUnsupported: "bogus",
			expectDegradations: []string{
				DegradationUnsupportedForm,
			},
		},
		{
			name:                "pin present narrows the tool list",
			body:                `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"function","function":{"name":"read_file"}},"tools":` + pinToolsJSON + `}`,
			expectToolChoice:    `"required"`,
			expectNormalized:    true,
			expectPin:           "read_file",
			expectPinPreserved:  true,
			expectNarrowedTools: 1,
		},
		{
			name:                "responses flat pin form is accepted",
			body:                `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"function","name":"get_weather"},"tools":` + pinToolsJSON + `}`,
			expectToolChoice:    `"required"`,
			expectNormalized:    true,
			expectPin:           "get_weather",
			expectPinPreserved:  true,
			expectNarrowedTools: 1,
		},
		{
			name:             "pin missing from tools degrades to bare required",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"function","function":{"name":"nope"}},"tools":` + pinToolsJSON + `}`,
			expectToolChoice: `"required"`,
			expectNormalized: true,
			expectDowngraded: true,
			expectPin:        "nope",
			expectPinMissing: true,
			expectDegradations: []string{
				DegradationPinMissing,
			},
		},
		{
			name:             "pin without any tools drops the field",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"function","function":{"name":"read_file"}}}`,
			expectNormalized: true,
			expectDowngraded: true,
			expectPin:        "read_file",
			expectPinMissing: true,
			expectDegradations: []string{
				DegradationPinMissing,
			},
		},
		{
			name:              "function form without a name degrades",
			body:              `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"function"},"tools":` + pinToolsJSON + `}`,
			expectToolChoice:  `"required"`,
			expectNormalized:  true,
			expectDowngraded:  true,
			expectUnsupported: "function_without_name",
			expectDegradations: []string{
				DegradationUnsupportedForm,
			},
		},
		{
			name:             "plain object forms map to the same string",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"none"},"tools":` + pinToolsJSON + `}`,
			expectToolChoice: `"none"`,
			expectNormalized: true,
		},
		{
			name:              "array form relaxes to auto",
			body:              `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":["a"],"tools":` + pinToolsJSON + `}`,
			expectToolChoice:  `"auto"`,
			expectNormalized:  true,
			expectDowngraded:  true,
			expectUnsupported: "array",
			expectDegradations: []string{
				DegradationUnsupportedForm,
			},
		},
		{
			name:              "number form relaxes to auto",
			body:              `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":7,"tools":` + pinToolsJSON + `}`,
			expectToolChoice:  `"auto"`,
			expectNormalized:  true,
			expectDowngraded:  true,
			expectUnsupported: "number",
			expectDegradations: []string{
				DegradationUnsupportedForm,
			},
		},
		{
			name:              "unknown form without tools drops the field",
			body:              `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":{"type":"wat"}}`,
			expectNormalized:  true,
			expectDowngraded:  true,
			expectUnsupported: "wat",
			expectDegradations: []string{
				DegradationUnsupportedForm,
			},
		},
		{
			name:             "null tool_choice is passed through untouched",
			body:             `{"model":"m","messages":[{"role":"system","content":"s"}],"tool_choice":null}`,
			expectToolChoice: "null",
		},
		{
			name:                 "missing system prompt is injected",
			body:                 `{"model":"m","messages":[{"role":"user","content":"hi"}]}`,
			expectSystemInjected: true,
		},
	}
}

// TestRewriteRequestBodyInvariants 逐行断言形态表，并同时校验跨形态不变量。
//
// 不变量（与 Node 侧 test/pinned-tool-translation.test.js 的 ①–⑦ 同源）：
//
//	① 上游合法性：落到 body 的 tool_choice 只可能是 auto/required/none，且 stream 恒为 true；
//	② 有损必留痕：降级必须给出原因（pinMissing 或 unsupportedForm）；
//	③ 钉选不静默丢失：客户端钉了函数名时，结局只能是保住或显式报缺失；
//	④ 保住的钉选严格等价：收窄 tools 到被钉的那一个 + required，且不标记降级；
//	⑤ 不改写入参：原始字节必须原样可用；
//	⑥ 未触碰字段逐字节保留（比 Node 更强的保证：只重写必须改的字段）；
//	⑦ 降级码与降级标记一致（客户端可见的那半不得与日志侧分叉）。
func TestRewriteRequestBodyInvariants(t *testing.T) {
	for _, testCase := range rewriteCases() {
		t.Run(testCase.name, func(t *testing.T) {
			original := []byte(testCase.body)
			result, err := RewriteRequestBody(original, RewriteOptions{})
			if err != nil {
				t.Fatalf("改写失败: %v", err)
			}
			// ⑤ 不改写入参。
			if string(original) != testCase.body {
				t.Fatalf("入参被就地改写: %s", original)
			}
			body := decodeObject(t, result.Body)
			// ① stream 恒为 true；**我们写出去**的 tool_choice 只能是上游认的字符串。
			// 未改动的 tool_choice 必须与客户端原样字节一致（例如 null 表示「没有约束」，
			// 上游按 Go string 接收 null 等价于未设置，改它反而是多余的改动）。
			if string(body["stream"]) != "true" {
				t.Fatalf("stream 必须为 true，实际 %s", body["stream"])
			}
			if result.ToolChoiceChanged {
				if raw, ok := body["tool_choice"]; ok {
					var value string
					if err := json.Unmarshal(raw, &value); err != nil || !supportedToolChoiceStrings[value] {
						t.Fatalf("落到 body 的 tool_choice 不是上游认的字符串: %s", raw)
					}
				}
			} else if original := decodeObject(t, []byte(testCase.body)); string(body["tool_choice"]) != string(original["tool_choice"]) {
				t.Fatalf("未改动的 tool_choice 必须保持原样: %s → %s", original["tool_choice"], body["tool_choice"])
			}
			if got := strings.TrimSpace(string(body["tool_choice"])); got != testCase.expectToolChoice {
				t.Fatalf("tool_choice = %q，期望 %q", got, testCase.expectToolChoice)
			}
			// 结论逐字段对照。
			assertEqual(t, "ToolChoiceChanged", result.ToolChoiceChanged, testCase.expectNormalized)
			assertEqual(t, "ToolChoiceDowngraded", result.ToolChoiceDowngraded, testCase.expectDowngraded)
			assertEqual(t, "ToolChoicePin", result.ToolChoicePin, testCase.expectPin)
			assertEqual(t, "ToolChoicePinPreserved", result.ToolChoicePinPreserved, testCase.expectPinPreserved)
			assertEqual(t, "ToolChoicePinMissing", result.ToolChoicePinMissing, testCase.expectPinMissing)
			assertEqual(t, "ToolChoiceUnsupportedForm", result.ToolChoiceUnsupportedForm, testCase.expectUnsupported)
			assertEqual(t, "NarrowedToolCount", result.NarrowedToolCount, testCase.expectNarrowedTools)
			assertEqual(t, "InjectedSystemPrompt", result.InjectedSystemPrompt, testCase.expectSystemInjected)
			if !slices.Equal(result.Degradations, testCase.expectDegradations) {
				t.Fatalf("Degradations = %v，期望 %v", result.Degradations, testCase.expectDegradations)
			}
			// ② 有损必留痕。
			if result.ToolChoiceDowngraded && !result.ToolChoicePinMissing && result.ToolChoiceUnsupportedForm == "" {
				t.Fatal("发生了降级却没有给出原因")
			}
			// ③ 钉选不静默丢失。
			if result.ToolChoicePin != "" && !result.ToolChoicePinPreserved && !result.ToolChoicePinMissing {
				t.Fatal("钉选既没保住也没报缺失")
			}
			// ④ 保住的钉选严格等价。
			if result.ToolChoicePinPreserved {
				if result.NarrowedToolCount != 1 || result.ToolChoiceDowngraded {
					t.Fatal("保住的钉选必须收窄到 1 个工具且不标记降级")
				}
				if string(body["tool_choice"]) != `"required"` {
					t.Fatalf("保住的钉选必须带 required，实际 %s", body["tool_choice"])
				}
				narrowed, err := decodeRawArray(body["tools"])
				if err != nil || len(narrowed) != 1 || toolFunctionName(narrowed[0]) != result.ToolChoicePin {
					t.Fatalf("收窄后的 tools 必须只剩被钉的那一个: %s", body["tools"])
				}
			}
			// ⑦ 降级码与降级标记一致。
			if (len(result.Degradations) > 0) != result.ToolChoiceDowngraded {
				t.Fatalf("降级码 %v 与降级标记 %v 不一致", result.Degradations, result.ToolChoiceDowngraded)
			}
		})
	}
}

// decodeObject 把改写结果解析成「字段 → 原始字节」。
func decodeObject(t *testing.T, body []byte) map[string]json.RawMessage {
	t.Helper()
	fields := map[string]json.RawMessage{}
	if err := json.Unmarshal(body, &fields); err != nil {
		t.Fatalf("结果不是 JSON 对象: %v", err)
	}
	return fields
}

// assertEqual 断言两个可比较值相等，并在失败信息里带上字段名。
func assertEqual[T comparable](t *testing.T, field string, actual, expected T) {
	t.Helper()
	if actual != expected {
		t.Fatalf("%s = %v，期望 %v", field, actual, expected)
	}
}

// TestRewriteRequestBodyPreservesUntouchedFields 守 ⑥：只重写必须改的字段，
// 其余字段的**原始字节**必须逐字节保留（上游的富字段如 reasoning_effort / metadata /
// extra_fields 不能因为我们解析过一次就被重排、被转成 float64 或被丢掉）。
func TestRewriteRequestBodyPreservesUntouchedFields(t *testing.T) {
	const body = `{"model":"hy4-preview","messages":[{"role":"user","content":"hi"}],` +
		`"reasoning_effort":"low","max_tokens":4096,"metadata":{"trace":{"id":"01234567890123456789"}},` +
		`"top_p":0.95,"extra_fields":{"a":[1,2,3]}}`
	result, err := RewriteRequestBody([]byte(body), RewriteOptions{})
	if err != nil {
		t.Fatalf("改写失败: %v", err)
	}
	original := decodeObject(t, []byte(body))
	rewritten := decodeObject(t, result.Body)
	for _, field := range []string{"model", "reasoning_effort", "max_tokens", "metadata", "top_p", "extra_fields"} {
		if string(rewritten[field]) != string(original[field]) {
			t.Fatalf("%s 被改动了: %s → %s", field, original[field], rewritten[field])
		}
	}
	// 首条被补上 system 后，原本的 user 消息必须原样保留。
	messages, err := decodeRawArray(rewritten["messages"])
	if err != nil || len(messages) != 2 {
		t.Fatalf("messages 应被补成 2 条: %s (%v)", rewritten["messages"], err)
	}
	if string(messages[1]) != `{"role":"user","content":"hi"}` {
		t.Fatalf("原有消息被改动: %s", messages[1])
	}
}

// TestRewriteRequestBodyKeepsExistingSystemMessage 守约束 3 的反面：
// 首条已经是 system（含大小写差异）时不得重复注入。
func TestRewriteRequestBodyKeepsExistingSystemMessage(t *testing.T) {
	const body = `{"model":"m","messages":[{"role":"System","content":"keep me"},{"role":"user","content":"hi"}]}`
	result, err := RewriteRequestBody([]byte(body), RewriteOptions{})
	if err != nil {
		t.Fatalf("改写失败: %v", err)
	}
	if result.InjectedSystemPrompt {
		t.Fatal("首条已是 system 时不得注入占位")
	}
	messages, _ := decodeRawArray(decodeObject(t, result.Body)["messages"])
	if len(messages) != 2 || string(messages[0]) != `{"role":"System","content":"keep me"}` {
		t.Fatalf("原有 system 消息被改动: %s", messages)
	}
}

// TestRewriteRequestBodyHonoursSystemPromptOverride 覆盖补位文案（部署可定制）。
func TestRewriteRequestBodyHonoursSystemPromptOverride(t *testing.T) {
	result, err := RewriteRequestBody(
		[]byte(`{"model":"m","messages":[{"role":"user","content":"hi"}]}`),
		RewriteOptions{DefaultSystemPrompt: "custom prompt"},
	)
	if err != nil {
		t.Fatalf("改写失败: %v", err)
	}
	messages, _ := decodeRawArray(decodeObject(t, result.Body)["messages"])
	if len(messages) == 0 || !strings.Contains(string(messages[0]), "custom prompt") {
		t.Fatalf("补位文案未生效: %s", messages)
	}
}

// TestRewriteRequestBodyRejectsInvalidJSON 非法请求体必须报错，由调用方交回 Canonical
// （那边按客户端协议给规范 400，而不是透传通道自造错误）。
func TestRewriteRequestBodyRejectsInvalidJSON(t *testing.T) {
	for _, body := range []string{"", "not json", "[1,2,3]", `{"messages":"nope"}`, `{"tools":"nope"}`} {
		if _, err := RewriteRequestBody([]byte(body), RewriteOptions{}); !errors.Is(err, ErrInvalidRequestBody) {
			t.Fatalf("body %q 应返回 ErrInvalidRequestBody，实际 %v", body, err)
		}
	}
}
