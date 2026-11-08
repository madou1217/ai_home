package accountcredentials

import (
	"context"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
)

type delegationStrategy struct{ exempt bool }

func (delegationStrategy) ProviderID() string { return "test" }
func (delegationStrategy) ExpiresAt(accountapp.Credential) (time.Time, bool) {
	return time.Time{}, false
}
func (strategy delegationStrategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	return nil, nil
}
func (strategy delegationStrategy) RefreshesDespiteDelegation() bool { return strategy.exempt }

func TestRefreshDelegationExemptOnlyForOptedInStrategies(t *testing.T) {
	if refreshDelegationExempt(delegationStrategy{}) {
		t.Fatalf("普通策略不应绕过宿主委托")
	}
	if !refreshDelegationExempt(delegationStrategy{exempt: true}) {
		t.Fatalf("显式声明豁免的策略必须自行刷新")
	}
}
