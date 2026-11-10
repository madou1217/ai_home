package webuifile

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWithinRoot(t *testing.T) {
	cases := []struct {
		name   string
		root   string
		target string
		want   bool
	}{
		{name: "same", root: "/a/b", target: "/a/b", want: true},
		{name: "child", root: "/a/b", target: "/a/b/c.txt", want: true},
		{name: "descendant", root: "/a/b", target: "/a/b/c/d", want: true},
		{name: "prefix trick", root: "/a/b", target: "/a/bc", want: false},
		{name: "parent", root: "/a/b", target: "/a", want: false},
		{name: "sibling", root: "/a/b", target: "/a/c", want: false},
		{name: "dot dot", root: "/a/b", target: "/a/b/../c", want: false},
		{name: "relative target", root: "/a/b", target: "c", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := WithinRoot(tc.root, tc.target); got != tc.want {
				t.Fatalf("WithinRoot(%q, %q) = %v, want %v", tc.root, tc.target, got, tc.want)
			}
		})
	}
}

func TestSensitivePaths(t *testing.T) {
	home := t.TempDir()
	deny := DenyPolicy{HostHomeDir: home}

	denied := []string{
		"/home/u/.ssh/id_ed25519",
		// JSON 转义过的 Windows 路径里 .ssh 两侧是双反斜杠（Node 只认这种形态）。
		"C:\\\\Users\\\\u\\\\.ssh\\\\config",
		"/home/u/.ssh/config",
		"/tmp/auth.json",
		"/tmp/oauth_creds.json",
		"/tmp/credentials.json",
		"/tmp/id_rsa",
		"/tmp/electron-user-data",
		"/tmp/Library/Keychains",
		"/tmp/.codex/auth.json.bak",
		"/tmp/.codex/config.toml",
		"/tmp/data.sqlite3",
	}
	for _, target := range denied {
		if !deny.IsSensitive(target) {
			t.Errorf("IsSensitive(%q) = false, want true", target)
		}
	}

	// 目录型私有产物只拒绝目录本身，其子文件不在此函数内（与 Node 一致）。
	allowed := []string{
		"/tmp/electron-user-data/Cache",
		"/tmp/Library/Keychains/login.keychain-db",
		"/tmp/id_rsa.pub",
		"/tmp/notes.txt",
		"/tmp/project/main.go",
		"/tmp/.codex/sessions/rollout.jsonl",
		"/tmp/.claude/projects/-sessions/s.jsonl",
	}
	for _, target := range allowed {
		if deny.IsSensitive(target) {
			t.Errorf("IsSensitive(%q) = true, want false", target)
		}
	}
	if deny.IsSensitive("") {
		t.Error("empty path must not be sensitive")
	}
}

func TestSensitiveProviderConfigurationAndArtifacts(t *testing.T) {
	home := "/host/home"
	deny := DenyPolicy{HostHomeDir: home}

	cases := []struct {
		target string
		want   bool
	}{
		// provider 配置：recursive 与备份变体都要拒绝。
		{filepath.Join(home, ".codex", "config.toml"), true},
		{filepath.Join(home, ".codex", "config.toml.backup-2026"), true},
		{filepath.Join(home, ".codex", "hooks.json.tmp"), true},
		{filepath.Join(home, ".claude", "settings.json"), true},
		{filepath.Join(home, ".claude", "settings.local.json.old"), true},
		{filepath.Join(home, ".config", "opencode", "anything", "deep.json"), true},
		{filepath.Join(home, ".gemini", "config", "nested", "x"), true},
		{filepath.Join(home, ".gemini", "antigravity-cli", "mcp_config.json"), true},
		{filepath.Join(home, ".mcp.json"), true},
		// 相邻但不相关、深层同名文件不误伤。
		{filepath.Join(home, ".claude", "other.json"), false},
		{filepath.Join(home, ".codex", "sub", "config.toml"), false},
		{filepath.Join(home, "project", "settings.json"), false},
		// 账号私有产物按路径尾匹配，目录本身拒绝、子文件不在此规则内。
		{"/x/.codex/auth.json.bak", true},
		{"/x/.kimi-code/credentials/kimi-code.json", true},
		{"/x/.auth/user", true},
		{"/x/some/deep/credentials.json", true},
		{"/x/Library/Keychains", true},
		{"/x/Library/Keychains/login.keychain-db", false},
		{"/x/.codex/sessions/rollout.jsonl", false},
	}
	for _, tc := range cases {
		if got := deny.IsSensitive(tc.target); got != tc.want {
			t.Errorf("IsSensitive(%q) = %v, want %v", tc.target, got, tc.want)
		}
	}

	// 没有宿主 HOME 时只有配置表里、且不在私有产物表的路径会失去归因；
	// .codex/config.toml 属于私有产物，仍然拒绝。
	if (DenyPolicy{}).IsSensitive(filepath.Join(home, ".mcp.json")) {
		t.Error("empty host home must not match provider config")
	}
	if !(DenyPolicy{}).IsSensitive(filepath.Join(home, ".codex", "config.toml")) {
		t.Error("config.toml stays denied as a private artifact")
	}
	if !(DenyPolicy{}).IsSensitive(filepath.Join(home, ".codex", "auth.json")) {
		t.Error("auth.json must stay denied without host home")
	}
}

func TestTrustCandidates(t *testing.T) {
	boundary := TrustBoundary{HostHomeDir: "/host/home", AIHomeDir: "/host/home/.ai_home"}

	deep := TrustCandidates("/host/work/project/notes.md", boundary)
	if len(deep) != 2 {
		t.Fatalf("deep file candidates = %d, want 2", len(deep))
	}
	if deep[0].Scope != TrustScopeFileDirectory || deep[0].Path != "/host/work/project" {
		t.Fatalf("first candidate = %+v", deep[0])
	}
	if deep[0].Label != "信任此文件夹" || deep[1].Label != "信任父级文件夹" {
		t.Fatalf("labels = %q / %q", deep[0].Label, deep[1].Label)
	}
	if deep[1].Scope != TrustScopeParentDirectory || deep[1].Path != "/host/work" {
		t.Fatalf("second candidate = %+v", deep[1])
	}

	// 父目录就是宿主 HOME 时只剩文件目录：授权 HOME 等于放开全部凭据。
	nearHome := TrustCandidates(filepath.Join("/host/home", "project", "notes.md"), boundary)
	if len(nearHome) != 1 || nearHome[0].Path != filepath.Join("/host/home", "project") {
		t.Fatalf("near-home candidates = %+v", nearHome)
	}

	if candidates := TrustCandidates("/notes.md", boundary); len(candidates) != 0 {
		t.Fatalf("root file candidates = %+v, want none", candidates)
	}
	if candidates := TrustCandidates("relative/notes.md", boundary); len(candidates) != 0 {
		t.Fatalf("relative candidates = %+v, want none", candidates)
	}
}

func TestAddTrustedRoot(t *testing.T) {
	roots := NormalizeTrustedRoots([]TrustedRoot{
		{Path: "/work/a"},
		{Path: "/work/a"},
		{Path: "relative"},
		{Path: ""},
	})
	if len(roots) != 1 || roots[0].Path != "/work/a" {
		t.Fatalf("normalized = %+v", roots)
	}

	next, effective, err := AddTrustedRoot(roots, "/work/a/sub", 100)
	if err != nil {
		t.Fatalf("add covering: %v", err)
	}
	if effective != "/work/a" || len(next) != 1 {
		t.Fatalf("covering entry should be reused, got %q %+v", effective, next)
	}

	next, effective, err = AddTrustedRoot(roots, "/work", 100)
	if err != nil {
		t.Fatalf("add parent: %v", err)
	}
	if effective != "/work" || len(next) != 1 || next[0].Path != "/work" || next[0].TrustedAt != 100 {
		t.Fatalf("parent should replace child, got %q %+v", effective, next)
	}

	if _, _, err := AddTrustedRoot(roots, "relative", 100); err != ErrTrustRootInvalid {
		t.Fatalf("relative root err = %v", err)
	}
}

func TestImageContentTypes(t *testing.T) {
	cases := map[string]string{
		"a.png":       "image/png",
		"A.JPG":       "image/jpeg",
		"b.jpeg":      "image/jpeg",
		"c.svg":       "image/svg+xml",
		"d.webp":      "image/webp",
		"e.gif":       "image/gif",
		"f.avif":      "image/avif",
		"g.bmp":       "image/bmp",
		"notes.md":    "",
		"archive.zip": "",
	}
	for file, want := range cases {
		if got := ImageContentType(file); got != want {
			t.Errorf("ImageContentType(%q) = %q, want %q", file, got, want)
		}
	}

	headers, ok := NewMediaHeaders("cat.png", 42)
	if !ok || headers.ContentType != "image/png" || headers.ContentLength != 42 {
		t.Fatalf("headers = %+v ok=%v", headers, ok)
	}
	if headers.CacheControl != CacheControlNoStore || headers.Pragma != PragmaNoCache {
		t.Fatalf("cache headers = %+v", headers)
	}
	if _, ok := NewMediaHeaders("payload.bin", 1); ok {
		t.Fatal("non-image must be rejected")
	}
	if TextFileSizeLimit != 5*1024*1024 || MediaFileSizeLimit != 15*1024*1024 {
		t.Fatalf("limits = %d / %d", TextFileSizeLimit, MediaFileSizeLimit)
	}
	if SizeLimitMB(5*1024*1024) != 5 || SizeLimitMB(15*1024*1024) != 15 {
		t.Fatalf("SizeLimitMB = %d / %d", SizeLimitMB(5*1024*1024), SizeLimitMB(15*1024*1024))
	}
}

func TestResolveProjectChild(t *testing.T) {
	root := realTempDir(t)
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	writeFile(t, filepath.Join(root, "sub", "a.txt"), "a")
	outside := realTempDir(t)
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")
	if err := os.Symlink(outside, filepath.Join(root, "escape")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	child, ok := ResolveProjectChild(OSFS{}, root, "sub/a.txt")
	if !ok || child.RealRoot != root || child.RealTarget != filepath.Join(root, "sub", "a.txt") {
		t.Fatalf("child = %+v ok=%v", child, ok)
	}

	if _, ok := ResolveProjectChild(OSFS{}, root, "../"+filepath.Base(outside)); ok {
		t.Fatal("parent escape must be rejected")
	}
	if _, ok := ResolveProjectChild(OSFS{}, root, "/etc/hosts"); ok {
		t.Fatal("absolute path must be rejected")
	}
	if _, ok := ResolveProjectChild(OSFS{}, root, "escape/secret.txt"); ok {
		t.Fatal("symlink escape must be rejected")
	}
	if _, ok := ResolveProjectChild(OSFS{}, root, "missing.txt"); ok {
		t.Fatal("missing target must be rejected")
	}
}

func realTempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("eval temp dir: %v", err)
	}
	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}
