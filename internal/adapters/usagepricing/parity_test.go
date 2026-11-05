package usagepricing

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// parityFixture 是 Node 侧算出真值的对照夹具（scripts/gen-usage-pricing-fixtures.js）。
type parityFixture struct {
	ProviderIDs []string             `json:"providerIds"`
	Catalog     map[string]RawRecord `json:"catalog"`
	Matches     []struct {
		Model             string   `json:"model"`
		Provider          string   `json:"provider"`
		Attributed        bool     `json:"attributed"`
		ExecutionProvider string   `json:"executionProvider"`
		ModelID           string   `json:"modelId"`
		ModelIDs          []string `json:"modelIds"`
		ProviderPrefixes  []string `json:"providerPrefixes"`
		MatchedModel      *string  `json:"matchedModel"`
	} `json:"matches"`
	Costs []struct {
		Model    string `json:"model"`
		Provider string `json:"provider"`
		Usage    struct {
			InputTokens              int64 `json:"inputTokens"`
			OutputTokens             int64 `json:"outputTokens"`
			CacheReadInputTokens     int64 `json:"cacheReadInputTokens"`
			CacheCreationInputTokens int64 `json:"cacheCreationInputTokens"`
			ReasoningOutputTokens    int64 `json:"reasoningOutputTokens"`
		} `json:"usage"`
		MatchedModel *string `json:"matchedModel"`
		CostUSD      float64 `json:"costUsd"`
	} `json:"costs"`
}

func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	payload, err := os.ReadFile(filepath.Join("testdata", "parity.json"))
	if err != nil {
		t.Fatalf("读取夹具失败: %v", err)
	}
	var fixture parityFixture
	if err := json.Unmarshal(payload, &fixture); err != nil {
		t.Fatalf("解析夹具失败: %v", err)
	}
	if len(fixture.Matches) == 0 || len(fixture.Costs) == 0 {
		t.Fatal("夹具为空，重新运行 scripts/gen-usage-pricing-fixtures.js")
	}
	return fixture
}

// 归属解析必须与 Node 逐字段一致：前缀判定、版本分隔符、别名展开三者任一偏离都会选错定价。
func TestParityBillingIdentity(t *testing.T) {
	fixture := loadParityFixture(t)
	index := NewAttributionIndex(fixture.ProviderIDs)
	for _, want := range fixture.Matches {
		got := index.Resolve(want.Model, want.Provider)
		if got.Attributed != want.Attributed {
			t.Fatalf("%q/%q attributed = %v, want %v", want.Model, want.Provider, got.Attributed, want.Attributed)
		}
		if got.ExecutionProvider != want.ExecutionProvider {
			t.Fatalf("%q/%q executionProvider = %q, want %q", want.Model, want.Provider, got.ExecutionProvider, want.ExecutionProvider)
		}
		if got.ModelID != want.ModelID {
			t.Fatalf("%q/%q modelId = %q, want %q", want.Model, want.Provider, got.ModelID, want.ModelID)
		}
		if !reflect.DeepEqual(got.ModelIDs, want.ModelIDs) {
			t.Fatalf("%q/%q modelIds = %v, want %v", want.Model, want.Provider, got.ModelIDs, want.ModelIDs)
		}
		if len(want.ProviderPrefixes) == 0 {
			if len(got.ProviderPrefixes) != 0 {
				t.Fatalf("%q/%q providerPrefixes = %v, want empty", want.Model, want.Provider, got.ProviderPrefixes)
			}
			continue
		}
		if !reflect.DeepEqual(got.ProviderPrefixes, want.ProviderPrefixes) {
			t.Fatalf("%q/%q providerPrefixes = %v, want %v", want.Model, want.Provider, got.ProviderPrefixes, want.ProviderPrefixes)
		}
	}
}

// 命中哪条定价必须一致：前缀优先级（opencode-go 先于 opencode）出错会算错单价。
func TestParityPricingMatch(t *testing.T) {
	fixture := loadParityFixture(t)
	index := NewAttributionIndex(fixture.ProviderIDs)
	catalog := NewCatalog(ParseCatalog(fixture.Catalog))
	for _, want := range fixture.Matches {
		record := catalog.Match(index.Resolve(want.Model, want.Provider))
		switch {
		case want.MatchedModel == nil:
			if record != nil {
				t.Fatalf("%q/%q matched %q, want no match", want.Model, want.Provider, record.Model)
			}
		case record == nil:
			t.Fatalf("%q/%q matched nothing, want %q", want.Model, want.Provider, *want.MatchedModel)
		case record.Model != *want.MatchedModel:
			t.Fatalf("%q/%q matched %q, want %q", want.Model, want.Provider, record.Model, *want.MatchedModel)
		}
	}
}

// 成本必须与 Node 同值（相对误差 1e-9）：分档选错或推理单价回落错都会在这里暴露。
func TestParityCost(t *testing.T) {
	fixture := loadParityFixture(t)
	index := NewAttributionIndex(fixture.ProviderIDs)
	catalog := NewCatalog(ParseCatalog(fixture.Catalog))
	for _, want := range fixture.Costs {
		record := catalog.Match(index.Resolve(want.Model, want.Provider))
		got := CalculateCostUSD(Usage{
			InputTokens:              want.Usage.InputTokens,
			OutputTokens:             want.Usage.OutputTokens,
			CacheReadInputTokens:     want.Usage.CacheReadInputTokens,
			CacheCreationInputTokens: want.Usage.CacheCreationInputTokens,
			ReasoningOutputTokens:    want.Usage.ReasoningOutputTokens,
		}, record)
		if !closeEnough(got, want.CostUSD) {
			t.Fatalf("%q/%q usage=%+v cost = %v, want %v", want.Model, want.Provider, want.Usage, got, want.CostUSD)
		}
	}
}

// 声明为 0 与未声明的区别：只有分档、没有基础价的记录必须仍然可计价。
func TestTierOnlyRecordIsValid(t *testing.T) {
	fixture := loadParityFixture(t)
	record, ok := ParseCatalog(fixture.Catalog)["tier-only/model-b"]
	if !ok {
		t.Fatal("只有分档的目录行被当成无效记录，会算出一笔 0 元账单")
	}
	if len(record.ContextCostTiers) != 1 {
		t.Fatalf("tiers = %d, want 1", len(record.ContextCostTiers))
	}
	if _, ok := ParseCatalog(map[string]RawRecord{"empty/row": {}})["empty/row"]; ok {
		t.Fatal("没有任何成本字段的行不该产生定价记录")
	}
}

func closeEnough(got, want float64) bool {
	if got == want {
		return true
	}
	scale := math.Max(math.Abs(got), math.Abs(want))
	return math.Abs(got-want) <= 1e-9*scale
}
