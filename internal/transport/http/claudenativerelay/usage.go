package claudenativerelay

import (
	"bytes"
	"encoding/json"

	"github.com/madou1217/ai_home/core/inference"
)

// nativeUsageDTO 是 Anthropic usage 的局部累计字段（message_start 给输入，message_delta 给输出）。
type nativeUsageDTO struct {
	InputTokens              *uint64 `json:"input_tokens"`
	OutputTokens             *uint64 `json:"output_tokens"`
	CacheCreationInputTokens *uint64 `json:"cache_creation_input_tokens"`
	CacheReadInputTokens     *uint64 `json:"cache_read_input_tokens"`
}

// nativeUsageEnvelope 同时覆盖 message_start（message.usage）与 message_delta（usage）。
type nativeUsageEnvelope struct {
	Message *struct {
		Usage *nativeUsageDTO `json:"usage"`
	} `json:"message"`
	Usage *nativeUsageDTO `json:"usage"`
}

// nativeUsageState 旁路累计原始 SSE 里的 token 字段；只读，不修改透传字节。
type nativeUsageState struct {
	uncachedInput uint64
	output        uint64
	cacheWrite    uint64
	cacheRead     uint64
	seen          bool
}

// observe 合并一个事件里的 usage 字段；无法解析的事件静默跳过。
func (state *nativeUsageState) observe(data []byte) {
	var envelope nativeUsageEnvelope
	if json.Unmarshal(data, &envelope) != nil {
		return
	}
	if envelope.Message != nil && envelope.Message.Usage != nil {
		state.merge(envelope.Message.Usage)
	}
	if envelope.Usage != nil {
		state.merge(envelope.Usage)
	}
}

func (state *nativeUsageState) merge(wire *nativeUsageDTO) {
	if wire.InputTokens != nil {
		state.uncachedInput = *wire.InputTokens
		state.seen = true
	}
	if wire.OutputTokens != nil && *wire.OutputTokens >= state.output {
		state.output = *wire.OutputTokens
		state.seen = true
	}
	if wire.CacheCreationInputTokens != nil {
		state.cacheWrite = *wire.CacheCreationInputTokens
		state.seen = true
	}
	if wire.CacheReadInputTokens != nil {
		state.cacheRead = *wire.CacheReadInputTokens
		state.seen = true
	}
}

// canonical 与 Claude Messages 适配器同口径：输入 = 非缓存 + 缓存写 + 缓存读。
func (state nativeUsageState) canonical() (inference.Usage, bool) {
	if !state.seen {
		return inference.Usage{}, false
	}
	input := state.uncachedInput + state.cacheWrite + state.cacheRead
	if input < state.uncachedInput {
		return inference.Usage{}, false
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:           input,
		OutputTokens:          state.output,
		CachedInputTokens:     state.cacheRead,
		CacheWriteInputTokens: state.cacheWrite,
	})
	if err != nil || usage.TotalTokens() == 0 {
		return inference.Usage{}, false
	}
	return usage, true
}

// nonStreamUsageCaptureLimit 是非流式响应旁路读取 usage 的上限；超出则放弃统计。
const nonStreamUsageCaptureLimit = 4 << 20

// boundedCapture 保存响应前缀；超过上限后丢弃并标记，写入永远报告成功。
type boundedCapture struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

// Write 实现 io.Writer；绝不向 TeeReader 返回错误。
func (capture *boundedCapture) Write(payload []byte) (int, error) {
	if !capture.truncated {
		if capture.buffer.Len()+len(payload) > capture.limit {
			capture.truncated = true
			capture.buffer.Reset()
		} else {
			capture.buffer.Write(payload)
		}
	}
	return len(payload), nil
}
