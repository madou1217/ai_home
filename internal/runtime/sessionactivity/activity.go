// Package sessionactivity 提供账号实时活动状态机、持久 CLI 会话与原生终态/限流轮询。
//
// 本包对应并完整接管原 Node 运行时中的四项后台职责：
//   1. AccountActivity：内存态 per-(provider, accountRef) in-flight/rate/turn/runtime 计数，
//      以及每 1s 原子落盘到 <AIHomeDir>/run/account-activity.json 并触发变化回调；
//   2. SessionActivityPoller：轮询受管持久会话（tmux pane + Cline/Kiro 会话存储探针），
//      区分「终端打开（runtimeActive）」与「回合运行（sessionTurnActive）」，停用账号跳过；
//   3. Cline / Kiro NativeSessionOutcomePoller：提取原生 CLI 终态与 usage_summary 结果，
//      以 app-state.db KV 游标幂等去重后记入账号结果统计；
//   4. CodebuddySessionLimitObserver：扫描 CodeBuddy 家族原生 JSONL 中的 429 reset at /
//      Credits exhausted 报错，解析模型与归属并通知运行态限流冷却。
package sessionactivity

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	// DefaultRateWindow 是统计账号请求速率（rate）的滑动窗口。
	DefaultRateWindow = 10 * time.Second
	// DefaultSessionTurnTTL 是原生 CLI 回合事件（markSessionTurn）的默认存活时间。
	DefaultSessionTurnTTL = 120 * time.Second
	// DefaultSessionRuntimeTTL 是持久终端会话标记（markRuntime）的默认存活时间。
	DefaultSessionRuntimeTTL = 15 * time.Second
	// DefaultFlushInterval 是账号活动快照落盘周期。
	DefaultFlushInterval = time.Second
	// MaxRateSamples 限制单账号在内存保留的速率样本数，避免极端突刺无限增长。
	MaxRateSamples = 1000
)

// AccountActivityOptions 配置 AccountActivity 实例的窗口、TTL 与时钟。
type AccountActivityOptions struct {
	Window            time.Duration
	SessionTurnTTL    time.Duration
	SessionRuntimeTTL time.Duration
	Now               func() time.Time
}

// AccountSnapshot 对外暴露单个账号在快照时刻的活动视图，JSON 字段名与 WebUI/CLI 契约一致。
type AccountSnapshot struct {
	Provider          string   `json:"provider"`
	AccountRef        string   `json:"accountRef"`
	InFlight          int      `json:"inFlight"`
	SessionTurnActive bool     `json:"sessionTurnActive"`
	RuntimeActive     bool     `json:"runtimeActive"`
	RuntimeServing    bool     `json:"runtimeServing"`
	RuntimeSessions   int      `json:"runtimeSessions"`
	RuntimeAttached   int      `json:"runtimeAttached"`
	Rate              int      `json:"rate"`
	ActiveModels      []string `json:"activeModels"`
	LastActivityAt    int64    `json:"lastActivityAt"`
	UpdatedAt         int64    `json:"updatedAt"`
}

// SelectionLoad 返回调度器读取的实时负载（不含附加终端的 UI 近似值）。
type SelectionLoad struct {
	InFlight      int
	ModelInFlight int
	Rate          int
	WindowMS      int64
}

// ActivityDocument 是落盘到 run/account-activity.json 的完整 JSON 文档。
type ActivityDocument struct {
	UpdatedAt int64                      `json:"updatedAt"`
	Accounts  map[string]AccountSnapshot `json:"accounts"`
}

type accountState struct {
	inFlight         int
	modelInFlight    map[string]int
	samples          []int64
	lastActivityAt   int64
	sessionTurnUntil int64
	runtimeUntil     int64
	runtimeSessions  int
	runtimeAttached  int
}

// AccountActivity 维护线程安全的 per-(provider, accountRef) 实时活动状态。
type AccountActivity struct {
	mu                sync.Mutex
	windowMS          int64
	sessionTurnTTLMS  int64
	sessionRuntimeTTL int64
	now               func() time.Time
	states            map[string]*accountState
}

// NewAccountActivity 创建实时活动状态跟踪器。
func NewAccountActivity(options AccountActivityOptions) *AccountActivity {
	window := options.Window
	if window < time.Second {
		window = DefaultRateWindow
	}
	turnTTL := options.SessionTurnTTL
	if turnTTL < time.Second {
		turnTTL = DefaultSessionTurnTTL
	}
	runtimeTTL := options.SessionRuntimeTTL
	if runtimeTTL < time.Second {
		runtimeTTL = DefaultSessionRuntimeTTL
	}
	nowFn := options.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &AccountActivity{
		windowMS:          window.Milliseconds(),
		sessionTurnTTLMS:  turnTTL.Milliseconds(),
		sessionRuntimeTTL: runtimeTTL.Milliseconds(),
		now:               nowFn,
		states:            make(map[string]*accountState),
	}
}

// WindowDuration 返回速率滑动窗口长度。
func (activity *AccountActivity) WindowDuration() time.Duration {
	return time.Duration(activity.windowMS) * time.Millisecond
}

func activityKeyOf(provider, accountRef string) string {
	ref := strings.TrimSpace(accountRef)
	if ref == "" {
		return ""
	}
	return strings.ToLower(strings.TrimSpace(provider)) + ":" + ref
}

func normalizeModelName(model string) string {
	return strings.ToLower(strings.TrimSpace(model))
}

func (activity *AccountActivity) getOrCreateStateLocked(key string) *accountState {
	state, ok := activity.states[key]
	if !ok {
		state = &accountState{
			modelInFlight: make(map[string]int),
		}
		activity.states[key] = state
	}
	return state
}

func (activity *AccountActivity) nowMS() int64 {
	return activity.now().UnixMilli()
}

func (activity *AccountActivity) pruneLocked(state *accountState, nowMS int64) {
	cutoff := nowMS - activity.windowMS
	idx := 0
	for idx < len(state.samples) && state.samples[idx] < cutoff {
		idx++
	}
	if idx > 0 {
		state.samples = append([]int64(nil), state.samples[idx:]...)
	}
}

// Begin 记录网关一次请求 attempt 开始，in-flight +1 并写入速率样本。
func (activity *AccountActivity) Begin(provider, accountRef, model string) {
	if activity == nil {
		return
	}
	key := activityKeyOf(provider, accountRef)
	if key == "" {
		return
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	state := activity.getOrCreateStateLocked(key)
	state.inFlight++
	if m := normalizeModelName(model); m != "" {
		state.modelInFlight[m]++
	}
	at := activity.nowMS()
	state.lastActivityAt = at
	state.samples = append(state.samples, at)
	if len(state.samples) > MaxRateSamples {
		state.samples = append([]int64(nil), state.samples[len(state.samples)-MaxRateSamples:]...)
	}
}

// End 记录网关一次请求 attempt 结束，in-flight -1（下限 0）。
func (activity *AccountActivity) End(provider, accountRef, model string) {
	if activity == nil {
		return
	}
	key := activityKeyOf(provider, accountRef)
	if key == "" {
		return
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	state, ok := activity.states[key]
	if !ok {
		return
	}
	if state.inFlight > 0 {
		state.inFlight--
	}
	if m := normalizeModelName(model); m != "" {
		rem := state.modelInFlight[m] - 1
		if rem > 0 {
			state.modelInFlight[m] = rem
		} else {
			delete(state.modelInFlight, m)
		}
	}
	// 防御不成对的旧调用：已无在途请求时清空模型集合，避免 UI 假燃烧。
	if state.inFlight == 0 {
		clear(state.modelInFlight)
	}
	state.lastActivityAt = activity.nowMS()
}

// MarkSessionTurn 刷新原生会话回合活跃期限。ttl <= 0 时使用默认值。
func (activity *AccountActivity) MarkSessionTurn(provider, accountRef string, ttl time.Duration) {
	if activity == nil {
		return
	}
	key := activityKeyOf(provider, accountRef)
	if key == "" {
		return
	}
	ttlMS := activity.sessionTurnTTLMS
	if ttl > 0 {
		ttlMS = max(int64(1000), ttl.Milliseconds())
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	state := activity.getOrCreateStateLocked(key)
	at := activity.nowMS()
	state.sessionTurnUntil = at + ttlMS
	state.lastActivityAt = at
}

// EndSessionTurn 在收到明确结束信号时立即清除原生会话回合活跃标记。
func (activity *AccountActivity) EndSessionTurn(provider, accountRef string) {
	if activity == nil {
		return
	}
	key := activityKeyOf(provider, accountRef)
	if key == "" {
		return
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	state, ok := activity.states[key]
	if !ok {
		return
	}
	state.sessionTurnUntil = 0
	state.lastActivityAt = activity.nowMS()
}

// MarkRuntime 刷新持久终端会话的存在与附着数量（不直接等价为 inFlight）。
func (activity *AccountActivity) MarkRuntime(provider, accountRef string, sessions, attached int, ttl time.Duration) {
	if activity == nil {
		return
	}
	key := activityKeyOf(provider, accountRef)
	if key == "" {
		return
	}
	ttlMS := activity.sessionRuntimeTTL
	if ttl > 0 {
		ttlMS = max(int64(1000), ttl.Milliseconds())
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	state := activity.getOrCreateStateLocked(key)
	at := activity.nowMS()
	state.runtimeUntil = at + ttlMS
	state.runtimeSessions = max(0, sessions)
	state.runtimeAttached = max(0, attached)
	state.lastActivityAt = at
}

// ResetAccount 在账号停用或删除时立刻清空该账号的全部活动痕迹。
func (activity *AccountActivity) ResetAccount(provider, accountRef string) bool {
	if activity == nil {
		return false
	}
	key := activityKeyOf(provider, accountRef)
	if key == "" {
		return false
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	if _, ok := activity.states[key]; !ok {
		return false
	}
	delete(activity.states, key)
	return true
}

// Snapshot 生成并裁剪全量活动快照，仅输出存在活动或最近痕迹的账号。
func (activity *AccountActivity) Snapshot() map[string]AccountSnapshot {
	result := make(map[string]AccountSnapshot)
	if activity == nil {
		return result
	}
	activity.mu.Lock()
	defer activity.mu.Unlock()

	snapshotAt := activity.nowMS()
	for key, state := range activity.states {
		activity.pruneLocked(state, snapshotAt)
		sessionTurnActive := state.sessionTurnUntil > snapshotAt
		if !sessionTurnActive {
			state.sessionTurnUntil = 0
		}
		runtimeActive := state.runtimeUntil > snapshotAt
		if !runtimeActive {
			state.runtimeUntil = 0
			state.runtimeSessions = 0
			state.runtimeAttached = 0
		}
		runtimeServing := runtimeActive && state.runtimeAttached > 0
		if state.inFlight <= 0 &&
			!sessionTurnActive &&
			!runtimeActive &&
			len(state.samples) <= 0 &&
			state.lastActivityAt <= 0 {
			delete(activity.states, key)
			continue
		}

		sep := strings.IndexByte(key, ':')
		prov := key
		ref := ""
		if sep >= 0 {
			prov = key[:sep]
			ref = key[sep+1:]
		}
		models := make([]string, 0, len(state.modelInFlight))
		for m, count := range state.modelInFlight {
			if count > 0 {
				models = append(models, m)
			}
		}
		sort.Strings(models)

		inFlight := state.inFlight
		if sessionTurnActive {
			inFlight++
		}
		result[key] = AccountSnapshot{
			Provider:          prov,
			AccountRef:        ref,
			InFlight:          inFlight,
			SessionTurnActive: sessionTurnActive,
			RuntimeActive:     runtimeActive,
			RuntimeServing:    runtimeServing,
			RuntimeSessions:   state.runtimeSessions,
			RuntimeAttached:   state.runtimeAttached,
			Rate:              len(state.samples),
			ActiveModels:      models,
			LastActivityAt:    state.lastActivityAt,
			UpdatedAt:         snapshotAt,
		}
	}
	return result
}

// SelectionLoad 返回单账号当前调度负载视图，不分配状态或遍历全池。
func (activity *AccountActivity) SelectionLoad(provider, accountRef, model string) SelectionLoad {
	if activity == nil {
		return SelectionLoad{WindowMS: DefaultRateWindow.Milliseconds()}
	}
	key := activityKeyOf(provider, accountRef)
	activity.mu.Lock()
	defer activity.mu.Unlock()

	load := SelectionLoad{WindowMS: activity.windowMS}
	if key == "" {
		return load
	}
	state, ok := activity.states[key]
	if !ok {
		return load
	}
	activity.pruneLocked(state, activity.nowMS())
	load.InFlight = state.inFlight
	load.ModelInFlight = state.modelInFlight[normalizeModelName(model)]
	load.Rate = len(state.samples)
	return load
}

// ComputeSignature 返回用于去重变化通知的稳定 JSON 签名。
func ComputeSignature(snapshot map[string]AccountSnapshot) string {
	if snapshot == nil {
		snapshot = map[string]AccountSnapshot{}
	}
	data, err := json.Marshal(snapshot)
	if err != nil {
		return ""
	}
	return string(data)
}

// WriteActivitySnapshotAtomic 将活动快照原子写入 <aiHomeDir>/run/account-activity.json。
func WriteActivitySnapshotAtomic(aiHomeDir string, snapshot map[string]AccountSnapshot, nowMS int64) error {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil
	}
	if snapshot == nil {
		snapshot = map[string]AccountSnapshot{}
	}
	runDir := filepath.Join(root, "run")
	if err := os.MkdirAll(runDir, 0o700); err != nil {
		return fmt.Errorf("创建 run 目录失败: %w", err)
	}
	doc := ActivityDocument{
		UpdatedAt: nowMS,
		Accounts:  snapshot,
	}
	payload, err := json.Marshal(doc)
	if err != nil {
		return fmt.Errorf("序列化账号活动快照失败: %w", err)
	}

	tmpFile, err := os.CreateTemp(runDir, ".account-activity-*.tmp")
	if err != nil {
		return fmt.Errorf("创建临时活动快照文件失败: %w", err)
	}
	tmpPath := tmpFile.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = os.Remove(tmpPath)
		}
	}()
	if _, err := tmpFile.Write(payload); err != nil {
		_ = tmpFile.Close()
		return fmt.Errorf("写入临时活动快照失败: %w", err)
	}
	if err := tmpFile.Chmod(0o600); err != nil {
		_ = tmpFile.Close()
		return fmt.Errorf("设置临时活动快照权限失败: %w", err)
	}
	if err := tmpFile.Close(); err != nil {
		return fmt.Errorf("关闭临时活动快照失败: %w", err)
	}
	targetPath := filepath.Join(runDir, "account-activity.json")
	if err := os.Rename(tmpPath, targetPath); err != nil {
		return fmt.Errorf("原子替换账号活动快照失败: %w", err)
	}
	cleanup = false
	return nil
}
