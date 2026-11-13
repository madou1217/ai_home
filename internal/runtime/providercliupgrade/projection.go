package providercliupgrade

import (
	"sort"

	"github.com/madou1217/ai_home/core/providers"
)

// ProjectStatus 把账本文件与可选调度器实时态合成完整的前端状态面负载。
//
// 解除熔断接口与 GET 状态接口必须调用同一份投影函数，确保两处返回值口径完全一致。
func ProjectStatus(aiHomeDir string, catalog *providers.Catalog, schedulerState *SchedulerState) map[string]any {
	ledger := ReadLedger(aiHomeDir)
	candidateOrder := ListUpgradeCandidateProviders(catalog)
	if schedulerState != nil && len(schedulerState.Providers) > 0 {
		candidateOrder = schedulerState.Providers
	}
	providerNames := collectProjectedProviders(candidateOrder, ledger)

	var tickMap map[string]TickProviderOutcome
	if schedulerState != nil && schedulerState.LastResult != nil {
		tickMap = schedulerState.LastResult.Providers
	}

	rows := make([]map[string]any, 0, len(providerNames))
	for _, provider := range providerNames {
		rows = append(rows, projectSingleProvider(provider, ledger, tickMap))
	}

	var schedulerField any
	if schedulerState != nil {
		schedulerField = *schedulerState
	}

	return map[string]any{
		"ok":        true,
		"scheduler": schedulerField,
		"global": map[string]any{
			"enabled":        ledger.Global.Enabled,
			"disabledReason": ledger.Global.DisabledReason,
		},
		"providers": rows,
	}
}

func collectProjectedProviders(candidates []string, ledger Ledger) []string {
	seen := make(map[string]struct{}, len(candidates)+len(ledger.Providers))
	out := make([]string, 0, len(candidates)+len(ledger.Providers))
	for _, provider := range candidates {
		if provider == "" {
			continue
		}
		if _, exists := seen[provider]; exists {
			continue
		}
		seen[provider] = struct{}{}
		out = append(out, provider)
	}
	var extras []string
	for provider := range ledger.Providers {
		if _, exists := seen[provider]; exists {
			continue
		}
		seen[provider] = struct{}{}
		extras = append(extras, provider)
	}
	sort.Strings(extras)
	out = append(out, extras...)
	return out
}

func projectSingleProvider(provider string, ledger Ledger, tickMap map[string]TickProviderOutcome) map[string]any {
	record := ledger.Record(provider)
	latest := record.LatestVersion
	installed := record.InstalledVersion
	updateAvailable := latest != "" && installed != "" && latest != installed && !containsString(record.BlockedVersions, latest)

	limit := len(record.History)
	if limit > ProjectionHistoryLimit {
		limit = ProjectionHistoryLimit
	}
	recentHistory := make([]map[string]any, 0, limit)
	for _, item := range record.History[len(record.History)-limit:] {
		recentHistory = append(recentHistory, item)
	}

	lastTickState := ""
	lastTickReason := ""
	if tick, ok := tickMap[provider]; ok {
		lastTickState = tick.State
		lastTickReason = tick.Reason
	}

	var baselineHealthy any
	if record.BaselineHealthy != nil {
		baselineHealthy = *record.BaselineHealthy
	}

	caps := ResolveChannelCapabilities(record.Channel, provider)
	return map[string]any{
		"provider":                  provider,
		"state":                     record.State,
		"channel":                   record.Channel,
		"pinnable":                  record.Channel != "" && caps.Pinnable,
		"enabled":                   record.Enabled,
		"disabledReason":            record.DisabledReason,
		"installedVersion":          installed,
		"latestVersion":             latest,
		"targetVersion":             record.TargetVersion,
		"knownGoodVersion":          record.KnownGoodVersion,
		"knownGoodRollbackable":     record.KnownGoodRollbackable,
		"baselineHealthy":           baselineHealthy,
		"updateAvailable":           updateAvailable,
		"blockedVersions":           nonNilStrings(record.BlockedVersions),
		"shadowedNpmInstall":        record.ShadowedNpmInstall,
		"resolvedPath":              record.ResolvedPath,
		"lastCheckAt":               record.LastCheckAt,
		"lastCheckError":            record.LastCheckError,
		"lastApplyAt":               record.LastApplyAt,
		"lastApplyError":            record.LastApplyError,
		"lastDeferReason":           record.LastDeferReason,
		"consecutiveFailures":       record.ConsecutiveFailures,
		"consecutiveDefers":         record.ConsecutiveDefers,
		"consecutiveQuiescentTicks": record.ConsecutiveQuiescentTicks,
		"soakUnknownCount":          record.SoakUnknownCount,
		"lastTickState":             lastTickState,
		"lastTickReason":            lastTickReason,
		"history":                   recentHistory,
	}
}

func nonNilStrings(in []string) []string {
	if len(in) == 0 {
		return []string{}
	}
	return append([]string(nil), in...)
}
