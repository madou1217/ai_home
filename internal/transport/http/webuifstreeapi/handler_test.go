package webuifstreeapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/internal/webuifile"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fixture struct {
	home    string
	project string
	outside string
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
	writeFile(t, filepath.Join(project, "src", "main.go"), "package main")
	writeFile(t, filepath.Join(project, "src", "nested", "deep.txt"), "deep")
	writeFile(t, filepath.Join(project, ".git", "config"), "hidden")
	writeFile(t, filepath.Join(outside, "secret.md"), "secret")
	return fixture{home: home, project: project, outside: outside}
}

func (f fixture) dependencies() Dependencies {
	return Dependencies{
		Authorizer:   fakeAuthorizer{allowed: true},
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
	defer response.Body.Close()
	body := map[string]any{}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	return response.StatusCode, response.Header, body
}

func entriesOf(t *testing.T, body map[string]any) []any {
	t.Helper()
	entries, ok := body["entries"].([]any)
	if !ok {
		t.Fatalf("entries 不是数组: %#v", body)
	}
	return entries
}

func findEntry(t *testing.T, entries []any, name string) map[string]any {
	t.Helper()
	for _, raw := range entries {
		entry, ok := raw.(map[string]any)
		if !ok {
			t.Fatalf("条目不是对象: %#v", raw)
		}
		if entry["name"] == name {
			return entry
		}
	}
	t.Fatalf("没有找到条目 %q: %#v", name, entries)
	return nil
}

func TestListRootEntries(t *testing.T) {
	f := newFixture(t)
	status, header, body := get(t, newServer(t, f.dependencies()), url.Values{"projectPath": {f.project}})
	if status != http.StatusOK || body["ok"] != true {
		t.Fatalf("status = %d body = %#v", status, body)
	}
	if header.Get("Cache-Control") != webuifile.CacheControlNoStore {
		t.Fatalf("缺少禁缓存头: %q", header.Get("Cache-Control"))
	}
	if body["path"] != "." || body["projectPath"] != f.project || body["depth"] != float64(DefaultTreeDepth) {
		t.Fatalf("响应元信息错误: %#v", body)
	}
	entries := entriesOf(t, body)
	first := entries[0].(map[string]any)
	if first["name"] != "src" || first["type"] != webuifile.TreeEntryDirectory || first["hasChildren"] != true {
		t.Fatalf("目录应排在文件前: %#v", first)
	}
	if _, ok := first["size"]; ok {
		t.Fatalf("目录不应带 size: %#v", first)
	}
	file := findEntry(t, entries, "a.txt")
	if file["type"] != webuifile.TreeEntryFile || file["size"] != float64(5) {
		t.Fatalf("文件条目错误: %#v", file)
	}
	for _, raw := range entries {
		if raw.(map[string]any)["name"] == ".git" {
			t.Fatalf("隐藏目录不应出现: %#v", entries)
		}
	}
}

func TestDepthExpandsNestedDirectories(t *testing.T) {
	f := newFixture(t)
	server := newServer(t, f.dependencies())

	_, _, shallow := get(t, server, url.Values{"projectPath": {f.project}, "path": {"src"}, "depth": {"1"}})
	nestedShallow := findEntry(t, entriesOf(t, shallow), "nested")
	if _, ok := nestedShallow["children"]; ok {
		t.Fatalf("depth=1 不应展开子目录: %#v", nestedShallow)
	}
	if nestedShallow["hasChildren"] != true {
		t.Fatalf("目录应标记 hasChildren: %#v", nestedShallow)
	}

	_, _, deep := get(t, server, url.Values{"projectPath": {f.project}, "path": {"src"}, "depth": {"2"}})
	src := findEntry(t, entriesOf(t, deep), "main.go")
	if src["type"] != webuifile.TreeEntryFile {
		t.Fatalf("main.go 条目错误: %#v", src)
	}
	nested := findEntry(t, entriesOf(t, deep), "nested")
	children, ok := nested["children"].([]any)
	if !ok || len(children) != 1 {
		t.Fatalf("depth=2 应展开 nested 子目录: %#v", nested)
	}
	if children[0].(map[string]any)["name"] != "deep.txt" {
		t.Fatalf("子条目错误: %#v", children)
	}

	_, _, rootDeep := get(t, server, url.Values{"projectPath": {f.project}, "depth": {"2"}})
	rootSrc := findEntry(t, entriesOf(t, rootDeep), "src")
	rootChildren, ok := rootSrc["children"].([]any)
	if !ok || len(rootChildren) != 2 {
		t.Fatalf("从根展开 depth=2 应包含两个子项: %#v", rootSrc)
	}
}

func TestDepthClampAndValidation(t *testing.T) {
	f := newFixture(t)
	server := newServer(t, f.dependencies())

	status, _, body := get(t, server, url.Values{"projectPath": {f.project}, "depth": {"99"}})
	if status != http.StatusOK || body["depth"] != float64(MaxTreeDepth) {
		t.Fatalf("depth 应被截断到 %d: %d %#v", MaxTreeDepth, status, body)
	}

	status, _, body = get(t, server, url.Values{"projectPath": {f.project}, "depth": {"0"}})
	if status != http.StatusBadRequest || body["error"] != "invalid_depth" {
		t.Fatalf("depth=0 应 400: %d %#v", status, body)
	}

	status, _, body = get(t, server, url.Values{"projectPath": {f.project}, "depth": {"abc"}})
	if status != http.StatusBadRequest || body["error"] != "invalid_depth" {
		t.Fatalf("depth=abc 应 400: %d %#v", status, body)
	}
}

func TestRejectsUnregisteredProject(t *testing.T) {
	f := newFixture(t)
	server := newServer(t, f.dependencies())

	status, _, body := get(t, server, url.Values{"projectPath": {f.outside}})
	if status != http.StatusForbidden || body["error"] != "unknown_project_root" {
		t.Fatalf("未登记项目应 403: %d %#v", status, body)
	}

	status, _, body = get(t, server, url.Values{})
	if status != http.StatusBadRequest || body["error"] != "project_path_required" {
		t.Fatalf("缺 projectPath 应 400: %d %#v", status, body)
	}

	status, _, body = get(t, server, url.Values{"projectPath": {f.project}, "path": {"../outside"}})
	if status != http.StatusForbidden || body["error"] != "path_escape" {
		t.Fatalf("越界路径应 403: %d %#v", status, body)
	}

	status, _, body = get(t, server, url.Values{"projectPath": {f.project}, "path": {"a.txt"}})
	if status != http.StatusBadRequest || body["error"] != "not_a_directory" {
		t.Fatalf("文件路径应 400: %d %#v", status, body)
	}
}

func TestSymlinkEscapeIsFiltered(t *testing.T) {
	f := newFixture(t)
	if err := os.Symlink(f.outside, filepath.Join(f.project, "link")); err != nil {
		t.Fatalf("创建符号链接失败: %v", err)
	}
	status, _, body := get(t, newServer(t, f.dependencies()), url.Values{"projectPath": {f.project}})
	if status != http.StatusOK {
		t.Fatalf("status = %d body = %#v", status, body)
	}
	for _, raw := range entriesOf(t, body) {
		if raw.(map[string]any)["name"] == "link" {
			t.Fatalf("越界符号链接不应出现: %#v", body)
		}
	}
}

func TestTrustedRootIsBrowsable(t *testing.T) {
	f := newFixture(t)
	dependencies := f.dependencies()
	dependencies.ProjectPaths = nil
	dependencies.TrustedRoots = func() []webuifile.TrustedRoot {
		return []webuifile.TrustedRoot{{Path: f.project, TrustedAt: 1}}
	}
	status, _, body := get(t, newServer(t, dependencies), url.Values{"projectPath": {f.project}})
	if status != http.StatusOK || body["ok"] != true {
		t.Fatalf("已信任目录应可浏览: %d %#v", status, body)
	}
	if len(entriesOf(t, body)) == 0 {
		t.Fatalf("已信任目录不应为空: %#v", body)
	}
}

func TestAuthMethodAndDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺少 Authorizer 应拒绝装配")
	}

	f := newFixture(t)
	denied := f.dependencies()
	denied.Authorizer = fakeAuthorizer{allowed: false}
	status, _, body := get(t, newServer(t, denied), url.Values{"projectPath": {f.project}})
	if status != http.StatusUnauthorized || body["error"] != "unauthorized" {
		t.Fatalf("未授权应 401: %d %#v", status, body)
	}

	handler, err := NewHandler(f.dependencies())
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, Path, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST 应 405: %d %s", recorder.Code, recorder.Body.String())
	}
	if recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("缺少 Allow 头: %#v", recorder.Header())
	}
}
