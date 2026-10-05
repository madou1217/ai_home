package anthropicmessages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// 对话中途的工具增删（beta mid-conversation-tool-changes-2026-07-01），只出现在 system 消息里：
//
//	{"type":"tool_addition","tool":{"type":"tool_definition","definition":{…custom tool…}}}
//	{"type":"tool_removal","tool":{"type":"tool_reference","name":"…"}}
//
// 定义按顶层 tools 的同一规则解码；Canonical 无法表达的工具（例如 Anthropic 服务端工具）
// 与未知字段按拒收处理，由 Node 原样透传。

type toolChangeDTO struct {
	Type         string          `json:"type"`
	Tool         json.RawMessage `json:"tool"`
	CacheControl json.RawMessage `json:"cache_control"`
}

type toolDefinitionRefDTO struct {
	Type       string          `json:"type"`
	Definition json.RawMessage `json:"definition"`
}

type toolReferenceDTO struct {
	Type string `json:"type"`
	Name string `json:"name"`
}

func decodeToolChangeContent(raw json.RawMessage, role inference.Role, field string) (decodedContent, error) {
	if role != inference.RoleSystem {
		return decodedContent{}, invalidField(field)
	}
	wire, err := decodeStrict[toolChangeDTO](raw, field)
	if err != nil {
		return decodedContent{}, err
	}
	cacheControl, err := decodePromptCacheControl(wire.CacheControl, field+".cache_control")
	if err != nil {
		return decodedContent{}, err
	}
	var content inference.ToolChangeContent
	switch wire.Type {
	case "tool_addition":
		reference, refErr := decodeStrict[toolDefinitionRefDTO](wire.Tool, field+".tool")
		if refErr != nil {
			return decodedContent{}, refErr
		}
		if reference.Type != "tool_definition" || !hasJSONValue(reference.Definition) {
			return decodedContent{}, unsupportedField(field + ".tool.type")
		}
		tools, _, toolsErr := decodeTools([]json.RawMessage{reference.Definition})
		if toolsErr != nil {
			return decodedContent{}, toolsErr
		}
		if len(tools) != 1 {
			return decodedContent{}, unsupportedField(field + ".tool.definition")
		}
		content, err = inference.NewToolAddition(tools[0])
	case "tool_removal":
		reference, refErr := decodeStrict[toolReferenceDTO](wire.Tool, field+".tool")
		if refErr != nil {
			return decodedContent{}, refErr
		}
		if reference.Type != "tool_reference" {
			return decodedContent{}, unsupportedField(field + ".tool.type")
		}
		content, err = inference.NewToolRemoval(reference.Name)
	default:
		return decodedContent{}, unsupportedField(field + ".type")
	}
	if err != nil {
		return decodedContent{}, invalidField(field + ".tool")
	}
	return decodedContent{content: content, cacheControl: cacheControl}, nil
}
