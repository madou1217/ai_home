package accountrouting

import (
	"context"
	"errors"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

type stubUsageGate struct {
	decision UsageDecision
	err      error
	calls    int
}

func (gate *stubUsageGate) EvaluateScheduling(
	context.Context,
	string,
	accountcore.AccountRef,
	runtimecore.ModelID,
) (UsageDecision, error) {
	gate.calls++
	return gate.decision, gate.err
}

func newUsageGateTestSession(t *testing.T, gate UsageGate) (*RecruitmentSession, accountapp.RoutingAccount) {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	candidate, err := accountapp.NewRoutingAccount(catalog, accountapp.RoutingAccountInput{
		Ref:          ref,
		ProviderID:   "agy",
		CLIAccountID: 1,
	})
	if err != nil {
		t.Fatalf("NewRoutingAccount() error = %v", err)
	}
	model, err := runtimecore.NewModelID("gemini-3.8-flash-tiered")
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
	recruiter := &Recruiter{usage: gate}
	session := &RecruitmentSession{
		recruiter: recruiter,
		request: Request{
			providerID: "agy",
			modelID:    model,
		},
	}
	return session, candidate
}

func TestUsageBlockedSkipsBlockedCandidate(t *testing.T) {
	gate := &stubUsageGate{decision: UsageDecision{
		Blocked: true,
		Status:  "blocked_by_policy",
		Reason:  "usage_below_server_threshold",
	}}
	session, candidate := newUsageGateTestSession(t, gate)
	blocked, err := session.usageBlocked(context.Background(), candidate)
	if err != nil || !blocked {
		t.Fatalf("usageBlocked() = %v, %v; want blocked", blocked, err)
	}
	if gate.calls != 1 {
		t.Fatalf("gate calls = %d, want 1", gate.calls)
	}
}

func TestUsageBlockedPropagatesGateFailure(t *testing.T) {
	gate := &stubUsageGate{err: errors.New("snapshot store unavailable")}
	session, candidate := newUsageGateTestSession(t, gate)
	if _, err := session.usageBlocked(context.Background(), candidate); err == nil {
		t.Fatal("usageBlocked() error = nil, want fail-closed")
	}
}

func TestUsageBlockedWithoutGateAllows(t *testing.T) {
	session, candidate := newUsageGateTestSession(t, nil)
	blocked, err := session.usageBlocked(context.Background(), candidate)
	if err != nil || blocked {
		t.Fatalf("usageBlocked() = %v, %v; want allowed", blocked, err)
	}
}
