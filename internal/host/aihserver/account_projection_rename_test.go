package aihserver

import (
	"os"
	"path/filepath"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestRenameAuthProjectionDirMovesRuntimeState(t *testing.T) {
	aiHomeDir := t.TempDir()
	previous := accountcore.AccountRef("acct_0123456789abcdef0123")
	current := accountcore.AccountRef("acct_abcdef0123456789abcd")
	from := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", previous.String())
	if err := os.MkdirAll(filepath.Join(from, ".gemini"), 0o700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(from, ".gemini", "oauth_creds.json")
	if err := os.WriteFile(file, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := renameAuthProjectionDir(aiHomeDir, "agy", previous, current); err != nil {
		t.Fatalf("renameAuthProjectionDir() error = %v", err)
	}
	if _, err := os.Stat(from); !os.IsNotExist(err) {
		t.Fatalf("old projection dir still exists: %v", err)
	}
	moved := filepath.Join(aiHomeDir, "run", "auth-projections", "agy", current.String(), ".gemini", "oauth_creds.json")
	if _, err := os.Stat(moved); err != nil {
		t.Fatalf("moved projection file error = %v", err)
	}
}

func TestRenameAuthProjectionDirKeepsExistingTarget(t *testing.T) {
	aiHomeDir := t.TempDir()
	previous := accountcore.AccountRef("acct_0123456789abcdef0123")
	current := accountcore.AccountRef("acct_abcdef0123456789abcd")
	root := filepath.Join(aiHomeDir, "run", "auth-projections", "agy")
	for _, ref := range []accountcore.AccountRef{previous, current} {
		if err := os.MkdirAll(filepath.Join(root, ref.String()), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := renameAuthProjectionDir(aiHomeDir, "agy", previous, current); err != nil {
		t.Fatalf("renameAuthProjectionDir() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, previous.String())); err != nil {
		t.Fatalf("old dir must stay when target exists: %v", err)
	}
}
