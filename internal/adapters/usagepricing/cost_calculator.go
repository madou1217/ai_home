package usagepricing

import (
	"context"
	"errors"
	"sync"
	"time"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/usageledger"
)

// ErrInvalidDependencies 表示成本计算器缺少定价目录来源。
var ErrInvalidDependencies = errors.New("usagepricing: 缺少定价目录来源")

// ModelPricingLoader 提供原始定价目录（通常是 model_usage_pricing 表）。
type ModelPricingLoader interface {
	LoadModelPricing(ctx context.Context) (map[string]RawRecord, error)
}

// DefaultPricingRefreshInterval 是定价目录的缓存时长。
//
// 定价变化以天为单位，而用量查询是秒级；每次查询都读表既浪费又会在 N 行模型上
// 放大成 N 次查询。5 分钟是一个「改价后最多迟 5 分钟生效」的折中。
const DefaultPricingRefreshInterval = 5 * time.Minute

// PricingSnapshot 是一份不可变的定价快照，可并发使用。
type PricingSnapshot struct {
	catalog     *Catalog
	attribution *AttributionIndex
}

// NewPricingSnapshot 用 Provider 列表与定价目录构造快照。
func NewPricingSnapshot(providerIDs []string, pricing map[string]Record) *PricingSnapshot {
	return &PricingSnapshot{
		catalog:     NewCatalog(pricing),
		attribution: NewAttributionIndex(providerIDs),
	}
}

// CostFor 计算一条模型用量的成本。第二个返回值为 false 表示目录里没有该模型。
func (snapshot *PricingSnapshot) CostFor(provider, model string, usage Usage) (float64, bool) {
	if snapshot == nil || snapshot.catalog == nil {
		return 0, false
	}
	record := snapshot.catalog.Match(snapshot.attribution.Resolve(model, provider))
	if record == nil {
		return 0, false
	}
	return CalculateCostUSD(usage, record), true
}

// ModelCostCalculator 为一批模型用量补充成本，实现 usagestatsapi 的成本端口。
//
// 为什么按批而不是按行：目录加载要读一整张表，按行调用会把一次查询放大成 N 次。
type ModelCostCalculator struct {
	loader      ModelPricingLoader
	providerIDs []string
	interval    time.Duration
	now         func() time.Time

	mu          sync.Mutex
	snapshot    *PricingSnapshot
	lastAttempt time.Time
}

// NewModelCostCalculator 创建成本计算器；providerIDs 来自 Provider 目录真值源。
func NewModelCostCalculator(
	loader ModelPricingLoader,
	providerIDs []string,
) (*ModelCostCalculator, error) {
	if loader == nil {
		return nil, ErrInvalidDependencies
	}
	return &ModelCostCalculator{
		loader:      loader,
		providerIDs: append([]string(nil), providerIDs...),
		interval:    DefaultPricingRefreshInterval,
		now:         time.Now,
	}, nil
}

// Costs 返回与输入等长的成本列表；第二个返回值表示定价目录是否可用。
//
// 目录读取失败时返回 supported=false 而不是错误：用量统计本身仍然有效，
// 只是没有成本口径，调用方应把 cost 标成「未知」而不是「0 元」。
func (calculator *ModelCostCalculator) Costs(
	ctx context.Context,
	models []usageledger.ModelStats,
) ([]float64, []bool, bool) {
	snapshot := calculator.snapshotFor(ctx)
	if snapshot == nil {
		return nil, nil, false
	}
	costs := make([]float64, len(models))
	known := make([]bool, len(models))
	for index, row := range models {
		cost, ok := snapshot.CostFor(row.Provider, row.Model, Usage{
			InputTokens:              int64(row.InputTokens),
			OutputTokens:             int64(row.OutputTokens),
			CacheReadInputTokens:     int64(row.CacheReadInputTokens),
			CacheCreationInputTokens: int64(row.CacheWriteInputTokens),
			ReasoningOutputTokens:    int64(row.ReasoningOutputTokens),
		})
		costs[index] = cost
		known[index] = ok
	}
	return costs, known, true
}

// snapshotFor 返回缓存快照，过期或缺失时重新加载；加载失败返回 nil（下次再试）。
func (calculator *ModelCostCalculator) snapshotFor(ctx context.Context) *PricingSnapshot {
	if calculator == nil {
		return nil
	}
	calculator.mu.Lock()
	defer calculator.mu.Unlock()
	now := calculator.now()
	// 失败也要记时间：否则定价表读不到时，每个窗口的每个模型都会重试一次，
	// 把一次故障放大成 N 次查询。
	if !calculator.lastAttempt.IsZero() && now.Sub(calculator.lastAttempt) < calculator.interval {
		return calculator.snapshot
	}
	calculator.lastAttempt = now
	raw, err := calculator.loader.LoadModelPricing(ctx)
	if err != nil {
		calculator.snapshot = nil
		return nil
	}
	calculator.snapshot = NewPricingSnapshot(calculator.providerIDs, ParseCatalog(raw))
	return calculator.snapshot
}

// WindowPricer 让同一个定价快照同时服务窗口统计（逐模型计价）。
type WindowPricer struct {
	calculator *ModelCostCalculator
}

// NewWindowPricer 用已建好的计算器构造窗口定价端口；共用缓存，避免两套目录。
func NewWindowPricer(calculator *ModelCostCalculator) (*WindowPricer, error) {
	if calculator == nil {
		return nil, ErrInvalidDependencies
	}
	return &WindowPricer{calculator: calculator}, nil
}

// CostFor 实现 accountusage.QuotaWindowPricer。
func (pricer *WindowPricer) CostFor(
	ctx context.Context,
	provider string,
	model string,
	usage usagecore.QuotaWindowModelUsage,
) (float64, bool) {
	snapshot := pricer.calculator.snapshotFor(ctx)
	if snapshot == nil {
		return 0, false
	}
	return snapshot.CostFor(provider, model, Usage{
		InputTokens:              usage.InputTokens,
		OutputTokens:             usage.OutputTokens,
		CacheReadInputTokens:     usage.CacheReadInputTokens,
		CacheCreationInputTokens: usage.CacheCreationInputTokens,
		ReasoningOutputTokens:    usage.ReasoningOutputTokens,
	})
}
