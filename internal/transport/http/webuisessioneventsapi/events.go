package webuisessioneventsapi

import (
	"bytes"
	"encoding/json"
)

// MarshalJSON 按事件类型输出字段，字段顺序与 Node 的对象字面量一致。
func (event Event) MarshalJSON() ([]byte, error) {
	switch event.Kind {
	case "user_message":
		images := event.Images
		if images == nil {
			images = []string{}
		}
		return marshalEventJSON(struct {
			Type      string   `json:"type"`
			Timestamp any      `json:"timestamp"`
			Content   string   `json:"content"`
			Images    []string `json:"images"`
			Source    string   `json:"source,omitempty"`
			Model     string   `json:"model,omitempty"`
		}{Type: event.Kind, Timestamp: event.Timestamp, Content: event.Content, Images: images, Source: event.Source, Model: event.Model})
	case "assistant_reasoning", "assistant_text":
		return marshalEventJSON(struct {
			Type      string `json:"type"`
			Timestamp any    `json:"timestamp,omitempty"`
			Text      string `json:"text"`
			Model     string `json:"model,omitempty"`
		}{Type: event.Kind, Timestamp: event.Timestamp, Text: event.Text, Model: event.Model})
	default:
		// assistant_tool_call / assistant_tool_result 共用 {type, timestamp, callId, content}。
		return marshalEventJSON(struct {
			Type      string `json:"type"`
			Timestamp any    `json:"timestamp,omitempty"`
			CallID    any    `json:"callId,omitempty"`
			Content   string `json:"content"`
			Model     string `json:"model,omitempty"`
		}{Type: event.Kind, Timestamp: event.Timestamp, CallID: event.CallID, Content: event.Content, Model: event.Model})
	}
}

// marshalEventJSON 与 Node JSON.stringify 同口径：不把 < > & 转成 \u003c 之类的实体。
func marshalEventJSON(value any) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buffer.Bytes(), []byte("\n")), nil
}
