package webuiaccountsapi

import (
	"strings"

	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

// Codex credentials are authoritative. UI state can still describe an older
// browser login after import or credential replacement.
func codexCredentialPresentation(fact accountFact) (bool, string, string) {
	switch strings.TrimSpace(fact.CredentialKind) {
	case "api_key":
		return true, "api-key", strings.TrimSpace(fact.CredentialBaseURL)
	case "oauth":
		mode := strings.TrimSpace(fact.UIAuthMode)
		if mode != "consumer" && mode != "oauth-browser" && mode != "oauth" {
			mode = "oauth"
		}
		return false, mode, ""
	default:
		return fact.UIAPIKeyMode != 0, fact.UIAuthMode, fact.UIBaseURL
	}
}

// A quota-confirmed plan supersedes token-time profile metadata. Preserve the
// raw upstream tier (including Team and new tiers), not its broader family.
func codexPlanPresentation(fact accountFact, snapshot any) (string, string) {
	snapshotPlan := codexPlanToken(snapshotAccountPlanType(snapshot))
	confirmed := false
	if object, ok := snapshot.(map[string]any); ok {
		if account, ok := object["account"].(map[string]any); ok {
			at, _ := account["planConfirmedAtMs"].(float64)
			confirmed = at > 0
		}
	}
	plan := ""
	if confirmed {
		plan = snapshotPlan
	}
	for _, candidate := range []string{fact.SubscriptionRaw, fact.Subscription, snapshotPlan} {
		if plan == "" {
			plan = codexPlanToken(candidate)
		}
	}
	if plan == "" {
		return "unknown", "套餐待识别"
	}
	// Keep the label tied to the selected tier; the live-row enrichment must not
	// reintroduce a planName from an older quota snapshot.
	return plan, plan
}

func codexPlanToken(value string) string {
	token := usagecore.NormalizePlanToken(value)
	if !usagecore.IsPlanToken(token) {
		return ""
	}
	return token
}
