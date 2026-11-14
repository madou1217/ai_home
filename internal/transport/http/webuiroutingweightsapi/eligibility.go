package webuiroutingweightsapi

import (
	"context"
	"encoding/json"
	"math"
	"strings"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/runtime/sessionactivity"
)

type persistedRuntimeStateDoc struct {
	CooldownUntil       float64                    `json:"cooldownUntil"`
	RoutingBlock        *persistedRoutingBlock     `json:"routingBlock"`
	ModelCooldowns      map[string]float64         `json:"modelCooldowns"`
	ModelFailureStreaks map[string]json.RawMessage `json:"modelFailureStreaks"`
}

type persistedRoutingBlock struct {
	Kind       string  `json:"kind"`
	Reason     string  `json:"reason"`
	Recheck    string  `json:"recheck"`
	ObservedAt float64 `json:"observedAt"`
	Until      float64 `json:"until"`
}

type persistedModelFailureStreak struct {
	Kind string `json:"kind"`
}

var goBlockReasonMap = map[runtimecore.RecoveryTrigger]string{
	runtimecore.RecoveryCredentialsUpdated: "runtime_auth_invalid",
	runtimecore.RecoveryUsageSnapshot:      "runtime_rate_limited",
	runtimecore.RecoveryBillingSnapshot:    "runtime_service_unavailable",
	runtimecore.RecoveryAccountStatus:      "runtime_service_unavailable",
	runtimecore.RecoveryPolicySnapshot:     "runtime_service_unavailable",
	runtimecore.RecoveryModelCatalog:       "model_not_in_catalog",
}

// evaluateAccountEligibility 按 Node createEligibilityEvaluator 与 Go 运行态的统一口径判定资格。
//
// 返回空串表示可调度；非空字符串为稳定的原因码（与前端 REASON_LABELS 一一对应）。
func (handler *Handler) evaluateAccountEligibility(
	ctx context.Context,
	account PoolAccount,
	provider string,
	model string,
	parsedModelID runtimecore.ModelID,
	modelIDValid bool,
	state runtimecore.AccountState,
	runtimeView *runtimeapp.AccountView,
	load sessionactivity.SelectionLoad,
	now time.Time,
) string {
	nowMS := now.UnixMilli()
	if !account.Enabled {
		return "account_state_unavailable"
	}

	hasState := len(state.Document()) > 0
	var doc persistedRuntimeStateDoc
	if hasState {
		_ = json.Unmarshal(state.Document(), &doc)
	}

	// 1. 账号级运行时阻塞 / 冷却状态（优先采用 Go 运行态实时观察，再看持久化 account_states）。
	if runtimeView != nil {
		for _, block := range runtimeView.Blocks {
			if reason, found := goBlockReasonMap[block]; found {
				return reason
			}
		}
	}
	if hasState {
		status := state.DeriveStatus(now)
		if !status.IsHealthy() {
			return "runtime_" + status.Status()
		}
		if doc.RoutingBlock != nil && strings.TrimSpace(doc.RoutingBlock.Kind) != "" {
			if strings.EqualFold(strings.TrimSpace(doc.RoutingBlock.Recheck), "manual") {
				return "runtime_" + normalizeRoutingBlockKind(doc.RoutingBlock.Kind)
			}
			// 路由硬阻塞到期进入单一试探期：已有在途请求时其余并发不蜂拥。
			if int64(doc.RoutingBlock.Until) > 0 && int64(doc.RoutingBlock.Until) <= nowMS && load.InFlight > 0 {
				return "routing_block_probe_in_flight"
			}
		}
		if int64(doc.CooldownUntil) > nowMS {
			return "account_cooldown"
		}
	}

	// 2. (账号, 模型) 维度冷却与恢复中检查。
	if findModelCooldownUntilMS(doc.ModelCooldowns, model) > nowMS {
		return "model_cooldown"
	}
	if hasState && findModelFailureKind(doc.ModelFailureStreaks, model) == "model_capacity_unavailable" && load.ModelInFlight > 0 {
		return "model_capacity_recovery_in_flight"
	}

	if runtimeView != nil {
		for _, modelEntry := range runtimeView.Models {
			if !modelIdsMatch(modelEntry.Model.String(), model) {
				continue
			}
			for _, block := range modelEntry.Blocks {
				switch block {
				case runtimecore.RecoveryModelCatalog:
					return reasonModelNotInCatalog
				case runtimecore.RecoveryUsageSnapshot:
					return "quota_exhausted"
				case runtimecore.RecoveryCredentialsUpdated:
					return "runtime_auth_invalid"
				default:
					return "runtime_blocked"
				}
			}
			if modelEntry.CooldownUntil.After(now) {
				return "model_cooldown"
			}
		}
	}

	parsedRef, refErr := accountcore.ParseAccountRef(strings.TrimSpace(account.AccountRef))
	if handler.eligibility != nil && refErr == nil && modelIDValid {
		if route, routeErr := runtimecore.NewModelRoute(parsedRef, parsedModelID.String()); routeErr == nil {
			elig, checkErr := handler.eligibility.CheckEligibility(ctx, route)
			if checkErr == nil && !elig.Eligible() {
				switch elig.Status() {
				case runtimecore.EligibilityModelCooldown:
					return "model_cooldown"
				case runtimecore.EligibilityCredentialBlocked:
					return "runtime_auth_invalid"
				case runtimecore.EligibilityQuotaBlocked:
					return "quota_exhausted"
				case runtimecore.EligibilityPolicyBlocked:
					return "runtime_blocked"
				}
			}
		}
	}

	// 3. 额度耗尽与静态可调度策略检查。
	if !account.APIKeyMode {
		if account.RemainingPct != nil && !math.IsNaN(*account.RemainingPct) && *account.RemainingPct <= 0 {
			return "quota_exhausted"
		}
		if strings.EqualFold(strings.TrimSpace(account.QuotaStatus), "exhausted") ||
			strings.TrimSpace(account.SchedulableStatus) == "blocked_by_quota" {
			return "quota_exhausted"
		}
	}
	if !allowsLiveRuntimeRecheck(account.SchedulableStatus) {
		return "runtime_blocked"
	}

	// 4. 选号前额度门禁（UsageGate：config:usage 阈值与模型额度窗口，错误按 fail-closed 拦截）。
	if handler.usageGate != nil && refErr == nil && modelIDValid {
		decision, err := handler.usageGate.EvaluateScheduling(ctx, provider, parsedRef, parsedModelID)
		if err != nil || decision.Blocked {
			return "usage_gate"
		}
	}

	return ""
}

func normalizeRoutingBlockKind(kind string) string {
	switch strings.TrimSpace(kind) {
	case "account_usage_exhausted", "account_no_resource_package":
		return "quota_exhausted"
	case "quota_exhausted", "billing_blocked", "permission_denied", "auth_invalid",
		"rate_limited", "overloaded", "service_unavailable", "upstream_error", "transient_network":
		return strings.TrimSpace(kind)
	default:
		return "cooling_down"
	}
}

func allowsLiveRuntimeRecheck(schedulableStatus string) bool {
	status := strings.TrimSpace(schedulableStatus)
	return status == "" ||
		status == "schedulable" ||
		status == "blocked_by_runtime_status"
}

func findModelCooldownUntilMS(cooldowns map[string]float64, model string) int64 {
	if len(cooldowns) == 0 {
		return 0
	}
	lowerModel := strings.ToLower(strings.TrimSpace(model))
	if until, ok := cooldowns[lowerModel]; ok && int64(until) > 0 {
		return int64(until)
	}
	maxUntil := int64(0)
	for key, until := range cooldowns {
		if modelIdsMatch(key, model) && int64(until) > maxUntil {
			maxUntil = int64(until)
		}
	}
	return maxUntil
}

func findModelFailureKind(streaks map[string]json.RawMessage, model string) string {
	if len(streaks) == 0 {
		return ""
	}
	lowerModel := strings.ToLower(strings.TrimSpace(model))
	if raw, ok := streaks[lowerModel]; ok {
		var parsed persistedModelFailureStreak
		if json.Unmarshal(raw, &parsed) == nil && parsed.Kind != "" {
			return strings.TrimSpace(parsed.Kind)
		}
	}
	for key, raw := range streaks {
		if !modelIdsMatch(key, model) {
			continue
		}
		var parsed persistedModelFailureStreak
		if json.Unmarshal(raw, &parsed) == nil && parsed.Kind != "" {
			return strings.TrimSpace(parsed.Kind)
		}
	}
	return ""
}
