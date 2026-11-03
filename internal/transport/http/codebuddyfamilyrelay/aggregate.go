package codebuddyfamilyrelay

import (
	"time"

	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// AggregatedCompletion 是非流式聚合的结果（别名到公共层，保持包内 API 稳定）。
type AggregatedCompletion = relaycore.AggregatedCompletion

// fallbackCompletionIDPrefix 是家族上游没给 id 时的兜底前缀。
//
// 保留家族专属前缀：运维在日志里一眼能看出这条聚合结果来自家族通道，而不是别的透传通道。
const fallbackCompletionIDPrefix = "chatcmpl-codebuddy"

// AggregateSSE 把家族上游的 SSE 文本聚合成一个非流式 `chat.completion`。
//
// 实现整体在 relaycore（协议形状的聚合与 Provider 无关，只有兜底 id 前缀不同）。
// 保留本函数是为了让包内既有调用方与测试的 API 不变。
func AggregateSSE(sse []byte, clock func() time.Time) AggregatedCompletion {
	return relaycore.AggregateSSE(sse, relaycore.AggregateOptions{
		Clock:            clock,
		FallbackIDPrefix: fallbackCompletionIDPrefix,
	})
}
