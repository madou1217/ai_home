// Package images 提供 OpenAI 兼容图片接口的响应渲染与上游请求整形。
//
// 它对应 Node 的 lib/server/image-generations-endpoint.js 的渲染部分：把各策略产出的
// 图片统一渲染成 OpenAI /v1/images/* 响应体。本包不选账号、不读凭据、不发上游请求。
package images

import (
	"encoding/base64"
	"encoding/json"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/imageblob"
)

// ResponseFormat 是图片响应的承载方式，与 imagegeneration 包保持一致。
type ResponseFormat string

const (
	// ResponseFormatB64JSON 表示内联 base64。
	ResponseFormatB64JSON ResponseFormat = "b64_json"
	// ResponseFormatURL 表示返回本机 blob URL。
	ResponseFormatURL ResponseFormat = "url"
	// DefaultImageMIME 是策略未声明媒体类型时的兜底值。
	DefaultImageMIME = "image/png"
)

// GeneratedImage 是单个策略产出的图片。
type GeneratedImage struct {
	// B64JSON 是内联 base64；与 URL 二选一。
	B64JSON string
	// URL 是上游返回的远程地址。
	URL string
	// MIME 是内联字节的媒体类型，仅在 response_format=url 需要落 blob 时使用。
	MIME string
	// RevisedPrompt 是上游改写后的提示词。
	RevisedPrompt string
}

// BlobWriter 是渲染 blob URL 所需的写入端口。
type BlobWriter interface {
	Put(bytes []byte, mime string) string
}

// RenderOptions 声明一次响应渲染的上下文。
type RenderOptions struct {
	// ResponseFormat 决定内联还是 blob URL；空值按 b64_json 处理。
	ResponseFormat ResponseFormat
	// BlobBaseURL 是 blob URL 的同源前缀（例如 http://127.0.0.1:9527）。
	BlobBaseURL string
	// Blobs 在需要 blob URL 时必须提供。
	Blobs BlobWriter
	// Now 提供响应时间；为 nil 时使用 time.Now。
	Now func() time.Time
}

// responseEnvelope 是 OpenAI 图片响应的根结构。
type responseEnvelope struct {
	Created int64          `json:"created"`
	Data    []responseItem `json:"data"`
}

// responseItem 是单个图片项，字段按需出现。
type responseItem struct {
	B64JSON       string `json:"b64_json,omitempty"`
	URL           string `json:"url,omitempty"`
	RevisedPrompt string `json:"revised_prompt,omitempty"`
}

// Render 把策略产出的图片渲染为 OpenAI 图片响应。
//
// 与 Node 逐字段一致：默认内联 b64_json；response_format=url 时把内联字节写入 blob 仓
// 并返回本机 URL；上游本来就给 URL 时原样透传。三项都不存在的图片渲染为空对象，
// 而不是伪造一个字段。
func Render(
	generated []GeneratedImage,
	options RenderOptions,
) ([]byte, error) {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	format := options.ResponseFormat
	if format != ResponseFormatURL {
		format = ResponseFormatB64JSON
	}
	items := make([]responseItem, 0, len(generated))
	for _, image := range generated {
		item := responseItem{RevisedPrompt: image.RevisedPrompt}
		switch {
		case format == ResponseFormatURL && image.B64JSON != "" && options.BlobBaseURL != "":
			// 只有需要 blob URL 且确实拿到内联字节时才落仓。
			bytes, err := base64.StdEncoding.DecodeString(image.B64JSON)
			if err != nil {
				// 非规范 base64：退回内联，避免静默丢弃这张图。
				item.B64JSON = image.B64JSON
				items = append(items, item)
				continue
			}
			mime := image.MIME
			if mime == "" {
				mime = DefaultImageMIME
			}
			if options.Blobs == nil {
				item.B64JSON = image.B64JSON
				items = append(items, item)
				continue
			}
			id := options.Blobs.Put(bytes, mime)
			item.URL = options.BlobBaseURL + "/v1/blobs/" + id
		case image.B64JSON != "":
			item.B64JSON = image.B64JSON
		case image.URL != "":
			item.URL = image.URL
		}
		items = append(items, item)
	}
	return json.Marshal(responseEnvelope{
		Created: now().Unix(),
		Data:    items,
	})
}

// BlobStoreAdapter 让 *imageblob.Store 直接满足 BlobWriter。
type BlobStoreAdapter struct {
	Store *imageblob.Store
}

// Put 写入 blob 仓并返回内容寻址 ID。
func (adapter BlobStoreAdapter) Put(bytes []byte, mime string) string {
	if adapter.Store == nil {
		return ""
	}
	return adapter.Store.Put(bytes, mime)
}

// 编译期确认适配器满足端口。
var _ BlobWriter = BlobStoreAdapter{}
