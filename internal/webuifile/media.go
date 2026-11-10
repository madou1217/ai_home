package webuifile

import (
	"math"
	"path/filepath"
	"strings"
)

// Node 侧 WEBUI 文件接口的两个上限：文本 5MB、媒体 15MB。
const (
	TextFileSizeLimit  int64 = 5 * 1024 * 1024
	MediaFileSizeLimit int64 = 15 * 1024 * 1024
)

// SizeLimitMB 是 file_too_large 文案里展示的整数兆数（Math.round 语义）。
func SizeLimitMB(limit int64) int64 {
	return int64(math.Round(float64(limit) / (1024 * 1024)))
}

// imageContentTypes 是媒体路由的白名单：只按扩展名返回图片类型，
// 避免 media 接口变成任意二进制下载入口。
var imageContentTypes = map[string]string{
	".avif": "image/avif",
	".bmp":  "image/bmp",
	".gif":  "image/gif",
	".jpeg": "image/jpeg",
	".jpg":  "image/jpeg",
	".png":  "image/png",
	".svg":  "image/svg+xml",
	".webp": "image/webp",
}

// ImageContentType 对应 getImageContentType：非图片扩展名返回空串。
func ImageContentType(filePath string) string {
	return imageContentTypes[strings.ToLower(filepath.Ext(strings.TrimSpace(filePath)))]
}

// 预览响应固定关闭缓存。
const (
	CacheControlNoStore = "no-store, max-age=0"
	PragmaNoCache       = "no-cache"
)

// MediaHeaders 是媒体响应的头形状；ContentType 为空表示不支持的类型。
type MediaHeaders struct {
	ContentType   string
	ContentLength int64
	CacheControl  string
	Pragma        string
}

// NewMediaHeaders 对应 handleReadFileMediaRequest 里的 writeHead 参数。
func NewMediaHeaders(filePath string, size int64) (MediaHeaders, bool) {
	contentType := ImageContentType(filePath)
	if contentType == "" {
		return MediaHeaders{}, false
	}
	return MediaHeaders{
		ContentType:   contentType,
		ContentLength: size,
		CacheControl:  CacheControlNoStore,
		Pragma:        PragmaNoCache,
	}, true
}
