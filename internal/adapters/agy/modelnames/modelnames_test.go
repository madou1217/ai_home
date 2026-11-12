package modelnames

import "testing"

func TestListOrderAndDefault(t *testing.T) {
	names := List()
	if len(names) == 0 || names[0] != "Gemini 3.8 Flash (High)" {
		t.Fatalf("List() = %v", names)
	}
	if Default() != names[0] {
		t.Fatalf("Default() = %q, want %q", Default(), names[0])
	}
	// 去重：tiered 与 medium 共用显示名。
	count := 0
	for _, name := range names {
		if name == "Gemini 3.8 Flash (Medium)" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("duplicate display names = %v", names)
	}
}

func TestResolve(t *testing.T) {
	cases := map[string]string{
		"gemini-3.8-flash-high":    "Gemini 3.8 Flash (High)",
		"gemini-3.8-flash-tiered":  "Gemini 3.8 Flash (Medium)",
		"  gemini-3.8-flash-low  ": "Gemini 3.8 Flash (Low)",
		"Gemini 3.8 Flash (Low)":   "Gemini 3.8 Flash (Low)",
		"unknown-model":            "",
		"":                         "",
	}
	for input, want := range cases {
		if got := Resolve(input); got != want {
			t.Fatalf("Resolve(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestListReturnsCopy(t *testing.T) {
	names := List()
	names[0] = "mutated"
	if Default() == "mutated" {
		t.Fatal("List() exposed internal slice")
	}
}
