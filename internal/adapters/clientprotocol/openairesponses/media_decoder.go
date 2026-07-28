package openairesponses

import (
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// decodeImageContent 解析 file_id、HTTP URL 或 Base64 data URL 图片。
func decodeImageContent(raw json.RawMessage, field string) (inference.Content, error) {
	wireImage, err := decodeStrict[imageContentDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireImage.Type != "input_image" {
		return nil, invalidField(field + ".type")
	}
	if hasJSONValue(wireImage.PromptCacheBreakpoint) {
		return nil, unsupportedField(field + ".prompt_cache_breakpoint")
	}
	source, err := decodeSingleMediaSource(
		wireImage.FileID,
		wireImage.ImageURL,
		"",
		field,
	)
	if err != nil {
		return nil, err
	}
	detail := inference.ImageDetail(wireImage.Detail)
	if detail == "" {
		detail = inference.ImageDetailAuto
	}
	content, contentErr := inference.NewImageContent(source, detail)
	if contentErr != nil {
		return nil, invalidField(field)
	}
	return content, nil
}

// decodeFileContent 解析 file_id、HTTP URL 或带 MIME 的 Base64 data URL 文档。
func decodeFileContent(raw json.RawMessage, field string) (inference.Content, error) {
	wireFile, err := decodeStrict[fileContentDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireFile.Type != "input_file" {
		return nil, invalidField(field + ".type")
	}
	if hasJSONValue(wireFile.PromptCacheBreakpoint) {
		return nil, unsupportedField(field + ".prompt_cache_breakpoint")
	}
	source, err := decodeSingleMediaSource(
		wireFile.FileID,
		wireFile.FileURL,
		wireFile.FileData,
		field,
	)
	if err != nil {
		return nil, err
	}
	detail := inference.DocumentDetail(wireFile.Detail)
	if detail == "" {
		detail = inference.DocumentDetailAuto
	}
	content, contentErr := inference.NewDetailedDocumentContent(
		source,
		wireFile.Filename,
		detail,
	)
	if contentErr != nil {
		return nil, invalidField(field)
	}
	return content, nil
}

// decodeSingleMediaSource 要求 file_id、URL 和内联数据恰好提供一个。
func decodeSingleMediaSource(
	fileID string,
	rawURL string,
	fileData string,
	field string,
) (inference.MediaSource, error) {
	sourceCount := 0
	for _, value := range []string{fileID, rawURL, fileData} {
		if value != "" {
			sourceCount++
		}
	}
	if sourceCount != 1 {
		return inference.MediaSource{}, invalidField(field)
	}
	switch {
	case fileID != "":
		source, err := inference.NewFileIDMediaSource(fileID)
		if err != nil {
			return inference.MediaSource{}, invalidField(field + ".file_id")
		}
		return source, nil
	case rawURL != "":
		if strings.HasPrefix(rawURL, "data:") {
			return decodeDataURL(rawURL, field)
		}
		source, err := inference.NewURLMediaSource(rawURL, "")
		if err != nil {
			return inference.MediaSource{}, invalidField(field)
		}
		return source, nil
	default:
		return decodeDataURL(fileData, field+".file_data")
	}
}

// decodeDataURL 将 Base64 data URL 拆为 MIME 类型和纯 Base64 数据。
func decodeDataURL(value string, field string) (inference.MediaSource, error) {
	header, data, found := strings.Cut(value, ",")
	if !found || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(header, ";base64") {
		return inference.MediaSource{}, invalidField(field)
	}
	mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	source, err := inference.NewBase64MediaSource(mediaType, data)
	if err != nil {
		return inference.MediaSource{}, invalidField(field)
	}
	return source, nil
}
