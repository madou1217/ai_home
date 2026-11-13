package windowactivation

import (
	"context"
	"encoding/json"
	"math"
	"strconv"
	"strings"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	// ConfigKeyPrefix 是账号窗口激活开关/间隔配置的 app_kv 键前缀。
	ConfigKeyPrefix = "account:window-activation:"
	// StateKeyPrefix 是账号窗口账本与最近探测状态的 app_kv 键前缀。
	StateKeyPrefix = "account:window-activation-state:"
	// ServerConfigKVKey 是 `aih server config set` 写入的服务器全局配置键。
	ServerConfigKVKey = "config:server"

	// DefaultIntervalMs 默认兜底探测间隔（1 小时）。
	DefaultIntervalMs int64 = 60 * 60 * 1000
	// DefaultMinIntervalMs 默认最小探测间隔（1 小时）。
	DefaultMinIntervalMs int64 = 60 * 60 * 1000
	// FloorMinIntervalMs 全局允许配置的最小探测间隔下限（1 分钟）。
	FloorMinIntervalMs int64 = 60 * 1000
	// MaxIntervalMs 单账号允许配置的最大探测间隔（365 天）。
	MaxIntervalMs int64 = 365 * 24 * 60 * 60 * 1000
)

// AccountConfig 描述单个账号的窗口激活设置（app_kv: account:window-activation:<ref>）。
type AccountConfig struct {
	Enabled    bool   `json:"enabled"`
	IntervalMs *int64 `json:"intervalMs"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// AccountState 描述单个账号的窗口账本、最近探测结果和最近决策（app_kv: account:window-activation-state:<ref>）。
type AccountState struct {
	LastProbeAt        int64  `json:"lastProbeAt"`
	LastActivatedAt    int64  `json:"lastActivatedAt"`
	LastOutcome        string `json:"lastOutcome"`
	WindowAnchorAtMs   int64  `json:"windowAnchorAtMs"`
	WindowMinutes      int64  `json:"windowMinutes"`
	WindowCloseAtMs    int64  `json:"windowCloseAtMs"`
	WindowSource       string `json:"windowSource"`
	WindowObservedAtMs int64  `json:"windowObservedAtMs"`
	ProbeFailureCount  int64  `json:"probeFailureCount"`
	LastDecisionAction string `json:"lastDecisionAction"`
	LastDecisionReason string `json:"lastDecisionReason"`
	LastDecisionAtMs   int64  `json:"lastDecisionAtMs"`
	UpdatedAt          int64  `json:"updatedAt"`
}

// SavedServerConfig 是持久化在 app_kv config:server 中的窗口激活全局设置。
type SavedServerConfig struct {
	Enabled           bool  `json:"windowActivation"`
	DefaultIntervalMs int64 `json:"windowActivationDefaultIntervalMs"`
	MinIntervalMs     int64 `json:"windowActivationMinIntervalMs"`
}

// GlobalStateView 对齐 WebUI 响应里的 global 提示对象（运行时生效 vs 已保存重启生效）。
type GlobalStateView struct {
	Enabled           *bool  `json:"enabled"`
	SavedEnabled      bool   `json:"savedEnabled"`
	RestartRequired   bool   `json:"restartRequired"`
	DefaultIntervalMs *int64 `json:"defaultIntervalMs"`
	MinIntervalMs     *int64 `json:"minIntervalMs"`
}

// Ledger 提取状态记录中的窗口账本字段。
func (state AccountState) Ledger() Ledger {
	return NormalizeLedger(Ledger{
		WindowAnchorAtMs:   state.WindowAnchorAtMs,
		WindowMinutes:      state.WindowMinutes,
		WindowCloseAtMs:    state.WindowCloseAtMs,
		WindowSource:       state.WindowSource,
		WindowObservedAtMs: state.WindowObservedAtMs,
		ProbeFailureCount:  state.ProbeFailureCount,
	})
}

// NormalizeAccountState 清洗与归一化窗口激活状态记录。
func NormalizeAccountState(raw AccountState) AccountState {
	ledger := raw.Ledger()
	action := strings.ToLower(strings.TrimSpace(raw.LastDecisionAction))
	if action != "probe" && action != "skip" {
		action = ""
	}
	return AccountState{
		LastProbeAt:        nonNegMs(raw.LastProbeAt),
		LastActivatedAt:    nonNegMs(raw.LastActivatedAt),
		LastOutcome:        strings.TrimSpace(raw.LastOutcome),
		WindowAnchorAtMs:   ledger.WindowAnchorAtMs,
		WindowMinutes:      ledger.WindowMinutes,
		WindowCloseAtMs:    ledger.WindowCloseAtMs,
		WindowSource:       ledger.WindowSource,
		WindowObservedAtMs: ledger.WindowObservedAtMs,
		ProbeFailureCount:  ledger.ProbeFailureCount,
		LastDecisionAction: action,
		LastDecisionReason: strings.TrimSpace(raw.LastDecisionReason),
		LastDecisionAtMs:   nonNegMs(raw.LastDecisionAtMs),
		UpdatedAt:          nonNegMs(raw.UpdatedAt),
	}
}

// ParseAccountConfigRaw 解析 app_kv 中的单账号设置记录；found==false 返回默认关闭配置。
func ParseAccountConfigRaw(raw string, found bool) (AccountConfig, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return AccountConfig{Enabled: false, IntervalMs: nil}, nil
	}
	var decoded struct {
		Enabled    any `json:"enabled"`
		IntervalMs any `json:"intervalMs"`
		UpdatedAt  any `json:"updatedAt"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return AccountConfig{}, err
	}
	cfg := AccountConfig{
		Enabled:   decoded.Enabled == true,
		UpdatedAt: NonNegativeInt64(decoded.UpdatedAt),
	}
	if interval := NonNegativeInt64(decoded.IntervalMs); interval > 0 {
		cfg.IntervalMs = &interval
	}
	return cfg, nil
}

// ParseAccountStateRaw 解析 app_kv 中的单账号状态记录；损坏或缺失返回零值状态。
func ParseAccountStateRaw(raw string) AccountState {
	if strings.TrimSpace(raw) == "" {
		return AccountState{}
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return AccountState{}
	}
	state := AccountState{
		LastProbeAt:        NonNegativeInt64(decoded["lastProbeAt"]),
		LastActivatedAt:    NonNegativeInt64(decoded["lastActivatedAt"]),
		LastOutcome:        strings.TrimSpace(jsString(decoded["lastOutcome"])),
		WindowAnchorAtMs:   NonNegativeInt64(decoded["windowAnchorAtMs"]),
		WindowMinutes:      NonNegativeInt64(decoded["windowMinutes"]),
		WindowCloseAtMs:    NonNegativeInt64(decoded["windowCloseAtMs"]),
		WindowSource:       jsString(decoded["windowSource"]),
		WindowObservedAtMs: NonNegativeInt64(decoded["windowObservedAtMs"]),
		ProbeFailureCount:  NonNegativeInt64(decoded["probeFailureCount"]),
		LastDecisionAction: jsString(decoded["lastDecisionAction"]),
		LastDecisionReason: strings.TrimSpace(jsString(decoded["lastDecisionReason"])),
		LastDecisionAtMs:   NonNegativeInt64(decoded["lastDecisionAtMs"]),
		UpdatedAt:          NonNegativeInt64(decoded["updatedAt"]),
	}
	return NormalizeAccountState(state)
}

// ReadAccountConfig 从 app_kv 读取单账号窗口激活配置。
func ReadAccountConfig(ctx context.Context, aiHomeDir, accountRef string) (AccountConfig, bool, error) {
	ref := strings.TrimSpace(accountRef)
	if ref == "" || strings.TrimSpace(aiHomeDir) == "" {
		return AccountConfig{}, false, nil
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return AccountConfig{}, false, err
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, ConfigKeyPrefix+ref)
	if err != nil {
		return AccountConfig{}, false, err
	}
	if !found {
		return AccountConfig{Enabled: false, IntervalMs: nil}, false, nil
	}
	cfg, err := ParseAccountConfigRaw(raw, true)
	if err != nil {
		return AccountConfig{}, true, err
	}
	return cfg, true, nil
}

// ReadAccountState 从 app_kv 读取单账号窗口激活状态（失败或缺失返回零值）。
func ReadAccountState(ctx context.Context, aiHomeDir, accountRef string) (AccountState, bool) {
	ref := strings.TrimSpace(accountRef)
	if ref == "" || strings.TrimSpace(aiHomeDir) == "" {
		return AccountState{}, false
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return AccountState{}, false
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, StateKeyPrefix+ref)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return AccountState{}, false
	}
	return ParseAccountStateRaw(raw), true
}

// WriteAccountState 将单账号窗口激活状态持久化到 app_kv。
func WriteAccountState(ctx context.Context, aiHomeDir, accountRef string, state AccountState, nowMs int64) error {
	ref := strings.TrimSpace(accountRef)
	if ref == "" || strings.TrimSpace(aiHomeDir) == "" {
		return nil
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return err
	}
	normalized := NormalizeAccountState(state)
	if nowMs <= 0 {
		nowMs = normalized.LastProbeAt
	}
	normalized.UpdatedAt = nonNegMs(nowMs)
	encoded, err := json.Marshal(normalized)
	if err != nil {
		return err
	}
	return appstate.WriteKV(ctx, dbPath, StateKeyPrefix+ref, string(encoded), normalized.UpdatedAt)
}

// ReadSavedServerConfig 从 app_kv 读取 config:server 里的全局窗口激活配置。
// 读不到或损坏时返回安全默认值（全局关闭、最小和默认间隔均 1 小时）。
func ReadSavedServerConfig(ctx context.Context, aiHomeDir string) SavedServerConfig {
	fallback := SavedServerConfig{
		Enabled:           false,
		DefaultIntervalMs: DefaultIntervalMs,
		MinIntervalMs:     DefaultMinIntervalMs,
	}
	if strings.TrimSpace(aiHomeDir) == "" {
		return fallback
	}
	dbPath, err := appstate.DatabasePath(aiHomeDir)
	if err != nil {
		return fallback
	}
	raw, found, err := appstate.ReadKV(ctx, dbPath, ServerConfigKVKey)
	if err != nil || !found || strings.TrimSpace(raw) == "" {
		return fallback
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return fallback
	}
	minMs := NonNegativeInt64(decoded["windowActivationMinIntervalMs"])
	if minMs <= 0 {
		minMs = DefaultMinIntervalMs
	}
	if minMs < FloorMinIntervalMs {
		minMs = FloorMinIntervalMs
	}
	defMs := NonNegativeInt64(decoded["windowActivationDefaultIntervalMs"])
	if defMs <= 0 {
		defMs = DefaultIntervalMs
	}
	if defMs < minMs {
		defMs = minMs
	}
	return SavedServerConfig{
		Enabled:           decoded["windowActivation"] == true,
		DefaultIntervalMs: defMs,
		MinIntervalMs:     minMs,
	}
}

// PresentGlobalState 结合运行中调度器状态与磁盘持久化配置组装 WebUI global 视图。
func PresentGlobalState(running *SchedulerState, saved SavedServerConfig) GlobalStateView {
	out := GlobalStateView{
		SavedEnabled: saved.Enabled,
	}
	if running != nil {
		enabled := running.Enabled
		out.Enabled = &enabled
		out.RestartRequired = enabled != saved.Enabled
		if running.DefaultIntervalMs > 0 {
			val := running.DefaultIntervalMs
			out.DefaultIntervalMs = &val
		}
		if running.MinIntervalMs > 0 {
			val := running.MinIntervalMs
			out.MinIntervalMs = &val
		}
	}
	return out
}

// ReadGlobalState 读取账号响应中的 global 全局闸门与生效间隔状态。
func ReadGlobalState(ctx context.Context, aiHomeDir string, scheduler *Scheduler) GlobalStateView {
	saved := ReadSavedServerConfig(ctx, aiHomeDir)
	var runningPtr *SchedulerState
	if scheduler != nil {
		state := scheduler.State()
		runningPtr = &state
	}
	return PresentGlobalState(runningPtr, saved)
}

// EffectiveMinIntervalMs 返回写入单账号设置时实际生效的 intervalMs 下限。
// 运行态调度器优先；未装配时回落到 config:server（缺省 1 小时）。
func EffectiveMinIntervalMs(ctx context.Context, aiHomeDir string, scheduler *Scheduler) int64 {
	if scheduler != nil {
		state := scheduler.State()
		if state.MinIntervalMs > 0 {
			return state.MinIntervalMs
		}
	}
	saved := ReadSavedServerConfig(ctx, aiHomeDir)
	if saved.MinIntervalMs > 0 {
		return saved.MinIntervalMs
	}
	return DefaultMinIntervalMs
}

// StateRecordsEqual 比较影响调度/展示的核心字段是否发生变化（忽略 updatedAt），避免每 tick 写库。
func StateRecordsEqual(previous, next AccountState) bool {
	p := NormalizeAccountState(previous)
	n := NormalizeAccountState(next)
	return p.LastProbeAt == n.LastProbeAt &&
		p.LastActivatedAt == n.LastActivatedAt &&
		p.LastOutcome == n.LastOutcome &&
		p.WindowAnchorAtMs == n.WindowAnchorAtMs &&
		p.WindowMinutes == n.WindowMinutes &&
		p.WindowCloseAtMs == n.WindowCloseAtMs &&
		p.WindowSource == n.WindowSource &&
		p.WindowObservedAtMs == n.WindowObservedAtMs &&
		p.ProbeFailureCount == n.ProbeFailureCount &&
		p.LastDecisionAction == n.LastDecisionAction &&
		p.LastDecisionReason == n.LastDecisionReason &&
		p.LastDecisionAtMs == n.LastDecisionAtMs
}

// JSNumber 将 JSON/SQLite 中的数字语义统一转换为 float64（非法时返回 NaN）。
func JSNumber(value any) float64 {
	switch typed := value.(type) {
	case float64:
		return typed
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case json.Number:
		parsed, err := typed.Float64()
		if err != nil {
			return math.NaN()
		}
		return parsed
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		if err != nil {
			return math.NaN()
		}
		return parsed
	default:
		return math.NaN()
	}
}

// NonNegativeInt64 将 JS 数字按正值向下取整；非正数或 NaN 返回 0。
func NonNegativeInt64(value any) int64 {
	number := JSNumber(value)
	if math.IsNaN(number) || math.IsInf(number, 0) || number <= 0 {
		return 0
	}
	return int64(math.Floor(number))
}

func jsString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}
