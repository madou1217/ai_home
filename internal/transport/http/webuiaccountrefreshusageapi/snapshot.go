package webuiaccountrefreshusageapi

import (
	"errors"
	"math"
	"strings"
	"time"
)

// ErrInvalidSnapshot 表示探测结果与路由目标不一致，或窗口字段越界。
var ErrInvalidSnapshot = errors.New("额度探测快照无效")

// 与 Go 额度事实（core/accountusage）同名的稳定枚举值。
const (
	kindWindow       = "window"
	kindCredits      = "credits"
	scopeAccount     = "account"
	scopeModelFamily = "model_family"

	availabilityUnknown   = "unknown"
	availabilityAvailable = "available"
	availabilityExhausted = "exhausted"
	availabilityUnlimited = "unlimited"
	availabilityDisabled  = "disabled"
)

// Window 是一次额度探测归一后的单个额度窗口。
//
// 字段与 Go 的额度事实（core/accountusage.Entry）一一对应，只把剩余比例从基点
// 换算成展示层直接消费的百分比。零值语义与额度事实一致：RemainingPct 为 nil 表示
// 「未知」而不是「已耗尽」，WindowSeconds 为 0 表示 Provider 未提供窗口长度，
// ResetAt 为零值表示 Provider 未提供恢复时间。
type Window struct {
	// LimitID 是 Provider 的额度组标识；空值表示只有默认额度组。
	LimitID string
	// LimitName 是额度组展示名。
	LimitName string
	// Bucket 是额度组内稳定条目标识，例如 primary 或 five_hour。
	Bucket string
	// Kind 取 window 或 credits。
	Kind string
	// Scope 取 account 或 model_family。
	Scope string
	// ScopeKey 只在 model_family 作用域下保存 Provider 内部稳定族名。
	ScopeKey string
	// RemainingPct 是 0–100 的剩余百分比；nil 表示未知。
	RemainingPct *float64
	// WindowSeconds 是窗口长度秒数；0 表示未提供。
	WindowSeconds int64
	// ResetAt 是额度恢复时间；零值表示未提供。
	ResetAt time.Time
	// Availability 是探测方已确认的稳定可用性。
	Availability string
}

// Snapshot 是一次额度探测的完整结果。
//
// 探测方负责访问 Provider 并持久化额度事实；本包只用它组装响应。Provider 与
// AccountRef 必须回指被刷新的账号，防止把别的账号的快照写进这次响应。
type Snapshot struct {
	Provider   string
	AccountRef string
	PlanType   string
	Source     string
	CapturedAt time.Time
	Windows    []Window
}

// validate 校验快照身份与窗口字段，避免把错账号或越界数据当成刷新成功。
func (snapshot Snapshot) validate(provider string, accountRef string) error {
	if strings.ToLower(strings.TrimSpace(snapshot.Provider)) != provider ||
		strings.TrimSpace(snapshot.AccountRef) != accountRef ||
		snapshot.CapturedAt.IsZero() ||
		len(snapshot.Windows) == 0 {
		return ErrInvalidSnapshot
	}
	for _, window := range snapshot.Windows {
		if !window.isValid() {
			return ErrInvalidSnapshot
		}
	}
	return nil
}

// isValid 只拦截会破坏展示语义的字段组合，不复制领域层的全部不变量。
func (window Window) isValid() bool {
	bucket := strings.TrimSpace(window.Bucket)
	scopeKey := strings.TrimSpace(window.ScopeKey)
	if bucket == "" || window.WindowSeconds < 0 || !validAvailability(window.Availability) {
		return false
	}
	switch window.Kind {
	case kindWindow:
		// 时间窗口不会出现 Credits 专属状态。
		if window.Availability == availabilityUnlimited || window.Availability == availabilityDisabled {
			return false
		}
	case kindCredits:
	default:
		return false
	}
	switch window.Scope {
	case scopeAccount:
		if scopeKey != "" {
			return false
		}
	case scopeModelFamily:
		if scopeKey == "" {
			return false
		}
	default:
		return false
	}
	if window.RemainingPct != nil {
		remaining := *window.RemainingPct
		if math.IsNaN(remaining) || remaining < 0 || remaining > 100 {
			return false
		}
	}
	return true
}

func validAvailability(value string) bool {
	switch value {
	case availabilityUnknown,
		availabilityAvailable,
		availabilityExhausted,
		availabilityUnlimited,
		availabilityDisabled:
		return true
	default:
		return false
	}
}
