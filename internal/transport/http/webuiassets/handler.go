// Package webuiassets 托管 Web UI 的构建产物（`web/dist`）与 SPA fallback。
//
// 与 Node 实现的差异（刻意的设计修正，不是照抄）：
//   - Node 用 path.normalize + join + 字符串包含 '..' 做目录遍历防护；这里直接跑在
//     fs.FS 上（生产用 os.DirFS），越界路径在文件系统层就不可能解析成功。
//   - Node 在进程内维护 immutable 资源的字节缓存，因为 fs.readFileSync 会阻塞事件循环；
//     Go 侧不需要：读文件走系统调用，页缓存由内核管理，再叠一层只会多一份内存。
//   - 非 GET/HEAD 返回 405，而不是把 POST 当成静态请求处理。
package webuiassets

import (
	"errors"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strings"
)

// ErrInvalidDependencies 表示 Handler 缺少静态资源根。
var ErrInvalidDependencies = errors.New("webuiassets: 静态资源根无效")

// Prefix 是 Web UI 资源在公开路由上的前缀。
const Prefix = "/ui/"

// indexFile 是目录与 SPA fallback 的入口文件。
const indexFile = "index.html"

// notBuiltMessage 与 Node 的提示保持一致，便于排障时直接照做。
const notBuiltMessage = "Web UI not built. Run: cd web && npm run build"

// contentTypes 是构建产物会出现的扩展名到 MIME 的映射（与 Node 同表）。
var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "application/javascript; charset=utf-8",
	".mjs":   "application/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json; charset=utf-8",
	".map":   "application/json; charset=utf-8",
	".png":   "image/png",
	".jpg":   "image/jpeg",
	".jpeg":  "image/jpeg",
	".gif":   "image/gif",
	".svg":   "image/svg+xml",
	".ico":   "image/x-icon",
	".webp":  "image/webp",
	".wasm":  "application/wasm",
	".woff":  "font/woff",
	".woff2": "font/woff2",
	".ttf":   "font/ttf",
	".eot":   "application/vnd.ms-fontobject",
}

// immutablePattern 识别内容哈希命名的构建产物（可长期缓存）。
//
// 与 Node 的 isImmutableStaticAsset 同判据：文件名里出现 8 位以上十六进制片段，
// 或 Vite 的 .async/.chunk 分块命名。index.html 与 service worker 不匹配。
var immutablePattern = regexp.MustCompile(`(?i)\.[a-f0-9]{8,}\.|\.(?:async|chunk)\.[a-z0-9]{6,}\.`)

// Handler 按「解析 → 缓存策略 → 写出」三步托管构建产物。
type Handler struct {
	files fs.FS
}

// NewHandler 创建静态资源 Handler。files 通常是 os.DirFS(webDistDir)。
func NewHandler(files fs.FS) (*Handler, error) {
	if files == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{files: files}, nil
}

// ServeHTTP 实现 http.Handler。
func (handler *Handler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if handler == nil || handler.files == nil {
		http.Error(response, "static assets unavailable", http.StatusServiceUnavailable)
		return
	}
	if request.Method != http.MethodGet && request.Method != http.MethodHead {
		response.Header().Set("Allow", "GET, HEAD")
		http.Error(response, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// /ui -> /ui/：相对路径基准不同，必须由浏览器拿到带斜杠的地址。
	if request.URL.Path == strings.TrimSuffix(Prefix, "/") {
		http.Redirect(response, request, Prefix, http.StatusFound)
		return
	}
	relative := strings.TrimPrefix(request.URL.Path, Prefix)
	relative = strings.TrimPrefix(path.Clean("/"+relative), "/")
	if relative == "" || relative == "." {
		relative = indexFile
	} else if strings.HasSuffix(request.URL.Path, "/") {
		relative = path.Join(relative, indexFile)
	}
	handler.serveFile(response, request, relative)
}

// serveFile 解析目标文件并写出；缺失时按资源类型决定 404 还是 SPA fallback。
func (handler *Handler) serveFile(response http.ResponseWriter, request *http.Request, relative string) {
	target, ok := handler.resolve(relative)
	if !ok {
		if isStaticAssetRequest(relative) {
			// 静态资源缺失不能回落 index.html：浏览器会把 HTML 当 JS/CSS 加载，
			// 报错信息从「404」变成看不懂的语法错误。
			writePlain(response, http.StatusNotFound, "Static asset not found")
			return
		}
		target, ok = handler.resolve(indexFile)
		if !ok {
			writePlain(response, http.StatusNotFound, notBuiltMessage)
			return
		}
	}
	content, err := fs.ReadFile(handler.files, target)
	if err != nil {
		writePlain(response, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	header := response.Header()
	header.Set("Content-Type", contentTypeFor(target))
	header.Set("X-Content-Type-Options", "nosniff")
	if isImmutable(target) {
		header.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
		header.Set("Pragma", "no-cache")
		header.Set("Expires", "0")
	}
	response.WriteHeader(http.StatusOK)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = response.Write(content)
}

// resolve 把相对路径解析成可读取的文件；目录会补上 index.html。
func (handler *Handler) resolve(relative string) (string, bool) {
	relative = strings.TrimPrefix(path.Clean("/"+relative), "/")
	if relative == "" || relative == "." {
		relative = indexFile
	}
	info, err := fs.Stat(handler.files, relative)
	if err != nil {
		return "", false
	}
	if !info.IsDir() {
		return relative, true
	}
	indexed := path.Join(relative, indexFile)
	if _, statErr := fs.Stat(handler.files, indexed); statErr != nil {
		return "", false
	}
	return indexed, true
}

// isStaticAssetRequest 判定请求是否必须是真实文件（不能走 SPA fallback）。
func isStaticAssetRequest(relative string) bool {
	requestPath := strings.ReplaceAll(relative, "\\", "/")
	if strings.HasPrefix(requestPath, "assets/") {
		return true
	}
	_, known := contentTypes[strings.ToLower(path.Ext(requestPath))]
	return known
}

// isImmutable 判定资源是否内容哈希命名。
func isImmutable(filePath string) bool {
	return immutablePattern.MatchString(path.Base(filePath))
}

func contentTypeFor(filePath string) string {
	if value, ok := contentTypes[strings.ToLower(path.Ext(filePath))]; ok {
		return value
	}
	return "application/octet-stream"
}

func writePlain(response http.ResponseWriter, status int, message string) {
	response.Header().Set("Content-Type", "text/plain; charset=utf-8")
	response.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	response.WriteHeader(status)
	_, _ = response.Write([]byte(message))
}
