package webuiwindowactivationapi

import (
	"context"
	"net/http"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/runtime/windowactivation"
)

const (
	stateKeyPrefix = windowactivation.StateKeyPrefix
	probeGraceMs   = windowactivation.ProbeGraceMs
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

type accountActivationViewResponse struct {
	OK         bool                             `json:"ok"`
	Provider   string                           `json:"provider"`
	AccountRef string                           `json:"accountRef"`
	Setting    settingView                      `json:"setting"`
	LastProbe  lastProbeView                    `json:"lastProbe"`
	Window     windowView                       `json:"window"`
	Global     windowactivation.GlobalStateView `json:"global"`
}

// writeAccountView 输出账号窗口激活设置、账本视图及全局调度器状态。
func (handler *Handler) writeAccountView(
	ctx context.Context,
	response http.ResponseWriter,
	databasePath string,
	provider string,
	accountRef string,
) {
	configRaw, configFound, err := appstate.ReadKV(ctx, databasePath, keyPrefix+accountRef)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_read_failed", "")
		return
	}
	parsedSetting, err := windowactivation.ParseAccountConfigRaw(configRaw, configFound)
	if err != nil {
		writeError(response, http.StatusInternalServerError, "window_activation_read_failed", "")
		return
	}

	stateRaw, _, err := appstate.ReadKV(ctx, databasePath, stateKeyPrefix+accountRef)
	if err != nil {
		// 状态是提示性数据：读不到按「无记录」展示，不影响设置本身。
		stateRaw = ""
	}
	state := windowactivation.ParseAccountStateRaw(stateRaw)
	now := time.Now().UnixMilli()
	view := windowactivation.DescribeWindowView(state.Ledger(), now)
	global := windowactivation.ReadGlobalState(ctx, handler.aiHomeDir, handler.scheduler)

	writeJSON(response, http.StatusOK, accountActivationViewResponse{
		OK:         true,
		Provider:   provider,
		AccountRef: accountRef,
		Setting: settingView{
			Enabled:    parsedSetting.Enabled,
			IntervalMs: parsedSetting.IntervalMs,
		},
		LastProbe: lastProbeView{
			At:      state.LastProbeAt,
			Outcome: state.LastOutcome,
		},
		Window: windowView{
			Kind:              view.Kind,
			AnchorAtMs:        view.AnchorAtMs,
			CloseAtMs:         view.CloseAtMs,
			WindowMinutes:     view.WindowMinutes,
			RemainingMs:       view.RemainingMs,
			Source:            view.Source,
			ObservedAtMs:      view.ObservedAtMs,
			NextActionAtMs:    view.NextActionAtMs,
			ProbeFailureCount: state.ProbeFailureCount,
			LastDecision: decisionView{
				Action: state.LastDecisionAction,
				Reason: state.LastDecisionReason,
				At:     state.LastDecisionAtMs,
			},
		},
		Global: global,
	})
}
