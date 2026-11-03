package images

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/imagegeneration"
)

// 本文件对应 Node 的 image-generation-stream.js：客户端要流式（stream: true）时，把一次已
// 完成的生图结果按 OpenAI Images 流式协议渲染成 SSE。
//
// 上游一律按非流式执行，所以只发「完成」事件、不发 partial_image 预览（partial_images 只是
// 「最多」几张预览，没有预览的流是合法流）。失败仍发生在写出任何字节之前，换号与 HTTP 错误码
// 与非流式完全一致。事件：生成 image_generation.completed / 编辑 image_edit.completed，每张图
// 一个；最后一个事件带 OpenAI 形状的 usage（上游给了时）。

// StreamOptions 声明流式事件的请求上下文。
type StreamOptions struct {
	Mode         Mode
	Size         string
	Quality      string
	Background   string
	OutputFormat string
	// Now 提供事件时间；为 nil 时使用 time.Now。
	Now func() time.Time
}

// streamEvent 是一个 OpenAI Images 流式完成事件。
//
// b64_json 是必填字段，事件结构里没有 url：流式只承载 base64，结构上就不可能降级成链接。
type streamEvent struct {
	Type         string          `json:"type"`
	B64JSON      string          `json:"b64_json"`
	CreatedAt    int64           `json:"created_at"`
	Size         string          `json:"size"`
	Quality      string          `json:"quality"`
	Background   string          `json:"background"`
	OutputFormat string          `json:"output_format"`
	Usage        json.RawMessage `json:"usage,omitempty"`
}

// mimeOutputFormats 把内联字节的媒体类型映射为 output_format。
var mimeOutputFormats = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpeg",
	"image/webp": "webp",
}

// RenderStream 把策略产出的图片渲染为 SSE 字节流。
func RenderStream(
	generated []GeneratedImage,
	usage json.RawMessage,
	options StreamOptions,
) ([]byte, error) {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	eventType := "image_generation.completed"
	if options.Mode == imagegeneration.ModeEdit {
		eventType = "image_edit.completed"
	}
	images := make([]GeneratedImage, 0, len(generated))
	for _, image := range generated {
		if image.B64JSON != "" || image.URL != "" || len(image.Rehosted) > 0 {
			images = append(images, image)
		}
	}
	if len(images) == 0 {
		// 零图不能在写出任何字节之后再暴露：那会变成「流开起来但永远没有完成事件」。
		// 与非流式保持同一语义，在写头之前就失败。
		return nil, newError(502, "invalid_image_output", "image generation returned no images")
	}
	openAIUsage := openAIShapedUsage(usage)
	var output bytes.Buffer
	for _, image := range images {
		event := streamEvent{
			Type:         eventType,
			CreatedAt:    now().Unix(),
			Size:         valueOr(options.Size, "auto"),
			Quality:      valueOr(options.Quality, "auto"),
			Background:   valueOr(options.Background, "auto"),
			OutputFormat: valueOr(options.OutputFormat, valueOr(mimeOutputFormats[strings.ToLower(image.MIME)], "png")),
		}
		switch {
		case image.B64JSON != "":
			event.B64JSON = image.B64JSON
		case len(image.Rehosted) > 0:
			// 对应 Node 的 image-generation-stream.js：取回的字节在这里变成 b64。
			event.B64JSON = base64.StdEncoding.EncodeToString(image.Rehosted)
		default:
			// 走到这里说明入口没有补齐字节：在写出任何字节之前失败，绝不发只有 url 的事件。
			return nil, newError(502, "image_output_unavailable", "streaming requires inline image bytes")
		}
		// 完成事件的 usage 是每个事件自带的字段，不是只在最后一个上。
		event.Usage = openAIUsage
		encoded, err := json.Marshal(event)
		if err != nil {
			return nil, err
		}
		output.WriteString("event: " + eventType + "\ndata: ")
		output.Write(encoded)
		output.WriteString("\n\n")
	}
	return output.Bytes(), nil
}

// openAIShapedUsage 只保留 OpenAI 形状的用量（Gemini 的 usageMetadata 不是这个形状）。
func openAIShapedUsage(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil
	}
	if _, found := fields["total_tokens"]; found {
		return raw
	}
	if _, found := fields["input_tokens"]; found {
		return raw
	}
	return openAIUsageFromGemini(fields)
}

// openAIUsageFromGemini 把 Gemini 的 usageMetadata 映射成 OpenAI 形状的用量。
//
// 原生 agy/gemini 策略回的是 usageMetadata（promptTokenCount / candidatesTokenCount /
// totalTokenCount），不映射的话这条主路径的流式事件永远没有 usage。
func openAIUsageFromGemini(fields map[string]json.RawMessage) json.RawMessage {
	read := func(names ...string) (int64, bool) {
		for _, name := range names {
			raw, found := fields[name]
			if !found {
				continue
			}
			var value int64
			if err := json.Unmarshal(raw, &value); err == nil {
				return value, true
			}
		}
		return 0, false
	}
	prompt, hasPrompt := read("promptTokenCount", "prompt_token_count")
	candidates, hasCandidates := read("candidatesTokenCount", "candidates_token_count")
	total, hasTotal := read("totalTokenCount", "total_token_count")
	if !hasPrompt && !hasCandidates && !hasTotal {
		return nil
	}
	if !hasTotal {
		total = prompt + candidates
	}
	converted, err := json.Marshal(map[string]int64{
		"input_tokens":  prompt,
		"output_tokens": candidates,
		"total_tokens":  total,
	})
	if err != nil {
		return nil
	}
	return converted
}
