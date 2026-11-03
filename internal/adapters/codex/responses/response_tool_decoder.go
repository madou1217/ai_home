package responses

import (
	"encoding/json"
	"strings"

	"github.com/madou1217/ai_home/core/inference"
)

// appendFunctionArguments 追加 function_call JSON 参数片段。
func (decoder *responseDecoder) appendFunctionArguments(
	event streamEventDTO,
) error {
	item, outputIndex, err := decoder.toolItem(event)
	if err != nil || item.custom {
		return ErrInvalidUpstreamResponse
	}
	return decoder.appendToolArguments(
		outputIndex,
		item,
		event.Delta,
	)
}

// completeFunctionArguments 补齐并校验完整 JSON Object 参数。
func (decoder *responseDecoder) completeFunctionArguments(
	event streamEventDTO,
) error {
	item, outputIndex, err := decoder.toolItem(event)
	if err != nil || item.custom {
		return ErrInvalidUpstreamResponse
	}
	full := event.Arguments
	if full == "" {
		full = event.Text
	}
	return decoder.finalizeToolArguments(outputIndex, item, full)
}

// appendCustomInput 把自定义工具字符串无损包装为 {"input": string}。
func (decoder *responseDecoder) appendCustomInput(
	event streamEventDTO,
) error {
	item, outputIndex, err := decoder.toolItem(event)
	if err != nil || !item.custom || item.customFinished {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.ensureCustomPrefix(outputIndex, item); err != nil {
		return err
	}
	if event.Delta == "" {
		return nil
	}
	escaped, err := escapeJSONStringFragment(event.Delta)
	if err != nil {
		return err
	}
	if err := decoder.appendToolArguments(outputIndex, item, escaped); err != nil {
		return err
	}
	item.customInput += event.Delta
	return nil
}

// completeCustomInput 完成自定义工具 JSON 包装并提交工具终值。
func (decoder *responseDecoder) completeCustomInput(
	event streamEventDTO,
) error {
	item, outputIndex, err := decoder.toolItem(event)
	if err != nil || !item.custom {
		return ErrInvalidUpstreamResponse
	}
	full := event.Input
	if full == "" {
		full = event.Text
	}
	return decoder.finalizeCustomInput(outputIndex, item, full)
}

// ensureCustomPrefix 只提交一次 JSON Object 和字符串前缀。
func (decoder *responseDecoder) ensureCustomPrefix(
	outputIndex uint32,
	item *decodedItem,
) error {
	if item.customStarted {
		return nil
	}
	if err := decoder.appendToolArguments(
		outputIndex,
		item,
		`{"input":"`,
	); err != nil {
		return err
	}
	item.customStarted = true
	return nil
}

// finalizeCustomInput 补齐字符串后缀和 JSON 结束符。
func (decoder *responseDecoder) finalizeCustomInput(
	outputIndex uint32,
	item *decodedItem,
	full string,
) error {
	if item.customFinished {
		expected, err := marshalCustomArguments(full)
		if err != nil || item.arguments != expected {
			return ErrInvalidUpstreamResponse
		}
		return nil
	}
	if !strings.HasPrefix(full, item.customInput) {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.ensureCustomPrefix(outputIndex, item); err != nil {
		return err
	}
	suffix := strings.TrimPrefix(full, item.customInput)
	if suffix != "" {
		escaped, err := escapeJSONStringFragment(suffix)
		if err != nil {
			return err
		}
		if err := decoder.appendToolArguments(
			outputIndex,
			item,
			escaped,
		); err != nil {
			return err
		}
		item.customInput += suffix
	}
	if err := decoder.appendToolArguments(
		outputIndex,
		item,
		`"}`,
	); err != nil {
		return err
	}
	item.customFinished = true
	expected, err := marshalCustomArguments(full)
	if err != nil || item.arguments != expected {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitToolCompleted(outputIndex, item)
}

// appendToolArguments 提交一个属于已绑定 call ID 的参数增量。
func (decoder *responseDecoder) appendToolArguments(
	outputIndex uint32,
	item *decodedItem,
	delta string,
) error {
	if delta == "" {
		return nil
	}
	event, err := inference.NewToolArgumentsDeltaEvent(
		decoder.nextSequence,
		outputIndex,
		0,
		item.callID,
		delta,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	item.arguments += delta
	return nil
}

// finalizeToolArguments 补齐完整参数并提交工具完成事件。
func (decoder *responseDecoder) finalizeToolArguments(
	outputIndex uint32,
	item *decodedItem,
	full string,
) error {
	if item.toolCompleted {
		if item.arguments != full {
			return ErrInvalidUpstreamResponse
		}
		return nil
	}
	if full == "" || !strings.HasPrefix(full, item.arguments) {
		return ErrInvalidUpstreamResponse
	}
	if suffix := strings.TrimPrefix(full, item.arguments); suffix != "" {
		if err := decoder.appendToolArguments(outputIndex, item, suffix); err != nil {
			return err
		}
	}
	return decoder.emitToolCompleted(outputIndex, item)
}

// emitToolCompleted 验证完整 JSON Object 后提交工具终值。
func (decoder *responseDecoder) emitToolCompleted(
	outputIndex uint32,
	item *decodedItem,
) error {
	event, err := newCanonicalToolCallCompletedEvent(
		decoder.nextSequence,
		outputIndex,
		item.callID,
		item.identity,
		[]byte(item.arguments),
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	if err := decoder.emitEvent(event); err != nil {
		return err
	}
	item.toolCompleted = true
	return nil
}

// newCanonicalToolCallCompletedEvent 用完整身份选择普通或 namespaced 构造器。
func newCanonicalToolCallCompletedEvent(
	sequence uint64,
	outputIndex uint32,
	callID string,
	identity inference.ToolIdentity,
	arguments []byte,
) (inference.ToolCallCompletedEvent, error) {
	if namespace, found := identity.Namespace(); found {
		return inference.NewNamespacedToolCallCompletedEvent(
			sequence,
			outputIndex,
			0,
			callID,
			namespace,
			identity.Name(),
			arguments,
		)
	}
	return inference.NewToolCallCompletedEvent(
		sequence,
		outputIndex,
		0,
		callID,
		identity.Name(),
		arguments,
	)
}

// toolItem 根据 output_index 和可选 call_id 查找未完成工具项。
func (decoder *responseDecoder) toolItem(
	event streamEventDTO,
) (*decodedItem, uint32, error) {
	if event.OutputIndex == nil {
		return nil, 0, ErrInvalidUpstreamResponse
	}
	item, err := decoder.item(*event.OutputIndex)
	if err != nil ||
		item.kind != inference.OutputItemToolCall ||
		item.completed ||
		event.ItemID != "" && event.ItemID != item.id ||
		event.CallID != "" && event.CallID != item.callID {
		return nil, 0, ErrInvalidUpstreamResponse
	}
	return item, *event.OutputIndex, nil
}

// escapeJSONStringFragment 返回可拼接到 JSON 字符串内部的转义片段。
func escapeJSONStringFragment(value string) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) < 2 {
		return "", ErrInvalidUpstreamResponse
	}
	return string(encoded[1 : len(encoded)-1]), nil
}

// marshalCustomArguments 创建单字段稳定 JSON Object。
func marshalCustomArguments(value string) (string, error) {
	encoded, err := json.Marshal(struct {
		Input string `json:"input"`
	}{Input: value})
	if err != nil {
		return "", ErrInvalidUpstreamResponse
	}
	return string(encoded), nil
}
