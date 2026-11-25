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
