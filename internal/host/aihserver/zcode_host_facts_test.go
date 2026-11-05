package aihserver

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadZcodeHostFacts(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "run"), 0o755); err != nil {
		t.Fatal(err)
	}
	body := `{"appVersion":"3.17.1","blocks":[{"type":"text","text":"identity"},{"type":"text","text":"rules"}]}`
	if err := os.WriteFile(filepath.Join(dir, "run", zcodeHarnessStoreFile), []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
	facts := loadZcodeHostFacts(dir)
	if facts.AppVersion != "3.17.1" || len(facts.HarnessBlocks) != 2 {
		t.Fatalf("facts = %#v", facts)
	}
	if facts.AIHomeDir != dir {
		t.Fatalf("AIHomeDir = %q", facts.AIHomeDir)
	}
}

func TestLoadZcodeHostFactsMissingFileIsFailSoft(t *testing.T) {
	facts := loadZcodeHostFacts(t.TempDir())
	if facts.AppVersion != "" || len(facts.HarnessBlocks) != 0 {
		t.Fatalf("缺文件时必须零值: %#v", facts)
	}
}
