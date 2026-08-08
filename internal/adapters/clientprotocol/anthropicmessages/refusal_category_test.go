package anthropicmessages

import (
	"encoding/json"
	"testing"

	"github.com/madou1217/ai_home/core/inference"
)

// TestRefusalCategorySurvivesCanonical 锁定拒绝类别不被 Canonical 重建丢掉。
//
// 类别决定客户端该回退到哪个模型。此前它在解码第一步就被丢弃，客户端只知道
// 「被拒了」不知道为什么，本可换模型继续的任务只能直接失败。
func TestRefusalCategorySurvivesCanonical(t *testing.T) {
	t.Parallel()

	wire := renderRefusalTerminal(t, "cyber")
	if wire.StopDetails == nil {
		t.Fatal("stop_details 缺失，拒绝类别在重建中丢失")
	}
	if wire.StopDetails.Category != "cyber" {
		t.Fatalf("category = %q, want cyber", wire.StopDetails.Category)
	}
	if wire.StopDetails.Type != "refusal" {
		t.Fatalf("type = %q, want refusal", wire.StopDetails.Type)
	}
	if wire.StopReason == nil || *wire.StopReason != "refusal" {
		t.Fatalf("stop_reason = %v, want refusal", wire.StopReason)
	}
}

// TestRefusalWithoutCategoryOmitsStopDetails 验证上游未给类别时省略该字段。
//
// 上游不给类别是合法情况，此时应省略而不是发空对象——发空对象会让客户端
// 误以为拿到了一个无法识别的类别。
func TestRefusalWithoutCategoryOmitsStopDetails(t *testing.T) {
	t.Parallel()

	wire := renderRefusalTerminal(t, "")
	if wire.StopDetails != nil {
		t.Fatalf("上游未给类别时仍发出 stop_details: %#v", wire.StopDetails)
	}
	payload, err := json.Marshal(wire)
	if err != nil {
		t.Fatalf("Marshal() error = %v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if _, found := decoded["stop_details"]; found {
		t.Fatalf("stop_details 键不应出现: %s", payload)
	}
}

// TestNonRefusalTerminalHasNoStopDetails 验证非拒绝终态不带类别。
func TestNonRefusalTerminalHasNoStopDetails(t *testing.T) {
	t.Parallel()

	state := newRefusalTestState(t)
	usage := newRefusalTestUsage(t)
	completed, err := inference.NewResponseCompletedEvent(
		state.lastSequence+1,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	if err := state.apply(completed); err != nil {
		t.Fatalf("apply() error = %v", err)
	}
	wire, err := state.buildCompletedMessageWire()
	if err != nil {
		t.Fatalf("buildCompletedMessageWire() error = %v", err)
	}
	if wire.StopDetails != nil {
		t.Fatalf("非拒绝终态带上了 stop_details: %#v", wire.StopDetails)
	}
}

// renderRefusalTerminal 用给定类别推进到拒绝终态并返回线协议对象。
func renderRefusalTerminal(t *testing.T, category string) messageWireDTO {
	t.Helper()

	state := newRefusalTestState(t)
	completed, err := inference.NewRefusedResponseCompletedEvent(
		state.lastSequence+1,
		category,
		newRefusalTestUsage(t),
	)
	if err != nil {
		t.Fatalf("NewRefusedResponseCompletedEvent() error = %v", err)
	}
	if err := state.apply(completed); err != nil {
		t.Fatalf("apply() error = %v", err)
	}
	wire, err := state.buildCompletedMessageWire()
	if err != nil {
		t.Fatalf("buildCompletedMessageWire() error = %v", err)
	}
	return wire
}

// newRefusalTestUsage 构造最小合法 usage。
func newRefusalTestUsage(t *testing.T) inference.Usage {
	t.Helper()

	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  4,
		OutputTokens: 1,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	return usage
}

// newRefusalTestState 推进到「只差终态」的状态：已开始且没有未闭合内容块。
func newRefusalTestState(t *testing.T) *responseState {
	t.Helper()

	state := newResponseState(newRendererTestRequest(t))
	started, err := inference.NewResponseStartedEvent(
		0,
		"msg_refusal_1",
		"claude-opus-4-6",
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	if err := state.apply(started); err != nil {
		t.Fatalf("apply(started) error = %v", err)
	}
	return state
}
