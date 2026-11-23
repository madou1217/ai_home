package mcpscope

import "testing"

func ids(resolved []Resolved) []string {
	out := make([]string, 0, len(resolved))
	for _, item := range resolved {
		out = append(out, item.ID)
	}
	return out
}

func TestAutoUsesDefaults(t *testing.T) {
	resolved, err := Resolve(Builtins(), Policy{}, Context{Provider: "codex", WorkspaceBound: true})
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 1 || resolved[0].ID != IDRemoteTools {
		t.Fatalf("unexpected %v", ids(resolved))
	}
	if resolved[0].Reason != "workspace 绑定" {
		t.Fatalf("reason = %q", resolved[0].Reason)
	}
}

func TestAllowlistIntersectsRegistry(t *testing.T) {
	resolved, err := Resolve(Builtins(), Policy{Mode: ModeAllowlist, Allow: []string{" aih_remote ", "aih_remote"}}, Context{})
	if err != nil {
		t.Fatal(err)
	}
	if len(resolved) != 1 {
		t.Fatalf("expected dedupe, got %v", ids(resolved))
	}
}

func TestAllowlistRejectsUnknown(t *testing.T) {
	if _, err := Resolve(Builtins(), Policy{Mode: ModeAllowlist, Allow: []string{"missing"}}, Context{}); err == nil {
		t.Fatal("expected unknown mcp error")
	}
}

func TestDisabledIsEmpty(t *testing.T) {
	resolved, err := Resolve(Builtins(), Policy{Mode: ModeDisabled}, Context{})
	if err != nil || len(resolved) != 0 {
		t.Fatalf("disabled should be empty: %v %v", resolved, err)
	}
}

func TestProviderFilter(t *testing.T) {
	definitions := []Definition{{ID: "claude_only", Default: true, Providers: []string{"claude"}}}
	resolved, err := Resolve(definitions, Policy{}, Context{Provider: "codex"})
	if err != nil || len(resolved) != 0 {
		t.Fatalf("expected provider filter, got %v %v", ids(resolved), err)
	}
}
