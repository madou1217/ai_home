// Package blobsapi 提供进程内图片 blob 的只读 HTTP 入口。
//
// 它对应 Node 的 `GET /v1/blobs/<id>`（lib/server/v1-router.js）：从请求里被剥离出来
// 的图片与按 response_format=url 返回的生成结果都存在 imageblob 仓里，具备视觉能力的
// 下游通过这条路由取回原图。入口与其它 /v1 路由共用同一客户端密钥闸门。
package blobsapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imageblob"
)

const (
	// Path 是 blob 资源的规范前缀（不含参数段）。
	//
	// 与 PathPrefix 一样写成字面量：仓库的路由采集器只解析 Go 的字符串字面量常量。
	Path = "/v1/blobs"
	// PathPrefix 是 blob 取回的路径前缀。
	PathPrefix = "/v1/blobs/"
	// cacheControl 与 Node 一致：blob 内容按 ID 不可变，允许浏览器私有缓存。
	cacheControl = "private, max-age=3600"
)

var (
	// ErrInvalidDependencies 表示缺少 blob 读取端口。
	ErrInvalidDependencies = errors.New("blob HTTP Handler 依赖无效")
)

// Authorizer 判断客户端是否允许读取 /v1 数据面资源。
type Authorizer interface {
	Authorized(request *http.Request) bool
}

// BlobReader 是 Handler 所需的只读 blob 端口。
type BlobReader interface {
	Get(id string) (imageblob.Entry, bool)
}

// Dependencies 声明 blob 取回的只读依赖。
type Dependencies struct {
	Blobs      BlobReader
	Authorizer Authorizer
}

// Handler 提供 GET /v1/blobs/{id}。
type Handler struct {
	blobs      BlobReader
	authorizer Authorizer
}

// NewHandler 创建不会写入仓库的 blob 读取 Handler。
func NewHandler(dependencies Dependencies) (*Handler, error) {
	if dependencies.Blobs == nil || dependencies.Authorizer == nil {
		return nil, ErrInvalidDependencies
	}
	return &Handler{
		blobs:      dependencies.Blobs,
		authorizer: dependencies.Authorizer,
	}, nil
}

// ServeHTTP 完成客户端鉴权后按 ID 返回原始字节。
func (handler *Handler) ServeHTTP(
	response http.ResponseWriter,
	request *http.Request,
) {
	if handler == nil ||
		handler.authorizer == nil ||
		!handler.authorizer.Authorized(request) {
		response.Header().Set("WWW-Authenticate", "Bearer")
		writeJSON(response, http.StatusUnauthorized, blobError{
			OK:    false,
			Error: "unauthorized_client",
		})
		return
	}
	if request.Method != http.MethodGet {
		response.Header().Set("Allow", http.MethodGet)
		writeJSON(response, http.StatusMethodNotAllowed, blobError{
			OK:    false,
			Error: "method_not_allowed",
		})
		return
	}
	id, valid := blobID(request.URL.Path)
	if !valid {
		writeNotFound(response)
		return
	}
	entry, found := handler.blobs.Get(id)
	if !found {
		writeNotFound(response)
		return
	}
	body := entry.Bytes()
	response.Header().Set("Cache-Control", cacheControl)
	response.Header().Set("Content-Type", entry.MIME())
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.Header().Set("Content-Length", strconv.Itoa(len(body)))
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(body)
}

// blobID 从 /v1/blobs/{id} 提取 ID。
//
// 只接受恰好一段路径：/v1/blobs/ 与 /v1/blobs/a/b 都不算 blob 取回。
func blobID(path string) (string, bool) {
	if !strings.HasPrefix(path, PathPrefix) {
		return "", false
	}
	remainder := path[len(PathPrefix):]
	if remainder == "" || strings.Contains(remainder, "/") {
		return "", false
	}
	decoded, err := url.PathUnescape(remainder)
	if err != nil {
		return "", false
	}
	id := strings.TrimSpace(decoded)
	if id == "" {
		return "", false
	}
	return id, true
}

// blobError 是 blob 路由的错误 envelope，字段名与 Node 保持一致。
type blobError struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// writeNotFound 输出与 Node 逐字段一致的 404 响应。
func writeNotFound(response http.ResponseWriter) {
	writeJSON(response, http.StatusNotFound, blobError{
		OK:    false,
		Error: "blob_not_found",
	})
}

// writeJSON 写入禁止缓存的单个 JSON 文档。
func writeJSON(response http.ResponseWriter, status int, payload any) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(payload)
}
