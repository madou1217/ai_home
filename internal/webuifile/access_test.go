package webuifile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStripFileLineSuffix(t *testing.T) {
	cases := map[string]string{
		"a.go":          "a.go",
		"a.go:12":       "a.go",
		"a.go:12-18":    "a.go",
		"  b.txt:7  ":   "b.txt",
		"c:12notes.txt": "c:12notes.txt",
		"/x/y/z.ts:3-4": "/x/y/z.ts",
	}
	for input, want := range cases {
		if got := StripFileLineSuffix(input); got != want {
			t.Errorf("StripFileLineSuffix(%q) = %q, want %q", input, got, want)
		}
	}
}

func newTestEnv(home string) Env {
	return Env{
		AIHomeDir:        filepath.Join(home, ".ai_home"),
		HostHomeDir:      home,
		ChatImageRootDir: filepath.Join(home, "chat-images"),
	}
}

func TestResolveAuthorizedReadsProjectFile(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	writeFile(t, filepath.Join(project, "a.txt"), "hello")
	env := newTestEnv(home)
	registry := NewProjectRoots([]string{project})

	target, failure := ResolveAuthorized(OSFS{}, env, registry, Request{
		RawPath:     filepath.Join(project, "a.txt"),
		ProjectPath: project,
	}, nil)
	if failure != nil {
		t.Fatalf("resolve: %v", failure)
	}
	if target.TargetPath != filepath.Join(project, "a.txt") || target.ReadPath != filepath.Join(project, "a.txt") {
		t.Fatalf("target = %+v", target)
	}
	if target.Stat.Size() != 5 {
		t.Fatalf("size = %d", target.Stat.Size())
	}

	// 行号后缀与项目根外的路径由同一入口处理。
	withSuffix, failure := ResolveAuthorized(OSFS{}, env, registry, Request{
		RawPath:     filepath.Join(project, "a.txt") + ":12",
		ProjectPath: project,
	}, nil)
	if failure != nil {
		t.Fatalf("line suffix: %v", failure)
	}
	if withSuffix.ReadPath != filepath.Join(project, "a.txt") {
		t.Fatalf("line suffix read path = %q", withSuffix.ReadPath)
	}
}

func TestResolveAuthorizedRejectsOutsideWorkspace(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	writeFile(t, filepath.Join(project, "a.txt"), "hello")
	outside := filepath.Join(home, "outside")
	writeFile(t, filepath.Join(outside, "secret.md"), "secret")
	env := newTestEnv(home)
	registry := NewProjectRoots([]string{project})

	_, failure := ResolveAuthorized(OSFS{}, env, registry, Request{
		RawPath:     filepath.Join(outside, "secret.md"),
		ProjectPath: project,
	}, nil)
	if failure == nil || failure.Status != 403 || failure.Code != "outside_workspace" {
		t.Fatalf("failure = %v", failure)
	}
	if failure.Authorization == nil || !failure.Authorization.Required {
		t.Fatalf("authorization = %+v", failure.Authorization)
	}
	if failure.Authorization.FilePath != filepath.Join(outside, "secret.md") {
		t.Fatalf("authorization file path = %q", failure.Authorization.FilePath)
	}
	if len(failure.Authorization.Candidates) != 1 || failure.Authorization.Candidates[0].Path != outside {
		t.Fatalf("candidates = %+v", failure.Authorization.Candidates)
	}

	// 已信任目录直接放行。
	target, failure := ResolveAuthorized(OSFS{}, env, registry, Request{
		RawPath:     filepath.Join(outside, "secret.md"),
		ProjectPath: project,
	}, []TrustedRoot{{Path: outside}})
	if failure != nil || target == nil {
		t.Fatalf("trusted resolve = %v %v", target, failure)
	}
}

func TestResolveAuthorizedUnknownProjectAndSize(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	big := filepath.Join(project, "big.txt")
	writeFile(t, big, strings.Repeat("a", 1024*1024+1))
	env := newTestEnv(home)
	registry := NewProjectRoots([]string{project})

	_, failure := ResolveAuthorized(OSFS{}, env, registry, Request{
		RawPath:     filepath.Join(project, "big.txt"),
		ProjectPath: filepath.Join(home, "project2"),
	}, nil)
	if failure == nil || failure.Status != 403 || failure.Code != "unknown_project_root" {
		t.Fatalf("unknown project failure = %v", failure)
	}

	_, failure = ResolveAuthorized(OSFS{}, env, registry, Request{
		RawPath:     filepath.Join(project, "big.txt"),
		ProjectPath: project,
		SizeLimit:   1024 * 1024,
	}, nil)
	if failure == nil || failure.Status != 413 || failure.Message != "文件超过1MB大小限制" {
		t.Fatalf("size failure = %v", failure)
	}
}

func TestResolveTargetCodexMemory(t *testing.T) {
	home := realTempDir(t)
	memoryRoot := filepath.Join(home, ".codex", "memories")
	writeFile(t, filepath.Join(memoryRoot, "note.md"), "note")
	writeFile(t, filepath.Join(home, "secret.md"), "secret")
	env := newTestEnv(home)

	target, failure := ResolveTarget(OSFS{}, env, "note.md", SourceCodexMemory)
	if failure != nil {
		t.Fatalf("memory target: %v", failure)
	}
	if target.ForcedAuthorizedRoot != memoryRoot || target.ReadPath != filepath.Join(memoryRoot, "note.md") {
		t.Fatalf("target = %+v", target)
	}

	for _, raw := range []string{"../secret.md", "/etc/hosts", "~/note.md", "./../note.md"} {
		_, failure := ResolveTarget(OSFS{}, env, raw, SourceCodexMemory)
		if failure == nil || failure.Code != "outside_memory_root" {
			t.Errorf("ResolveTarget(%q) failure = %v", raw, failure)
		}
	}
}

func TestResolveTargetDeniesCredentialsAndBlockedProjection(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	writeFile(t, filepath.Join(project, "auth.json"), "{}")
	env := newTestEnv(home)

	_, failure := ResolveTarget(OSFS{}, env, filepath.Join(project, "auth.json"), "")
	if failure == nil || failure.Status != 403 || failure.Code != "permission_denied" {
		t.Fatalf("auth.json failure = %v", failure)
	}

	blockedEnv := env
	blockedEnv.CanonicalizeProviderPath = func(rawPath string) ProviderPath {
		return ProviderPath{Path: rawPath, Blocked: true}
	}
	_, failure = ResolveTarget(OSFS{}, blockedEnv, filepath.Join(project, "notes.md"), "")
	if failure == nil || failure.Code != "permission_denied" || failure.Message != "出于安全考虑，不允许读取账号凭证投影" {
		t.Fatalf("blocked projection failure = %v", failure)
	}

	// 投影别名改写后按新路径继续判定。
	writeFile(t, filepath.Join(project, "real.txt"), "real")
	rewritingEnv := env
	rewritingEnv.CanonicalizeProviderPath = func(_ string) ProviderPath {
		return ProviderPath{Path: filepath.Join(project, "real.txt")}
	}
	target, failure := ResolveTarget(OSFS{}, rewritingEnv, "/run/auth-projections/claude/acct/.claude/real.txt", "")
	if failure != nil {
		t.Fatalf("rewritten target: %v", failure)
	}
	if target.TargetPath != filepath.Join(project, "real.txt") {
		t.Fatalf("rewritten target path = %q", target.TargetPath)
	}

	_, failure = ResolveTarget(OSFS{}, env, filepath.Join(project, "missing.txt"), "")
	if failure == nil || failure.Status != 404 || failure.Code != "not_found" {
		t.Fatalf("missing failure = %v", failure)
	}
	if _, failure := ResolveTarget(OSFS{}, env, "   ", ""); failure == nil || failure.Code != "path_required" {
		t.Fatalf("empty path failure = %v", failure)
	}
}

func TestResolveTargetExpandsTilde(t *testing.T) {
	home := realTempDir(t)
	writeFile(t, filepath.Join(home, "docs", "a.txt"), "a")
	env := newTestEnv(home)

	target, failure := ResolveTarget(OSFS{}, env, "~/docs/a.txt", "")
	if failure != nil {
		t.Fatalf("tilde target: %v", failure)
	}
	if target.TargetPath != filepath.Join(home, "docs", "a.txt") {
		t.Fatalf("tilde target path = %q", target.TargetPath)
	}

	writeFile(t, filepath.Join(home, "docs", "dir"), "")
	if _, failure := ResolveTarget(OSFS{}, env, "~/docs", ""); failure == nil || failure.Code != "not_a_file" {
		t.Fatalf("directory failure = %v", failure)
	}
}

func TestExtraReadableRoots(t *testing.T) {
	home := realTempDir(t)
	roots := ExtraReadableRoots(newTestEnv(home))
	required := []string{
		filepath.Join(home, ".codex", ".tmp", "model", "images"),
		filepath.Join(home, ".codex", "attachments"),
		filepath.Join(home, ".claude", "projects"),
		filepath.Join(home, ".claude", "artifacts"),
		filepath.Join(home, ".gemini", "history"),
		filepath.Join(home, ".gemini", "antigravity-cli", "brain"),
		filepath.Join(home, ".local", "share", "opencode", "storage"),
		filepath.Join(home, "chat-images"),
	}
	index := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		index[root] = struct{}{}
	}
	for _, expected := range required {
		if _, ok := index[expected]; !ok {
			t.Errorf("missing readable root %q in %v", expected, roots)
		}
	}
	seen := make(map[string]struct{}, len(roots))
	for _, root := range roots {
		if _, ok := seen[root]; ok {
			t.Errorf("duplicate readable root %q", root)
		}
		seen[root] = struct{}{}
	}
}

func TestTreeListsProjectDirectory(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	writeFile(t, filepath.Join(project, "b.txt"), "bb")
	writeFile(t, filepath.Join(project, "a.txt"), "a")
	writeFile(t, filepath.Join(project, ".env"), "secret")
	writeFile(t, filepath.Join(project, ".git", "HEAD"), "ref")
	writeFile(t, filepath.Join(project, "node_modules", "pkg", "index.js"), "x")
	writeFile(t, filepath.Join(project, "zdir", "z.txt"), "z")
	writeFile(t, filepath.Join(project, "adir", "a.txt"), "a")
	registry := NewProjectRoots([]string{project})

	result, failure := Tree(OSFS{}, registry, project, "", false)
	if failure != nil {
		t.Fatalf("tree: %v", failure)
	}
	names := make([]string, 0, len(result.Entries))
	for _, entry := range result.Entries {
		names = append(names, entry.Name)
	}
	want := []string{"adir", "zdir", "a.txt", "b.txt"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("entries = %v, want %v", names, want)
	}
	if result.Path != "." || result.ProjectPath != project || result.Truncated {
		t.Fatalf("result = %+v", result)
	}
	for _, entry := range result.Entries {
		if entry.Type == TreeEntryDirectory {
			if entry.Size != nil || !entry.HasChildren {
				t.Errorf("directory entry = %+v", entry)
			}
			continue
		}
		if entry.Size == nil || *entry.Size == 0 || entry.HasChildren {
			t.Errorf("file entry = %+v", entry)
		}
		if entry.MTime == 0 {
			t.Errorf("file entry missing mtime: %+v", entry)
		}
	}

	nested, failure := Tree(OSFS{}, registry, project, "adir", false)
	if failure != nil {
		t.Fatalf("nested tree: %v", failure)
	}
	if nested.Path != "adir" || len(nested.Entries) != 1 || nested.Entries[0].Name != "a.txt" {
		t.Fatalf("nested result = %+v", nested)
	}

	shown, failure := Tree(OSFS{}, registry, project, "", true)
	if failure != nil {
		t.Fatalf("tree show hidden: %v", failure)
	}
	hidden := make(map[string]struct{}, len(shown.Entries))
	for _, entry := range shown.Entries {
		hidden[entry.Name] = struct{}{}
	}
	for _, name := range []string{".env", ".git", "node_modules"} {
		if _, ok := hidden[name]; !ok {
			t.Errorf("showHidden omitted %q", name)
		}
	}
}

func TestTreeFollowsContainmentAndCapsEntries(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	outside := filepath.Join(home, "outside")
	writeFile(t, filepath.Join(outside, "secret.txt"), "secret")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("mkdir project: %v", err)
	}
	if err := os.Symlink(outside, filepath.Join(project, "escape")); err != nil {
		t.Fatalf("symlink: %v", err)
	}
	registry := NewProjectRoots([]string{project})

	result, failure := Tree(OSFS{}, registry, project, "", true)
	if failure != nil {
		t.Fatalf("tree: %v", failure)
	}
	for _, entry := range result.Entries {
		if entry.Name == "escape" {
			t.Fatal("symlink escaping the project must be omitted")
		}
	}

	big := filepath.Join(home, "big")
	for index := 0; index < MaxTreeEntries+5; index++ {
		writeFile(t, filepath.Join(big, fileName(index)), "x")
	}
	bigRegistry := NewProjectRoots([]string{big})
	result, failure = Tree(OSFS{}, bigRegistry, big, "", false)
	if failure != nil {
		t.Fatalf("big tree: %v", failure)
	}
	if len(result.Entries) != MaxTreeEntries || !result.Truncated {
		t.Fatalf("entries = %d truncated=%v", len(result.Entries), result.Truncated)
	}
}

func TestTreeRejectsInvalidRequests(t *testing.T) {
	home := realTempDir(t)
	project := filepath.Join(home, "project")
	writeFile(t, filepath.Join(project, "a.txt"), "a")
	registry := NewProjectRoots([]string{project})

	cases := []struct {
		name        string
		projectPath string
		relative    string
		status      int
		code        string
	}{
		{name: "missing project", projectPath: "", status: 400, code: "project_path_required"},
		{name: "unknown project", projectPath: filepath.Join(home, "other"), status: 403, code: "unknown_project_root"},
		{name: "escape", projectPath: project, relative: "../outside", status: 403, code: "path_escape"},
		{name: "not a directory", projectPath: project, relative: "a.txt", status: 400, code: "not_a_directory"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, failure := Tree(OSFS{}, registry, tc.projectPath, tc.relative, false)
			if failure == nil || failure.Status != tc.status || failure.Code != tc.code {
				t.Fatalf("failure = %v, want %d %s", failure, tc.status, tc.code)
			}
		})
	}
}

func fileName(index int) string {
	return "f" + strings.Repeat("0", 3) + string(rune('a'+index%26)) + strings.Repeat("x", index/26) + ".txt"
}
