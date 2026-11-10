package webuifsaccessapi

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/webuifile"
)

type fakeAuthorizer struct {
	allowed bool
}

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fixture struct {
	home    string
	project string
	outside string
	env     webuifile.Env
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	home, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatalf("解析临时目录失败: %v", err)
	}
	project := filepath.Join(home, "project")
	outside := filepath.Join(home, "outside")
	writeFile(t, filepath.Join(project, "a.txt"), "hello")
	writeFile(t, filepath.Join(outside, "secret.md"), "secret")
	return fixture{
		home:    home,
		project: project,
		outside: outside,
		env: webuifile.Env{
			AIHomeDir:        filepath.Join(home, ".ai_home"),
			HostHomeDir:      home,
			ChatImageRootDir: filepath.Join(home, "chat-images"),
		},
	}
}

func (f fixture) dependencies() Dependencies {
	return Dependencies{
		Authorizer:   fakeAuthorizer{allowed: true},
		Env:          f.env,
		ProjectPaths: func() []string { return []string{f.project} },
	}
}

func newServer(t *testing.T, dependencies Dependencies) *httptest.Server {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(Path, handler)
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
}

func get(t *testing.T, server *httptest.Server, values url.Values) (int, http.Header, map[string]any) {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, server.URL+Path+"?"+values.Encode(), nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	var payload map[string]any
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("响应不是 JSON: %s (%v)", raw, err)
		}
	}
	return response.StatusCode, response.Header, payload
}

// TestAccessAuthorizedProjectFile 锁住 200 形状、缓存头与 mtime 的毫秒语义。
func TestAccessAuthorizedProjectFile(t *testing.T) {
	fixture := newFixture(t)
	server := newServer(t, fixture.dependencies())

	status, header, payload := get(t, server, url.Values{
		"path":        {filepath.Join(fixture.project, "a.txt")},
		"projectPath": {fixture.project},
	})
	if status != http.StatusOK {
		t.Fatalf("status = %d body=%#v", status, payload)
	}
	if payload["ok"] != true || payload["path"] != filepath.Join(fixture.project, "a.txt") {
		t.Fatalf("payload = %#v", payload)
	}
	if payload["size"] != float64(5) {
		t.Fatalf("size = %#v, want 5", payload["size"])
	}
	if mtime, ok := payload["mtime"].(float64); !ok || mtime <= 0 {
		t.Fatalf("mtime = %#v", payload["mtime"])
	}
	if header.Get("Cache-Control") != webuifile.CacheControlNoStore || header.Get("Pragma") != webuifile.PragmaNoCache {
		t.Fatalf("cache headers = %q %q", header.Get("Cache-Control"), header.Get("Pragma"))
	}
}

// TestAccessErrorShapes 覆盖 400/403/404/413 的 Node 兼容形状。
func TestAccessErrorShapes(t *testing.T) {
	fixture := newFixture(t)
	big := filepath.Join(fixture.project, "big.png")
	writeFile(t, big, "")
	if err := os.Truncate(big, webuifile.MediaFileSizeLimit+1); err != nil {
		t.Fatalf("构造大文件失败: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(fixture.project, "dir"), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	server := newServer(t, fixture.dependencies())

	cases := []struct {
		name        string
		query       url.Values
		wantStatus  int
		wantError   string
		wantMessage string
	}{
		{
			name:        "path required",
			query:       url.Values{},
			wantStatus:  http.StatusBadRequest,
			wantError:   "path_required",
			wantMessage: "必须提供文件路径",
		},
		{
			name:        "not found",
			query:       url.Values{"path": {filepath.Join(fixture.project, "missing.txt")}, "projectPath": {fixture.project}},
			wantStatus:  http.StatusNotFound,
			wantError:   "not_found",
			wantMessage: "文件不存在: " + filepath.Join(fixture.project, "missing.txt"),
		},
		{
			name:        "unknown project root",
			query:       url.Values{"path": {filepath.Join(fixture.project, "a.txt")}, "projectPath": {filepath.Join(fixture.home, "other")}},
			wantStatus:  http.StatusForbidden,
			wantError:   "unknown_project_root",
			wantMessage: "只允许读取服务端已登记项目内的文件",
		},
		{
			name:        "not a regular file",
			query:       url.Values{"path": {filepath.Join(fixture.project, "dir")}, "projectPath": {fixture.project}},
			wantStatus:  http.StatusBadRequest,
			wantError:   "not_a_file",
			wantMessage: "目标路径不是一个普通文件",
		},
		{
			name:        "media size limit",
			query:       url.Values{"path": {big}, "projectPath": {fixture.project}},
			wantStatus:  http.StatusRequestEntityTooLarge,
			wantError:   "file_too_large",
			wantMessage: fmt.Sprintf("文件超过%dMB大小限制", webuifile.SizeLimitMB(webuifile.MediaFileSizeLimit)),
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			status, _, payload := get(t, server, testCase.query)
			if status != testCase.wantStatus {
				t.Fatalf("status = %d body=%#v", status, payload)
			}
			if payload["ok"] != false || payload["error"] != testCase.wantError || payload["message"] != testCase.wantMessage {
				t.Fatalf("payload = %#v", payload)
			}
		})
	}
}

// TestAccessOutsideWorkspaceCarriesTrustCandidates 锁住前端的授权弹框载荷。
func TestAccessOutsideWorkspaceCarriesTrustCandidates(t *testing.T) {
	fixture := newFixture(t)
	server := newServer(t, fixture.dependencies())
	secret := filepath.Join(fixture.outside, "secret.md")

	status, header, payload := get(t, server, url.Values{
		"path":        {secret},
		"projectPath": {fixture.project},
	})
	if status != http.StatusForbidden || payload["error"] != "outside_workspace" {
		t.Fatalf("status = %d body=%#v", status, payload)
	}
	if header.Get("Cache-Control") != webuifile.CacheControlNoStore {
		t.Fatalf("cache-control = %q", header.Get("Cache-Control"))
	}
	authorization, ok := payload["authorization"].(map[string]any)
	if !ok {
		t.Fatalf("authorization = %#v", payload["authorization"])
	}
	if authorization["required"] != true || authorization["filePath"] != secret {
		t.Fatalf("authorization = %#v", authorization)
	}
	candidates, ok := authorization["candidates"].([]any)
	if !ok || len(candidates) != 1 {
		t.Fatalf("candidates = %#v, want 1 item", authorization["candidates"])
	}
	candidate, _ := candidates[0].(map[string]any)
	if candidate["scope"] != "file_directory" || candidate["path"] != fixture.outside {
		t.Fatalf("candidate = %#v", candidate)
	}
	if candidate["label"] == "" || candidate["description"] == "" {
		t.Fatalf("candidate labels = %#v", candidate)
	}
}

func TestAccessTrustedRootAllowsOutsideFile(t *testing.T) {
	fixture := newFixture(t)
	dependencies := fixture.dependencies()
	dependencies.TrustedRoots = func() []webuifile.TrustedRoot {
		return []webuifile.TrustedRoot{{Path: fixture.outside}}
	}
	server := newServer(t, dependencies)

	status, _, payload := get(t, server, url.Values{
		"path":        {filepath.Join(fixture.outside, "secret.md")},
		"projectPath": {fixture.project},
	})
	if status != http.StatusOK || payload["ok"] != true {
		t.Fatalf("status = %d body=%#v", status, payload)
	}
}

// TestAccessCodexMemorySource 覆盖 source 参数：只接受记忆根下的相对路径。
func TestAccessCodexMemorySource(t *testing.T) {
	fixture := newFixture(t)
	note := filepath.Join(fixture.home, ".codex", "memories", "note.md")
	writeFile(t, note, "note")
	server := newServer(t, fixture.dependencies())

	status, _, payload := get(t, server, url.Values{"path": {"note.md"}, "source": {"codex-memory"}})
	if status != http.StatusOK || payload["path"] != note {
		t.Fatalf("memory status = %d body=%#v", status, payload)
	}

	status, _, payload = get(t, server, url.Values{"path": {"/etc/hosts"}, "source": {"codex-memory"}})
	if status != http.StatusForbidden || payload["error"] != "outside_memory_root" {
		t.Fatalf("absolute memory status = %d body=%#v", status, payload)
	}
}

func TestAccessRequiresAuthorizationAndGet(t *testing.T) {
	fixture := newFixture(t)
	denied := fixture.dependencies()
	denied.Authorizer = fakeAuthorizer{allowed: false}
	server := newServer(t, denied)

	status, _, payload := get(t, server, url.Values{"path": {filepath.Join(fixture.project, "a.txt")}})
	if status != http.StatusUnauthorized || payload["error"] != "unauthorized" {
		t.Fatalf("unauthorized status = %d body=%#v", status, payload)
	}

	server = newServer(t, fixture.dependencies())
	request, err := http.NewRequest(http.MethodPost, server.URL+Path, nil)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode != http.StatusMethodNotAllowed || response.Header.Get("Allow") != http.MethodGet {
		t.Fatalf("method status = %d allow=%q", response.StatusCode, response.Header.Get("Allow"))
	}
}

func TestNewHandlerRequiresAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v, want ErrInvalidDependencies", err)
	}
}
