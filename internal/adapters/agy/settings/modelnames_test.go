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
	for _, alias := range agyCLIModelAliases {
		if got := ResolveModelName(alias.ID); got != alias.Name {
			t.Fatalf("ResolveModelName(%q) = %q, want %q", alias.ID, got, alias.Name)
		}
		if got := ResolveModelName(alias.Name); got != alias.Name {
			t.Fatalf("ResolveModelName(%q) = %q, want 原样返回", alias.Name, got)
		}
	}
}
