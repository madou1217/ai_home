package accountrouting

import (
	"errors"
	"math/rand/v2"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

var (
	// ErrUnknownSelectionStrategy 表示宿主配置了未实现的选号策略。
	ErrUnknownSelectionStrategy = errors.New("账号选号策略未知")
)

// SelectionStrategy 是候选账号的选号策略。
type SelectionStrategy string

const (
	// StrategyRoundRobin 按 Provider、模型的公平票号环形轮转，忽略额度权重。
	StrategyRoundRobin SelectionStrategy = "round-robin"
	// StrategyRandom 按剩余额度加权随机；没有额度信息时退化为等概率。
	//
	// 该值是 Node 的默认策略，Go 必须保持一致，否则同一份配置下两端的负载分布不同。
	StrategyRandom SelectionStrategy = "random"
)

// ParseSelectionStrategy 解析宿主配置的选号策略；空值取 Node 同构的默认值。
func ParseSelectionStrategy(value string) (SelectionStrategy, error) {
	switch SelectionStrategy(strings.TrimSpace(strings.ToLower(value))) {
	case "":
		return StrategyRandom, nil
	case StrategyRoundRobin:
		return StrategyRoundRobin, nil
	case StrategyRandom:
		return StrategyRandom, nil
	default:
		return "", ErrUnknownSelectionStrategy
	}
}

// IsValid 判断策略是否属于已实现集合。
func (strategy SelectionStrategy) IsValid() bool {
	return strategy == StrategyRoundRobin || strategy == StrategyRandom
}

// AccountWeightSource 提供账号由最新额度快照推导出的剩余额度。
//
// 实现只回答事实；把剩余额度换算成选号权重是选号策略，留在本包。
type AccountWeightSource interface {
	// AccountRemaining 返回账号剩余额度；无信息时返回未知值。
	AccountRemaining(accountRef accountcore.AccountRef) usagecore.Remaining
}

// selectionWeight 把剩余额度换算成选号权重，与 Node 的 max(1, round(remainingPct)) 同构。
//
// 未知额度取最小权重 1：它表示「没有额度信息」，而不是「额度耗尽」，因此仍然参与
// 选号，只是不会被加权优待。
func selectionWeight(remaining usagecore.Remaining) int {
	if !remaining.Known {
		return 1
	}
	// 基点转百分比的四舍五入：round(bps / 100) == floor((bps + 50) / 100)。
	weight := (int(remaining.BasisPoints) + 50) / 100
	if weight < 1 {
		return 1
	}
	return weight
}

// weightedStart 按剩余额度权重随机选出环形扫描起点。
//
// 候选顺序固定，权重只影响起点分布；后续仍按环形顺序跳过不合格候选，因此选号语义
// 与 Node 的加权随机一致：剩余额度越多的账号越可能被优先尝试。
func weightedStart(
	candidates *accountapp.RoutingCandidates,
	weights AccountWeightSource,
	randomIntN func(int) int,
) int {
	count := candidates.Len()
	if count <= 0 {
		return 0
	}
	if weights == nil || randomIntN == nil {
		return 0
	}
	total := 0
	accountWeights := make([]int, count)
	for index := 0; index < count; index++ {
		candidate, found := candidates.At(index)
		if !found {
			return 0
		}
		weight := selectionWeight(weights.AccountRemaining(candidate.Ref()))
		accountWeights[index] = weight
		total += weight
	}
	if total <= 0 {
		return 0
	}
	offset := randomIntN(total)
	if offset < 0 || offset >= total {
		return 0
	}
	for index, weight := range accountWeights {
		offset -= weight
		if offset < 0 {
			return index
		}
	}
	return count - 1
}

// defaultRandomIntN 是生产使用的全局随机源；math/rand/v2 的全局源自带随机种子。
func defaultRandomIntN(limit int) int {
	return rand.IntN(limit)
}
