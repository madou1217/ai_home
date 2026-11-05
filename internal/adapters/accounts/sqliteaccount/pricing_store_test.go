package sqliteaccount

import (
	"database/sql"
	"encoding/json"
	"testing"
)

// 表里 reasoning_output_token_cost 是 NOT NULL DEFAULT 0，读回时必须还原成「未声明」：
// 0 会被定价引擎当成明确免费，让所有推理 token 不计费。
func TestNewPricingRecordTreatsZeroReasoningAsUndeclared(t *testing.T) {
	record, ok := newPricingRecord(pricingRow{
		model:     "anthropic/claude-opus-4-6",
		input:     1.5e-5,
		output:    7.5e-5,
		reasoning: 0,
	})
	if !ok {
		t.Fatal("有效行被丢弃")
	}
	if record.raw.ReasoningOutputTokenCost != nil {
		t.Fatalf("reasoning = %v, want nil（未声明）", *record.raw.ReasoningOutputTokenCost)
	}

	declared, _ := newPricingRecord(pricingRow{
		model:     "anthropic/claude-opus-4-6",
		input:     1.5e-5,
		output:    7.5e-5,
		reasoning: 9e-5,
	})
	if declared.raw.ReasoningOutputTokenCost == nil || *declared.raw.ReasoningOutputTokenCost != 9e-5 {
		t.Fatal("显式声明的推理单价被丢掉")
	}
}

func TestNewPricingRecordRejectsEmptyModel(t *testing.T) {
	if _, ok := newPricingRecord(pricingRow{model: "   ", input: 1}); ok {
		t.Fatal("空模型名不应产生定价行")
	}
}

// 分档 JSON 同时接受 camelCase 与 snake_case；坏数据退化成「没有分档」而不是整行失败。
func TestDecodePricingTiersAcceptsBothKeyStyles(t *testing.T) {
	payload := `[{"size":100000,"inputCostPerToken":1.5e-6},{"context_size":200000,"input_cost_per_token":2e-6}]`
	tiers := decodePricingTiers(sql.NullString{String: payload, Valid: true})
	if len(tiers) != 2 {
		t.Fatalf("tiers = %d, want 2", len(tiers))
	}
	if tiers[0].Size == nil || *tiers[0].Size != 100000 {
		t.Fatalf("第一个分档 size = %v", tiers[0].Size)
	}
	if tiers[0].InputCostPerToken == nil || *tiers[0].InputCostPerToken != 1.5e-6 {
		t.Fatal("camelCase 单价没解析出来")
	}
	if tiers[1].Size == nil || *tiers[1].Size != 200000 {
		t.Fatalf("snake_case size 没解析出来: %v", tiers[1].Size)
	}
	// 序列化结果必须是定价引擎能直接吃下的形状。
	if _, err := json.Marshal(tiers); err != nil {
		t.Fatalf("tiers 不可序列化: %v", err)
	}
	if got := decodePricingTiers(sql.NullString{String: "{bad json", Valid: true}); got != nil {
		t.Fatalf("坏 JSON 应退化成没有分档，got %v", got)
	}
	if got := decodePricingTiers(sql.NullString{}); got != nil {
		t.Fatalf("NULL 应退化成没有分档，got %v", got)
	}
}
