package messages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// encodeToolChange 把对话中途的工具增删写回 Messages 线协议（只出现在 system 消息里）：
//
//	{"type":"tool_addition","tool":{"type":"tool_definition","definition":{…}}}
//	{"type":"tool_addition","tool":{"type":"tool_reference","name":"…"}}
//	{"type":"tool_removal","tool":{"type":"tool_reference","name":"…"}}
//
// 并声明 Claude Code 同样声明的 mid-conversation-tool-changes beta。
func (encoder *requestEncoder) encodeToolChange(
	change inference.ToolChangeContent,
	cacheControl *cacheControlDTO,
) (contentDTO, error) {
	var payload any
	switch change.Change() {
	case inference.ToolChangeAddition:
		definition, byValue := change.Definition()
		if !byValue {
			payload = map[string]any{"type": "tool_reference", "name": change.ReferencedName()}
			break
		}
		encoded, err := encoder.encodeToolDefinition(definition, nil)
		if err != nil {
			return contentDTO{}, err
		}
		payload = map[string]any{"type": "tool_definition", "definition": encoded}
	case inference.ToolChangeRemoval:
		payload = map[string]any{"type": "tool_reference", "name": change.RemovedName()}
	default:
		return contentDTO{}, ErrUnsupportedRequest
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return contentDTO{}, ErrUnsupportedRequest
	}
	encoder.addBeta(betaMidConvToolChanges)
	contentType := "tool_addition"
	if change.Change() == inference.ToolChangeRemoval {
		contentType = "tool_removal"
	}
	return contentDTO{Type: contentType, Tool: raw, CacheControl: cacheControl}, nil
}
