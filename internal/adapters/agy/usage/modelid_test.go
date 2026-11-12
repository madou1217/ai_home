package usage

import (
	"encoding/json"
	"testing"
)

func TestIsRealProviderModelID(t *testing.T) {
	t.Parallel()
	cases := []struct {
		id   string
		want bool
	}{
		{id: "gemini-3-pro", want: true},
		{id: "claude-sonnet-4-5", want: true},
		{id: "  gemini-3-pro  ", want: true},
		{id: "", want: false},
		{id: "*", want: false},
		{id: "gemini-*", want: false},
		// 内部枚举只认全大写：MODEL_foo 在 Node 的正则下不是内部枚举。
		{id: "MODEL_FOO_BAR", want: false},
		{id: "MODEL_foo", want: true},
		{id: "MODEL_FOO_VERTEX", want: false},
		{id: "chat_internal", want: false},
		// 锚点 ^chat_[a-z0-9]+$：带下划线的续写不是同一类资源。
		{id: "chat_internal_foo", want: true},
		{id: "tab_completion", want: false},
		{id: "tab_completion_v2", want: false},
		{id: "models/gemini-3-pro", want: false},
		{id: "gemini-proactive-observer-x", want: false},
		{id: "gemini-placeholder-1", want: false},
	}
	for _, testCase := range cases {
		if got := isRealProviderModelID(testCase.id); got != testCase.want {
			t.Fatalf("isRealProviderModelID(%q) = %v, want %v", testCase.id, got, testCase.want)
		}
	}
}

func TestStripCodeAssistModelSuffix(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"gemini-3-pro_vertex": "gemini-3-pro",
		"gemini-3-pro_VERTEX": "gemini-3-pro",
		"gemini-3-pro":        "gemini-3-pro",
		"vertex":              "vertex",
		"_vertex":             "",
	}
	for input, want := range cases {
		if got := stripCodeAssistModelSuffix(input); got != want {
			t.Fatalf("stripCodeAssistModelSuffix(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestReadPublicModelID(t *testing.T) {
	t.Parallel()
	object := func(raw string) map[string]json.RawMessage {
		var parsed map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		return parsed
	}
	// MODEL_ID_FIELDS 顺序是 id → model：两者都在时 Node 取 id。
	if got := readPublicModelID(object(`{"id":"alpha","model":"beta"}`)); got != "alpha" {
		t.Fatalf("id precedence = %q", got)
	}
	if got := readPublicModelID(object(`{"model":"gemini-3-pro_vertex"}`)); got != "gemini-3-pro" {
		t.Fatalf("vertex suffix = %q", got)
	}
	if got := readPublicModelID(object(`{"model":"MODEL_PLACEHOLDER_1"}`)); got != "" {
		t.Fatalf("placeholder = %q", got)
	}
	if got := readPublicModelID(object(`{"model_id":"gemini-2-5-flash"}`)); got != "gemini-2-5-flash" {
		t.Fatalf("snake field = %q", got)
	}
	// 归一字段名匹配：modelId 与 model_id 同键。
	if got := readPublicModelID(object(`{"ModelId":"claude-opus-4-5"}`)); got != "claude-opus-4-5" {
		t.Fatalf("normalized field name = %q", got)
	}
}

func TestObjectModelID(t *testing.T) {
	t.Parallel()
	var info map[string]json.RawMessage
	if err := json.Unmarshal([]byte(`{"model":"beta"}`), &info); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got := objectModelID("alpha", info); got != "alpha" {
		t.Fatalf("key precedence = %q", got)
	}
	if got := objectModelID("", info); got != "beta" {
		t.Fatalf("fallback = %q", got)
	}
}
