package codeassist

import "testing"

// 上游只接受 *-tiered 基座：展开出来的 -high/-medium/-low 必须是基座的别名，
// 否则网关会把档位 id 原样发给上游并得到 404（真机已复现）。
func TestDecodeModelCatalogMapsTierAliasesToTieredBase(t *testing.T) {
	payload := []byte(`{"models":{"gemini-3.8-flash-tiered":{}}}`)
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatalf("decodeModelCatalog() error = %v", err)
	}
	found := make(map[string]bool, len(models))
	for _, model := range models {
		found[model] = true
	}
	for _, alias := range []string{
		"gemini-3.8-flash-high",
		"gemini-3.8-flash-medium",
		"gemini-3.8-flash-low",
	} {
		if !found[alias] {
			t.Fatalf("model %s missing from catalog %v", alias, models)
		}
		if wires[alias] != "gemini-3.8-flash-tiered" {
			t.Fatalf("wire[%s] = %q, want tiered base", alias, wires[alias])
		}
	}
	if wires["gemini-3.8-flash-tiered"] != "" {
		t.Fatalf("base model must not be rewritten: %q", wires["gemini-3.8-flash-tiered"])
	}
}
