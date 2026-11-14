package accountcredentials

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestInspectRefreshCandidateReportsExpiryAndDelegationWithoutRefreshing(t *testing.T) {
	now := time.Unix(1_700_000_000, 0).UTC()
	cred := delegationCredential{
		providerID: "test",
		seed:       "seed-inspect-1",
		access:     "initial-access",
	}
	accountRef, err := accountcore.DeriveAccountRef(cred)
	if err != nil {
		t.Fatalf("DeriveAccountRef() error = %v", err)
	}
	snapshot, err := accountapp.NewCredentialSnapshot(accountRef, "test", cred, now.Add(-time.Minute))
	if err != nil {
		t.Fatalf("NewCredentialSnapshot() error = %v", err)
	}
	store := &delegationStore{snapshot: snapshot}
	strategy := &dueDelegationStrategy{now: now}

	resolver, err := NewResolver(Dependencies{
		Store:            store,
		Strategies:       []RefreshStrategy{strategy},
		Clock:            func() time.Time { return now },
		RefreshDelegated: false,
	})
	if err != nil {
		t.Fatalf("NewResolver() error = %v", err)
	}

	candidate, err := resolver.InspectRefreshCandidate(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("InspectRefreshCandidate() error = %v", err)
	}
	if !candidate.Refreshable || candidate.Delegated {
		t.Fatalf("unexpected candidate flags: %+v", candidate)
	}
	if !candidate.ExpiresAt.Equal(now.Add(-time.Minute)) {
		t.Fatalf("ExpiresAt = %v, want %v", candidate.ExpiresAt, now.Add(-time.Minute))
	}
	if strategy.refreshes != 0 {
		t.Fatalf("InspectRefreshCandidate should not trigger refresh, got %d", strategy.refreshes)
	}

	delegatedResolver, err := NewResolver(Dependencies{
		Store:            store,
		Strategies:       []RefreshStrategy{strategy},
		Clock:            func() time.Time { return now },
		RefreshDelegated: true,
	})
	if err != nil {
		t.Fatalf("NewResolver(delegated) error = %v", err)
	}
	delegatedCandidate, err := delegatedResolver.InspectRefreshCandidate(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("InspectRefreshCandidate(delegated) error = %v", err)
	}
	if !delegatedCandidate.Delegated {
		t.Fatalf("expected Delegated=true, got %+v", delegatedCandidate)
	}
}
