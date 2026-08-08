package openairesponses

import "github.com/madou1217/ai_home/core/inference"

const (
	// statusCompleted 表示模型自然结束，输出完整。
	statusCompleted = "completed"
	// statusIncomplete 表示模型被外部条件截断，输出不完整。
	statusIncomplete = "incomplete"
	// statusFailed 表示本次调用未产生可用输出。
	statusFailed = "failed"
)

// terminalStatusFor 把 Canonical 停止原因映射为 Responses 终态与不完整原因。
//
// 为什么必须区分：Responses 客户端按 status 决定要不要把输出当成完整答案。
// 把 max_tokens 截断渲染成 completed，客户端会把半截回答当成最终结果——既不重试
// 也不提示用户，直接产生错误的任务结果。这比任何字段缺失都严重。
//
// reason 取值沿用 OpenAI Responses 的稳定枚举，不自造：
// max_output_tokens 对应输出上限截断，content_filter 对应安全策略拦截。
func terminalStatusFor(reason inference.StopReason) (string, string) {
	switch reason {
	case inference.StopReasonMaxTokens:
		return statusIncomplete, "max_output_tokens"
	case inference.StopReasonContentFilter:
		return statusIncomplete, "content_filter"
	default:
		// end_turn、stop_sequence、tool_use 都是模型自主结束，输出完整。
		//
		// pause_turn 例外地归入 completed：它表示服务端工具循环达到迭代上限、
		// 可由客户端原样续跑，输出本身没有被截断；标成 incomplete 会让客户端
		// 误以为结果不可用而丢弃它。
		return statusCompleted, ""
	}
}
