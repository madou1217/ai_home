// Package imagegeneration 解析并校验 OpenAI 兼容的图片生成/编辑请求。
//
// 它对应 Node 的 lib/server/image-generation-request.js：把全部输入整形集中在这里，
// 让线协议关注点不渗进策略分派。本包是纯函数，不选账号、不读凭据、不发上游请求。
package imagegeneration

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/imagedata"
)

// Mode 是一次请求的图片语义。
type Mode string

const (
	// ModeGeneration 对应 POST /v1/images/generations。
	ModeGeneration Mode = "generation"
	// ModeEdit 对应 POST /v1/images/edits。
	ModeEdit Mode = "edit"
)

const (
	// PathGenerations 是图片生成入口。
	PathGenerations = "/v1/images/generations"
	// PathEdits 是图片编辑入口。
	PathEdits = "/v1/images/edits"

	// DefaultMaxImageBytes 与 Node 一致：单张图片 4 MiB，和聊天附件同口径。
	DefaultMaxImageBytes = 4 * 1024 * 1024
	// MaxImageInputs 是编辑请求允许的最大输入图片数。
	MaxImageInputs = 16
	// MaxOutputCount 是 n 的上限。
	MaxOutputCount = 10
)

// ResponseFormat 是响应的图片承载方式。
type ResponseFormat string

const (
	// ResponseFormatB64JSON 表示内联 base64（默认）。
	ResponseFormatB64JSON ResponseFormat = "b64_json"
	// ResponseFormatURL 表示返回本机 blob URL。
	ResponseFormatURL ResponseFormat = "url"
)

// Error 是请求解析失败，字段与 Node 的 ImageGenerationError 对齐。
type Error struct {
	// StatusCode 是应返回的 HTTP 状态码。
	StatusCode int
	// Code 是机器可读错误码。
	Code string
	// Detail 是面向调用方的说明。
	Detail string
}

// Error 实现 error。
func (requestError *Error) Error() string {
	return fmt.Sprintf("%s: %s", requestError.Code, requestError.Detail)
}

// Image 是一张已校验的内联图片。
type Image struct {
	// MIME 是归一化并已与字节校验一致的媒体类型。
	MIME imagedata.MIME
	// Data 是规范 base64（不含 data URL 前缀）。
	Data string
}

// Request 是校验并归一化后的图片请求。
type Request struct {
	Mode              Mode
	Provider          string
	Model             string
	Prompt            string
	N                 int
	Size              string
	Quality           string
	ResponseFormat    ResponseFormat
	Images            []Image
	Mask              *Image
	Background        string
	OutputFormat      string
	OutputCompression *int
	Moderation        string
}

// Options 声明可信调用方可以调整的上传上限。
type Options struct {
	// MaxImageBytes 覆盖单张图片上限；非正时使用 DefaultMaxImageBytes。
	MaxImageBytes int64
	// MaxMaskBytes 覆盖蒙版上限；非正时回落到 MaxImageBytes。
	MaxMaskBytes int64
}

// 枚举集合与 Node 保持一致。
var (
	qualityValues    = []string{"low", "medium", "high", "auto"}
	backgroundValues = []string{"auto", "transparent", "opaque"}
	outputFormats    = []string{"png", "jpeg", "webp"}
	moderationValues = []string{"auto", "low"}
)

// requestMIMEWhitelist 是图片请求允许的媒体类型。
//
// 它比 imagedata 支持的集合更窄：Node 的请求解析用 {png,jpeg,webp}，
// 而底层 image-data.js 还认 gif。两者不同是有意的——请求入口不接受 gif，
// 因此这里必须单独设白名单，否则 gif 会绕过请求校验。
var requestMIMEWhitelist = map[imagedata.MIME]struct{}{
	imagedata.MIMEPNG:  {},
	imagedata.MIMEJPEG: {},
	imagedata.MIMEWEBP: {},
}

// Parse 校验并归一化一份 /v1/images/* 请求体。
func Parse(body []byte, pathname string, options Options) (Request, error) {
	var document map[string]json.RawMessage
	if len(strings.TrimSpace(string(body))) > 0 {
		if err := json.Unmarshal(body, &document); err != nil {
			return Request{}, requestError("invalid_request_body", "request body must be a JSON object")
		}
	}
	if document == nil {
		document = map[string]json.RawMessage{}
	}

	mode := ModeGeneration
	if pathname == PathEdits {
		mode = ModeEdit
	}

	model := trimmedString(document["model"])
	if model == "" {
		return Request{}, requestError("model_required", "model is required")
	}
	provider := strings.ToLower(trimmedString(document["provider"]))
	prompt := trimmedString(document["prompt"])
	if prompt == "" {
		return Request{}, requestError("prompt_required", "prompt is required")
	}

	n := 1
	if raw, found := document["n"]; found && !isJSONNull(raw) {
		value, ok := jsNumber(raw)
		if !ok || !isJSInteger(value) || value < 1 || value > MaxOutputCount {
			return Request{}, requestError("invalid_n", "n must be an integer between 1 and 10")
		}
		n = int(value)
	}

	size := ""
	if raw, found := document["size"]; found && !isJSONNull(raw) {
		size = trimmedString(raw)
		if !isValidSize(size) {
			return Request{}, requestError("invalid_size", "size must look like 1024x1024 or auto")
		}
	}

	quality := ""
	if raw, found := document["quality"]; found && !isJSONNull(raw) {
		quality = strings.ToLower(trimmedString(raw))
		if !contains(qualityValues, quality) {
			return Request{}, requestError(
				"invalid_quality",
				"quality must be one of low, medium, high, auto",
			)
		}
	}

	responseFormatRaw := strings.ToLower(trimmedString(document["response_format"]))
	responseFormat := ResponseFormatB64JSON
	if responseFormatRaw == "url" {
		responseFormat = ResponseFormatURL
	} else if responseFormatRaw != "" && responseFormatRaw != "b64_json" {
		return Request{}, requestError(
			"invalid_response_format",
			"response_format must be url or b64_json",
		)
	}

	background, err := optionalEnum(
		document["background"],
		backgroundValues,
		"invalid_background",
		"background must be one of auto, transparent, opaque",
	)
	if err != nil {
		return Request{}, err
	}
	outputFormat, err := optionalEnum(
		document["output_format"],
		outputFormats,
		"invalid_output_format",
		"output_format must be one of png, jpeg, webp",
	)
	if err != nil {
		return Request{}, err
	}
	moderation, err := optionalEnum(
		document["moderation"],
		moderationValues,
		"invalid_moderation",
		"moderation must be one of auto, low",
	)
	if err != nil {
		return Request{}, err
	}

	var outputCompression *int
	if raw, found := document["output_compression"]; found && !isJSONNull(raw) {
		value, ok := jsNumber(raw)
		if !ok || !isJSInteger(value) || value < 0 || value > 100 {
			return Request{}, requestError(
				"invalid_output_compression",
				"output_compression must be an integer between 0 and 100",
			)
		}
		if outputFormat != "jpeg" && outputFormat != "webp" {
			return Request{}, requestError(
				"output_compression_requires_lossy_format",
				"output_compression requires output_format jpeg or webp",
			)
		}
		integer := int(value)
		outputCompression = &integer
	}
	if background == "transparent" && outputFormat == "jpeg" {
		return Request{}, requestError(
			"transparent_background_requires_alpha_format",
			"transparent backgrounds require output_format png or webp",
		)
	}

	var images []Image
	if mode == ModeEdit {
		images, err = parseEditImages(document, options)
		if err != nil {
			return Request{}, err
		}
	} else if _, found := document["image"]; found {
		return Request{}, requestError(
			"image_requires_edit",
			"image input requires the image edits endpoint",
		)
	} else if _, found := document["images"]; found {
		return Request{}, requestError(
			"image_requires_edit",
			"image input requires the image edits endpoint",
		)
	}

	var mask *Image
	if raw, found := document["mask"]; found && !isJSONNull(raw) {
		if mode != ModeEdit {
			return Request{}, requestError(
				"mask_requires_edit",
				"image masks require the image edits endpoint",
			)
		}
		parsed, err := parseDataURL(rawString(raw), options.MaxMaskBytes, options)
		if err != nil {
			return Request{}, err
		}
		if parsed.MIME != imagedata.MIMEPNG {
			return Request{}, requestError(
				"invalid_image_mask_mime",
				"image masks must use image/png",
			)
		}
		mask = &parsed
	}

	return Request{
		Mode:              mode,
		Provider:          provider,
		Model:             model,
		Prompt:            prompt,
		N:                 n,
		Size:              size,
		Quality:           quality,
		ResponseFormat:    responseFormat,
		Images:            images,
		Mask:              mask,
		Background:        background,
		OutputFormat:      outputFormat,
		OutputCompression: outputCompression,
		Moderation:        moderation,
	}, nil
}

// parseEditImages 解析 image/images 二选一的输入图片列表。
func parseEditImages(
	document map[string]json.RawMessage,
	options Options,
) ([]Image, error) {
	imageRaw, hasImage := document["image"]
	imagesRaw, hasImages := document["images"]
	hasImage = hasImage && !isJSONNull(imageRaw)
	hasImages = hasImages && !isJSONNull(imagesRaw)
	if hasImage && hasImages {
		return nil, requestError(
			"ambiguous_image_input",
			"choose either image or images, not both",
		)
	}
	source := imageRaw
	if hasImages {
		source = imagesRaw
	}
	references, err := imageReferences(source)
	if err != nil {
		return nil, err
	}
	if len(references) < 1 {
		return nil, requestError("image_required", "image is required for image edits")
	}
	if len(references) > MaxImageInputs {
		return nil, requestError(
			"invalid_image_count",
			fmt.Sprintf("image edits support at most %d input images", MaxImageInputs),
		)
	}
	images := make([]Image, 0, len(references))
	for _, reference := range references {
		parsed, err := parseDataURL(reference, options.MaxImageBytes, options)
		if err != nil {
			return nil, err
		}
		images = append(images, parsed)
	}
	return images, nil
}

// imageReferences 把 image/images 归一成字符串引用列表。
func imageReferences(raw json.RawMessage) ([]string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if trimmed[0] == '[' {
		var items []json.RawMessage
		if err := json.Unmarshal(raw, &items); err != nil {
			return nil, requestError("invalid_image_reference", "invalid image array")
		}
		references := make([]string, 0, len(items))
		for _, item := range items {
			reference, err := imageReference(item)
			if err != nil {
				return nil, err
			}
			references = append(references, reference)
		}
		return references, nil
	}
	reference, err := imageReference(raw)
	if err != nil {
		return nil, err
	}
	return []string{reference}, nil
}

// imageReference 接受字符串或 {image_url: "..."} 对象。
func imageReference(raw json.RawMessage) (string, error) {
	trimmed := strings.TrimSpace(string(raw))
	if len(trimmed) > 0 && trimmed[0] == '"' {
		var value string
		if err := json.Unmarshal(raw, &value); err == nil {
			return value, nil
		}
	}
	var object struct {
		ImageURL string `json:"image_url"`
	}
	if err := json.Unmarshal(raw, &object); err == nil && object.ImageURL != "" {
		return object.ImageURL, nil
	}
	return "", requestError(
		"invalid_image_reference",
		"each image must be a data URL or an object with an image_url data URL",
	)
}

// parseDataURL 解析 data:<mime>;base64,<payload> 并校验媒体类型与字节一致。
func parseDataURL(dataURL string, limit int64, options Options) (Image, error) {
	text := strings.TrimSpace(dataURL)
	prefix, payload, found := splitDataURL(text)
	if !found {
		return Image{}, requestError(
			"invalid_image_data_url",
			"image must be a data URL with base64 payload",
		)
	}
	mimeType := imagedata.NormalizeMIME(prefix)
	if _, allowed := requestMIMEWhitelist[mimeType]; !allowed {
		return Image{}, requestError(
			"invalid_image_mime",
			fmt.Sprintf("unsupported image mime type: %s", strings.ToLower(strings.TrimSpace(prefix))),
		)
	}
	decoded, ok := imagedata.DecodeCanonicalBase64(payload)
	if !ok {
		return Image{}, requestError(
			"invalid_image_data_url",
			"image base64 payload is empty or invalid",
		)
	}
	maxBytes := resolveMaxBytes(limit, options)
	if int64(len(decoded.Bytes)) > maxBytes {
		return Image{}, requestError(
			"image_too_large",
			fmt.Sprintf("image exceeds %s limit", formatImageLimit(maxBytes)),
		)
	}
	detected := imagedata.DetectMIME(decoded.Bytes)
	if detected == "" {
		return Image{}, requestError(
			"invalid_image_data_url",
			"image base64 payload is not a supported image",
		)
	}
	if detected != mimeType {
		return Image{}, requestError(
			"invalid_image_mime",
			fmt.Sprintf(
				"declared image mime type %s does not match %s bytes",
				mimeType,
				detected,
			),
		)
	}
	return Image{MIME: mimeType, Data: decoded.Base64}, nil
}

// splitDataURL 拆分 data URL 的媒体类型与 base64 载荷。
//
// 与 Node 的 /^data:([^;,]+);base64,([\s\S]+)$/i 等价：媒体类型不能含 `;` 或 `,`，
// 载荷必须非空。
func splitDataURL(value string) (string, string, bool) {
	if len(value) < len("data:") || !strings.EqualFold(value[:5], "data:") {
		return "", "", false
	}
	rest := value[5:]
	separator := strings.Index(rest, ";base64,")
	if separator < 0 {
		return "", "", false
	}
	prefix := rest[:separator]
	payload := rest[separator+len(";base64,"):]
	if prefix == "" || payload == "" {
		return "", "", false
	}
	if strings.ContainsAny(prefix, ";,") {
		return "", "", false
	}
	return prefix, payload, true
}

// resolveMaxBytes 返回生效的字节上限。
func resolveMaxBytes(limit int64, options Options) int64 {
	if limit > 0 {
		return limit
	}
	if options.MaxImageBytes > 0 {
		return options.MaxImageBytes
	}
	return DefaultMaxImageBytes
}

// formatImageLimit 按 Node 的规则格式化上限说明。
func formatImageLimit(maxBytes int64) string {
	if maxBytes%(1024*1024) == 0 {
		return fmt.Sprintf("%d MiB", maxBytes/(1024*1024))
	}
	return fmt.Sprintf("%d byte", maxBytes)
}

// optionalEnum 归一化可选枚举值，缺失返回空串。
func optionalEnum(
	raw json.RawMessage,
	allowed []string,
	code string,
	detail string,
) (string, error) {
	if len(raw) == 0 || isJSONNull(raw) {
		return "", nil
	}
	normalized := strings.ToLower(trimmedString(raw))
	if !contains(allowed, normalized) {
		return "", requestError(code, detail)
	}
	return normalized, nil
}

// isValidSize 校验 size 形如 auto 或 1024x1024。
func isValidSize(value string) bool {
	if value == "auto" {
		return true
	}
	parts := strings.Split(value, "x")
	if len(parts) != 2 {
		return false
	}
	return isDigitRun(parts[0], 2, 5) && isDigitRun(parts[1], 2, 5)
}

// isDigitRun 判断字符串是否为指定长度区间的纯数字。
func isDigitRun(value string, minimum int, maximum int) bool {
	if len(value) < minimum || len(value) > maximum {
		return false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return false
		}
	}
	return true
}

// trimmedString 把 JSON 值还原成去空白的字符串；非字符串返回空串。
func trimmedString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

// rawString 把 JSON 值还原成未修剪的字符串；非字符串回退为空串。
func rawString(raw json.RawMessage) string {
	var value string
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return value
}

// jsNumber 复刻 JavaScript 的 Number(value) 强制转换。
//
// 必须复刻而不是要求严格 JSON 数字：Node 用 `Number(body.n)`，因此 `n: "2"` 会得到 2
// 并被接受，`n: true` 会得到 1。只认 JSON 数字会让 Go 与 Node 在同样的请求上给出
// 不同结果（Go 报 400、Node 正常处理）。
func jsNumber(raw json.RawMessage) (float64, bool) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" {
		return 0, false
	}
	switch {
	case trimmed == "true":
		return 1, true
	case trimmed == "false":
		return 0, true
	case trimmed == "null":
		return 0, true
	case trimmed[0] == '"':
		var text string
		if err := json.Unmarshal(raw, &text); err != nil {
			return 0, false
		}
		return parseJSNumberString(text)
	case trimmed[0] == '[' || trimmed[0] == '{':
		return 0, false
	}
	value, err := strconv.ParseFloat(trimmed, 64)
	if err != nil {
		return 0, false
	}
	return value, true
}

// parseJSNumberString 解析字符串形式的数字。
//
// JavaScript 的 Number(”) 是 0，Number('  12  ') 是 12，无法解析时为 NaN。
func parseJSNumberString(value string) (float64, bool) {
	text := strings.TrimSpace(value)
	if text == "" {
		return 0, true
	}
	parsed, err := strconv.ParseFloat(text, 64)
	if err != nil {
		return 0, false
	}
	return parsed, true
}

// isJSInteger 判断值是否为 JavaScript 意义上的整数。
func isJSInteger(value float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value == math.Trunc(value)
}

// isJSONNull 判断 JSON 值是否为 null。
func isJSONNull(raw json.RawMessage) bool {
	return strings.TrimSpace(string(raw)) == "null"
}

// contains 判断字符串切片是否包含目标值。
func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// requestError 创建 400 级请求错误。
func requestError(code string, detail string) *Error {
	return &Error{StatusCode: 400, Code: code, Detail: detail}
}

// AsError 把任意 error 还原成本包错误，便于上层取状态码与错误码。
func AsError(err error) (*Error, bool) {
	var requestErr *Error
	if errors.As(err, &requestErr) {
		return requestErr, true
	}
	return nil, false
}
