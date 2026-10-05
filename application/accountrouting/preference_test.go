package accountrouting

import (
	"context"
	"errors"
	"fmt"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

type scriptedPreference struct {
	prefer func(candidates []accountcore.AccountRef) []accountcore.AccountRef
	err    error
	calls  int
}

func (preference *scriptedPreference) Prefer(_ context.Context, _ string, _ string, candidates []accountcore.AccountRef) ([]accountcore.AccountRef, error) {
	preference.calls++
	if preference.err != nil {
		return nil, preference.err
	}
	return preference.prefer(candidates), nil
}

func preferenceFixture(t *testing.T, count int) (*Recruiter, []accountapp.RoutingAccount) {
	t.Helper()
	candidates := make([]accountapp.RoutingAccount, 0, count)
	resolutions := make(map[accountcore.AccountRef]credentialResolution, count)
	for index := int64(1); index <= int64(count); index++ {
		candidate, credential := newRecruitmentCandidate(t, "codex", index, fmt.Sprintf("pref-%d", index))
		candidates = append(candidates, candidate)
		resolutions[candidate.Ref()] = credentialResolution{credential: credential}
	}
	return newTestRecruiter(t, &recruitmentCandidateSource{candidates: candidates}, newRecruitmentCredentialResolver(resolutions)), candidates
}

func scanOrder(t *testing.T, session *RecruitmentSession, count int) []accountcore.AccountRef {
	t.Helper()
	order := make([]accountcore.AccountRef, 0, count)
	for range count {
		result, err := session.Next(context.Background())
		if err != nil {
			t.Fatalf("Next() error = %v", err)
		}
		order = append(order, result.Account().Ref())
	}
	return order
}

func TestPreferredAccountsAreTriedFirstAndTheRestKeepRotationOrder(t *testing.T) {
	t.Parallel()
	recruiter, candidates := preferenceFixture(t, 4)
	third, first := candidates[2].Ref(), candidates[0].Ref()
	preference := &scriptedPreference{prefer: func([]accountcore.AccountRef) []accountcore.AccountRef {
		return []accountcore.AccountRef{third, first, third}
	}}
	ctx := WithPreferenceProvider(context.Background(), preference)
	session, err := recruiter.Begin(ctx, newTestRequest(t, "codex", "", 1), allowAllCredentialTransport{})
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	order := scanOrder(t, session, 4)
	if order[0] != third || order[1] != first {
		t.Fatalf("preferred accounts must come first: %v", order)
	}
	seen := map[accountcore.AccountRef]bool{}
	for _, ref := range order {
		if seen[ref] {
			t.Fatalf("an account was tried twice: %v", order)
		}
		seen[ref] = true
	}
	if _, err := session.Next(context.Background()); !errors.Is(err, ErrNoRoutableAccount) {
		t.Fatalf("exhausted: %v", err)
	}
}

func TestPreferenceOutsideTheCandidatesOrAFailingProviderFailsTheRequest(t *testing.T) {
	t.Parallel()
	recruiter, _ := preferenceFixture(t, 2)
	outside, _ := accountcore.ParseAccountRef(fmt.Sprintf("acct_%020x", 999))
	for name, preference := range map[string]*scriptedPreference{
		"outside": {prefer: func([]accountcore.AccountRef) []accountcore.AccountRef { return []accountcore.AccountRef{outside} }},
		"failing": {err: errors.New("plugin denied")},
	} {
		_, err := recruiter.Begin(WithPreferenceProvider(context.Background(), preference), newTestRequest(t, "codex", "", 1), allowAllCredentialTransport{})
		if !errors.Is(err, ErrAccountPreferenceFailed) {
			t.Fatalf("%s: err = %v", name, err)
		}
	}
}

func TestNoPreferenceProviderOrAnEmptyPreferenceKeepsTheFairRotation(t *testing.T) {
	t.Parallel()
	recruiter, _ := preferenceFixture(t, 3)
	empty := &scriptedPreference{prefer: func([]accountcore.AccountRef) []accountcore.AccountRef { return nil }}
	session, err := recruiter.Begin(WithPreferenceProvider(context.Background(), empty), newTestRequest(t, "codex", "", 1), allowAllCredentialTransport{})
	if err != nil || session.order != nil || empty.calls != 1 {
		t.Fatalf("err=%v order=%v calls=%d", err, session.order, empty.calls)
	}
	plain, err := recruiter.Begin(context.Background(), newTestRequest(t, "codex", "", 1), allowAllCredentialTransport{})
	if err != nil || plain.order != nil {
		t.Fatalf("no provider: err=%v order=%v", err, plain.order)
	}
}
