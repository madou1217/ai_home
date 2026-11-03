package modelsapi

import "testing"

func TestResolveModelOwnerRecognizesClinePassNamespace(t *testing.T) {
	if got := resolveModelOwner("cline", "cline-pass/sonnet"); got != "cline" {
		t.Fatalf("resolveModelOwner() = %q, want cline", got)
	}
}

func TestResolveModelOwnerFallsBackToClineProvider(t *testing.T) {
	if got := resolveModelOwner("cline", "custom-model"); got != "cline" {
		t.Fatalf("resolveModelOwner() = %q, want cline", got)
	}
}
