package webuiassets

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// 本文件逐场景对照 Node 的 serveStaticFile（lib/server/web-ui-router.js）。
// 期望值直接取自 Node 实现，不取 Go 实现，改动一旦偏离就是回归。

const (
	parityIndexBody     = "<!doctype html><div id=\"root\"></div>"
	parityDocsBody      = "<html>docs</html>"
	parityRootAssetBody = "console.log(\"root-asset\")"
	parityAsyncBody     = "export const x=1"
	parityCSSBody       = "body{color:red}"
	paritySVGBody       = "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"
	parityNoExtBody     = "license text"
	parityWorkerBody    = "self.addEventListener('fetch',()=>{})"
	parityBinaryBody    = "bin"

	parityAssetMissingBody = "Static asset not found"
	parityNotBuiltBody     = "Web UI not built. Run: cd web && npm run build"

	parityImmutableCache = "public, max-age=31536000, immutable"
	parityNoStoreCache   = "no-cache, no-store, must-revalidate"
)

// parityDist 按真实构建产物的形状造一份 dist：根目录放哈希分块，
// assets/ 放未哈希资源，另有 html5 路由目录、无 index 的目录和无扩展名文件。
func parityDist(t *testing.T) string {
	t.Helper()
	root := filepath.Join(t.TempDir(), "dist")
	files := map[string]string{
		"index.html":             parityIndexBody,
		"index.90cbf421.js":      parityRootAssetBody,
		"1008.90cbf421.async.js": parityAsyncBody,
		"assets/app.css":         parityCSSBody,
		"assets/logo.svg":        paritySVGBody,
		"docs/index.html":        parityDocsBody,
		"docs/guide.txt":         "guide",
		"empty/placeholder.bin":  parityBinaryBody,
		"LICENSE":                parityNoExtBody,
		"sw.js":                  parityWorkerBody,
	}
	for relative, body := range files {
		full := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", relative, err)
		}
		if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
			t.Fatalf("write %s: %v", relative, err)
		}
	}
	return root
}

func parityHandler(t *testing.T, dist string) *Handler {
	t.Helper()
	handler, err := NewHandler(os.DirFS(dist))
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

type parityCase struct {
	name         string
	method       string
	target       string
	status       int
	location     string
	allow        string
	contentType  string
	cacheControl string
	body         string
	// contentLength 为 0 表示不校验；HEAD 用它证明头部带长度。
	contentLength int
	// expectEmptyBody 用于 HEAD：响应体必须为空但头部与 GET 一致。
	expectEmptyBody bool
}

func TestNodeParityScenarios(t *testing.T) {
	handler := parityHandler(t, parityDist(t))

	cases := []parityCase{
		{
			name: "root 返回 index.html 且不缓存", method: http.MethodGet, target: "/ui/",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			name: "裸 /ui 重定向到带斜杠", method: http.MethodGet, target: "/ui",
			status: http.StatusFound, location: "/ui/",
		},
		{
			name: "哈希资源 immutable", method: http.MethodGet, target: "/ui/index.90cbf421.js",
			status: http.StatusOK, contentType: "application/javascript; charset=utf-8",
			cacheControl: parityImmutableCache, body: parityRootAssetBody, contentLength: len(parityRootAssetBody),
		},
		{
			name: "vite 分块命名同样 immutable", method: http.MethodGet, target: "/ui/1008.90cbf421.async.js",
			status: http.StatusOK, contentType: "application/javascript; charset=utf-8",
			cacheControl: parityImmutableCache, body: parityAsyncBody, contentLength: len(parityAsyncBody),
		},
		{
			name: "HEAD 只回头部不写 body", method: http.MethodHead, target: "/ui/assets/app.css",
			status: http.StatusOK, contentType: "text/css; charset=utf-8",
			cacheControl: parityNoStoreCache, expectEmptyBody: true, contentLength: len(parityCSSBody),
		},
		{
			name: "未哈希资源不缓存", method: http.MethodGet, target: "/ui/assets/app.css",
			status: http.StatusOK, contentType: "text/css; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityCSSBody, contentLength: len(parityCSSBody),
		},
		{
			// 缺失的构建产物不能回落 index.html，否则浏览器把 HTML 当 JS 执行。
			name: "缺失哈希资源 404", method: http.MethodGet, target: "/ui/assets/index.0badc0de.js",
			status: http.StatusNotFound, contentType: "text/plain; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityAssetMissingBody,
			contentLength: len(parityAssetMissingBody),
		},
		{
			// 已知扩展名一律按静态资源处理，即便不在 assets/ 下。
			name: "缺失 .html 资源同样 404", method: http.MethodGet, target: "/ui/missing.html",
			status: http.StatusNotFound, contentType: "text/plain; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityAssetMissingBody,
			contentLength: len(parityAssetMissingBody),
		},
		{
			// assets/ 前缀是硬判据：目录本身缺失也不能回落 SPA。
			name: "assets 目录缺失 404", method: http.MethodGet, target: "/ui/assets/",
			status: http.StatusNotFound, contentType: "text/plain; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityAssetMissingBody,
			contentLength: len(parityAssetMissingBody),
		},
		{
			name: "HTML5 路由回落 index", method: http.MethodGet, target: "/ui/accounts/overview",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			// Node 用「请求路径」判静态资源，不是补齐 index.html 之后的路径；
			// 目录式路由带尾斜杠必须照样回落 SPA。
			name: "未知目录式路由带尾斜杠回落 index", method: http.MethodGet, target: "/ui/accounts/",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			name: "目录请求补自身 index.html", method: http.MethodGet, target: "/ui/docs/",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityDocsBody, contentLength: len(parityDocsBody),
		},
		{
			// 无尾斜杠的目录同样补 index.html（与 Node 的 existsSync+isDirectory 一致）。
			name: "无尾斜杠目录补 index.html", method: http.MethodGet, target: "/ui/docs",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityDocsBody, contentLength: len(parityDocsBody),
		},
		{
			// .txt 不在 Node 的 MIME 表里：存在的文件原样下发，但不用于判定「静态资源」。
			name: "未登记扩展名的文件走 octet-stream", method: http.MethodGet, target: "/ui/docs/guide.txt",
			status: http.StatusOK, contentType: "application/octet-stream",
			cacheControl: parityNoStoreCache, body: "guide", contentLength: len("guide"),
		},
		{
			// 同上：.txt 缺失不算静态资源缺失，Node 会回落 SPA。
			name: "未登记扩展名缺失时回落 SPA", method: http.MethodGet, target: "/ui/docs/missing.txt",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			// 目录存在但没有 index.html：Node 走 SPA fallback，不是 404。
			name: "无 index 的目录回落 SPA", method: http.MethodGet, target: "/ui/empty/",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			name: "无扩展名文件原样下发", method: http.MethodGet, target: "/ui/LICENSE",
			status: http.StatusOK, contentType: "application/octet-stream",
			cacheControl: parityNoStoreCache, body: parityNoExtBody, contentLength: len(parityNoExtBody),
		},
		{
			// service worker 不能长缓存，否则部署后客户端一直跑旧版本。
			name: "service worker 不缓存", method: http.MethodGet, target: "/ui/sw.js",
			status: http.StatusOK, contentType: "application/javascript; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityWorkerBody, contentLength: len(parityWorkerBody),
		},
		{
			name: "显式 index.html 不缓存", method: http.MethodGet, target: "/ui/index.html",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			// 查询串不参与文件解析：/?from=login 仍是同一个 index.html。
			name: "查询串不影响解析", method: http.MethodGet, target: "/ui/?from=login",
			status: http.StatusOK, contentType: "text/html; charset=utf-8",
			cacheControl: parityNoStoreCache, body: parityIndexBody, contentLength: len(parityIndexBody),
		},
		{
			// 刻意偏离 Node：静态托管不接受写方法，避免把 POST 当静态请求。
			name: "写方法被拒", method: http.MethodPost, target: "/ui/",
			status: http.StatusMethodNotAllowed, allow: "GET, HEAD",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := serve(handler, testCase.method, testCase.target)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, want %d (body %q)", recorder.Code, testCase.status, recorder.Body.String())
			}
			if testCase.location != "" {
				if got := recorder.Header().Get("Location"); got != testCase.location {
					t.Fatalf("location = %q, want %q", got, testCase.location)
				}
			}
			if testCase.allow != "" {
				if got := recorder.Header().Get("Allow"); got != testCase.allow {
					t.Fatalf("allow = %q, want %q", got, testCase.allow)
				}
			}
			if testCase.contentType != "" {
				if got := recorder.Header().Get("Content-Type"); got != testCase.contentType {
					t.Fatalf("content-type = %q, want %q", got, testCase.contentType)
				}
				if got := recorder.Header().Get("X-Content-Type-Options"); got != "nosniff" {
					t.Fatalf("x-content-type-options = %q, want nosniff", got)
				}
			}
			if testCase.cacheControl != "" {
				if got := recorder.Header().Get("Cache-Control"); got != testCase.cacheControl {
					t.Fatalf("cache-control = %q, want %q", got, testCase.cacheControl)
				}
				// Node 的 404 分支只带 Cache-Control，不带 Pragma/Expires；
				// 200 的未哈希文件两者都要有，immutable 则两者都不能有。
				if testCase.cacheControl == parityNoStoreCache && testCase.status == http.StatusOK {
					if got := recorder.Header().Get("Pragma"); got != "no-cache" {
						t.Fatalf("pragma = %q, want no-cache", got)
					}
					if got := recorder.Header().Get("Expires"); got != "0" {
						t.Fatalf("expires = %q, want 0", got)
					}
				} else if testCase.cacheControl != parityNoStoreCache && recorder.Header().Get("Pragma") != "" {
					t.Fatalf("immutable 响应不该带 Pragma")
				}
			}
			// 重定向与 405 的 body 由 net/http 生成，不参与逐字节比对。
			if testCase.location != "" || testCase.allow != "" {
				return
			}
			if testCase.contentLength > 0 {
				if got := recorder.Header().Get("Content-Length"); got != strconv.Itoa(testCase.contentLength) {
					t.Fatalf("content-length = %q, want %d", got, testCase.contentLength)
				}
			}
			if testCase.expectEmptyBody {
				if body := recorder.Body.String(); body != "" {
					t.Fatalf("HEAD 返回了 %d 字节 body: %q", len(body), body)
				}
				return
			}
			if body := recorder.Body.String(); body != testCase.body {
				t.Fatalf("body = %q, want %q", body, testCase.body)
			}
		})
	}
}

// 目录遍历：dist 的父目录放一个哨兵文件，任何形式都不许读出来。
func TestTraversalStaysInsideDist(t *testing.T) {
	parent := t.TempDir()
	dist := filepath.Join(parent, "dist")
	if err := os.MkdirAll(filepath.Join(dist, "assets"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dist, "index.html"), []byte(parityIndexBody), 0o644); err != nil {
		t.Fatalf("write index: %v", err)
	}
	if err := os.WriteFile(filepath.Join(parent, "secret.txt"), []byte("do-not-leak"), 0o644); err != nil {
		t.Fatalf("write secret: %v", err)
	}
	handler := parityHandler(t, dist)

	targets := []string{
		"/ui/../secret.txt",
		"/ui/../../secret.txt",
		"/ui/assets/../../secret.txt",
		"/ui/%2e%2e/secret.txt",
		"/ui/%2e%2e%2f%2e%2e%2fsecret.txt",
		"/ui/..%5csecret.txt",
		"/ui/./../secret.txt",
	}
	for _, target := range targets {
		t.Run(target, func(t *testing.T) {
			recorder := serve(handler, http.MethodGet, target)
			if strings.Contains(recorder.Body.String(), "do-not-leak") {
				t.Fatalf("遍历读到了根外文件: %q", recorder.Body.String())
			}
			// 解析后落在 dist 内的路径不是静态资源请求，按 Node 语义回落 SPA；
			// 解析不出来的按缺失静态资源 404。两者都不可泄漏内容。
			switch recorder.Code {
			case http.StatusOK:
				if body := recorder.Body.String(); body != parityIndexBody {
					t.Fatalf("body = %q, want SPA index", body)
				}
			case http.StatusNotFound:
				if body := recorder.Body.String(); body != parityAssetMissingBody {
					t.Fatalf("body = %q, want 静态资源 404", body)
				}
			default:
				t.Fatalf("status = %d, 既非 SPA 也非 404", recorder.Code)
			}
		})
	}
}

// 未构建的 dist：入口和 SPA 路由给出构建提示，静态资源仍是普通 404。
func TestMissingBuildKeepsNodeMessages(t *testing.T) {
	// 目录本身可以不存在（os.DirFS 允许），缺失文件全部走 404。
	handler := parityHandler(t, filepath.Join(t.TempDir(), "dist-empty"))
	cases := []struct {
		target string
		body   string
	}{
		{"/ui/", parityNotBuiltBody},
		{"/ui/accounts/overview", parityNotBuiltBody},
		{"/ui/accounts/", parityNotBuiltBody},
		{"/ui/assets/index.0badc0de.js", parityAssetMissingBody},
		{"/ui/missing.css", parityAssetMissingBody},
	}
	for _, testCase := range cases {
		t.Run(testCase.target, func(t *testing.T) {
			recorder := serve(handler, http.MethodGet, testCase.target)
			if recorder.Code != http.StatusNotFound {
				t.Fatalf("status = %d, want 404", recorder.Code)
			}
			if body := recorder.Body.String(); body != testCase.body {
				t.Fatalf("body = %q, want %q", body, testCase.body)
			}
		})
	}
}
