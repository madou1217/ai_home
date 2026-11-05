package kirorelay

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// TransformResponse 把 AWS event-stream 转成客户端要的 OpenAI 形态。
//
// 语义事件 → OpenAI：
//   - 文本 → delta.content / 聚合后的 message.content
//   - 推理 → delta.reasoning_content（不混进正文）
//   - 工具调用 → delta.tool_calls（start/delta/done 三段拼装）
//   - 其它（计量/上下文占用）不直接暴露，留给上游记账
//
// 上游没有 token 用量帧，usage 只能按字符估算；这里**不算**，宁可不给也不编造。
func (provider *Provider) TransformResponse(
	response http.ResponseWriter,
	upstream *http.Response,
	streaming bool,
) (bool, error) {
	if upstream == nil || upstream.Body == nil {
		return false, nil
	}
	decoder := NewFrameDecoder()
	frameDecoder := NewDecoder(upstream.Body)
	model := provider.modelName()

	if streaming {
		headers := response.Header()
		headers.Set("Content-Type", "text/event-stream")
		headers.Set("Cache-Control", "no-cache")
		headers.Set("Connection", "keep-alive")
		flusher, _ := response.(http.Flusher)
		write := func(event Event) error {
			chunk := buildChunk(model, event)
			if chunk == "" {
				return nil
			}
			if _, err := fmt.Fprintf(response, "data: %s\n\n", chunk); err != nil {
				return err
			}
			if flusher != nil {
				flusher.Flush()
			}
			return nil
		}
		for {
			frame, err := frameDecoder.Next()
			if err != nil {
				break
			}
			for _, event := range decoder.Decode(frame) {
				if err := write(event); err != nil {
					return true, err
				}
			}
		}
		for _, event := range decoder.Flush() {
			if err := write(event); err != nil {
				return true, err
			}
		}
		if _, err := fmt.Fprint(response, "data: [DONE]\n\n"); err != nil {
			return true, err
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true, nil
	}

	var text strings.Builder
	var thinking strings.Builder
	for {
		frame, err := frameDecoder.Next()
		if err != nil {
			break
		}
		for _, event := range decoder.Decode(frame) {
			switch event.Type {
			case EventText:
				text.WriteString(event.Text)
			case EventThinking:
				thinking.WriteString(event.Text)
			}
		}
	}
	message := map[string]any{"role": "assistant", "content": text.String()}
	if thinking.Len() > 0 {
		message["reasoning_content"] = thinking.String()
	}
	payload := map[string]any{
		"id":      completionID(),
		"object":  "chat.completion",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index":         0,
			"message":       message,
			"finish_reason": "stop",
		}},
	}
	response.Header().Set("Content-Type", "application/json")
	encoded, err := json.Marshal(payload)
	if err != nil {
		return true, err
	}
	if _, err := response.Write(encoded); err != nil {
		return true, err
	}
	return true, nil
}

func (provider *Provider) modelName() string {
	if provider != nil && provider.model != "" {
		return provider.model
	}
	return "kiro"
}

func buildChunk(model string, event Event) string {
	var delta map[string]any
	switch event.Type {
	case EventText:
		delta = map[string]any{"content": event.Text}
	case EventThinking:
		delta = map[string]any{"reasoning_content": event.Text}
	case EventToolStart:
		delta = map[string]any{"tool_calls": []any{map[string]any{
			"index": event.Index,
			"id":    event.ID,
			"type":  "function",
			"function": map[string]any{
				"name":      event.Name,
				"arguments": "",
			},
		}}}
	case EventToolDelta:
		delta = map[string]any{"tool_calls": []any{map[string]any{
			"index": event.Index,
			"function": map[string]any{
				"arguments": event.Delta,
			},
		}}}
	default:
		return ""
	}
	payload := map[string]any{
		"id":      completionID(),
		"object":  "chat.completion.chunk",
		"created": time.Now().Unix(),
		"model":   model,
		"choices": []any{map[string]any{
			"index":         0,
			"delta":         delta,
			"finish_reason": nil,
		}},
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		return ""
	}
	return string(encoded)
}

func completionID() string {
	return fmt.Sprintf("chatcmpl-%d", time.Now().UnixNano())
}

var _ relaycore.ResponseTransformer = (*Provider)(nil)
