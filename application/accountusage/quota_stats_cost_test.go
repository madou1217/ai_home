package accountusage

import (
	"context"
	"testing"
	"time"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// fakeQuotaPricer 按模型给固定成本；present=false 模拟「这个模型没有定价」。
type fakeQuotaPricer struct {
	costs   map[string]float64
	missing map[string]bool
	calls   int
}

func (fake *fakeQuotaPricer) CostFor(
	_ context.Context,
	_ string,
	model string,
	_ usagecore.QuotaWindowModelUsage,
) (float64, bool) {
	fake.calls++
	if fake.missing[model] {
		return 0, false
	}
	cost, ok := fake.costs[model]
	return cost, ok
}

func newQuotaStatsServiceWithPricer(
	t *testing.T,
	usage *fakeQuotaUsage,
	pricer QuotaWindowPricer,
) *QuotaStatsService {
	t.Helper()
	base := time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
	const hour = int64(60 * 60 * 1000)
	baseMS := base.UnixMilli()
	samples := &fakeQuotaSamples{
		scopes: []usagecore.QuotaWindowScope{
			{QuotaKey: "rate_limit:primary", WindowLabel: "5h", WindowMinutes: 300, SampleCount: 4, LastCapturedAtMS: baseMS + 7*hour},
		},
		samples: []usagecore.QuotaWindowSample{
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(80), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 10*60_000},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(20), ExpectedResetAtMS: baseMS + 5*hour, CapturedAtMS: baseMS + 3*hour},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(99), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 6*hour + 10*60_000},
			{QuotaKey: "rate_limit:primary", WindowMinutes: 300, RemainingPct: float64Ptr(60), ExpectedResetAtMS: baseMS + 11*hour, CapturedAtMS: baseMS + 7*hour},
		},
	}
	service, err := NewQuotaStatsService(QuotaStatsDependencies{
		Samples:   samples,
		Usage:     usage,
		Ledger:    &fakeQuotaLedger{},
		Events:    &fakeQuotaEvents{},
		Snapshots: &fakeQuotaSnapshots{err: ErrSnapshotNotFound},
		Clock:     func() time.Time { return base.Add(8 * time.Hour) },
		Pricer:    pricer,
	})
	if err != nil {
		t.Fatalf("NewQuotaStatsService() error = %v", err)
	}
	return service
}

func buildStats(t *testing.T, service *QuotaStatsService) QuotaStatsResult {
	t.Helper()
	result, err := service.BuildQuotaStats(context.Background(), QuotaStatsQuery{AccountRef: testAccountRef(t)})
	if err != nil {
		t.Fatalf("BuildQuotaStats() error = %v", err)
	}
	return result
}

// 每个窗口的成本 = 窗口内各模型成本之和；汇总 = 各窗口之和。
func TestQuotaStatsPricesWindows(t *testing.T) {
	usage := &fakeQuotaUsage{usages: []usagecore.QuotaWindowUsage{
		{Index: 0, Tokens: 200, RequestCount: 2, Models: []usagecore.QuotaWindowModelUsage{
			{Provider: "codex", Model: "gpt-5.1", Tokens: 120},
			{Provider: "codex", Model: "gpt-5.1-mini", Tokens: 80},
		}},
		{Index: 1, Tokens: 400, RequestCount: 4, Models: []usagecore.QuotaWindowModelUsage{
			{Provider: "codex", Model: "gpt-5.1", Tokens: 400},
		}},
	}}
	pricer := &fakeQuotaPricer{costs: map[string]float64{"gpt-5.1": 0.5, "gpt-5.1-mini": 0.25}}
	result := buildStats(t, newQuotaStatsServiceWithPricer(t, usage, pricer))
	if !result.CostSupported {
		t.Fatal("cost_supported = false, want true")
	}
	if len(result.Windows) != 2 {
		t.Fatalf("windows = %d", len(result.Windows))
	}
	if result.Windows[0].CostUSD == nil || *result.Windows[0].CostUSD != 0.75 {
		t.Fatalf("window0 cost = %v, want 0.75", result.Windows[0].CostUSD)
	}
	if result.Windows[1].CostUSD == nil || *result.Windows[1].CostUSD != 0.5 {
		t.Fatalf("window1 cost = %v, want 0.5", result.Windows[1].CostUSD)
	}
	if result.Summary.TotalCostUSD == nil || *result.Summary.TotalCostUSD != 1.25 {
		t.Fatalf("total = %v, want 1.25", result.Summary.TotalCostUSD)
	}
	if !result.Summary.CostKnown {
		t.Fatal("summary cost_known = false")
	}
	if result.Summary.AvgCostUSDPerWindow == nil || *result.Summary.AvgCostUSDPerWindow != 0.625 {
		t.Fatalf("avg = %v, want 0.625", result.Summary.AvgCostUSDPerWindow)
	}
}

// 窗口里只要有一个模型没有定价，整个窗口与汇总的成本都是「未知」，不能给部分合计。
func TestQuotaStatsMarksWindowUnknownWhenAnyModelUnpriced(t *testing.T) {
	usage := &fakeQuotaUsage{usages: []usagecore.QuotaWindowUsage{
		{Index: 0, Tokens: 200, RequestCount: 2, Models: []usagecore.QuotaWindowModelUsage{
			{Provider: "codex", Model: "gpt-5.1", Tokens: 120},
			{Provider: "codex", Model: "mystery-model", Tokens: 80},
		}},
	}}
	pricer := &fakeQuotaPricer{
		costs:   map[string]float64{"gpt-5.1": 0.5},
		missing: map[string]bool{"mystery-model": true},
	}
	result := buildStats(t, newQuotaStatsServiceWithPricer(t, usage, pricer))
	if len(result.Windows) == 0 {
		t.Fatal("没有窗口")
	}
	checked := 0
	for _, window := range result.Windows {
		if window.Tokens == 0 {
			// 空窗口是确定的 0 元，另有专门用例。
			continue
		}
		checked++
		if window.CostUSD != nil {
			t.Fatalf("成本应为未知，got %v", *window.CostUSD)
		}
		if window.CostKnown {
			t.Fatal("cost_known = true，部分定价被当成完整成本")
		}
	}
	if checked == 0 {
		t.Fatal("没有命中带用量的窗口，用例没验证到目标行为")
	}
	if result.Summary.TotalCostUSD != nil {
		t.Fatalf("total = %v, want null", *result.Summary.TotalCostUSD)
	}
	if result.Summary.CostKnown {
		t.Fatal("summary cost_known = true")
	}
}

// 没有定价端口时统计照常返回，只是没有成本口径。
func TestQuotaStatsWithoutPricerLeavesCostNull(t *testing.T) {
	usage := &fakeQuotaUsage{usages: []usagecore.QuotaWindowUsage{
		{Index: 0, Tokens: 200, RequestCount: 2, Models: []usagecore.QuotaWindowModelUsage{
			{Provider: "codex", Model: "gpt-5.1", Tokens: 200},
		}},
	}}
	service := newQuotaStatsServiceWithPricer(t, usage, nil)
	result := buildStats(t, service)
	if result.CostSupported {
		t.Fatal("cost_supported = true without a pricer")
	}
	if result.Summary.TotalCostUSD != nil || result.Summary.CostKnown {
		t.Fatal("没有定价口径时汇总成本必须为空")
	}
}

// 窗口里没有请求时 0 元是确定事实；空窗口不该把整份汇总拖成未知。
func TestQuotaStatsTreatsEmptyWindowCostAsZero(t *testing.T) {
	usage := &fakeQuotaUsage{usages: []usagecore.QuotaWindowUsage{
		{Index: 0, Tokens: 0, RequestCount: 0},
	}}
	pricer := &fakeQuotaPricer{costs: map[string]float64{}}
	result := buildStats(t, newQuotaStatsServiceWithPricer(t, usage, pricer))
	if len(result.Windows) == 0 {
		t.Fatal("没有窗口")
	}
	if result.Windows[0].CostUSD == nil || *result.Windows[0].CostUSD != 0 {
		t.Fatalf("空窗口成本 = %v, want 0", result.Windows[0].CostUSD)
	}
	if !result.Windows[0].CostKnown {
		t.Fatal("空窗口的成本应为已知的 0")
	}
	if !result.Summary.CostKnown {
		t.Fatal("空窗口把汇总拖成了未知")
	}
}
