package messages

import (
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// encodeContents 按原始顺序编码消息内容并应用精确缓存断点。
func (encoder *requestEncoder) encodeContents(
	messageIndex uint32,
	contents []inference.Content,
) ([]contentDTO, error) {
	wireContents := make([]contentDTO, 0, len(contents))
	for contentIndex := 0; contentIndex < len(contents); {
		projected, consumed, handled := encoder.projectCompatibleThinking(
			contents[contentIndex:],
		)
		if handled {
			if projected != nil {
				wireContents = append(wireContents, *projected)
			}
			contentIndex += consumed
			continue
		}

		content := contents[contentIndex]
		cacheControl := encoder.cache.cacheControlAt(
			messageIndex,
			uint32(contentIndex),
		)
		wire, err := encoder.encodeContent(content, cacheControl)
		if err != nil {
			return nil, err
		}
		if wire.CacheControl != nil && wire.CacheControl.Scope != "" {
			encoder.addBeta(betaPromptCachingScope)
		}
		wireContents = append(wireContents, wire)
		contentIndex++
	}
	return wireContents, nil
}

// projectCompatibleThinking 把相邻 summary 和 opaque carrier 作为一个整体处理；
// 只有可验证的 Claude signature 才能重建原生 thinking。
func (encoder *requestEncoder) projectCompatibleThinking(
	contents []inference.Content,
) (*contentDTO, int, bool) {
	var thinking strings.Builder
	consumed := 0
	for consumed < len(contents) {
		reasoning, ok := contents[consumed].(inference.ReasoningContent)
		if !ok || reasoning.ReasoningKind() != inference.ReasoningSummary {
			break
		}
		thinking.WriteString(reasoning.Text())
		consumed++
	}

	if consumed < len(contents) {
		reasoning, ok := contents[consumed].(inference.ReasoningContent)
		if ok && reasoning.ReasoningKind() == inference.ReasoningEncrypted {
			consumed++
			signature, compatible := normalizeClaudeThinkingSignature(
				reasoning.EncryptedData(),
			)
			if !compatible {
				return nil, consumed, true
			}
			encoder.addBeta(betaInterleavedThinking)
			text := thinking.String()
			return &contentDTO{
				Type:      "thinking",
				Thinking:  &text,
				Signature: signature,
			}, consumed, true
		}
	}
	if consumed > 0 {
		// 可见摘要本身不是 Claude 可回放 thinking；缺少原生签名时交给
		// 严格编码路径显式拒绝，避免静默丢失客户端历史。
		return nil, 0, false
	}
	return nil, 0, false
}

// encodeContent 分派封闭 Canonical Content 联合类型。
func (encoder *requestEncoder) encodeContent(
	content inference.Content,
	cacheControl *inference.PromptCacheControl,
) (contentDTO, error) {
	wireCache := encodeCacheControl(cacheControl)
	switch typed := content.(type) {
	case inference.TextContent:
		return contentDTO{
			Type:         "text",
			Text:         typed.Text(),
			CacheControl: wireCache,
		}, nil
	case inference.RefusalContent:
		// Anthropic 历史输入没有 refusal 类型；作为 assistant 可见文本回传
		// 不改变模型上下文语义，也不会伪造成新的输出分类。
		return contentDTO{
			Type:         "text",
			Text:         typed.Refusal(),
			CacheControl: wireCache,
		}, nil
	case inference.ImageContent:
		encoder.addMediaSourceBeta(typed.Source())
		return encodeImageContent(typed, wireCache)
	case inference.DocumentContent:
		encoder.addMediaSourceBeta(typed.Source())
		return encodeDocumentContent(typed, wireCache)
	case inference.ToolCallContent:
		wireName, err := encoder.toolNames.encode(typed.Identity())
		if err != nil {
			return contentDTO{}, err
		}
		return contentDTO{
			Type:         "tool_use",
			ID:           typed.CallID(),
			Name:         wireName,
			Input:        json.RawMessage(typed.Arguments()),
			CacheControl: wireCache,
		}, nil
	case inference.ToolResultContent:
		return encoder.encodeToolResultContent(typed, wireCache)
	case inference.ReasoningContent:
		if wireCache != nil {
			return contentDTO{}, ErrUnsupportedRequest
		}
		return encoder.encodeReasoningContent(typed)
	default:
		return contentDTO{}, ErrUnsupportedRequest
	}
}

// encodeImageContent 保留 Base64、URL 或文件引用，不下载媒体。
func encodeImageContent(
	content inference.ImageContent,
	cacheControl *cacheControlDTO,
) (contentDTO, error) {
	if content.Detail() != inference.ImageDetailAuto {
		return contentDTO{}, ErrUnsupportedRequest
	}
	source, err := encodeImageSource(content.Source())
	if err != nil {
		return contentDTO{}, err
	}
	return contentDTO{
		Type:         "image",
		Source:       source,
		CacheControl: cacheControl,
	}, nil
}

// encodeImageSource 限制到 Anthropic Messages 明确支持的图片来源。
func encodeImageSource(source inference.MediaSource) (*sourceDTO, error) {
	switch source.Kind() {
	case inference.MediaSourceBase64:
		if !isAnthropicImageMediaType(source.MediaType()) {
			return nil, ErrUnsupportedRequest
		}
		return &sourceDTO{
			Type:      "base64",
			MediaType: source.MediaType(),
			Data:      source.Value(),
		}, nil
	case inference.MediaSourceURL:
		return &sourceDTO{Type: "url", URL: source.Value()}, nil
	case inference.MediaSourceFileID:
		return &sourceDTO{Type: "file", FileID: source.Value()}, nil
	default:
		return nil, ErrUnsupportedRequest
	}
}

// isAnthropicImageMediaType 校验 Messages 当前公开图片 MIME。
func isAnthropicImageMediaType(value string) bool {
	switch value {
	case "image/jpeg", "image/png", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

// encodeDocumentContent 保留 PDF、纯文本或文件引用文档。
func encodeDocumentContent(
	content inference.DocumentContent,
	cacheControl *cacheControlDTO,
) (contentDTO, error) {
	if content.Detail() != inference.DocumentDetailAuto {
		return contentDTO{}, ErrUnsupportedRequest
	}
	source, err := encodeDocumentSource(content.Source())
	if err != nil {
		return contentDTO{}, err
	}
	return contentDTO{
		Type:         "document",
		Source:       source,
		Title:        content.Title(),
		CacheControl: cacheControl,
	}, nil
}

// encodeDocumentSource 限制到 Messages 可无损接收的文档来源。
func encodeDocumentSource(
	source inference.MediaSource,
) (*sourceDTO, error) {
	switch source.Kind() {
	case inference.MediaSourceBase64:
		if source.MediaType() != "application/pdf" {
			return nil, ErrUnsupportedRequest
		}
		return &sourceDTO{
			Type:      "base64",
			MediaType: source.MediaType(),
			Data:      source.Value(),
		}, nil
	case inference.MediaSourceURL:
		if source.MediaType() != "" &&
			source.MediaType() != "application/pdf" {
			return nil, ErrUnsupportedRequest
		}
		return &sourceDTO{Type: "url", URL: source.Value()}, nil
	case inference.MediaSourceText:
		if source.MediaType() != "text/plain" {
			return nil, ErrUnsupportedRequest
		}
		return &sourceDTO{
			Type:      "text",
			MediaType: source.MediaType(),
			Data:      source.Value(),
		}, nil
	case inference.MediaSourceFileID:
		return &sourceDTO{Type: "file", FileID: source.Value()}, nil
	default:
		return nil, ErrUnsupportedRequest
	}
}

// encodeToolResultContent 编码工具结果外层和其受限内容。
func (encoder *requestEncoder) encodeToolResultContent(
	content inference.ToolResultContent,
	cacheControl *cacheControlDTO,
) (contentDTO, error) {
	payload := content.Contents()
	wirePayload := make([]contentDTO, len(payload))
	for index, nested := range payload {
		wire, err := encoder.encodeToolResultPayload(nested)
		if err != nil {
			return contentDTO{}, err
		}
		wirePayload[index] = wire
	}
	var isError *bool
	if content.IsError() {
		value := true
		isError = &value
	}
	return contentDTO{
		Type:         "tool_result",
		ToolUseID:    content.CallID(),
		Content:      wirePayload,
		IsError:      isError,
		CacheControl: cacheControl,
	}, nil
}

// encodeToolResultPayload 只接受领域层允许的文本、图片和文档。
func (encoder *requestEncoder) encodeToolResultPayload(
	content inference.Content,
) (contentDTO, error) {
	switch typed := content.(type) {
	case inference.TextContent:
		return contentDTO{Type: "text", Text: typed.Text()}, nil
	case inference.ImageContent:
		encoder.addMediaSourceBeta(typed.Source())
		return encodeImageContent(typed, nil)
	case inference.DocumentContent:
		encoder.addMediaSourceBeta(typed.Source())
		return encodeDocumentContent(typed, nil)
	default:
		return contentDTO{}, ErrUnsupportedRequest
	}
}

// addMediaSourceBeta 为 Files API 引用声明精确协议版本。
func (encoder *requestEncoder) addMediaSourceBeta(
	source inference.MediaSource,
) {
	if source.Kind() == inference.MediaSourceFileID {
		encoder.addBeta(betaFilesAPI)
	}
}

// encodeReasoningContent 原样回传 signed 或 redacted thinking 连续性。
func (encoder *requestEncoder) encodeReasoningContent(
	content inference.ReasoningContent,
) (contentDTO, error) {
	encoder.addBeta(betaInterleavedThinking)
	switch content.ReasoningKind() {
	case inference.ReasoningThinking:
		thinking := content.Text()
		return contentDTO{
			Type:      "thinking",
			Thinking:  &thinking,
			Signature: content.Signature(),
		}, nil
	case inference.ReasoningRedacted:
		return contentDTO{
			Type: "redacted_thinking",
			Data: content.RedactedData(),
		}, nil
	default:
		return contentDTO{}, ErrUnsupportedRequest
	}
}
