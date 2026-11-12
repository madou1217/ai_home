package codeassist

import "testing"

func TestDecodeModelCatalogExpandsAliases(t *testing.T) {
	payload := []byte(`{
		"models": {
			"gemini-3.8-flash-tiered": {
				"displayName": "Gemini 3.8 Flash (Medium)",
				"aliases": ["gemini-3.8-flash-high", "gemini-3.8-flash-medium"],
				"commandModelIds": {"low": "gemini-3.8-flash-low"}
			}
		}
	}`)
	models, wires, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		seen[model] = true
	}
	for _, want := range []string{"gemini-3.8-flash-tiered", "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"} {
		if !seen[want] {
			t.Fatalf("model %q missing from %v", want, models)
		}
	}
	for _, alias := range []string{"gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"} {
		if wires[alias] != "gemini-3.8-flash-tiered" {
			t.Fatalf("wire %q = %q", alias, wires[alias])
		}
	}
}

func TestDecodeModelCatalogExpandsTieredBase(t *testing.T) {
	payload := []byte(`{"models":{"gemini-3.8-flash-tiered":{}}}`)
	models, _, err := decodeModelCatalog(payload)
	if err != nil {
		t.Fatal(err)
	}
	seen := make(map[string]bool, len(models))
	for _, model := range models {
		seen[model] = true
	}
	for _, want := range []string{"gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low"} {
		if !seen[want] {
			t.Fatalf("tiered expansion missing %q: %v", want, models)
		}
	}
}
