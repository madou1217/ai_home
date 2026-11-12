package settings

import (
	"reflect"
	"testing"
)

func TestListModelNamesOrderAndContent(t *testing.T) {
	want := []string{
		"Gemini 3.8 Flash (High)",
		"Gemini 3.8 Flash (Medium)",
		"Gemini 3.8 Flash (Low)",
		"Claude Sonnet 4.6 (Thinking)",
		"Claude Opus 4.6 (Thinking)",
		"GPT-OSS 120B (Medium)",
	}
	if got := ListModelNames(); !reflect.DeepEqual(got, want) {
		t.Fatalf("ListModelNames() = %v, want %v", got, want)
	}
	if got := DefaultModelName(); got != "Gemini 3.8 Flash (High)" {
		t.Fatalf("DefaultModelName() = %q, want 首项显示名", got)
	}
}

func TestListModelNamesReturnsCopy(t *testing.T) {
	names := ListModelNames()
	names[0] = "mutated"
	if got := ListModelNames()[0]; got == "mutated" {
		t.Fatalf("ListModelNames() 必须返回副本，内部表被调用方改坏")
	}
}

func TestResolveModelName(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"gemini-3.8-flash-high", "Gemini 3.8 Flash (High)"},
		{"gemini-3.8-flash-tiered", "Gemini 3.8 Flash (Medium)"},
		{"claude-opus-4-6-thinking", "Claude Opus 4.6 (Thinking)"},
		{"gpt-oss-120b-medium", "GPT-OSS 120B (Medium)"},
		{"  Gemini 3.8 Flash (Low)  ", "Gemini 3.8 Flash (Low)"},
		{"Gemini 3.5 Flash (High)", ""},
		{"gemini-9.9-unknown", ""},
		{"", ""},
		{"   ", ""},
	}
	for _, item := range cases {
		if got := ResolveModelName(item.input); got != item.want {
			t.Fatalf("ResolveModelName(%q) = %q, want %q", item.input, got, item.want)
		}
	}
}

func TestResolveModelNameRoundTripsEveryAlias(t *testing.T) {
	// 表已收敛到 modelnames；这里锁住 settings 的委托结果。
	for _, id := range []string{
		"gemini-3.8-flash-high",
		"gemini-3.8-flash-medium",
		"gemini-3.8-flash-tiered",
		"gemini-3.8-flash-low",
		"claude-sonnet-4-6",
		"claude-opus-4-6-thinking",
		"gpt-oss-120b-medium",
	} {
		name := ResolveModelName(id)
		if name == "" {
			t.Fatalf("ResolveModelName(%q) = empty", id)
		}
		if got := ResolveModelName(name); got != name {
			t.Fatalf("ResolveModelName(%q) = %q, want 原样返回", name, got)
		}
	}
}
