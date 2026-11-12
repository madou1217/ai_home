package accountactivity

// 运行守卫（防抖 + 唯一）：同一事件同一时刻只允许一个运行，且两次触发之间必须
// 间隔 debounce。与 lib/server/scheduled-run-guard.js 同语义，但状态在 Go 进程内。
//
// 为什么必须是进程内单例而不是文件锁：这些动作都是本机副作用操作（领臭鸡蛋要过
// 无痕验证、签到要打上游），重复执行既打上游又没有幂等键；server 只有一个进程，
// 跨进程去重没有意义。重启后窗口重置是刻意接受的。
//
// 键空间与 Node 一致（唯一构造点就是下面两个函数）：
//   activity:<provider>:<actionId>[#<参数指纹>][+...]   领取
//   probe:activity:<provider>:<actionId>                只读探测
// 探测不能吃掉领取的防抖窗口，但两者打的是同一个上游端点，**不能同时进行**。

import (
	"sort"
	"strings"
	"sync"
	"time"
)

// DefaultDebounce 是描述符没有声明 scheduleDebounceMs 时的兜底窗口。
const DefaultDebounce = time.Minute

// ProbeDebounce 是只读探测的短窗口：同样在打上游，但不能占用领取的键。
const ProbeDebounce = 15 * time.Second

// ClaimKey 是领取键（不含参数指纹；指纹由 RunKey 追加）。
func ClaimKey(provider string, actionID string) string {
	return "activity:" + strings.ToLower(strings.TrimSpace(provider)) + ":" + strings.ToLower(strings.TrimSpace(actionID))
}

// ProbeKey 是探测键：与领取分键空间，只用于互斥与探测自己的短防抖窗口。
func ProbeKey(provider string, actionID string) string {
	return "probe:" + ClaimKey(provider, actionID)
}

// DeniedReason 是运行权被拒的结构化原因。
type DeniedReason string

const (
	// DeniedInFlight 表示同一键已有运行在跑。
	DeniedInFlight DeniedReason = "in_flight"
	// DeniedDebounced 表示上一次运行结束得还不够久。
	DeniedDebounced DeniedReason = "debounced"
	// DeniedKeyMissing 表示键为空（调用方 bug）。
	DeniedKeyMissing DeniedReason = "run_key_missing"
)

// Denied 描述一次被拒绝的运行权申请。
type Denied struct {
	Reason        DeniedReason
	NextAllowedAt time.Time
	StartedAt     time.Time
}

type runEntry struct {
	inFlight   bool
	startedAt  time.Time
	finishedAt time.Time
}

// Guard 是进程内运行守卫。
type Guard struct {
	mu   sync.Mutex
	runs map[string]*runEntry
	now  func() time.Time
}

// NewGuard 创建守卫；now 为空时用 time.Now。
func NewGuard(now func() time.Time) *Guard {
	if now == nil {
		now = time.Now
	}
	return &Guard{runs: map[string]*runEntry{}, now: now}
}

// Acquire 尝试获取运行权。成功返回 release（幂等）；失败返回结构化原因。
func (guard *Guard) Acquire(key string, debounce time.Duration) (func(), *Denied) {
	normalized := strings.TrimSpace(key)
	if normalized == "" {
		return nil, &Denied{Reason: DeniedKeyMissing}
	}
	if debounce < 0 {
		debounce = 0
	}
	guard.mu.Lock()
	defer guard.mu.Unlock()
	at := guard.now()
	current := guard.runs[normalized]
	if current != nil && current.inFlight {
		return nil, &Denied{Reason: DeniedInFlight, StartedAt: current.startedAt}
	}
	if current != nil && !current.finishedAt.IsZero() && debounce > 0 && at.Sub(current.finishedAt) < debounce {
		return nil, &Denied{Reason: DeniedDebounced, NextAllowedAt: current.finishedAt.Add(debounce)}
	}
	guard.runs[normalized] = &runEntry{inFlight: true, startedAt: at}
	var once sync.Once
	release := func() {
		once.Do(func() {
			guard.mu.Lock()
			defer guard.mu.Unlock()
			entry := guard.runs[normalized]
			if entry == nil || !entry.startedAt.Equal(at) {
				return
			}
			entry.inFlight = false
			entry.finishedAt = guard.now()
		})
	}
	return release, nil
}

// RunningKeys 返回当前在跑的全部键（升序）。
func (guard *Guard) RunningKeys() []string {
	guard.mu.Lock()
	defer guard.mu.Unlock()
	keys := make([]string, 0, len(guard.runs))
	for key, entry := range guard.runs {
		if entry.inFlight {
			keys = append(keys, key)
		}
	}
	sort.Strings(keys)
	return keys
}

// IsProbeRunning 判断该动作是否正在被探测。
func (guard *Guard) IsProbeRunning(provider string, actionID string) bool {
	wanted := ProbeKey(provider, actionID)
	for _, key := range guard.RunningKeys() {
		if key == wanted {
			return true
		}
	}
	return false
}

// IsClaimRunning 判断该动作是否有领取在跑。
//
// 不能只查裸键：领取键会带参数指纹（#...），多 provider 批量还会用 + 连接，
// 于是「按参数领 acct_b」的键是 activity:zcode:trial_plan#{"accountRefs":["acct_b"]}。
// 这里按 + 拆分、去掉 # 指纹后逐个比对，覆盖全部形态。
func (guard *Guard) IsClaimRunning(provider string, actionID string) bool {
	wanted := ClaimKey(provider, actionID)
	for _, key := range guard.RunningKeys() {
		for _, part := range strings.Split(key, "+") {
			if strings.SplitN(part, "#", 2)[0] == wanted {
				return true
			}
		}
	}
	return false
}
