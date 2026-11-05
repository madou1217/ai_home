package kirorelay

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

// defaultContinuePrompt 用于补齐「必须以 user 轮结尾」的会话形状（与 Node 同值）。
const defaultContinuePrompt = "Continue."

// Message 是编码所需的最小 OpenAI 消息投影。
type Message struct {
	Role    string
	Content string
	// HasImages 表示消息里含图片 part；当前 Go 侧尚未实现图片方言，按降级处理。
	HasImages bool
}

// EncodeOptions 是会话编码的外部事实。
type EncodeOptions struct {
	// ConversationID 为空时随机生成；调用方通常传会话键派生值。
	ConversationID string
	// ModelID 是上游 modelId（默认取请求的 model）。
	ModelID string
	// ToolCount 是请求声明的工具数；Go 侧暂不支持工具方言，按降级上报。
	ToolCount int
}

// EncodedConversation 是编码结果。
type EncodedConversation struct {
	// Body 是上游 conversationState 所在的对象（JSON 可序列化）。
	Body map[string]any
	// Degradations 是本端丢掉的语义（relaycore 会如实回给客户端）。
	Degradations []string
	// PromptText 是给 usage 估算用的纯文本（上游没有 token 数）。
	PromptText string
}

// EncodeConversation 把 OpenAI chat 消息编码成 CodeWhisperer 的 conversationState。
//
// 与 Node 的 kiro-dialect 同语义，但**显式降级**：工具/图片方言尚未迁移时返回
// Degradations，而不是静默丢掉（Node 的老实现把这些混在编码函数里，丢没丢看不出来）。
func EncodeConversation(messages []Message, options EncodeOptions) EncodedConversation {
	turns := make([]Message, 0, len(messages)+2)
	systemParts := make([]string, 0, 2)
	for _, message := range messages {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		content := strings.TrimSpace(message.Content)
		switch role {
		case "system", "developer":
			if content != "" {
				systemParts = append(systemParts, content)
			}
		case "user", "assistant":
			turns = append(turns, Message{Role: role, Content: content, HasImages: message.HasImages})
		default:
			if content != "" {
				turns = append(turns, Message{Role: "user", Content: content, HasImages: message.HasImages})
			}
		}
	}
	if len(systemParts) > 0 {
		system := strings.Join(systemParts, "\n\n")
		folded := false
		for index := range turns {
			if turns[index].Role != "user" {
				continue
			}
			if turns[index].Content != "" {
				turns[index].Content = system + "\n\n" + turns[index].Content
			} else {
				turns[index].Content = system
			}
			folded = true
			break
		}
		if !folded {
			turns = append([]Message{{Role: "user", Content: system}}, turns...)
		}
	}
	// history 必须从 user 轮开始。
	if len(turns) > 0 && turns[0].Role != "user" {
		turns = append([]Message{{Role: "user", Content: defaultContinuePrompt}}, turns...)
	}
	// currentMessage 必须是 userInputMessage：末轮是 assistant 时补续写指令。
	if len(turns) == 0 || turns[len(turns)-1].Role != "user" {
		turns = append(turns, Message{Role: "user", Content: defaultContinuePrompt})
	}

	modelID := strings.TrimSpace(options.ModelID)
	conversationID := strings.TrimSpace(options.ConversationID)
	if conversationID == "" {
		conversationID = newUUID()
	}
	degradations := make([]string, 0, 2)
	hasImages := false
	for _, turn := range turns {
		if turn.HasImages {
			hasImages = true
			break
		}
	}
	if hasImages {
		degradations = append(degradations, "images_unsupported")
	}
	if options.ToolCount > 0 {
		degradations = append(degradations, "tools_unsupported")
	}

	encodeUser := func(turn Message) map[string]any {
		context := map[string]any{}
		message := map[string]any{
			"content":                 turn.Content,
			"userInputMessageContext": context,
			"origin":                  "AI_EDITOR",
		}
		if modelID != "" {
			message["modelId"] = modelID
		}
		return map[string]any{"userInputMessage": message}
	}
	encodeAssistant := func(turn Message) map[string]any {
		return map[string]any{"assistantResponseMessage": map[string]any{"content": turn.Content}}
	}

	history := make([]any, 0, len(turns)-1)
	promptParts := make([]string, 0, len(turns))
	for _, turn := range turns[:len(turns)-1] {
		if turn.Role == "assistant" {
			history = append(history, encodeAssistant(turn))
		} else {
			history = append(history, encodeUser(turn))
		}
		promptParts = append(promptParts, turn.Content)
	}
	last := turns[len(turns)-1]
	promptParts = append(promptParts, last.Content)

	conversationState := map[string]any{
		"chatTriggerType": "MANUAL",
		"conversationId":  conversationID,
		"currentMessage":  encodeUser(last),
	}
	if len(history) > 0 {
		conversationState["history"] = history
	}
	return EncodedConversation{
		Body:         map[string]any{"conversationState": conversationState},
		Degradations: degradations,
		PromptText:   strings.Join(promptParts, "\n"),
	}
}

func newUUID() string {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return ""
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	hexed := hex.EncodeToString(bytes[:])
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexed[0:8], hexed[8:12], hexed[12:16], hexed[16:20], hexed[20:32])
}
