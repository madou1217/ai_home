// Package webuiassets 托管 Web UI 的构建产物（`web/dist`）与 SPA fallback。
//
// 核心架构特性：
//   - 规范化相对路径并运行在 fs.FS（生产为 os.DirFS）之上；部署方须确保静态目录不含越界符号链接；
//   - 内容哈希构建产物使用一年期 immutable 强缓存，入口 HTML 与 Service Worker 严格禁缓存；
//   - 有界的大小/修改时间摘要缓存；全部条件请求与 Range 由同一标准库路径处理；
//   - 可 seek 文件保持流式输出，不把整个构建产物保留在 Go 堆或缓存中。
package webuiassets

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// ErrInvalidDependencies 表示 Handler 缺少静态资源根。
var ErrInvalidDependencies = errors.New("webuiassets: 静态资源根无效")

// Prefix 是 Web UI 资源在公开路由上的前缀。
const Prefix = "/ui/"

const (
	indexFile       = "index.html"
	notBuiltMessage = "Web UI not built. Run: cd web && npm run build"
	maxETagEntries  = 4096
)

// contentTypes 是构建产物会出现的扩展名到 MIME 的映射。
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
var immutablePattern = regexp.MustCompile(`(?i)\.[a-f0-9]{8,}\.|\.(?:async|chunk)\.[a-z0-9]{6,}\.`)

type cachedETag struct {
	size        int64
	modTimeNano int64
	etag        string
}

// Handler 按「解析 → ETag/缓存协商 → 条件请求与流式写出」托管构建产物。
type Handler struct {
	files  fs.FS
	etagMu sync.RWMutex
	etags  map[string]cachedETag
}

// NewHandler 创建静态资源 Handler。files 通常是 os.DirFS(webDistDir)。
func NewHandler(files fs.FS) (*Handler, error) {
	if files == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		files: files,
		etags: make(map[string]cachedETag, 64),
	}, nil
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
	// /ui -> /ui/：相对路径基准不同，必须由浏览器拿到带斜杠的地址，同时保留原始查询串。
	if request.URL.Path == strings.TrimSuffix(Prefix, "/") {
		target := Prefix
		if request.URL.RawQuery != "" {
			target += "?" + request.URL.RawQuery
		}
		http.Redirect(response, request, target, http.StatusFound)
		return
	}
	requestRelative := strings.TrimPrefix(request.URL.Path, Prefix)
	staticAsset := isStaticAssetRequest(requestRelative)

	relative := strings.TrimPrefix(path.Clean("/"+requestRelative), "/")
	if relative == "" || relative == "." {
		relative = indexFile
	} else if strings.HasSuffix(requestRelative, "/") {
		relative = path.Join(relative, indexFile)
	}
	handler.serveFile(response, request, relative, staticAsset)
}

// serveFile 解析目标文件并流式写出；缺失时按资源类型决定 404 还是 SPA fallback。
func (handler *Handler) serveFile(response http.ResponseWriter, request *http.Request, relative string, staticAsset bool) {
	target, ok := handler.resolve(relative)
	if !ok {
		if staticAsset {
			writePlain(response, request, http.StatusNotFound, "Static asset not found")
			return
		}
		target, ok = handler.resolve(indexFile)
		if !ok {
			writePlain(response, request, http.StatusNotFound, notBuiltMessage)
			return
		}
	}

	file, err := handler.files.Open(target)
	if err != nil {
		writePlain(response, request, http.StatusInternalServerError, "Internal Server Error")
		return
	}
	defer func() { _ = file.Close() }()

	info, err := file.Stat()
	if err != nil || info.IsDir() {
		writePlain(response, request, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	etag, content, err := handler.prepareAssetStream(target, file, info)
	if err != nil {
		writePlain(response, request, http.StatusInternalServerError, "Internal Server Error")
		return
	}

	header := response.Header()
	header.Set("Content-Type", contentTypeFor(target))
	header.Set("X-Content-Type-Options", "nosniff")
	if etag != "" {
		header.Set("ETag", etag)
	}
	if isImmutable(target) {
		header.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
		header.Set("Pragma", "no-cache")
		header.Set("Expires", "0")
	}

	// Use the same precondition and range evaluation for GET and HEAD, whether
	// the ETag was cached or freshly computed. In particular, If-Match must
	// not be ignored merely because the request has no Range header.
	http.ServeContent(response, request, path.Base(target), info.ModTime(), content)
}

func (handler *Handler) prepareAssetStream(
	target string,
	file fs.File,
	info fs.FileInfo,
) (string, io.ReadSeeker, error) {
	if seeker, ok := file.(io.ReadSeeker); ok {
		size := info.Size()
		cacheable := !info.ModTime().IsZero()
		modNano := info.ModTime().UnixNano()
		if cacheable {
			handler.etagMu.RLock()
			cached, found := handler.etags[target]
			handler.etagMu.RUnlock()
			if found && cached.size == size && cached.modTimeNano == modNano {
				return cached.etag, seeker, nil
			}
		}
		hasher := sha256.New()
		if _, err := io.Copy(hasher, file); err != nil {
			return "", nil, err
		}
		if _, err := seeker.Seek(0, io.SeekStart); err != nil {
			return "", nil, err
		}
		etag := `"` + hex.EncodeToString(hasher.Sum(nil)[:16]) + `"`
		if cacheable {
			handler.storeETag(target, cachedETag{size: size, modTimeNano: modNano, etag: etag})
		}
		return etag, seeker, nil
	}

	// A digest-only cache cannot turn a nonseekable fs.File into a seekable
	// response. Materialize it on every request so cold and warm Range/HEAD
	// semantics stay identical, without retaining file bodies in the cache.
	raw, err := io.ReadAll(file)
	if err != nil {
		return "", nil, err
	}
	sum := sha256.Sum256(raw)
	etag := `"` + hex.EncodeToString(sum[:16]) + `"`
	return etag, bytes.NewReader(raw), nil
}

func (handler *Handler) storeETag(target string, entry cachedETag) {
	handler.etagMu.Lock()
	if len(handler.etags) >= maxETagEntries {
		clear(handler.etags)
	}
	handler.etags[target] = entry
	handler.etagMu.Unlock()
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
	trailingSlash := strings.HasSuffix(requestPath, "/")
	cleaned := strings.TrimPrefix(path.Clean("/"+requestPath), "/")
	if cleaned == "." {
		cleaned = ""
	}
	if trailingSlash && cleaned != "" && !strings.HasSuffix(cleaned, "/") {
		cleaned += "/"
	}
	if strings.HasPrefix(cleaned, "assets/") {
		return true
	}
	_, known := contentTypes[strings.ToLower(path.Ext(cleaned))]
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

// writePlain 写出纯文本错误响应；HEAD 只回头部，与其他路径语义一致。
func writePlain(response http.ResponseWriter, request *http.Request, status int, message string) {
	header := response.Header()
	header.Set("Content-Type", "text/plain; charset=utf-8")
	header.Set("Cache-Control", "no-cache, no-store, must-revalidate")
	header.Set("X-Content-Type-Options", "nosniff")
	header.Set("Content-Length", strconv.Itoa(len(message)))
	response.WriteHeader(status)
	if request.Method == http.MethodHead {
		return
	}
	_, _ = response.Write([]byte(message))
}
