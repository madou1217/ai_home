package effortalign

import (
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

type stubLadders map[string][]inference.ReasoningEffort

func (stub stubLadders) LookupReasoningEfforts(providerID string, modelID string) ([]inference.ReasoningEffort, bool) {
	ladder, found := stub[providerID+"/"+modelID]
	return ladder, found
}

func mustRequest(t *testing.T, protocol inference.ClientProtocolID, reasoning *inference.ReasoningConfig) inference.Request {
	t.Helper()
	text, err := inference.NewTextContent("hi")
	if err != nil {
		t.Fatal(err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatal(err)
	}
	input := inference.RequestInput{
		ClientProtocol: protocol,
		Model:          "test-model",
		Messages:       []inference.Message{message},
		Reasoning:      reasoning,
	}
	request, err := inference.NewRequest(input)
	if err != nil {
		t.Fatal(err)
	}
	return request
}

func effortReasoning(t *testing.T, effort inference.ReasoningEffort) *inference.ReasoningConfig {
	t.Helper()
	config, err := inference.NewEffortReasoning(effort, "")
	if err != nil {
		t.Fatal(err)
	}
	return &config
}

// anthropic 客户端只有 low..max 五档：来源方高五档要按顶端对齐压进目标三档。
func TestApplyAlignsTheClientLadderIntoTheModelLadder(t *testing.T) {
	ladders := stubLadders{
		"claude/k3": []inference.ReasoningEffort{
			inference.ReasoningEffortLow,
			inference.ReasoningEffortHigh,
			inference.ReasoningEffortMax,
		},
	}
	aligner := New(ladders)
	request := mustRequest(t, inference.ClientProtocolAnthropicMessages, effortReasoning(t, inference.ReasoningEffortMax))
	aligned := aligner.Apply(request, inference.ProviderClaude, "k3")
	reasoning, ok := aligned.Reasoning()
	if !ok || reasoning.Effort() != inference.ReasoningEffortMax {
		t.Fatalf("max must stay at the top of the model ladder, got %q", reasoning.Effort())
	}

	request = mustRequest(t, inference.ClientProtocolAnthropicMessages, effortReasoning(t, inference.ReasoningEffortLow))
	aligned = aligner.Apply(request, inference.ProviderClaude, "k3")
	reasoning, _ = aligned.Reasoning()
	if reasoning.Effort() != inference.ReasoningEffortLow {
		t.Fatalf("low must stay at the bottom of the model ladder, got %q", reasoning.Effort())
	}
}

// 目标阶梯比客户端窄时整体平移，而不是「同名就留在原地」。
func TestApplyShiftsInsteadOfMatchingByName(t *testing.T) {
	// 模型只有 low/medium，发送方是 OpenAI 全阶梯：medium 应落到目标最高的 medium，
	// 而 low 也落到 medium（目标最低档之上不再有更低档）。
	ladders := stubLadders{
		"codex/lite": []inference.ReasoningEffort{
			inference.ReasoningEffortLow,
			inference.ReasoningEffortMedium,
		},
	}
	aligner := New(ladders)
	request := mustRequest(t, inference.ClientProtocolOpenAIResponses, effortReasoning(t, inference.ReasoningEffortHigh))
	aligned := aligner.Apply(request, inference.ProviderCodex, "lite")
	reasoning, _ := aligned.Reasoning()
	if reasoning.Effort() != inference.ReasoningEffortMedium {
		t.Fatalf("high against [low medium] must converge to medium, got %q", reasoning.Effort())
	}
}

// 查不到档位就不动请求：目录缺数据不等于模型没有档位，猜测会静默降档。
func TestApplyLeavesUnknownModelsAlone(t *testing.T) {
	aligner := New(stubLadders{})
	request := mustRequest(t, inference.ClientProtocolAnthropicMessages, effortReasoning(t, inference.ReasoningEffortMax))
	aligned := aligner.Apply(request, inference.ProviderClaude, "not-in-catalog")
	reasoning, _ := aligned.Reasoning()
	if reasoning.Effort() != inference.ReasoningEffortMax {
		t.Fatalf("unknown models must keep the requested effort, got %q", reasoning.Effort())
	}
}

// 目标模型没有任何档位时去掉整个强度意图，而不是塞一个它不认识的档位。
func TestApplyDropsReasoningWhenTheModelHasNoTiers(t *testing.T) {
	aligner := New(stubLadders{"claude/plain": nil})
	request := mustRequest(t, inference.ClientProtocolAnthropicMessages, effortReasoning(t, inference.ReasoningEffortHigh))
	if _, has := request.Reasoning(); !has {
		t.Fatal("fixture must carry reasoning")
	}
	aligned := aligner.Apply(request, inference.ProviderClaude, "plain")
	if _, has := aligned.Reasoning(); has {
		t.Fatal("a model without tiers must not receive a reasoning intent")
	}
}

// 没有强度意图、或没有接线读取端口时，请求必须逐字不变（对齐器是可选能力）。
func TestApplyIsInertWithoutIntentOrReader(t *testing.T) {
	request := mustRequest(t, inference.ClientProtocolAnthropicMessages, nil)
	if got := New(stubLadders{}).Apply(request, inference.ProviderClaude, "x"); got.Model() != request.Model() {
		t.Fatal("requests without intent must pass through")
	}
	request = mustRequest(t, inference.ClientProtocolAnthropicMessages, effortReasoning(t, inference.ReasoningEffortHigh))
	if reasoning, ok := New(nil).Apply(request, inference.ProviderClaude, "x").Reasoning(); !ok ||
		reasoning.Effort() != inference.ReasoningEffortHigh {
		t.Fatal("an unwired aligner must keep the request unchanged")
	}
}

// 按轮强度必须跟着请求级强度一起对齐，否则同一轮会先 high 后 max。
func TestApplyAlignsPerTurnEffortToo(t *testing.T) {
	ladders := stubLadders{
		"claude/k3": []inference.ReasoningEffort{
			inference.ReasoningEffortLow,
			inference.ReasoningEffortHigh,
		},
	}
	text, err := inference.NewTextContent("sys")
	if err != nil {
		t.Fatal(err)
	}
	system, err := inference.NewMessage(inference.RoleSystem, text)
	if err != nil {
		t.Fatal(err)
	}
	system, err = system.WithTurnEffort(inference.ReasoningEffortMax)
	if err != nil {
		t.Fatal(err)
	}
	user, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatal(err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          "test-model",
		Messages:       []inference.Message{system, user},
		Reasoning:      effortReasoning(t, inference.ReasoningEffortMax),
	})
	if err != nil {
		t.Fatal(err)
	}
	aligned := New(ladders).Apply(request, inference.ProviderClaude, "k3")
	reasoning, _ := aligned.Reasoning()
	if reasoning.Effort() != inference.ReasoningEffortHigh {
		t.Fatalf("request effort = %q, want high", reasoning.Effort())
	}
	if got := aligned.Messages()[0].TurnEffort(); got != inference.ReasoningEffortHigh {
		t.Fatalf("per-turn effort = %q, want high", got)
	}
}
