package webuiwindowactivationapi

import (
	"encoding/json"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	stateKeyPrefix = "account:window-activation-state:"
	probeGraceMs   = 60 * 1000
)

type settingView struct {
	Enabled    bool   `json:"enabled"`
	IntervalMs *int64 `json:"intervalMs"`
}

type lastProbeView struct {
	At      int64  `json:"at"`
	Outcome string `json:"outcome"`
}

type decisionView struct {
	Action string `json:"action"`
	Reason string `json:"reason"`
	At     int64  `json:"at"`
}

type windowView struct {
	Kind              string       `json:"kind"`
	AnchorAtMs        int64        `json:"anchorAtMs"`
	CloseAtMs         int64        `json:"closeAtMs"`
	WindowMinutes     int64        `json:"windowMinutes"`
	RemainingMs       int64        `json:"remainingMs"`
	Source            string       `json:"source"`
	ObservedAtMs      int64        `json:"observedAtMs"`
	NextActionAtMs    int64        `json:"nextActionAtMs"`
	ProbeFailureCount int64        `json:"probeFailureCount"`
	LastDecision      decisionView `json:"lastDecision"`
}

type readResponse struct {
	OK         bool          `json:"ok"`
	Provider   string        `json:"provider"`
	AccountRef string        `json:"accountRef"`
	Setting    settingView   `json:"setting"`
	LastProbe  lastProbeView `json:"lastProbe"`
	Window     windowView    `json:"window"`
}

// readWindowActivation 返回账号配置 + 窗口账本视图（global 由 Node 合并）。
func (handler *Handler) readWindowActivation(response http.ResponseWriter, request *http.Request, provider string, accountRef string) {
	ctx := request.Context()
	databasePath, err := appstate.DatabasePath(handler.aiHomeDir)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_read_failed", err.Error())
		return
	}
	owner, found, err := appstate.LookupAccountProvider(ctx, databasePath, accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_read_failed", err.Error())
		return
	}
	if !found {
		writeError(response, http.StatusNotFound, "account_not_found", "")
		return
	}
	if strings.ToLower(strings.TrimSpace(owner)) != provider {
		writeError(response, http.StatusConflict, "account_provider_mismatch", "")
		return
	}

	configRaw, configFound, err := appstate.ReadKV(ctx, databasePath, keyPrefix+accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_read_failed", "")
		return
	}
	stateRaw, _, err := appstate.ReadKV(ctx, databasePath, stateKeyPrefix+accountRef)
	if err != nil {
		// 状态是提示性数据：读不到按「无记录」展示，不影响设置本身。
		stateRaw = ""
	}
	setting, err := parseSetting(configRaw, configFound)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_read_failed", "")
		return
	}
	state := parseState(stateRaw)
	now := time.Now().UnixMilli()
	writeJSON(response, http.StatusOK, readResponse{
		OK:         true,
		Provider:   provider,
		AccountRef: accountRef,
		Setting:    setting,
		LastProbe:  lastProbeView{At: state.lastProbeAt, Outcome: state.lastOutcome},
		Window:     describeWindow(state, now),
	})
}

type windowState struct {
	lastProbeAt        int64
	lastOutcome        string
	windowAnchorAtMs   int64
	windowMinutes      int64
	windowCloseAtMs    int64
	windowSource       string
	windowObservedAtMs int64
	probeFailureCount  int64
	lastDecisionAction string
	lastDecisionReason string
	lastDecisionAtMs   int64
}

func parseSetting(raw string, found bool) (settingView, error) {
	if !found || strings.TrimSpace(raw) == "" {
		return settingView{Enabled: false, IntervalMs: nil}, nil
	}
	var decoded struct {
		Enabled    any `json:"enabled"`
		IntervalMs any `json:"intervalMs"`
	}
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return settingView{}, err
	}
	setting := settingView{Enabled: decoded.Enabled == true}
	if interval := positiveInt64(decoded.IntervalMs); interval > 0 {
		setting.IntervalMs = &interval
	}
	return setting, nil
}

func parseState(raw string) windowState {
	state := windowState{}
	if strings.TrimSpace(raw) == "" {
		return state
	}
	var decoded map[string]any
	if err := json.Unmarshal([]byte(raw), &decoded); err != nil {
		return state
	}
	state.lastProbeAt = nonNegativeInt64(decoded["lastProbeAt"])
	state.lastOutcome = strings.TrimSpace(jsString(decoded["lastOutcome"]))
	state.windowAnchorAtMs = nonNegativeInt64(decoded["windowAnchorAtMs"])
	state.windowMinutes = nonNegativeInt64(decoded["windowMinutes"])
	state.windowCloseAtMs = nonNegativeInt64(decoded["windowCloseAtMs"])
	source := strings.ToLower(strings.TrimSpace(jsString(decoded["windowSource"])))
	if source == "snapshot" || source == "probe" || source == "activity" {
		state.windowSource = source
	}
	state.windowObservedAtMs = nonNegativeInt64(decoded["windowObservedAtMs"])
	state.probeFailureCount = nonNegativeInt64(decoded["probeFailureCount"])
	action := strings.ToLower(strings.TrimSpace(jsString(decoded["lastDecisionAction"])))
	if action == "probe" || action == "skip" {
		state.lastDecisionAction = action
	}
	state.lastDecisionReason = strings.TrimSpace(jsString(decoded["lastDecisionReason"]))
	state.lastDecisionAtMs = nonNegativeInt64(decoded["lastDecisionAtMs"])
	return state
}

// describeWindow 复刻 window-ledger.js 的 describeWindowView。
func describeWindow(state windowState, now int64) windowView {
	view := windowView{
		Kind:              "unknown",
		WindowMinutes:     state.windowMinutes,
		ProbeFailureCount: state.probeFailureCount,
		LastDecision: decisionView{
			Action: state.lastDecisionAction,
			Reason: state.lastDecisionReason,
			At:     state.lastDecisionAtMs,
		},
	}
	if state.windowCloseAtMs > 0 && now < state.windowCloseAtMs {
		view.Kind = "open"
		view.AnchorAtMs = state.windowAnchorAtMs
		view.CloseAtMs = state.windowCloseAtMs
		view.RemainingMs = state.windowCloseAtMs - now
		view.Source = state.windowSource
		view.ObservedAtMs = state.windowObservedAtMs
		view.NextActionAtMs = state.windowCloseAtMs + probeGraceMs
		return view
	}
	if state.windowCloseAtMs > 0 {
		view.Kind = "closed"
		view.AnchorAtMs = state.windowAnchorAtMs
		view.CloseAtMs = state.windowCloseAtMs
		view.Source = state.windowSource
		view.ObservedAtMs = state.windowObservedAtMs
		view.NextActionAtMs = now
		return view
	}
	if state.windowObservedAtMs > 0 {
		view.Kind = "absent"
		view.WindowMinutes = state.windowMinutes
		view.Source = state.windowSource
		view.ObservedAtMs = state.windowObservedAtMs
		view.NextActionAtMs = now
		return view
	}
	return view
}

func jsString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func nonNegativeInt64(value any) int64 {
	number := jsNumber(value)
	if math.IsNaN(number) || number <= 0 {
		return 0
	}
	return int64(math.Floor(number))
}

func positiveInt64(value any) int64 {
	number := jsNumber(value)
	if math.IsNaN(number) || number <= 0 {
		return 0
	}
	return int64(math.Floor(number))
}
