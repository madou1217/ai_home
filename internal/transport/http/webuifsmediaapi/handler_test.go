package webuifsmediaapi

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
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

func writeFile(t *testing.T, path string, payload []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(path, payload, 0o600); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
}

func get(t *testing.T, server *httptest.Server, values url.Values) (*http.Response, []byte) {
	t.Helper()
	target := server.URL + Path
	if encoded := values.Encode(); encoded != "" {
		target += "?" + encoded
	}
	response, err := http.Get(target)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	t.Cleanup(func() { _ = response.Body.Close() })
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("读取响应失败: %v", err)
	}
	return response, body
}

func decodeError(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var view map[string]any
	if err := json.Unmarshal(body, &view); err != nil {
		t.Fatalf("解析错误响应失败: %v, body=%q", err, string(body))
	}
	return view
}

func TestServesImageBytesWithMediaHeaders(t *testing.T) {
	f := newFixture(t)
	payload := []byte("\x89PNG\r\n\x1a\nmedia-bytes")
	writeFile(t, filepath.Join(f.project, "pic.PNG"), payload)
	server := newServer(t, f.dependencies())

	response, body := get(t, server, url.Values{
		"path":        {filepath.Join(f.project, "pic.PNG")},
		"projectPath": {f.project},
	})

	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200, body=%s", response.StatusCode, string(body))
	}
	if got := response.Header.Get("Content-Type"); got != "image/png" {
		t.Fatalf("Content-Type = %q, want image/png", got)
	}
	if got, want := response.Header.Get("Content-Length"), strconv.Itoa(len(payload)); got != want {
		t.Fatalf("Content-Length = %q, want %s", got, want)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store, max-age=0" {
		t.Fatalf("Cache-Control = %q", got)
	}
	if got := response.Header.Get("Pragma"); got != "no-cache" {
		t.Fatalf("Pragma = %q", got)
	}
	if !bytes.Equal(body, payload) {
		t.Fatalf("body = %q, want %q", body, payload)
	}
}

func TestRejectsUnsupportedMediaType(t *testing.T) {
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "notes.txt"), []byte("plain"))
	server := newServer(t, f.dependencies())

	response, body := get(t, server, url.Values{
		"path":        {filepath.Join(f.project, "notes.txt")},
		"projectPath": {f.project},
	})

	if response.StatusCode != http.StatusUnsupportedMediaType {
		t.Fatalf("status = %d, want 415, body=%s", response.StatusCode, string(body))
	}
	if got := decodeError(t, body)["error"]; got != "unsupported_media_type" {
		t.Fatalf("error = %v, want unsupported_media_type", got)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store, max-age=0" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestMediaLimitIsFifteenMegabytes(t *testing.T) {
	f := newFixture(t)
	large := bytes.Repeat([]byte("a"), 6*1024*1024)
	writeFile(t, filepath.Join(f.project, "large.png"), large)
	server := newServer(t, f.dependencies())

	response, body := get(t, server, url.Values{
		"path":        {filepath.Join(f.project, "large.png")},
		"projectPath": {f.project},
	})

	if response.StatusCode != http.StatusOK {
		t.Fatalf("6MB 图片应按媒体上限放行, status = %d, body=%s", response.StatusCode, string(body))
	}
	if len(body) != len(large) {
		t.Fatalf("body 长度 = %d, want %d", len(body), len(large))
	}
}

func TestRejectsFileOverMediaLimit(t *testing.T) {
	f := newFixture(t)
	writeFile(t, filepath.Join(f.project, "huge.png"), bytes.Repeat([]byte("a"), 15*1024*1024+1))
	server := newServer(t, f.dependencies())

	response, body := get(t, server, url.Values{
		"path":        {filepath.Join(f.project, "huge.png")},
		"projectPath": {f.project},
	})

	if response.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413, body=%s", response.StatusCode, string(body))
	}
	view := decodeError(t, body)
	if got := view["error"]; got != "file_too_large" {
		t.Fatalf("error = %v, want file_too_large", got)
	}
	if got := view["message"]; got != "文件超过15MB大小限制" {
		t.Fatalf("message = %v", got)
	}
}

func TestRejectsOutsideWorkspaceWithAuthorization(t *testing.T) {
	f := newFixture(t)
	writeFile(t, filepath.Join(f.outside, "pic.png"), []byte("png"))
	server := newServer(t, f.dependencies())

	response, body := get(t, server, url.Values{
		"path":        {filepath.Join(f.outside, "pic.png")},
		"projectPath": {f.project},
	})

	if response.StatusCode != http.StatusForbidden {
		t.Fatalf("status = %d, want 403, body=%s", response.StatusCode, string(body))
	}
	view := decodeError(t, body)
	if got := view["error"]; got != "outside_workspace" {
		t.Fatalf("error = %v, want outside_workspace", got)
	}
	authorization, ok := view["authorization"].(map[string]any)
	if !ok || authorization["required"] != true {
		t.Fatalf("authorization = %v, want required", view["authorization"])
	}
}

func TestRequiresManagementKey(t *testing.T) {
	f := newFixture(t)
	dependencies := f.dependencies()
	dependencies.Authorizer = fakeAuthorizer{allowed: false}
	server := newServer(t, dependencies)

	response, body := get(t, server, url.Values{"path": {"/tmp/a.png"}})

	if response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401, body=%s", response.StatusCode, string(body))
	}
	if got := decodeError(t, body)["error"]; got != "unauthorized" {
		t.Fatalf("error = %v, want unauthorized", got)
	}
	if got := response.Header.Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q", got)
	}
}

func TestRejectsNonGet(t *testing.T) {
	f := newFixture(t)
	server := newServer(t, f.dependencies())

	response, err := http.Post(server.URL+Path, "text/plain", nil)
	if err != nil {
		t.Fatalf("请求失败: %v", err)
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(response.Body)

	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405, body=%s", response.StatusCode, string(body))
	}
	if got := response.Header.Get("Allow"); got != http.MethodGet {
		t.Fatalf("Allow = %q", got)
	}
}

func TestRequiresPath(t *testing.T) {
	server := newServer(t, newFixture(t).dependencies())

	response, body := get(t, server, url.Values{})

	if response.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400, body=%s", response.StatusCode, string(body))
	}
	if got := decodeError(t, body)["error"]; got != "path_required" {
		t.Fatalf("error = %v, want path_required", got)
	}
}

func TestNewHandlerRequiresAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("NewHandler() 缺少鉴权时应当报错")
	}
}
