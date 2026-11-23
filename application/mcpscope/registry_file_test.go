package mcpscope

import (
	"os"
	"path/filepath"
	"testing"
)

func writeRegistry(t *testing.T, body string) string {
	t.Helper()
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "mcp"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(RegistryPath(home), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	return home
}

func TestLoadRegistryMissingFileUsesBuiltins(t *testing.T) {
	definitions, err := LoadRegistry(t.TempDir())
	if err != nil || len(definitions) != 1 || definitions[0].ID != IDRemoteTools {
		t.Fatalf("unexpected %v %v", definitions, err)
	}
}

func TestLoadRegistryMergesCustomServer(t *testing.T) {
	home := writeRegistry(t, `{"mcpServers":[{"id":"github","displayName":"GitHub","command":"github-mcp","default":false}]}`)
	definitions, err := LoadRegistry(home)
	if err != nil {
		t.Fatal(err)
	}
	if len(definitions) != 2 || definitions[1].ID != "github" || definitions[1].Transport != "stdio" {
		t.Fatalf("unexpected %v", definitions)
	}
}

func TestLoadRegistryRejectsDuplicateAndInvalid(t *testing.T) {
	duplicate := writeRegistry(t, `{"mcpServers":[{"id":"aih_remote","command":"x"}]}`)
	if _, err := LoadRegistry(duplicate); err == nil {
		t.Fatal("expected duplicate id error")
	}
	missingCommand := writeRegistry(t, `{"mcpServers":[{"id":"github"}]}`)
	if _, err := LoadRegistry(missingCommand); err == nil {
		t.Fatal("expected missing command error")
	}
}
