package accountusage

import (
	"context"
	"errors"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// 选号前的额度门禁状态与原因，取值与 Node 的 account-usage-gate 一致
// （lib/server/account-usage-gate.js:106-145）。
const (
	// SchedulingBlockedByQuota 表示最新快照明确显示某个适用窗口已经耗尽。
	SchedulingBlockedByQuota = "blocked_by_quota"
	// SchedulingBlockedByPolicy 表示剩余额度低于服务端阈值。
	SchedulingBlockedByPolicy = "blocked_by_policy"

	// SchedulingReasonExhausted 是额度耗尽的原因码。
	SchedulingReasonExhausted = "usage_exhausted"
	// SchedulingReasonBelowThreshold 是低于服务端阈值的原因码。
	SchedulingReasonBelowThreshold = "usage_below_server_threshold"
)

// SchedulingDecision 是一次选号前额度判定。
//
// Blocked 为 false 时其余字段无意义；RemainingKnown 为 false 表示快照里没有
// 适用于该模型的剩余比例（仍然允许选号，与 Node 的 ALLOW 同义）。
type SchedulingDecision struct {
	Blocked              bool
	Status               string
	Reason               string
	RemainingBasisPoints uint16
	RemainingKnown       bool
}

// EvaluateScheduling 判断账号能否为该模型承接请求。
//
// 语义与 Node 的 account-usage-gate.evaluate 对齐：
//   - 没有该 Provider 的额度策略、没有快照、快照 Provider 不符 → 不阻断；
//   - 任一适用条目明确耗尽 → blocked_by_quota / usage_exhausted；
//   - 适用条目里最小剩余 ≤ 阈值 → blocked_by_policy / usage_below_server_threshold；
//   - 其余情况放行。
//
// minimumBasisPoints 是「剩余百分比下限」的基点值（Node 的 100-threshold_pct）；
// 0 表示只拦真正耗尽的账号。
func (service *Service) EvaluateScheduling(
	ctx context.Context,
	providerID string,
	accountRef accountcore.AccountRef,
	modelID runtimecore.ModelID,
	minimumBasisPoints uint16,
) (SchedulingDecision, error) {
	if service == nil || ctx == nil || !accountRef.IsValid() || !modelID.IsValid() {
		return SchedulingDecision{}, ErrInvalidRequest
	}
	strategy := service.strategies[providerID]
	if strategy == nil {
		return SchedulingDecision{}, nil
	}
	snapshot, err := service.store.GetUsageSnapshot(ctx, accountRef)
	if err != nil {
		if errors.Is(err, ErrSnapshotNotFound) {
			return SchedulingDecision{}, nil
		}
		return SchedulingDecision{}, err
	}
	if !snapshot.IsValid() || snapshot.ProviderID() != providerID {
		return SchedulingDecision{}, nil
	}
	return evaluateSchedulingSnapshot(strategy, snapshot, modelID, minimumBasisPoints), nil
}

// evaluateSchedulingSnapshot 是纯函数版本，便于表驱动测试。
func evaluateSchedulingSnapshot(
	strategy ProviderStrategy,
	snapshot usagecore.Snapshot,
	modelID runtimecore.ModelID,
	minimumBasisPoints uint16,
) SchedulingDecision {
	decision := SchedulingDecision{}
	for _, entry := range snapshot.Entries() {
		switch entry.Scope() {
		case usagecore.ScopeAccount:
		case usagecore.ScopeModelFamily:
			if !strategy.MatchesModelFamily(entry.ScopeKey(), modelID) {
				continue
			}
		default:
			continue
		}
		if entry.Availability() == usagecore.AvailabilityExhausted {
			return SchedulingDecision{
				Blocked: true,
				Status:  SchedulingBlockedByQuota,
				Reason:  SchedulingReasonExhausted,
			}
		}
		basisPoints, known := entry.RemainingBasisPoints()
		if !known {
			continue
		}
		if !decision.RemainingKnown || basisPoints < decision.RemainingBasisPoints {
			decision.RemainingKnown = true
			decision.RemainingBasisPoints = basisPoints
		}
	}
	if decision.RemainingKnown && decision.RemainingBasisPoints <= minimumBasisPoints {
		decision.Blocked = true
		decision.Status = SchedulingBlockedByPolicy
		decision.Reason = SchedulingReasonBelowThreshold
	}
	return decision
}

// MinimumRemainingBasisPoints 把 Node 的 threshold_pct 换算成剩余下限基点。
//
// Node 的 threshold_pct 是「用到多少就停」：95 表示剩余 ≤5% 停池
// （lib/account/derived-state.js:32-37）。非有限值按默认 95 处理，范围夹在 1..100。
func MinimumRemainingBasisPoints(thresholdPct float64) uint16 {
	if thresholdPct != thresholdPct || thresholdPct < 1 || thresholdPct > 100 {
		thresholdPct = 95
	}
	remaining := 100 - thresholdPct
	return uint16(remaining * 100)
}
