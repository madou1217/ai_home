package messages

import "github.com/madou1217/ai_home/core/inference"

// cachePosition 唯一标识 Canonical 消息内容块。
type cachePosition struct {
	messageIndex uint32
	contentIndex uint32
}

// cacheLayout 保存已经按目标建立索引的缓存控制。
type cacheLayout struct {
	request  *inference.PromptCacheControl
	messages map[cachePosition]inference.PromptCacheControl
	tools    map[uint32]inference.PromptCacheControl
}

// newCacheLayout 把小规模断点切片转为编码阶段的常数时间查询。
func newCacheLayout(
	breakpoints []inference.PromptCacheBreakpoint,
) (cacheLayout, error) {
	layout := cacheLayout{
		messages: make(map[cachePosition]inference.PromptCacheControl),
		tools:    make(map[uint32]inference.PromptCacheControl),
	}
	for _, breakpoint := range breakpoints {
		control := breakpoint.Control()
		if !breakpoint.IsValid() || !control.IsValid() {
			return cacheLayout{}, ErrUnsupportedRequest
		}
		switch breakpoint.Target() {
		case inference.PromptCacheTargetRequest:
			value := control
			layout.request = &value
		case inference.PromptCacheTargetMessageContent:
			layout.messages[cachePosition{
				messageIndex: breakpoint.MessageIndex(),
				contentIndex: breakpoint.ContentIndex(),
			}] = control
		case inference.PromptCacheTargetTool:
			layout.tools[breakpoint.ToolIndex()] = control
		default:
			return cacheLayout{}, ErrUnsupportedRequest
		}
	}
	return layout, nil
}

// encodeCacheControl 把 nil 或 Canonical 控制转换为 Messages 结构。
func encodeCacheControl(
	control *inference.PromptCacheControl,
) *cacheControlDTO {
	if control == nil {
		return nil
	}
	return &cacheControlDTO{
		Type:  "ephemeral",
		TTL:   string(control.TTL()),
		Scope: string(control.Scope()),
	}
}

// cacheControlAt 返回指定消息内容块的控制副本。
func (layout cacheLayout) cacheControlAt(
	messageIndex uint32,
	contentIndex uint32,
) *inference.PromptCacheControl {
	control, found := layout.messages[cachePosition{
		messageIndex: messageIndex,
		contentIndex: contentIndex,
	}]
	if !found {
		return nil
	}
	return &control
}

// toolCacheControlAt 返回指定工具定义的控制副本。
func (layout cacheLayout) toolCacheControlAt(
	toolIndex uint32,
) *inference.PromptCacheControl {
	control, found := layout.tools[toolIndex]
	if !found {
		return nil
	}
	return &control
}
