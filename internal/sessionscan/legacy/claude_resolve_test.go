package legacy

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestResolveClaudeProjectPathResolvesHyphenatedDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base := t.TempDir()
	target := filepath.Join(base, "aih-acp-probe-e2e-work")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	got := resolveClaudeProjectPath(sanitizePath(target), nil)
	if got != target {
		t.Fatalf("resolveClaudeProjectPath = %q, want %q", got, target)
	}
}

func TestResolveClaudeProjectPathResolvesDotDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base := t.TempDir()
	target := filepath.Join(base, ".claude", "jobs", "41c496b5")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	got := resolveClaudeProjectPath(sanitizePath(target), nil)
	if got != target {
		t.Fatalf("resolveClaudeProjectPath = %q, want %q", got, target)
	}
}

func TestResolveClaudeProjectPathResolvesUnderscoreDirectory(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base := t.TempDir()
	target := filepath.Join(base, "ai_home")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	got := resolveClaudeProjectPath(sanitizePath(target), nil)
	if got != target {
		t.Fatalf("resolveClaudeProjectPath = %q, want %q", got, target)
	}
}

func TestResolveClaudeProjectPathBacktracksPastShorterPrefix(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "aih"), 0o755); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(base, "aih-acp-probe-e2e-work")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	got := resolveClaudeProjectPath(sanitizePath(target), nil)
	if got != target {
		t.Fatalf("resolveClaudeProjectPath = %q, want %q", got, target)
	}
}

func TestReadClaudeProjectUsesRecordedDeletedCwd(t *testing.T) {
	home := t.TempDir()
	cwd := "/private/tmp/aih-acp-probe-test-does-not-exist/e2e-work"
	if isDirectory(cwd) {
		t.Fatalf("test cwd unexpectedly exists: %s", cwd)
	}
	dirName := sanitizePath(cwd)
	writeFixture(t, filepath.Join(home, ".claude", "projects", dirName, "s1.jsonl"),
		fmt.Sprintf("{\"type\":\"user\",\"cwd\":%q,\"message\":{\"content\":\"Deleted cwd\"}}\n", cwd),
		time.Date(2026, 2, 1, 0, 0, 0, 0, time.UTC))

	project, ok := ReadClaudeProject(home, dirName, nil)
	if !ok {
		t.Fatal("ReadClaudeProject returned ok=false")
	}
	if project.Path != cwd {
		t.Fatalf("project.Path = %q, want recorded cwd %q", project.Path, cwd)
	}
}
