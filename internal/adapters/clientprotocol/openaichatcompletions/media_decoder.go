package openaichatcompletions

import (
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// decodeImageSource 保留 HTTP URL 或 Base64 data URL，不执行网络下载。
func decodeImageSource(value string, field string) (inference.MediaSource, error) {
	if strings.HasPrefix(value, "data:") {
		return decodeImageDataURL(value, field)
	}
	source, err := inference.NewURLMediaSource(value, "")
	if err != nil {
		return inference.MediaSource{}, invalidField(field)
	}
	return source, nil
}

// decodeImageDataURL 将 Base64 data URL 拆为 MIME 类型和纯数据。
func decodeImageDataURL(value string, field string) (inference.MediaSource, error) {
	header, data, found := strings.Cut(value, ",")
	if !found ||
		!strings.HasPrefix(header, "data:image/") ||
		!strings.HasSuffix(header, ";base64") {
		return inference.MediaSource{}, invalidField(field)
	}
	mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	source, err := inference.NewBase64MediaSource(mediaType, data)
	if err != nil {
		return inference.MediaSource{}, invalidField(field)
	}
	return source, nil
}
