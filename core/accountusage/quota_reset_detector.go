package accountusage

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
)

// 重置检测：从连续的额度观测里识别「额度回满」事件。
//
// 判据与 Node lib/account/quota-reset-detector.js 完全一致：
//
//	cycle_rollover  原定关窗时刻已到且额度回满（自然滚动）；
//	replenishment   原定关窗时刻未到但额度回满（提前回血 / 套餐升级）。
//
// 两条铁律：
//  1. 只有「此前存在消耗」才可能重置 —— 100% → 100% 的空转不是事件；
//  2. 只记录回到 100% 的重置 —— 90% → 91% 的浮动小增量不是事件。
//
// 本文件是纯状态机：不读盘、不发请求、不含 Provider 名。
const (
	// QuotaResetToleranceMS 吸收时钟抖动与采集间隔。
	QuotaResetToleranceMS = int64(3 * 60 * 1000)
	// QuotaExhaustedThresholdPct 以下视为「额度耗尽」。
	QuotaExhaustedThresholdPct = 5.0
	// QuotaReplenishedThresholdPct 以上视为「回满」。
	QuotaReplenishedThresholdPct = 99.5
)

// 事件类型。
const (
	QuotaResetKindCycleRollover = "cycle_rollover"
	QuotaResetKindReplenishment = "replenishment"
)

// QuotaDetectorState 是一个 (账号, quotaKey) 的检测基线。
type QuotaDetectorState struct {
	LastRemainingPct      *float64
	LastExpectedResetAtMS int64
	LastCapturedAtMS      int64
	IsArmed               bool
	RearmGeneration       int64
	ExhaustedAtMS         *int64
}

// QuotaResetEvent 是一次被识别出来的额度重置。
type QuotaResetEvent struct {
	EventKey                  string
	ProviderID                string
	QuotaKey                  string
	WindowLabel               string
	WindowMinutes             int64
	EventKind                 string
	Classification            string
	Cause                     string
	PreviousRemainingPct      *float64
	CurrentRemainingPct       *float64
	PreviousExpectedResetAtMS int64
	ExhaustedAtMS             *int64
	OccurredAtMS              int64
	DetectedAtMS              int64
	EarlyDurationMS           int64
}

// AdvanceQuotaDetector 用一个观测推进状态机，返回新状态与可能产生的事件。
//
// hasState=false 表示这是该 (账号, quotaKey) 的首次观测：只建基线，绝不产生事件。
// 观测按 capturedAt 单调推进；乱序或重复时刻的观测被丢弃（与 Node 一致）。
func AdvanceQuotaDetector(
	state QuotaDetectorState,
	hasState bool,
	accountRef string,
	providerID string,
	observation QuotaWindowSample,
) (QuotaDetectorState, *QuotaResetEvent) {
	now := observation.CapturedAtMS
	remaining := observation.RemainingPct
	if now <= 0 {
		return state, nil
	}

	if !hasState {
		// 只要消耗了（< 100%）就进入武装状态，等待回满。
		isArmed := remaining != nil && *remaining < 100
		next := QuotaDetectorState{
			LastRemainingPct:      copyPct(remaining),
			LastExpectedResetAtMS: nonNegative(observation.ExpectedResetAtMS),
			LastCapturedAtMS:      now,
			IsArmed:               isArmed,
		}
		if isArmed {
			next.RearmGeneration = 1
		}
		if remaining != nil && *remaining <= QuotaExhaustedThresholdPct {
			exhausted := now
			next.ExhaustedAtMS = &exhausted
		}
		return next, nil
	}
	if now <= state.LastCapturedAtMS {
		return state, nil
	}

	next := state
	prevRemaining := state.LastRemainingPct
	prevResetAt := state.LastExpectedResetAtMS
	exhaustedAt := state.ExhaustedAtMS

	// 记录额度耗尽时刻（<= 5%），供事件回溯。
	if remaining != nil && *remaining <= QuotaExhaustedThresholdPct && exhaustedAt == nil {
		value := now
		exhaustedAt = &value
	}

	hadConsumption := prevRemaining != nil && *prevRemaining < QuotaReplenishedThresholdPct
	isFullyReplenished := hadConsumption &&
		remaining != nil &&
		*remaining >= QuotaReplenishedThresholdPct

	resetTimestampAdvanced := prevResetAt > 0 &&
		observation.ExpectedResetAtMS > 0 &&
		observation.ExpectedResetAtMS > prevResetAt+QuotaResetToleranceMS
	naturalResetTimePassed := prevResetAt > 0 &&
		now >= prevResetAt-QuotaResetToleranceMS &&
		remaining != nil &&
		*remaining >= QuotaReplenishedThresholdPct

	var event *QuotaResetEvent
	switch {
	case isFullyReplenished && ((resetTimestampAdvanced && now >= prevResetAt-QuotaResetToleranceMS) ||
		naturalResetTimePassed):
		// 自然滚动：物理重置时刻就是原定关窗时刻（比发现时刻更接近真相）。
		occurredAt := prevResetAt
		if occurredAt <= 0 {
			occurredAt = now
		}
		event = &QuotaResetEvent{
			EventKey: buildQuotaResetEventKey(
				accountRef, providerID, observation.QuotaKey, "cycle",
				fmt.Sprintf("%d:%d", prevResetAt, firstPositive(observation.ExpectedResetAtMS, occurredAt)),
			),
			ProviderID:                providerID,
			QuotaKey:                  observation.QuotaKey,
			WindowLabel:               observation.WindowLabel,
			WindowMinutes:             observation.WindowMinutes,
			EventKind:                 QuotaResetKindCycleRollover,
			Classification:            "natural",
			Cause:                     "scheduled",
			PreviousRemainingPct:      copyPct(prevRemaining),
			CurrentRemainingPct:       copyPct(remaining),
			PreviousExpectedResetAtMS: prevResetAt,
			ExhaustedAtMS:             copyInt64(state.ExhaustedAtMS),
			OccurredAtMS:              occurredAt,
			DetectedAtMS:              now,
		}
		next.IsArmed = remaining != nil && *remaining < 100
		if next.IsArmed {
			next.RearmGeneration++
		}
		if remaining != nil && *remaining <= QuotaExhaustedThresholdPct {
			value := now
			exhaustedAt = &value
		} else {
			exhaustedAt = nil
		}
	case isFullyReplenished:
		// 提前回血：原定关窗时刻还没到，额度已经回满。
		isEarly := prevResetAt > 0 && now < prevResetAt-QuotaResetToleranceMS
		earlyDurationMS := int64(0)
		if isEarly {
			earlyDurationMS = maxInt64(prevResetAt-now, 0)
		}
		classification := "natural"
		cause := "scheduled"
		if isEarly {
			classification = "early_inferred"
			cause = "unknown"
		}
		event = &QuotaResetEvent{
			EventKey: buildQuotaResetEventKey(
				accountRef, providerID, observation.QuotaKey, "rearm",
				fmt.Sprintf("%d:%d", state.RearmGeneration, now/60000),
			),
			ProviderID:                providerID,
			QuotaKey:                  observation.QuotaKey,
			WindowLabel:               observation.WindowLabel,
			WindowMinutes:             observation.WindowMinutes,
			EventKind:                 QuotaResetKindReplenishment,
			Classification:            classification,
			Cause:                     cause,
			PreviousRemainingPct:      copyPct(prevRemaining),
			CurrentRemainingPct:       copyPct(remaining),
			PreviousExpectedResetAtMS: prevResetAt,
			ExhaustedAtMS:             copyInt64(state.ExhaustedAtMS),
			OccurredAtMS:              now,
			DetectedAtMS:              now,
			EarlyDurationMS:           earlyDurationMS,
		}
		next.IsArmed = remaining != nil && *remaining < 100
		if remaining != nil && *remaining >= 100 {
			exhaustedAt = nil
		}
	default:
		// 纯消耗分支：武装监控，不产生事件。
		if remaining != nil && *remaining < 100 && !next.IsArmed {
			next.IsArmed = true
			next.RearmGeneration++
		}
	}

	next.LastRemainingPct = copyPct(remaining)
	next.LastExpectedResetAtMS = nonNegative(observation.ExpectedResetAtMS)
	next.LastCapturedAtMS = now
	next.ExhaustedAtMS = exhaustedAt
	return next, event
}

// buildQuotaResetEventKey 生成与 Node 同形状的幂等键（sha256 前 32 位十六进制）。
func buildQuotaResetEventKey(accountRef, providerID, quotaKey, kind, suffix string) string {
	digest := sha256.Sum256([]byte(strings.Join(
		[]string{accountRef, providerID, quotaKey, kind, suffix},
		":",
	)))
	return hex.EncodeToString(digest[:])[:32]
}

func copyPct(value *float64) *float64 {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func copyInt64(value *int64) *int64 {
	if value == nil {
		return nil
	}
	copied := *value
	return &copied
}

func firstPositive(value int64, fallback int64) int64 {
	if value > 0 {
		return value
	}
	return fallback
}

func maxInt64(left int64, right int64) int64 {
	if left > right {
		return left
	}
	return right
}
