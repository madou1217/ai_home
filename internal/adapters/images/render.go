// Package images 提供 OpenAI 兼容图片接口的响应渲染与上游请求整形。
//
// 它对应 Node 的 lib/server/image-generations-endpoint.js 的渲染部分：把各策略产出的
// 图片统一渲染成 OpenAI /v1/images/* 响应体。本包不选账号、不读凭据、不发上游生成请求。
package images

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
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
	// Rehosted 是策略从「与账号上游同源」的链接取回的字节：非空时渲染改写为本网关 blob 链接，
	// 否则客户端只有网关密钥、打不开上游的鉴权链接（对应 Node 的 REHOSTED_IMAGE）。
	Rehosted []byte
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
	// ExplicitResponseFormat 表示客户端在请求里显式写了 response_format。
	//
	// 解析层把缺省值也归一成 b64_json，渲染层拿不到「客户端没说」这一信息；默认路径必须与
	// 改造前一致（上游只给链接就原样回链接），所以只有显式 b64_json 才把链接取回成内联字节。
	ExplicitResponseFormat bool
	// BlobBaseURL 是 blob URL 的同源前缀（例如 http://127.0.0.1:9527）。
	BlobBaseURL string
	// Blobs 在需要 blob URL 时必须提供。
	Blobs BlobWriter
	// Fetcher 在显式 b64_json 且上游只给链接时取回字节；为 nil 时返回明确的取回失败。
	Fetcher ImageFetcher
	// Context 是取回链接时使用的上下文；为 nil 时使用 context.Background()。
	Context context.Context
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
// response_format 在这里被彻底归一，不依赖上游是否遵守请求：
//   - 客户端要 url：上游只给内联字节时写入 blob 仓并返回本网关链接；没有配置 blob 仓或
//     前缀时退回内联 b64（网关无法生成本机可服务的链接，见 renderImage）；
//   - 客户端显式要 b64_json：上游只给链接时用 Fetcher 取回字节再内联；
//   - 客户端没声明 response_format：保持改造前的行为逐字节不变（链接原样透传）。
//
// 三项都不存在的图片渲染为空对象，而不是伪造一个字段。
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
		item, err := renderImage(image, format, options)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return json.Marshal(responseEnvelope{
		Created: now().Unix(),
		Data:    items,
	})
}

// renderImage 把单张图片渲染成客户端请求的承载方式。
func renderImage(
	image GeneratedImage,
	format ResponseFormat,
	options RenderOptions,
) (responseItem, error) {
	item := responseItem{RevisedPrompt: image.RevisedPrompt}
	if len(image.Rehosted) > 0 {
		if format == ResponseFormatB64JSON && options.ExplicitResponseFormat {
			// 显式 b64_json 时客户端不接受链接：已经取回的字节直接内联。
			item.B64JSON = base64.StdEncoding.EncodeToString(image.Rehosted)
			return item, nil
		}
		// 取回的字节优先：与 Node 的 materializeRehostedImages 一致。
		blobURL, err := storeBlobURL(options, image.Rehosted, image.MIME)
		if err != nil {
			return item, err
		}
		if blobURL != "" {
			item.URL = blobURL
			return item, nil
		}
		// 没有 blob 仓/前缀：保持上游链接（改造前的兜底行为）。
		item.URL = image.URL
		return item, nil
	}
	if format == ResponseFormatURL {
		if image.B64JSON == "" {
			// 上游已经给了链接，客户端要的也是链接：原样透传。
			item.URL = image.URL
			return item, nil
		}
		if !canStoreBlob(options) {
			// 没有配置 BlobWriter 或 blob 前缀：无法生成网关可服务的链接，退回内联 b64。
			item.B64JSON = image.B64JSON
			return item, nil
		}
		payload, err := base64.StdEncoding.DecodeString(image.B64JSON)
		if err != nil {
			// 非规范 base64：退回内联，避免静默丢弃这张图。
			item.B64JSON = image.B64JSON
			return item, nil
		}
		blobURL, err := storeBlobURL(options, payload, image.MIME)
		if err != nil {
			return item, err
		}
		if blobURL == "" {
			item.B64JSON = image.B64JSON
			return item, nil
		}
		item.URL = blobURL
		return item, nil
	}
	if image.B64JSON != "" {
		item.B64JSON = image.B64JSON
		return item, nil
	}
	if image.URL != "" && options.ExplicitResponseFormat {
		// 显式 b64_json 而上游只给链接：取回字节，保证客户端拿到的是内联图片。
		payload, err := fetchInlineBytes(options, image.URL)
		if err != nil {
			return item, err
		}
		item.B64JSON = base64.StdEncoding.EncodeToString(payload)
		return item, nil
	}
	// 默认（客户端没有声明 response_format）：保持改造前的原样透传。
	item.URL = image.URL
	return item, nil
}

// RenderPassthrough 直接回上游原体。
//
// 上游的 created / usage / model / data 里的额外字段全部原样保留（对应 Node 的
// materializeRehostedImages + passthroughBody）：网关只做一件事 —— 把已经回取到字节的图片
// 链接改写成本网关的 blob 链接，否则客户端只有网关密钥、打不开上游的鉴权链接。
//
// 与 Render 一样，客户端显式声明 response_format 时这里也把 data 项归一成对应承载方式：
// url 要 b64 的项取回字节，b64 要 url 的项落 blob；默认路径不做任何额外改写。
func RenderPassthrough(result Result, options RenderOptions) ([]byte, error) {
	if len(result.PassthroughBody) == 0 {
		return nil, newError(500, "invalid_image_output", "passthrough body is empty")
	}
	var document map[string]any
	if err := json.Unmarshal(result.PassthroughBody, &document); err != nil {
		return nil, newError(502, "invalid_image_output", "upstream image response is not an object")
	}
	format := options.ResponseFormat
	if format != ResponseFormatURL {
		format = ResponseFormatB64JSON
	}
	data, _ := document["data"].([]any)
	for index, raw := range data {
		item, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		var rehosted []byte
		mime := ""
		if index < len(result.Images) {
			rehosted = result.Images[index].Rehosted
			mime = result.Images[index].MIME
		}
		// 显式 b64_json 时由下面的归一直接内联取回的字节，不必先落一次 blob。
		if len(rehosted) > 0 && !(format == ResponseFormatB64JSON && options.ExplicitResponseFormat) {
			blobURL, err := storeBlobURL(options, rehosted, mime)
			if err != nil {
				return nil, err
			}
			if blobURL != "" {
				item["url"] = blobURL
			}
		}
		if err := normalizePassthroughItem(item, format, rehosted, mime, options); err != nil {
			return nil, err
		}
	}
	return json.Marshal(document)
}

// normalizePassthroughItem 把一个上游 data 项归一成客户端请求的承载方式。
func normalizePassthroughItem(
	item map[string]any,
	format ResponseFormat,
	rehosted []byte,
	mime string,
	options RenderOptions,
) error {
	urlValue := strings.TrimSpace(stringValue(item["url"]))
	b64Value := strings.TrimSpace(stringValue(item["b64_json"]))
	if format == ResponseFormatB64JSON {
		if b64Value != "" || !options.ExplicitResponseFormat {
			// 已经是内联，或客户端没有显式声明：默认路径原样保留。
			return nil
		}
		payload := rehosted
		if len(payload) == 0 {
			if urlValue == "" {
				return nil
			}
			fetched, err := fetchInlineBytes(options, urlValue)
			if err != nil {
				return err
			}
			payload = fetched
		}
		item["b64_json"] = base64.StdEncoding.EncodeToString(payload)
		delete(item, "url")
		return nil
	}
	// format == ResponseFormatURL：客户端要链接，上游给的是内联字节时落 blob。
	if urlValue != "" {
		return nil
	}
	if !canStoreBlob(options) {
		// 没有配置 BlobWriter 或 blob 前缀：无法生成网关可服务的链接，保持上游原样（内联 b64）。
		return nil
	}
	payload := rehosted
	if len(payload) == 0 {
		if b64Value == "" {
			return nil
		}
		decoded, err := base64.StdEncoding.DecodeString(b64Value)
		if err != nil {
			// 非规范 base64：保持内联，避免静默丢弃这张图。
			return nil
		}
		payload = decoded
	}
	blobURL, err := storeBlobURL(options, payload, mime)
	if err != nil {
		return err
	}
	if blobURL == "" {
		return nil
	}
	item["url"] = blobURL
	delete(item, "b64_json")
	return nil
}

// canStoreBlob 判断当前配置能否生成本网关可服务的 blob 链接。
func canStoreBlob(options RenderOptions) bool {
	return options.Blobs != nil && strings.TrimSpace(options.BlobBaseURL) != ""
}

// storeBlobURL 把字节写进 blob 仓并返回本网关链接；没有 blob 仓或没有前缀时返回空串。
//
// 配置了 blob 仓但写入没有返回句柄时返回 502 image_blob_store_failed：此时绝不能拼出一个
// 网关无法服务的 /v1/blobs/ 空链接。
func storeBlobURL(options RenderOptions, payload []byte, mime string) (string, error) {
	if !canStoreBlob(options) || len(payload) == 0 {
		return "", nil
	}
	if strings.TrimSpace(mime) == "" {
		mime = DefaultImageMIME
	}
	id := strings.TrimSpace(options.Blobs.Put(payload, mime))
	if id == "" {
		return "", newError(502, "image_blob_store_failed", "image blob storage did not return a handle")
	}
	return options.BlobBaseURL + "/v1/blobs/" + id, nil
}

// fetchInlineBytes 取回上游图片链接的字节，供显式 b64_json 使用。
func fetchInlineBytes(options RenderOptions, rawURL string) ([]byte, error) {
	if options.Fetcher == nil {
		return nil, newError(502, "image_fetch_failed", "image fetch transport is not configured")
	}
	ctx := options.Context
	if ctx == nil {
		ctx = context.Background()
	}
	fetched, err := options.Fetcher.Fetch(ctx, rawURL, FetchOptions{})
	if err != nil {
		// 取回器自己的错误已经是 502 + 明确 code（image_fetch_failed / image_fetch_forbidden
		// / image_fetch_too_large）；其它错误统一归一为 image_fetch_failed。
		if fetchErr, ok := AsError(err); ok {
			return nil, fetchErr
		}
		return nil, newError(502, "image_fetch_failed", "upstream image url is not fetchable")
	}
	if len(fetched.Bytes) == 0 {
		return nil, newError(502, "image_fetch_failed", "upstream image url returned no bytes")
	}
	return fetched.Bytes, nil
}

// stringValue 读取 JSON 对象里的字符串字段；其它类型按空串处理。
func stringValue(value any) string {
	text, _ := value.(string)
	return text
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
