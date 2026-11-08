package sessionchat

import (
	"bytes"
	"encoding/json"
	"strings"
)

// claudeImageMediaTypes 是 claude stream-json 支持的图片媒体类型（按扩展名）。
var claudeImageMediaTypes = map[string]string{
	"png":  "image/png",
	"jpg":  "image/jpeg",
	"jpeg": "image/jpeg",
	"gif":  "image/gif",
	"webp": "image/webp",
}

// DetectImageMediaType 按路径扩展名推断图片媒体类型；未知扩展名回落 image/png。
func DetectImageMediaType(imagePath string) string {
	lowered := strings.ToLower(imagePath)
	extension := lowered
	if index := strings.LastIndex(lowered, "."); index >= 0 {
		extension = lowered[index+1:]
	}
	if mediaType, found := claudeImageMediaTypes[extension]; found {
		return mediaType
	}
	return "image/png"
}

// ImageAttachment 是一条待送入 claude 的 base64 图片。
//
// Node 侧负责读文件与 base64 编码（I/O），Go 侧只负责消息组装。
type ImageAttachment struct {
	MediaType string
	Base64    string
}

// streamJSONTextBlock 是 user 消息里的文本块。
type streamJSONTextBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// streamJSONImageSource 是图片块的 source。
type streamJSONImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// streamJSONImageBlock 是 user 消息里的图片块。
type streamJSONImageBlock struct {
	Type   string                `json:"type"`
	Source streamJSONImageSource `json:"source"`
}

// streamJSONMessageBody 是 user 消息的 message 字段。
type streamJSONMessageBody struct {
	Role    string `json:"role"`
	Content []any  `json:"content"`
}

// streamJSONUserMessage 是 claude --input-format stream-json 的一行用户消息。
type streamJSONUserMessage struct {
	Type    string                `json:"type"`
	Message streamJSONMessageBody `json:"message"`
}

// BuildClaudeStreamJSONUserMessage 组装一行 JSONL 用户消息（文本块 + base64 图片块）。
//
// claude 新版 CLI 接图片输入的唯一方式是 --input-format stream-json；codex 那种
// -i <path> 对 claude 无效。prompt 为空且没有图片时仍送一个空文本块。
func BuildClaudeStreamJSONUserMessage(prompt string, images []ImageAttachment) string {
	content := make([]any, 0, len(images)+1)
	if strings.TrimSpace(prompt) != "" {
		content = append(content, streamJSONTextBlock{Type: "text", Text: prompt})
	}
	for _, image := range images {
		if strings.TrimSpace(image.Base64) == "" {
			continue
		}
		content = append(content, streamJSONImageBlock{
			Type: "image",
			Source: streamJSONImageSource{
				Type:      "base64",
				MediaType: image.MediaType,
				Data:      image.Base64,
			},
		})
	}
	if len(content) == 0 {
		content = append(content, streamJSONTextBlock{Type: "text", Text: prompt})
	}
	message := streamJSONUserMessage{
		Type:    "user",
		Message: streamJSONMessageBody{Role: "user", Content: content},
	}
	// 不转义 HTML 字符，与 JSON.stringify 的字节形态保持一致。
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(message); err != nil {
		// 结构体字段全部是可编码类型，失败只可能是内存错误；返回空串让调用方失败关闭。
		return ""
	}
	return buffer.String()
}
