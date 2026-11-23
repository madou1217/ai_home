package mcpscope

import "testing"

func TestSessionNoMCPDisablesEverything(t *testing.T) {
	resolved, err := ResolveSession(Builtins(), Policy{}, SessionSelection{NoMCP: true}, Context{Provider: "codex"})
	if err != nil || len(resolved) != 0 {
		t.Fatalf("expected empty, got %v %v", resolved, err)
	}
}

func TestSessionOnlyNarrows(t *testing.T) {
	resolved, err := ResolveSession(Builtins(), Policy{}, SessionSelection{Only: []string{"aih_remote"}}, Context{Provider: "codex"})
	if err != nil || len(resolved) != 1 {
		t.Fatalf("expected aih_remote, got %v %v", resolved, err)
	}
}

func TestSessionCannotWidenAccount(t *testing.T) {
	if _, err := ResolveSession(Builtins(), Policy{Mode: ModeDisabled}, SessionSelection{Only: []string{"aih_remote"}}, Context{}); err == nil {
		t.Fatal("expected account ceiling error")
	}
}

func TestSessionEmptyKeepsAccount(t *testing.T) {
	resolved, err := ResolveSession(Builtins(), Policy{}, SessionSelection{}, Context{})
	if err != nil || len(resolved) != 1 {
		t.Fatalf("expected account result, got %v %v", resolved, err)
	}
}
