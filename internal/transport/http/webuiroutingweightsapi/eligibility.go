package webuiroutingweightsapi

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	"github.com/madou1217/ai_home/application/accountscheduling"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	schedcore "github.com/madou1217/ai_home/core/accountscheduling"
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

var goBlockReasonMap = map[runtimecore.RecoveryTrigger]schedcore.Reason{
	runtimecore.RecoveryCredentialsUpdated: schedcore.ReasonRuntimeAuthInvalid,
	runtimecore.RecoveryUsageSnapshot:      schedcore.ReasonRuntimeRateLimited,
	runtimecore.RecoveryBillingSnapshot:    schedcore.ReasonRuntimeServiceUnavailable,
	runtimecore.RecoveryAccountStatus:      schedcore.ReasonRuntimeServiceUnavailable,
	runtimecore.RecoveryPolicySnapshot:     schedcore.ReasonRuntimeServiceUnavailable,
	runtimecore.RecoveryModelCatalog:       schedcore.ReasonModelNotInCatalog,
}

// evaluateAccountEligibility 返回空串表示可调度，否则返回稳定的原因码。
//
// 判定规则不在本层：这里只把运行态、持久化状态与外部端口的结论取证成 Evidence，
// 交给账号/Provider 策略（application/accountscheduling）决定。
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
	catalog catalogFacts,
	now time.Time,
) schedcore.Verdict {
	evidence := handler.schedulingEvidence(
		ctx, account, provider, model, parsedModelID, modelIDValid, state, runtimeView, load, catalog, now,
	)
	return handler.scheduling.Evaluate(evidence)
}

// schedulingEvidence 把一次判定的全部事实取证成 Evidence。
func (handler *Handler) schedulingEvidence(
	ctx context.Context,
	account PoolAccount,
	provider string,
	model string,
	parsedModelID runtimecore.ModelID,
	modelIDValid bool,
	state runtimecore.AccountState,
	runtimeView *runtimeapp.AccountView,
	load sessionactivity.SelectionLoad,
	catalog catalogFacts,
	now time.Time,
) accountscheduling.Evidence {
	evidence := accountscheduling.Evidence{
		Provider:   provider,
		AccountRef: account.AccountRef,
		ModelID:    model,
		Model: accountscheduling.ModelFacts{
			CatalogKnown:  catalog.Known,
			InCatalog:     catalog.InCatalog,
			Excluded:      catalog.Excluded,
			ExcludeReason: schedcore.Reason(catalog.Reason),
		},
		Account: accountscheduling.AccountFacts{
			Enabled:           account.Enabled,
			Configured:        account.Configured,
			APIKeyMode:        account.APIKeyMode,
			RemainingPct:      account.RemainingPct,
			QuotaStatus:       account.QuotaStatus,
			SchedulableStatus: account.SchedulableStatus,
		},
	}
	evidence.Observed.AccountInFlight = load.InFlight
	evidence.Observed.ModelInFlight = load.ModelInFlight
	evidence.Buckets = bucketsFromSnapshot(account.UsageSnapshot)

	hasState := len(state.Document()) > 0
	var doc persistedRuntimeStateDoc
	if hasState {
		_ = json.Unmarshal(state.Document(), &doc)
	}

	// 1. 账号级运行态阻塞：优先采用 Go 运行态实时观察，再看持久化 account_states。
	if runtimeView != nil {
		for _, block := range runtimeView.Blocks {
			if reason, found := goBlockReasonMap[block]; found {
				evidence.Observed.AccountReasons = append(evidence.Observed.AccountReasons, reason)
			}
		}
	}
	if hasState {
		if status := state.DeriveStatus(now); !status.IsHealthy() {
			evidence.Observed.AccountReasons = append(
				evidence.Observed.AccountReasons,
				schedcore.Reason("runtime_"+status.Status()),
			)
		}
		if doc.RoutingBlock != nil && strings.TrimSpace(doc.RoutingBlock.Kind) != "" {
			if strings.EqualFold(strings.TrimSpace(doc.RoutingBlock.Recheck), "manual") {
				evidence.Observed.RoutingBlockReason = "runtime_" + normalizeRoutingBlockKind(doc.RoutingBlock.Kind)
			}
			if untilMS := int64(doc.RoutingBlock.Until); untilMS > 0 {
				evidence.Observed.RoutingBlockUntil = time.UnixMilli(untilMS)
			}
		}
		if wait := int64(doc.CooldownUntil); wait > now.UnixMilli() {
			evidence.Observed.AccountCooldownUntil = time.UnixMilli(wait)
		}
		if wait := findModelCooldownUntilMS(doc.ModelCooldowns, model); wait > 0 {
			evidence.Observed.ModelCooldownUntil = time.UnixMilli(wait)
		}
		evidence.Observed.ModelFailureKind = findModelFailureKind(doc.ModelFailureStreaks, model)
	}

	// 2. (账号, 模型) 维度的运行态观察。
	if runtimeView != nil {
		entryCooldown := int64(0)
		for _, modelEntry := range runtimeView.Models {
			if !modelIdsMatch(modelEntry.Model.String(), model) {
				continue
			}
			for _, block := range modelEntry.Blocks {
				evidence.Observed.ModelReasons = append(
					evidence.Observed.ModelReasons,
					modelBlockReason(block),
				)
			}
			if modelEntry.CooldownUntil.After(now) {
				if until := modelEntry.CooldownUntil.UnixMilli(); until > entryCooldown {
					entryCooldown = until
				}
			}
		}
		if entryCooldown > 0 {
			evidence.Observed.RuntimeModelCooldownUntil = time.UnixMilli(entryCooldown)
		}
	}

	// 3. 需要外部端口才能得出的两个结论：路由资格与选号前额度门禁。
	parsedRef, refErr := accountcore.ParseAccountRef(strings.TrimSpace(account.AccountRef))
	if handler.eligibility != nil && refErr == nil && modelIDValid {
		if route, routeErr := runtimecore.NewModelRoute(parsedRef, parsedModelID.String()); routeErr == nil {
			if elig, checkErr := handler.eligibility.CheckEligibility(ctx, route); checkErr == nil && !elig.Eligible() {
				evidence.Eligibility.Route = eligibilityReason(elig.Status())
			}
		}
	}
	if handler.usageGate != nil && refErr == nil && modelIDValid {
		decision, err := handler.usageGate.EvaluateScheduling(ctx, provider, parsedRef, parsedModelID)
		if err != nil || decision.Blocked {
			evidence.Eligibility.UsageGate = schedcore.ReasonUsageGate
		}
	}
	return evidence
}

// eligibilityReason 把运行态资格状态映射成稳定原因码。
func eligibilityReason(status runtimecore.EligibilityStatus) schedcore.Reason {
	switch status {
	case runtimecore.EligibilityModelCooldown:
		return schedcore.ReasonModelCooldown
	case runtimecore.EligibilityCredentialBlocked:
		return schedcore.ReasonRuntimeAuthInvalid
	case runtimecore.EligibilityQuotaBlocked:
		return schedcore.ReasonQuotaExhausted
	case runtimecore.EligibilityPolicyBlocked:
		return schedcore.ReasonRuntimeBlocked
	default:
		return schedcore.ReasonRuntimeBlocked
	}
}

// modelBlockReason 把单个模型级恢复触发映射成原因码。
func modelBlockReason(block runtimecore.RecoveryTrigger) schedcore.Reason {
	switch block {
	case runtimecore.RecoveryModelCatalog:
		return schedcore.ReasonModelNotInCatalog
	case runtimecore.RecoveryUsageSnapshot:
		return schedcore.ReasonQuotaExhausted
	case runtimecore.RecoveryCredentialsUpdated:
		return schedcore.ReasonRuntimeAuthInvalid
	default:
		return schedcore.ReasonRuntimeBlocked
	}
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

// bucketsFromSnapshot 把归一化额度快照里的档位转成策略可用的 Bucket。
//
// 快照来自不同装配路径（map[string]any 与 []map[string]any 混用），这里统一走
// 一次 JSON 往返再解析，避免依赖具体 Go 容器类型。
func bucketsFromSnapshot(snapshot map[string]any) []schedcore.Bucket {
	if len(snapshot) == 0 {
		return nil
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return nil
	}
	var doc struct {
		Entries []struct {
			Bucket       string   `json:"bucket"`
			Label        string   `json:"label"`
			RemainingPct *float64 `json:"remainingPct"`
			UsedUnits    *float64 `json:"usedUnits"`
			TotalUnits   *float64 `json:"totalUnits"`
			ResetAtMs    *float64 `json:"resetAtMs"`
		} `json:"entries"`
	}
	if json.Unmarshal(raw, &doc) != nil {
		return nil
	}
	buckets := make([]schedcore.Bucket, 0, len(doc.Entries))
	for _, entry := range doc.Entries {
		id := strings.TrimSpace(entry.Bucket)
		if id == "" {
			id = strings.TrimSpace(entry.Label)
		}
		if id == "" {
			continue
		}
		bucket := schedcore.Bucket{ID: id}
		if entry.RemainingPct != nil {
			pct := *entry.RemainingPct
			switch {
			case pct < 0:
				pct = 0
			case pct > 100:
				pct = 100
			}
			bucket.Known = true
			bucket.RemainingBasisPoints = uint16(pct * 100)
		}
		if entry.UsedUnits != nil && entry.TotalUnits != nil && *entry.TotalUnits > 0 && *entry.UsedUnits >= *entry.TotalUnits {
			bucket.Exhausted = true
		}
		if entry.ResetAtMs != nil && *entry.ResetAtMs > 0 {
			bucket.ResetAt = time.UnixMilli(int64(*entry.ResetAtMs))
		}
		buckets = append(buckets, bucket)
	}
	return buckets
}

func stringValue(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func floatValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	default:
		return 0, false
	}
}
