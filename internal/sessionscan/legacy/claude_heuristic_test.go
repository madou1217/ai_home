package legacy

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestResolveClaudeProjectPathKnownPathFallback(t *testing.T) {
	dirName := "-aih-known-fallback-test"
	known := "/aih/known/fallback/test"
	if sanitizePath(known) != dirName {
		t.Fatalf("fixture mismatch: sanitizePath(%q) = %q", known, sanitizePath(known))
	}

	got := resolveClaudeProjectPath(dirName, []string{known})
	if got != known {
		t.Fatalf("resolveClaudeProjectPath = %q, want known path %q", got, known)
	}
}

func TestResolveClaudeProjectPathFallsBackToSlashReplacement(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base := t.TempDir()
	missing := filepath.Join(base, "aih-resolve-missing-zz7f3c9")
	dirName := sanitizePath(missing)

	got := resolveClaudeProjectPath(dirName, nil)
	want := strings.ReplaceAll(dirName, "-", "/")
	if got != want {
		t.Fatalf("resolveClaudeProjectPath = %q, want heuristic fallback %q", got, want)
	}
}

func TestResolveClaudeProjectPathFallsBackWhenOnlyPrefixExists(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base := t.TempDir()
	if err := os.MkdirAll(filepath.Join(base, "aih-prefix-only"), 0o755); err != nil {
		t.Fatal(err)
	}
	dirName := sanitizePath(filepath.Join(base, "aih-prefix-only-missing-child"))

	got := resolveClaudeProjectPath(dirName, nil)
	want := strings.ReplaceAll(dirName, "-", "/")
	if got != want {
		t.Fatalf("resolveClaudeProjectPath = %q, want heuristic fallback %q", got, want)
	}
}
func TestResolveClaudeProjectPathHeuristicTokenSuccess(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("sanitized absolute paths are POSIX-shaped")
	}
	base, err := os.MkdirTemp("/tmp", "aihheuristic")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(base) })
	target := filepath.Join(base, "existing")
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}

	// Drop the leading '-' so the real-path resolver is skipped and the old
	// per-token heuristic is forced.
	dirName := strings.TrimPrefix(sanitizePath(target), "-")
	got := resolveClaudeProjectPath(dirName, nil)
	if got != target {
		t.Fatalf("resolveClaudeProjectPath = %q, want heuristic token path %q", got, target)
	}
}

func TestResolveClaudePathFromDirEdgeCases(t *testing.T) {
	dir := t.TempDir()
	if got, ok := resolveClaudePathFromDir(dir, ""); !ok || got != dir {
		t.Fatalf("empty remaining = %q, %t; want %q, true", got, ok, dir)
	}
	if _, ok := resolveClaudePathFromDir(filepath.Join(dir, "missing"), "x"); ok {
		t.Fatal("missing directory should not resolve")
	}
	if err := os.MkdirAll(filepath.Join(dir, "a"), 0o755); err != nil {
		t.Fatal(err)
	}
	// entry "a" matches the prefix, but the next character is not a separator.
	if _, ok := resolveClaudePathFromDir(dir, "ab"); ok {
		t.Fatal("non-separator suffix should not resolve")
	}
}
