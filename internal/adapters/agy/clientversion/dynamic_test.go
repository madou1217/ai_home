package clientversion

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLatestVersionFromPagePicksHighestMajorTwoOrNewer(t *testing.T) {
	page := `<a>Antigravity CLI v1.5.5</a>
<a>Antigravity IDE v2.6.0</a>
<a>Antigravity v2.31.0</a>
<a>VS Code Extension v1.12.0</a>`
	if got := latestVersionFromPage(page); got != "2.31.0" {
		t.Fatalf("latestVersionFromPage() = %q, want 2.31.0", got)
	}
}

func TestLatestVersionFromPageRejectsOneXOnly(t *testing.T) {
	if got := latestVersionFromPage("cli v1.5.5"); got != "" {
		t.Fatalf("latestVersionFromPage() = %q, want empty", got)
	}
}

func TestCachedVersionRoundTrip(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("XDG_CACHE_HOME", filepath.Join(home, "cache"))
	writeCachedVersion("2.7.3")
	if got := readCachedVersion(); got != "2.7.3" {
		t.Fatalf("readCachedVersion() = %q", got)
	}
	path := cacheFilePath()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("cache file missing: %v", err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("cache mode = %o, want 600", info.Mode().Perm())
	}
}
