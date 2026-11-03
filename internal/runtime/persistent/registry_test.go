package persistent

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestRegistryWritesAddressingMetadataAndSurvivesReopen(t *testing.T) {
	dir := t.TempDir()
	registry, err := NewRegistry(filepath.Join(dir, "run"))
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	entry := Entry{
		Provider: "codex", RuntimeScope: "acct_0123456789abcdef0123", AccountRef: "acct_0123456789abcdef0123",
		Socket: "aih-codex-acct_0123456789abcdef0123", Session: "p-project-abc123", CWD: dir,
		ForwardArgs: []string{"resume", "thread-1"}, CreatedAt: time.UnixMilli(100).UTC(),
	}
	if err := registry.Write(context.Background(), entry); err != nil {
		t.Fatalf("Write() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "run", "persistent-sessions", "aih-codex-acct_0123456789abcdef0123--p-project-abc123.json")); err != nil {
		t.Fatalf("registry file missing: %v", err)
	}
	reopened, err := NewRegistry(filepath.Join(dir, "run"))
	if err != nil {
		t.Fatalf("reopen NewRegistry() error = %v", err)
	}
	entries, err := reopened.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Session != entry.Session || entries[0].ForwardArgs[1] != "thread-1" {
		t.Fatalf("entries = %#v", entries)
	}
}

func TestRegistryRejectsInvalidScopeAndNeverStoresSecretLikeFields(t *testing.T) {
	registry, err := NewRegistry(t.TempDir())
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	if err := registry.Write(context.Background(), Entry{Provider: "codex", RuntimeScope: "gateway", AccountRef: "acct_0123456789abcdef0123", Socket: "socket", Session: "session"}); err == nil {
		t.Fatal("Write() accepted mismatched runtime scope")
	}
	if err := registry.Write(context.Background(), Entry{Provider: "codex", RuntimeScope: "acct_0123456789abcdef0123", AccountRef: "acct_0123456789abcdef0123", Socket: "socket", Session: "session", Secret: "token"}); err == nil {
		t.Fatal("Write() accepted secret metadata")
	}
}
