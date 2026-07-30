package messages

import (
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// usageState 保存 Anthropic 分阶段返回的累计 token 字段。
type usageState struct {
	uncachedInput uint64
	output        uint64
	cacheWrite    uint64
	cacheRead     uint64
}

// updateUsage 合并 message_start 或 message_delta 的局部累计字段。
func (decoder *responseDecoder) updateUsage(
	raw json.RawMessage,
) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}
	var wire usageDTO
	if err := json.Unmarshal(raw, &wire); err != nil {
		return ErrInvalidUpstreamResponse
	}
	if wire.InputTokens != nil {
		decoder.usage.uncachedInput = *wire.InputTokens
	}
	if wire.OutputTokens != nil {
		if *wire.OutputTokens < decoder.usage.output {
			return ErrInvalidUpstreamResponse
		}
		decoder.usage.output = *wire.OutputTokens
	}
	if wire.CacheCreationInputTokens != nil {
		decoder.usage.cacheWrite = *wire.CacheCreationInputTokens
	}
	if wire.CacheReadInputTokens != nil {
		decoder.usage.cacheRead = *wire.CacheReadInputTokens
	}
	if wire.InputTokens == nil &&
		wire.OutputTokens == nil &&
		wire.CacheCreationInputTokens == nil &&
		wire.CacheReadInputTokens == nil {
		return ErrInvalidUpstreamResponse
	}
	usage, err := decoder.usage.canonical()
	if err != nil {
		return err
	}
	event, err := inference.NewUsageUpdatedEvent(
		decoder.nextSequence,
		usage,
	)
	if err != nil {
		return ErrInvalidUpstreamResponse
	}
	return decoder.emitEvent(event)
}

// canonical 把 Anthropic 非缓存输入和缓存分项合成为 Canonical Usage。
func (state usageState) canonical() (inference.Usage, error) {
	inputTokens, err := checkedAddUsage(
		state.uncachedInput,
		state.cacheWrite,
		state.cacheRead,
	)
	if err != nil {
		return inference.Usage{}, err
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           inputTokens,
		OutputTokens:          state.output,
		CachedInputTokens:     state.cacheRead,
		CacheWriteInputTokens: state.cacheWrite,
	})
	if err != nil {
		return inference.Usage{}, ErrInvalidUpstreamResponse
	}
	return usage, nil
}
