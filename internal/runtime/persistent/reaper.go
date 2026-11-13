package persistent

import (
	"context"
	"fmt"
	"math"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultIdleTTLMinutes 是空闲持久会话默认过期分钟数（1440m = 1 天）。
	DefaultIdleTTLMinutes = 24 * 60
	// DefaultMaxIdle 是允许保留的空闲会话上限，超出后按最久未活动淘汰。
	DefaultMaxIdle = 10
)

// ReapReason 表示某条空闲会话进入回收计划的原因。
type ReapReason string

const (
	ReapReasonTTL ReapReason = "ttl"
	ReapReasonLRU ReapReason = "lru"
)

// ReapPolicy 描述空闲持久会话的回收开关、TTL 与上限配额。
type ReapPolicy struct {
	Enabled        bool
	IdleTTLMinutes int
	IdleTTL        time.Duration
	MaxIdle        int
}

// SessionRow 表示一次持久会话枚举返回的统一只读行视图。
type SessionRow struct {
	Provider     string
	RuntimeScope string
	AccountRef   string
	Gateway      bool
	Socket       string
	Name         string
	Label        string
	Path         string
	StartPath    string
	Title        string
	// NativeID 是该会话对应的 Provider 原生会话 id（能直接 resume）；未知为空。
	NativeID         string
	WindowName       string
	Command          string
	PanePID          int
	Live             bool
	CreatedAtMS      int64
	LastActivityAtMS int64
	LastActiveAtMS   int64
	ForwardArgs      []string
}

// ReapCandidate 记录待回收会话及其判定依据。
type ReapCandidate struct {
	Row          SessionRow
	Reason       ReapReason
	LastActiveAt int64
	IdleDuration time.Duration
}

// ReapPlan 是 PlanIdleSessionReap 计算出的纯计划结果。
type ReapPlan struct {
	Policy    ReapPolicy
	IdleCount int
	Expired   []ReapCandidate
	Evicted   []ReapCandidate
	Kept      []SessionRow
}

// ReapFailure 记录单个会话关闭失败时的上下文。
type ReapFailure struct {
	Provider string
	Scope    string
	Name     string
	Socket   string
	Error    string
}

// ReapResult 记录执行回收后的统计与明细。
type ReapResult struct {
	Policy     ReapPolicy
	Scanned    int
	IdleCount  int
	Expired    []ReapCandidate
	Evicted    []ReapCandidate
	Kept       []SessionRow
	Closed     int
	Failed     int
	ClosedRows []SessionRow
	Failures   []ReapFailure
}

// ReapOptions 配置 ReapIdleSessions 的时钟、环境变量读取和关闭端口。
type ReapOptions struct {
	Env            func(string) string
	Now            func() time.Time
	Policy         *ReapPolicy
	IdleTTLMinutes *int
	MaxIdle        *int
	Closer         SessionCloser
}

// ResolveReapPolicy 从环境变量与可选覆盖值解析空闲回收策略。
func ResolveReapPolicy(getenv func(string) string, overrides ...int) ReapPolicy {
	if getenv == nil {
		getenv = os.Getenv
	}
	fallbackTTL := DefaultIdleTTLMinutes
	if len(overrides) > 0 && overrides[0] >= 0 {
		fallbackTTL = overrides[0]
	}
	fallbackMax := DefaultMaxIdle
	if len(overrides) > 1 && overrides[1] >= 0 {
		fallbackMax = overrides[1]
	}
	enabled := strings.TrimSpace(getenv("AIH_SESSION_REAP")) != "0"
	ttlMinutes := readNonNegativeInt(getenv("AIH_SESSION_IDLE_TTL_MINUTES"), fallbackTTL)
	maxIdle := readNonNegativeInt(getenv("AIH_SESSION_MAX_IDLE"), fallbackMax)
	return ReapPolicy{
		Enabled:        enabled,
		IdleTTLMinutes: ttlMinutes,
		IdleTTL:        time.Duration(ttlMinutes) * time.Minute,
		MaxIdle:        maxIdle,
	}
}

// SessionLastActiveAt 计算会话最近一次活动时间戳（Epoch 毫秒，未知则返回 0）。
func SessionLastActiveAt(row SessionRow) int64 {
	best := int64(0)
	for _, candidate := range []int64{
		normalizeEpochMS(row.LastActiveAtMS, false),
		normalizeEpochMS(row.LastActivityAtMS, false),
		normalizeEpochMS(row.CreatedAtMS, true),
	} {
		if candidate > best {
			best = candidate
		}
	}
	return best
}

// PlanIdleSessionReap 为持久会话计算本轮 TTL 过期与 LRU 上限淘汰计划（不执行副作用）。
func PlanIdleSessionReap(rows []SessionRow, now time.Time, policy ReapPolicy) ReapPlan {
	plan := ReapPlan{
		Policy: policy,
		Kept:   append([]SessionRow(nil), rows...),
	}
	if !policy.Enabled {
		return plan
	}

	nowMS := now.UnixMilli()
	ttlMS := policy.IdleTTL.Milliseconds()

	var idle []int
	for index, row := range rows {
		if !row.Live {
			idle = append(idle, index)
		}
	}
	plan.IdleCount = len(idle)
	if len(idle) == 0 {
		return plan
	}

	type idleEntry struct {
		index        int
		row          SessionRow
		lastActiveAt int64
	}
	remaining := make([]idleEntry, 0, len(idle))
	reapedIndices := make(map[int]struct{})

	for _, idx := range idle {
		row := rows[idx]
		lastActive := SessionLastActiveAt(row)
		var idleMS int64
		if lastActive > 0 {
			idleMS = nowMS - lastActive
		}
		if ttlMS > 0 && lastActive > 0 && idleMS >= ttlMS {
			plan.Expired = append(plan.Expired, ReapCandidate{
				Row:          row,
				Reason:       ReapReasonTTL,
				LastActiveAt: lastActive,
				IdleDuration: time.Duration(idleMS) * time.Millisecond,
			})
			reapedIndices[idx] = struct{}{}
		} else {
			remaining = append(remaining, idleEntry{
				index:        idx,
				row:          row,
				lastActiveAt: lastActive,
			})
		}
	}

	if policy.MaxIdle > 0 && len(remaining) > policy.MaxIdle {
		sorted := append([]idleEntry(nil), remaining...)
		sort.SliceStable(sorted, func(i, j int) bool {
			if sorted[i].lastActiveAt != sorted[j].lastActiveAt {
				return sorted[i].lastActiveAt < sorted[j].lastActiveAt
			}
			if sorted[i].row.Name != sorted[j].row.Name {
				return sorted[i].row.Name < sorted[j].row.Name
			}
			return sorted[i].row.Socket < sorted[j].row.Socket
		})
		excess := len(sorted) - policy.MaxIdle
		for _, entry := range sorted[:excess] {
			var idleDur time.Duration
			if entry.lastActiveAt > 0 && nowMS > entry.lastActiveAt {
				idleDur = time.Duration(nowMS-entry.lastActiveAt) * time.Millisecond
			}
			plan.Evicted = append(plan.Evicted, ReapCandidate{
				Row:          entry.row,
				Reason:       ReapReasonLRU,
				LastActiveAt: entry.lastActiveAt,
				IdleDuration: idleDur,
			})
			reapedIndices[entry.index] = struct{}{}
		}
	}

	kept := make([]SessionRow, 0, len(rows)-len(reapedIndices))
	for index, row := range rows {
		if _, removed := reapedIndices[index]; !removed {
			kept = append(kept, row)
		}
	}
	plan.Kept = kept
	return plan
}

// ReapIdleSessions 计算回收计划并逐条调用 Closer 关闭候选会话。
func ReapIdleSessions(ctx context.Context, rows []SessionRow, opts ReapOptions) ReapResult {
	var policy ReapPolicy
	if opts.Policy != nil {
		policy = *opts.Policy
	} else {
		var overrides []int
		if opts.IdleTTLMinutes != nil {
			overrides = append(overrides, *opts.IdleTTLMinutes)
		} else {
			overrides = append(overrides, DefaultIdleTTLMinutes)
		}
		if opts.MaxIdle != nil {
			overrides = append(overrides, *opts.MaxIdle)
		}
		policy = ResolveReapPolicy(opts.Env, overrides...)
	}
	now := time.Now
	if opts.Now != nil {
		now = opts.Now
	}

	plan := PlanIdleSessionReap(rows, now(), policy)
	result := ReapResult{
		Policy:    plan.Policy,
		Scanned:   len(rows),
		IdleCount: plan.IdleCount,
		Expired:   plan.Expired,
		Evicted:   plan.Evicted,
		Kept:      plan.Kept,
	}
	if !plan.Policy.Enabled || opts.Closer == nil {
		return result
	}

	targets := make([]ReapCandidate, 0, len(plan.Expired)+len(plan.Evicted))
	targets = append(targets, plan.Expired...)
	targets = append(targets, plan.Evicted...)
	for _, candidate := range targets {
		if ctx != nil && ctx.Err() != nil {
			result.Failed++
			result.Failures = append(result.Failures, ReapFailure{
				Provider: candidate.Row.Provider,
				Scope:    candidate.Row.RuntimeScope,
				Name:     candidate.Row.Name,
				Socket:   candidate.Row.Socket,
				Error:    ctx.Err().Error(),
			})
			continue
		}
		if err := opts.Closer.CloseSession(ctx, candidate.Row); err != nil {
			result.Failed++
			result.Failures = append(result.Failures, ReapFailure{
				Provider: candidate.Row.Provider,
				Scope:    candidate.Row.RuntimeScope,
				Name:     candidate.Row.Name,
				Socket:   candidate.Row.Socket,
				Error:    err.Error(),
			})
			continue
		}
		result.Closed++
		result.ClosedRows = append(result.ClosedRows, candidate.Row)
	}
	return result
}

// DescribeReapResult 生成与 Node 一致的中文日志摘要；无变更且无失败时返回空串。
func DescribeReapResult(result ReapResult) string {
	if result.Closed == 0 && result.Failed == 0 {
		return ""
	}
	var reasons []string
	if len(result.Expired) > 0 {
		reasons = append(reasons, fmt.Sprintf("空闲超 %s %d 个", formatIdleTTL(result.Policy.IdleTTL), len(result.Expired)))
	}
	if len(result.Evicted) > 0 {
		reasons = append(reasons, fmt.Sprintf("超出 %d 个空闲上限 %d 个", result.Policy.MaxIdle, len(result.Evicted)))
	}
	detail := ""
	if len(reasons) > 0 {
		detail = "（" + strings.Join(reasons, "，") + "）"
	}
	failed := ""
	if result.Failed > 0 {
		failed = fmt.Sprintf("，%d 个失败", result.Failed)
	}
	return fmt.Sprintf("已回收 %d 个空闲会话%s%s", result.Closed, detail, failed)
}

func formatIdleTTL(idleTTL time.Duration) string {
	hours := int(math.Round(float64(idleTTL.Milliseconds()) / 3600000.0))
	if hours >= 24 && hours%24 == 0 {
		return fmt.Sprintf("%d 天", hours/24)
	}
	return fmt.Sprintf("%d 小时", hours)
}

func readNonNegativeInt(raw string, fallback int) int {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(trimmed)
	if err != nil || parsed < 0 {
		return fallback
	}
	return parsed
}

func normalizeEpochMS(value int64, treatSmallAsSeconds bool) int64 {
	if value <= 0 {
		return 0
	}
	if treatSmallAsSeconds && value < 1_000_000_000_000 {
		return value * 1000
	}
	return value
}
