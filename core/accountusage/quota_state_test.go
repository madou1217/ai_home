package accountusage

import "testing"

func TestDeriveQuotaStateNumeric(t *testing.T) {
	state := DeriveQuotaState(QuotaStateInput{
		Kind:      "codex_oauth_status",
		Remaining: Remaining{Known: true, BasisPoints: 4250},
	})
	if state.Status != QuotaStateAvailable || !state.HasNumericRemaining {
		t.Fatalf("state = %#v", state)
	}
	if state.RemainingPct == nil || *state.RemainingPct != 42.5 {
		t.Fatalf("remaining = %v", state.RemainingPct)
	}
}

func TestDeriveQuotaStateExhausted(t *testing.T) {
	state := DeriveQuotaState(QuotaStateInput{
		Remaining: Remaining{Known: true, BasisPoints: 0},
	})
	if state.Status != QuotaStateExhausted || state.RemainingPct == nil || *state.RemainingPct != 0 {
		t.Fatalf("state = %#v", state)
	}
}

func TestDeriveQuotaStateCodexTeamAndFreeStayPending(t *testing.T) {
	for _, tc := range []struct {
		planType string
		reason   string
	}{
		{planType: "team", reason: "codex_team_plan_pending_rate_limits"},
		{planType: "TEAM", reason: "codex_team_plan_pending_rate_limits"},
		{planType: "free", reason: "codex_free_plan_pending_rate_limits"},
	} {
		state := DeriveQuotaState(QuotaStateInput{
			Kind:           "codex_oauth_status",
			FallbackSource: "account_read",
			PlanType:       tc.planType,
		})
		if state.Status != QuotaStatePending || state.Reason != tc.reason {
			t.Fatalf("plan %q state = %#v", tc.planType, state)
		}
	}
}

func TestDeriveQuotaStateCodexFallbacks(t *testing.T) {
	authJSON := DeriveQuotaState(QuotaStateInput{
		Kind:           "codex_oauth_status",
		FallbackSource: "auth_json",
	})
	if authJSON.Status != QuotaStatePending || authJSON.Reason != "auth_metadata_only" {
		t.Fatalf("auth_json state = %#v", authJSON)
	}
	// 非 team/free 的 account_read 仍然是「上游没给数值」，不能套用套餐文案。
	other := DeriveQuotaState(QuotaStateInput{
		Kind:           "codex_oauth_status",
		FallbackSource: "account_read",
		PlanType:       "plus",
	})
	if other.Reason != "provider_returned_no_numeric_usage" {
		t.Fatalf("plus state = %#v", other)
	}
}

func TestDeriveQuotaStateUnknown(t *testing.T) {
	state := DeriveQuotaState(QuotaStateInput{Kind: "zcode_plan_balance"})
	if state.Status != QuotaStatePending || state.Reason != "provider_returned_no_numeric_usage" {
		t.Fatalf("state = %#v", state)
	}
	if state.HasNumericRemaining || state.RemainingPct != nil {
		t.Fatalf("unknown remaining leaked: %#v", state)
	}
}
