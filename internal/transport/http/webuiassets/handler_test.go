package webuiassets

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

func testHandler(t *testing.T) *Handler {
	t.Helper()
	handler, err := NewHandler(fstest.MapFS{
		"index.html":               {Data: []byte("<html>app</html>")},
		"assets/index.90cbf421.js": {Data: []byte("console.log(1)")},
		"assets/app.css":           {Data: []byte("body{}")},
		"docs/index.html":          {Data: []byte("<html>docs</html>")},
		"secret.txt":               {Data: []byte("do-not-leak")},
		"sw.js":                    {Data: []byte("self.addEventListener")},
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

func serve(handler *Handler, method, target string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestServesIndexAtRootWithNoStore(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui/")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if body := recorder.Body.String(); body != "<html>app</html>" {
		t.Fatalf("body = %q", body)
	}
	if got := recorder.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
	if got := recorder.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("cache-control = %q, want no-store", got)
	}
}

func TestRedirectsBareUiToTrailingSlash(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui")
	if recorder.Code != http.StatusFound {
		t.Fatalf("status = %d, want 302", recorder.Code)
	}
	if got := recorder.Header().Get("Location"); got != "/ui/" {
		t.Fatalf("location = %q", got)
	}
}

func TestHashedAssetsAreImmutable(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui/assets/index.90cbf421.js")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if got := recorder.Header().Get("Cache-Control"); got != "public, max-age=31536000, immutable" {
		t.Fatalf("cache-control = %q", got)
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/javascript; charset=utf-8" {
		t.Fatalf("content-type = %q", got)
	}
}

func TestUnhashedAssetsAreNotCached(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui/assets/app.css")
	if got := recorder.Header().Get("Cache-Control"); !strings.Contains(got, "no-store") {
		t.Fatalf("cache-control = %q, want no-store", got)
	}
	if got := recorder.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("pragma = %q", got)
	}
}

// 缺失的静态资源必须是 404：回落 index.html 会让浏览器把 HTML 当 JS 执行。
func TestMissingStaticAssetDoesNotFallBackToSpa(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui/assets/index.0badc0de.js")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
	if body := recorder.Body.String(); body != "Static asset not found" {
		t.Fatalf("body = %q", body)
	}
}

func TestUnknownRouteFallsBackToIndex(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui/accounts/overview")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if body := recorder.Body.String(); body != "<html>app</html>" {
		t.Fatalf("body = %q", body)
	}
}

func TestDirectoryServesItsOwnIndex(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodGet, "/ui/docs/")
	if body := recorder.Body.String(); body != "<html>docs</html>" {
		t.Fatalf("body = %q", body)
	}
}

// 目录遍历不能读到根目录外的文件（用真实目录 + os.DirFS 验证，MapFS 没有父目录）。
func TestTraversalCannotEscapeRoot(t *testing.T) {
	parent := t.TempDir()
	dist := filepath.Join(parent, "dist")
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte("<html>app</html>"), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(parent, "secret.txt"), []byte("do-not-leak"), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	handler, err := NewHandler(os.DirFS(dist))
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := serve(handler, http.MethodGet, "/ui/../../secret.txt")
	if strings.Contains(recorder.Body.String(), "do-not-leak") {
		t.Fatalf("traversal leaked file content: %q", recorder.Body.String())
	}
	if recorder.Code != http.StatusOK || recorder.Body.String() != "<html>app</html>" {
		t.Fatalf("status=%d body=%q, want SPA index", recorder.Code, recorder.Body.String())
	}
}

func TestMissingBuildReportsHint(t *testing.T) {
	handler, err := NewHandler(fstest.MapFS{})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := serve(handler, http.MethodGet, "/ui/anything")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "npm run build") {
		t.Fatalf("body = %q", recorder.Body.String())
	}
}

func TestRejectsNonReadMethods(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodPost, "/ui/")
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != "GET, HEAD" {
		t.Fatalf("allow = %q", got)
	}
}

func TestHeadReturnsHeadersWithoutBody(t *testing.T) {
	recorder := serve(testHandler(t), http.MethodHead, "/ui/assets/index.90cbf421.js")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if body, _ := io.ReadAll(recorder.Body); len(body) != 0 {
		t.Fatalf("HEAD returned %d body bytes", len(body))
	}
}

// 真实构建产物：确认哈希资源与 index.html 在真实目录结构下也能命中。
// 未构建时跳过（web/dist 是构建产物，不该成为单测的硬依赖）。
func TestServesRealDistWhenBuilt(t *testing.T) {
	dist := filepath.Join("..", "..", "..", "..", "web", "dist")
	if info, err := os.Stat(dist); err != nil || !info.IsDir() {
		t.Skip("web/dist 未构建")
	}
	handler, err := NewHandler(os.DirFS(dist))
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	indexResponse := serve(handler, http.MethodGet, "/ui/")
	if indexResponse.Code != http.StatusOK || !strings.Contains(indexResponse.Body.String(), "<html") {
		t.Fatalf("index status=%d", indexResponse.Code)
	}
	entries, err := os.ReadDir(dist)
	if err != nil || len(entries) == 0 {
		t.Skipf("dist 目录不可读: %v", err)
	}
	var hashed string
	for _, entry := range entries {
		if isImmutable(entry.Name()) && strings.HasSuffix(entry.Name(), ".js") {
			hashed = entry.Name()
			break
		}
	}
	if hashed == "" {
		t.Skip("未找到哈希命名的 JS 资源")
	}
	assetResponse := serve(handler, http.MethodGet, "/ui/"+hashed)
	if assetResponse.Code != http.StatusOK {
		t.Fatalf("asset %s status = %d", hashed, assetResponse.Code)
	}
	if got := assetResponse.Header().Get("Cache-Control"); !strings.Contains(got, "immutable") {
		t.Fatalf("asset cache-control = %q", got)
	}
	if missing := serve(handler, http.MethodGet, "/ui/not-built.0badc0de.js"); missing.Code != http.StatusNotFound {
		t.Fatalf("missing asset status = %d", missing.Code)
	}
}

func TestRejectsNilFilesystem(t *testing.T) {
	if _, err := NewHandler(nil); err == nil {
		t.Fatal("expected nil fs to be rejected")
	}
}
