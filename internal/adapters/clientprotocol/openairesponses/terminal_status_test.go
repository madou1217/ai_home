package openairesponses

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestTerminalStatusDistinguishesTruncation 锁定截断与自然结束的区分。
//
// Responses 客户端只有 status 一个判据来决定要不要把输出当成最终答案。此前所有
// 终态一律渲染成 completed，导致 max_tokens 截断的半截回答被当成完整结果——客户端
// 既不重试也不提示用户，直接产生错误的任务结果。
func TestTerminalStatusDistinguishesTruncation(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		reason inference.StopReason
		status string
		detail string
	}{
		{
			name:   "输出上限截断",
			reason: inference.StopReasonMaxTokens,
			status: statusIncomplete,
			detail: "max_output_tokens",
		},
		{
			name:   "安全策略拦截",
			reason: inference.StopReasonContentFilter,
			status: statusIncomplete,
			detail: "content_filter",
		},
		{
			name:   "自然结束",
			reason: inference.StopReasonEndTurn,
			status: statusCompleted,
		},
		{
			name:   "命中停止序列",
			reason: inference.StopReasonStopSequence,
			status: statusCompleted,
		},
		{
			name:   "转交工具调用",
			reason: inference.StopReasonToolUse,
			status: statusCompleted,
		},
		{
			// pause_turn 的输出没有被截断，客户端可原样续跑；
			// 标成 incomplete 会让它误判结果不可用而丢弃。
			name:   "服务端工具循环暂停",
			reason: inference.StopReasonPauseTurn,
			status: statusCompleted,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			status, detail := terminalStatusFor(test.reason)
			if status != test.status || detail != test.detail {
				t.Fatalf(
					"terminalStatusFor(%s) = (%q, %q), want (%q, %q)",
					test.reason,
					status,
					detail,
					test.status,
					test.detail,
				)
			}
		})
	}
}

// TestIncompleteDetailsOnlyOnIncomplete 验证 incomplete_details 只在截断时出现。
//
// completed 终态携带非空 incomplete_details 会让客户端误判输出不完整。
func TestIncompleteDetailsOnlyOnIncomplete(t *testing.T) {
	t.Parallel()

	for _, reason := range []inference.StopReason{
		inference.StopReasonEndTurn,
		inference.StopReasonStopSequence,
		inference.StopReasonToolUse,
		inference.StopReasonPauseTurn,
	} {
		if status, detail := terminalStatusFor(reason); detail != "" {
			t.Fatalf(
				"terminalStatusFor(%s) 在 %s 终态下给出了截断原因 %q",
				reason,
				status,
				detail,
			)
		}
	}
}
