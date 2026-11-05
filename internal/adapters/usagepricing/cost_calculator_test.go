package usagepricing

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/usageledger"
)

type fakeLoader struct {
	records map[string]RawRecord
	err     error
	calls   int
}

func (loader *fakeLoader) LoadModelPricing(context.Context) (map[string]RawRecord, error) {
	loader.calls++
	if loader.err != nil {
		return nil, loader.err
	}
	return loader.records, nil
}

func floatPointerForTest(value float64) *float64 { return &value }

func pricedLoader() *fakeLoader {
	return &fakeLoader{records: map[string]RawRecord{
		"openai/gpt-5.1": {
			InputCostPerToken:  floatPointerForTest(1.25e-6),
			OutputCostPerToken: floatPointerForTest(1e-5),
		},
	}}
}

// 成本按行给出，且命中定价的模型才标 known。
func TestModelCostCalculatorCostsPerRow(t *testing.T) {
	calculator, err := NewModelCostCalculator(pricedLoader(), []string{"codex"})
	if err != nil {
		t.Fatalf("NewModelCostCalculator() error = %v", err)
	}
	costs, known, supported := calculator.Costs(context.Background(), []usageledger.ModelStats{
		{Provider: "codex", Model: "gpt-5.1", InputTokens: 1000, OutputTokens: 500},
		{Provider: "codex", Model: "no-pricing", InputTokens: 10},
	})
	if !supported {
		t.Fatal("supported = false, want true")
	}
	if !closeEnough(costs[0], 0.00125+0.005) {
		t.Fatalf("cost = %v, want 0.00625", costs[0])
	}
	if !known[0] {
		t.Fatal("known[0] = false, want true")
	}
	if known[1] || costs[1] != 0 {
		t.Fatalf("未定价模型: known=%v cost=%v, want false/0", known[1], costs[1])
	}
}

// 目录在刷新间隔内只读一次：按行读表会把一次查询放大成 N 次。
func TestModelCostCalculatorCachesCatalog(t *testing.T) {
	loader := pricedLoader()
	calculator, _ := NewModelCostCalculator(loader, []string{"codex"})
	now := time.Date(2026, 11, 6, 12, 0, 0, 0, time.UTC)
	calculator.now = func() time.Time { return now }
	models := []usageledger.ModelStats{{Provider: "codex", Model: "gpt-5.1", InputTokens: 10}}

	calculator.Costs(context.Background(), models)
	calculator.Costs(context.Background(), models)
	if loader.calls != 1 {
		t.Fatalf("loader calls = %d, want 1（缓存内不应重复读表）", loader.calls)
	}
	now = now.Add(DefaultPricingRefreshInterval + time.Second)
	calculator.Costs(context.Background(), models)
	if loader.calls != 2 {
		t.Fatalf("loader calls = %d, want 2（过期后应重新读取）", loader.calls)
	}
}

// 读表失败只意味着「成本未知」，不能让用量统计整体失败。
func TestModelCostCalculatorFailsSoft(t *testing.T) {
	calculator, _ := NewModelCostCalculator(&fakeLoader{err: errors.New("db locked")}, []string{"codex"})
	costs, known, supported := calculator.Costs(context.Background(), []usageledger.ModelStats{
		{Provider: "codex", Model: "gpt-5.1", InputTokens: 10},
	})
	if supported || costs != nil || known != nil {
		t.Fatalf("supported=%v costs=%v known=%v, want all empty", supported, costs, known)
	}
}

func TestNewModelCostCalculatorRejectsNilLoader(t *testing.T) {
	if _, err := NewModelCostCalculator(nil, nil); err == nil {
		t.Fatal("nil loader should be rejected")
	}
}
