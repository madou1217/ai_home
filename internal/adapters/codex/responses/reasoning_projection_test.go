package responses

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestProjectReasoningPrefersExplicitEffort 锁定「客户端已声明强度就直接沿用」。
//
// 真实 Claude Code 每次都发 thinking:{type:"adaptive"} + output_config.effort，
// Canonical 会把两者一起保留。若投影忽略已有 effort 而按模式重新推导，等于用网关
// 的猜测覆盖客户端的明确意图。
func TestProjectReasoningPrefersExplicitEffort(t *testing.T) {
	t.Parallel()

	adaptive, err := inference.NewAdaptiveReasoningWithEffort(
		inference.ReasoningSummaryAuto,
		inference.ReasoningEffortLow,
	)
	if err != nil {
		t.Fatalf("NewAdaptiveReasoningWithEffort() error = %v", err)
	}
	if got := projectReasoningEffort(adaptive); got != inference.ReasoningEffortLow {
		t.Fatalf("adaptive+low 投影 = %q, want low", got)
	}

	budget, err := inference.NewBudgetReasoningWithEffort(
		2_048,
		inference.ReasoningSummaryAuto,
		inference.ReasoningEffortMax,
	)
	if err != nil {
		t.Fatalf("NewBudgetReasoningWithEffort() error = %v", err)
	}
	// 预算很小但客户端明确要 max，必须尊重客户端而不是按预算降档。
	if got := projectReasoningEffort(budget); got != inference.ReasoningEffortMax {
		t.Fatalf("budget+max 投影 = %q, want max", got)
	}
}

// TestProjectReasoningDerivesOnlyWhenEffortAbsent 验证仅在缺 effort 时才推导。
func TestProjectReasoningDerivesOnlyWhenEffortAbsent(t *testing.T) {
	t.Parallel()

	adaptive, err := inference.NewAdaptiveReasoning(inference.ReasoningSummaryAuto)
	if err != nil {
		t.Fatalf("NewAdaptiveReasoning() error = %v", err)
	}
	// adaptive 表示由模型自行决定思考量，high 是 Codex 侧最接近的表达。
	if got := projectReasoningEffort(adaptive); got != inference.ReasoningEffortHigh {
		t.Fatalf("adaptive 投影 = %q, want high", got)
	}

	for _, test := range []struct {
		name   string
		budget uint64
		want   inference.ReasoningEffort
	}{
		{name: "最小合法预算", budget: 1_024, want: inference.ReasoningEffortLow},
		{name: "压缩档上界", budget: 8_000, want: inference.ReasoningEffortLow},
		{name: "压缩档之上", budget: 8_001, want: inference.ReasoningEffortMedium},
		{name: "现代默认上界", budget: 32_000, want: inference.ReasoningEffortMedium},
		{name: "超出现代默认", budget: 32_001, want: inference.ReasoningEffortHigh},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			config, err := inference.NewBudgetReasoning(
				test.budget,
				inference.ReasoningSummaryAuto,
			)
			if err != nil {
				t.Fatalf("NewBudgetReasoning() error = %v", err)
			}
			if got := projectReasoningEffort(config); got != test.want {
				t.Fatalf(
					"budget=%d 投影 = %q, want %q",
					test.budget,
					got,
					test.want,
				)
			}
		})
	}
}

// TestEncodeReasoningNoLongerRejectsClaudeThinking 锁定跨协议不再整体失败。
//
// 这是本次修复的核心：此前 claude 客户端带 thinking 调 codex 账号会在编码阶段
// 直接 unsupported，整个请求失败，而不是丢一个字段。
func TestEncodeReasoningNoLongerRejectsClaudeThinking(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name   string
		build  func() (inference.ReasoningConfig, error)
		effort string
	}{
		{
			name: "Claude Code 的 adaptive + high",
			build: func() (inference.ReasoningConfig, error) {
				return inference.NewAdaptiveReasoningWithEffort(
					inference.ReasoningSummaryAuto,
					inference.ReasoningEffortHigh,
				)
			},
			effort: "high",
		},
		{
			name: "纯 adaptive 无 effort",
			build: func() (inference.ReasoningConfig, error) {
				return inference.NewAdaptiveReasoning(inference.ReasoningSummaryAuto)
			},
			effort: "high",
		},
		{
			name: "旧式 budget_tokens",
			build: func() (inference.ReasoningConfig, error) {
				return inference.NewBudgetReasoning(
					4_096,
					inference.ReasoningSummaryAuto,
				)
			},
			effort: "low",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			config, err := test.build()
			if err != nil {
				t.Fatalf("build() error = %v", err)
			}
			if got := string(projectReasoningEffort(config)); got != test.effort {
				t.Fatalf("投影 effort = %q, want %q", got, test.effort)
			}
		})
	}
}

// TestCrossProtocolMaxTokensNoLongerRejected 锁定跨协议不再因必填字段整体失败。
//
// Anthropic Messages 的 max_tokens 是必填，claude 客户端没有「不发」的选项。
// 此前 Codex 编码器一律按不支持拒绝，等于 claude 客户端永远无法使用 codex 账号。
// 同协议仍然拒绝——codex 客户端本可以不发。
func TestCrossProtocolMaxTokensNoLongerRejected(t *testing.T) {
	t.Parallel()

	for _, test := range []struct {
		name     string
		protocol inference.ClientProtocolID
		rejected bool
	}{
		{
			name:     "claude 客户端必填上限应被容忍",
			protocol: inference.ClientProtocolAnthropicMessages,
			rejected: false,
		},
		{
			name:     "chat completions 客户端同样容忍",
			protocol: inference.ClientProtocolOpenAIChatCompletions,
			rejected: false,
		},
		{
			name:     "codex 同协议仍然拒绝",
			protocol: inference.ClientProtocolOpenAIResponses,
			rejected: true,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			request := newMaxTokensRequest(t, test.protocol)
			err := rejectUnsupportedRequest(request, "")
			if test.rejected && err == nil {
				t.Fatal("同协议超限字段未被拒绝")
			}
			if !test.rejected && err != nil {
				t.Fatalf("跨协议被拒绝: %v", err)
			}
		})
	}
}

// newMaxTokensRequest 构造只带输出上限的最小 Canonical 请求。
func newMaxTokensRequest(
	t *testing.T,
	protocol inference.ClientProtocolID,
) inference.Request {
	t.Helper()

	text, err := inference.NewTextContent("say ok")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol:  protocol,
		Model:           "gpt-5.6-sol",
		Messages:        []inference.Message{message},
		MaxOutputTokens: 1024,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}
