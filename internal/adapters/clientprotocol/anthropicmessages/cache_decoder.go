package anthropicmessages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// decodePromptCacheControl 解析标准 ttl 和 Claude Code 使用的可选 scope。
func decodePromptCacheControl(
	raw json.RawMessage,
	field string,
) (*inference.PromptCacheControl, error) {
	if !hasJSONValue(raw) {
		return nil, nil
	}
	wireControl, err := decodeStrict[cacheControlDTO](raw, field)
	if err != nil {
		return nil, err
	}
	if wireControl.Type != "ephemeral" {
		return nil, invalidField(field + ".type")
	}
	ttl := inference.PromptCacheTTLDefault
	if wireControl.TTL != nil {
		ttl = inference.PromptCacheTTL(*wireControl.TTL)
	}
	scope := inference.PromptCacheScopeDefault
	if wireControl.Scope != nil {
		scope = inference.PromptCacheScope(*wireControl.Scope)
	}
	control, controlErr := inference.NewPromptCacheControl(ttl, scope)
	if controlErr != nil {
		return nil, invalidField(field)
	}
	return &control, nil
}

// newMessageCacheBreakpoint 创建精确消息内容断点并保留字段路径。
func newMessageCacheBreakpoint(
	messageIndex uint32,
	contentIndex uint32,
	control *inference.PromptCacheControl,
	field string,
) (*inference.PromptCacheBreakpoint, error) {
	if control == nil {
		return nil, nil
	}
	breakpoint, err := inference.NewMessagePromptCacheBreakpoint(
		messageIndex,
		contentIndex,
		*control,
	)
	if err != nil {
		return nil, invalidField(field)
	}
	return &breakpoint, nil
}
