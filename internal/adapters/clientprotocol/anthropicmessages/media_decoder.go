package anthropicmessages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// decodeImageContent 解析 Anthropic 支持的 Base64 或 URL 图片。
func decodeImageContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[imageContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	if wireContent.Type != "image" {
		return decodedContent{}, invalidField(field + ".type")
	}
	source, err := decodeImageSource(wireContent.Source, field+".source")
	if err != nil {
		return decodedContent{}, err
	}
	content, contentErr := inference.NewImageContent(source, inference.ImageDetailAuto)
	if contentErr != nil {
		return decodedContent{}, invalidField(field)
	}
	cacheControl, err := decodePromptCacheControl(
		wireContent.CacheControl,
		field+".cache_control",
	)
	if err != nil {
		return decodedContent{}, err
	}
	return decodedContent{content: content, cacheControl: cacheControl}, nil
}

// decodeImageSource 保留图片来源，不下载或重新编码媒体数据。
func decodeImageSource(raw json.RawMessage, field string) (inference.MediaSource, error) {
	header, err := decodeHeader[sourceHeaderDTO](raw, field)
	if err != nil {
		return inference.MediaSource{}, err
	}
	switch header.Type {
	case "base64":
		wireSource, err := decodeStrict[base64SourceDTO](raw, field)
		if err != nil {
			return inference.MediaSource{}, err
		}
		if !isAnthropicImageMediaType(wireSource.MediaType) {
			return inference.MediaSource{}, invalidField(field + ".media_type")
		}
		source, sourceErr := inference.NewBase64MediaSource(
			wireSource.MediaType,
			wireSource.Data,
		)
		if sourceErr != nil {
			return inference.MediaSource{}, invalidField(field)
		}
		return source, nil
	case "url":
		wireSource, err := decodeStrict[urlSourceDTO](raw, field)
		if err != nil {
			return inference.MediaSource{}, err
		}
		source, sourceErr := inference.NewURLMediaSource(wireSource.URL, "")
		if sourceErr != nil {
			return inference.MediaSource{}, invalidField(field + ".url")
		}
		return source, nil
	default:
		return inference.MediaSource{}, unsupportedField(field + ".type")
	}
}

// isAnthropicImageMediaType 限制到 Messages API 当前公开支持的图片 MIME。
func isAnthropicImageMediaType(value string) bool {
	switch value {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

// decodeDocumentContent 解析 PDF、URL 或纯文本文档。
func decodeDocumentContent(raw json.RawMessage, field string) (decodedContent, error) {
	wireContent, err := decodeStrict[documentContentDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	switch {
	case wireContent.Type != "document":
		return decodedContent{}, invalidField(field + ".type")
	case wireContent.Context != nil:
		return decodedContent{}, unsupportedField(field + ".context")
	case hasJSONValue(wireContent.Citations):
		return decodedContent{}, unsupportedField(field + ".citations")
	}
	source, err := decodeDocumentSource(wireContent.Source, field+".source")
	if err != nil {
		return decodedContent{}, err
	}
	title := ""
	if wireContent.Title != nil {
		title = *wireContent.Title
	}
	content, contentErr := inference.NewDocumentContent(source, title)
	if contentErr != nil {
		return decodedContent{}, invalidField(field)
	}
	cacheControl, err := decodePromptCacheControl(
		wireContent.CacheControl,
		field+".cache_control",
	)
	if err != nil {
		return decodedContent{}, err
	}
	return decodedContent{content: content, cacheControl: cacheControl}, nil
}

// decodeDocumentSource 保留 PDF 或纯文本文档的来源类别。
func decodeDocumentSource(raw json.RawMessage, field string) (inference.MediaSource, error) {
	header, err := decodeHeader[sourceHeaderDTO](raw, field)
	if err != nil {
		return inference.MediaSource{}, err
	}
	switch header.Type {
	case "base64":
		wireSource, err := decodeStrict[base64SourceDTO](raw, field)
		if err != nil {
			return inference.MediaSource{}, err
		}
		if wireSource.MediaType != "application/pdf" {
			return inference.MediaSource{}, invalidField(field + ".media_type")
		}
		source, sourceErr := inference.NewBase64MediaSource(
			wireSource.MediaType,
			wireSource.Data,
		)
		if sourceErr != nil {
			return inference.MediaSource{}, invalidField(field)
		}
		return source, nil
	case "url":
		wireSource, err := decodeStrict[urlSourceDTO](raw, field)
		if err != nil {
			return inference.MediaSource{}, err
		}
		source, sourceErr := inference.NewURLMediaSource(
			wireSource.URL,
			"application/pdf",
		)
		if sourceErr != nil {
			return inference.MediaSource{}, invalidField(field + ".url")
		}
		return source, nil
	case "text":
		wireSource, err := decodeStrict[textSourceDTO](raw, field)
		if err != nil {
			return inference.MediaSource{}, err
		}
		if wireSource.MediaType != "text/plain" {
			return inference.MediaSource{}, invalidField(field + ".media_type")
		}
		source, sourceErr := inference.NewTextMediaSource(
			wireSource.MediaType,
			wireSource.Data,
		)
		if sourceErr != nil {
			return inference.MediaSource{}, invalidField(field)
		}
		return source, nil
	default:
		return inference.MediaSource{}, unsupportedField(field + ".type")
	}
}
