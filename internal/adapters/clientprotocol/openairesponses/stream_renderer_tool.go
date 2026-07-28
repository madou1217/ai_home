package openairesponses

import "github.com/madou1217/ai_home/core/inference"

// renderToolCallStarted 在 call ID 和工具名可用后生成 function_call added。
func (renderer *StreamRenderer) renderToolCallStarted(
	event inference.ToolCallStartedEvent,
) ([]RenderedEvent, error) {
	return renderer.renderOutputItemAdded(event.OutputIndex())
}

// renderToolArgumentsDelta 生成一个函数参数增量事件。
func (renderer *StreamRenderer) renderToolArgumentsDelta(
	event inference.ToolArgumentsDeltaEvent,
	delta string,
) ([]RenderedEvent, error) {
	return renderer.renderToolDelta(event.OutputIndex(), delta)
}

// renderToolCallCompleted 补齐缺失参数增量后生成 arguments.done。
func (renderer *StreamRenderer) renderToolCallCompleted(
	event inference.ToolCallCompletedEvent,
	suffix string,
) ([]RenderedEvent, error) {
	var frames []RenderedEvent
	if suffix != "" {
		delta, err := renderer.renderToolDelta(event.OutputIndex(), suffix)
		if err != nil {
			return nil, err
		}
		frames = append(frames, delta...)
	}
	item, err := renderer.state.openItem(event.OutputIndex())
	if err != nil {
		return nil, err
	}
	done, err := renderer.renderMany(streamEventWireDTO{
		Type:        "response.function_call_arguments.done",
		OutputIndex: uint32Pointer(event.OutputIndex()),
		ItemID:      item.id,
		Name:        event.Name(),
		Arguments:   string(event.Arguments()),
	})
	return append(frames, done...), err
}

// renderToolDelta 生成一个 function_call_arguments.delta。
func (renderer *StreamRenderer) renderToolDelta(
	outputIndex uint32,
	delta string,
) ([]RenderedEvent, error) {
	item, err := renderer.state.openItem(outputIndex)
	if err != nil {
		return nil, err
	}
	return renderer.renderMany(streamEventWireDTO{
		Type:        "response.function_call_arguments.delta",
		OutputIndex: uint32Pointer(outputIndex),
		ItemID:      item.id,
		Delta:       delta,
	})
}
