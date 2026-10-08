package accountrouting

import (
	"context"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestRecruiterSessionAffinitySticksToBoundAccount 验证同一会话键续接绑定账号。
func TestRecruiterSessionAffinitySticksToBoundAccount(t *testing.T) {
	t.Parallel()

	first, firstCredential := newRecruitmentCandidate(t, "codex", 1, "affinity-first")
	second, secondCredential := newRecruitmentCandidate(t, "codex", 2, "affinity-second")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {credential: firstCredential},
			second.Ref(): {credential: secondCredential},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	ctx := context.Background()
	request := newTestRequest(t, "codex", "", 2).
		WithSessionAffinity("session-sticky", false)

	// 首轮无绑定：公平起点 0，选中 first 并写入绑定。
	session, err := recruiter.Begin(ctx, request, allowAllCredentialTransport{})
	if err != nil {
		t.Fatalf("Begin(first) error = %v", err)
	}
	if session.start != 0 || session.order != nil {
		t.Fatalf(
			"first session start=%d order=%v, want start 0 且无亲和顺序",
			session.start,
			session.order,
		)
	}
	firstPick, err := session.Next(ctx)
	if err != nil || firstPick.Account().Ref() != first.Ref() {
		t.Fatalf("first pick=%#v error=%v, want first", firstPick, err)
	}

	// 次轮公平起点推进到 1，但会话亲和把绑定账号排到最前。
	sticky, err := recruiter.Begin(ctx, request, allowAllCredentialTransport{})
	if err != nil {
		t.Fatalf("Begin(second) error = %v", err)
	}
	if sticky.start != 1 {
		t.Fatalf("second session start=%d, want 1（公平游标应已推进）", sticky.start)
	}
	if len(sticky.order) != 2 || sticky.order[0] != 0 {
		t.Fatalf("second session order=%v, want 绑定账号在最前", sticky.order)
	}
	secondPick, err := sticky.Next(ctx)
	if err != nil || secondPick.Account().Ref() != first.Ref() {
		t.Fatalf("second pick=%#v error=%v, want first（会话亲和）", secondPick, err)
	}
}

// TestRecruiterSessionAffinityStickyOverSoftCooldown 验证携带加密推理链的续接请求
// 硬性优先其绑定账号，即使该账号仅被 (账号,模型) 软冷却挡住。
func TestRecruiterSessionAffinityStickyOverSoftCooldown(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fixture := newSoftCooldownFixture(t, 2, nil)
	preserve := fixture.request.WithSessionAffinity("session-sticky", true)

	// 首轮绑定第一个账号。
	bound, err := fixture.recruiter.Recruit(
		ctx,
		preserve,
		allowAllCredentialTransport{},
	)
	if err != nil {
		t.Fatalf("Recruit(first) error = %v", err)
	}
	coolRoute(t, ctx, fixture.registry, bound.Account().Ref(), fixture.modelID)

	// preserve=true：绑定账号仅被软冷却挡住，硬性优先。
	sticky, err := fixture.recruiter.Recruit(
		ctx,
		preserve,
		allowAllCredentialTransport{},
	)
	if err != nil || sticky.Account().Ref() != bound.Account().Ref() {
		t.Fatalf("sticky pick=%#v error=%v, want %v", sticky, err, bound.Account().Ref())
	}

	// preserve=false：普通续接请求跳过被软冷却的绑定账号，回落到其余候选。
	plain := fixture.request.WithSessionAffinity("session-sticky", false)
	fallback, err := fixture.recruiter.Recruit(
		ctx,
		plain,
		allowAllCredentialTransport{},
	)
	if err != nil || fallback.Account().Ref() == bound.Account().Ref() {
		t.Fatalf("plain pick=%#v error=%v, want 非绑定账号", fallback, err)
	}
}

// TestRecruiterSessionAffinityRebindsWhenBoundAccountLeavesCandidates 验证绑定账号
// 离开候选池后亲和失效并按公平起点重新绑定。
func TestRecruiterSessionAffinityRebindsWhenBoundAccountLeavesCandidates(t *testing.T) {
	t.Parallel()

	first, firstCredential := newRecruitmentCandidate(t, "codex", 1, "rebind-first")
	second, secondCredential := newRecruitmentCandidate(t, "codex", 2, "rebind-second")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {credential: firstCredential},
			second.Ref(): {credential: secondCredential},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	ctx := context.Background()
	request := newTestRequest(t, "codex", "", 2).
		WithSessionAffinity("session-rebind", false)

	if _, err := recruiter.Recruit(ctx, request, allowAllCredentialTransport{}); err != nil {
		t.Fatalf("Recruit(first) error = %v", err)
	}
	// first 离开候选池后，绑定失效并按公平起点重新绑定 second。
	source.SetCandidates([]accountapp.RoutingAccount{second})
	result, err := recruiter.Recruit(ctx, request, allowAllCredentialTransport{})
	if err != nil || result.Account().Ref() != second.Ref() {
		t.Fatalf("Recruit(after removal) result=%#v error=%v, want second", result, err)
	}
	rebound, found := recruiter.affinity.Lookup(
		"codex",
		"session-rebind",
		recruiter.now(),
	)
	if !found || rebound != second.Ref() {
		t.Fatalf("affinity after rebind = %q, %v, want second", rebound, found)
	}
}

// TestRecruiterWithoutSessionKeyIgnoresAffinity 验证没有会话键时不物化亲和顺序。
func TestRecruiterWithoutSessionKeyIgnoresAffinity(t *testing.T) {
	t.Parallel()

	first, firstCredential := newRecruitmentCandidate(t, "codex", 1, "no-key-first")
	second, secondCredential := newRecruitmentCandidate(t, "codex", 2, "no-key-second")
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	resolver := newRecruitmentCredentialResolver(
		map[accountcore.AccountRef]credentialResolution{
			first.Ref():  {credential: firstCredential},
			second.Ref(): {credential: secondCredential},
		},
	)
	recruiter := newTestRecruiter(t, source, resolver)
	ctx := context.Background()

	for range 2 {
		session, err := recruiter.Begin(
			ctx,
			newTestRequest(t, "codex", "", 2),
			allowAllCredentialTransport{},
		)
		if err != nil {
			t.Fatalf("Begin() error = %v", err)
		}
		if session.order != nil {
			t.Fatalf("session order=%v, want nil（无会话键）", session.order)
		}
		if _, err := session.Next(ctx); err != nil {
			t.Fatalf("Next() error = %v", err)
		}
	}
}
