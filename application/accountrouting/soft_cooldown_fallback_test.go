package accountrouting

import (
	"context"
	"fmt"
	"testing"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// softCooldownFixture 汇集一次征召所需的真实运行态、候选快照与请求。
type softCooldownFixture struct {
	recruiter  *Recruiter
	registry   *runtimeapp.Registry
	request    Request
	candidates []accountapp.RoutingAccount
	modelID    string
}

// newSoftCooldownFixture 用真实运行态 Registry（而非资格替身）搭起征召链。
//
// 「连接失败要连续两次才进冷却」是运行态策略本身的规定。若用替身直接返回一个
// 冷却资格，锁住的只是替身的行为；只有走真实策略，这条测试才真的在验证「代理抖
// 一下就把池子清空」这个现实场景。
func newSoftCooldownFixture(
	t *testing.T,
	size int,
	overrides map[int]runtimecore.Eligibility,
) softCooldownFixture {
	t.Helper()

	candidates := make([]accountapp.RoutingAccount, 0, size)
	resolutions := map[accountcore.AccountRef]credentialResolution{}
	for index := range size {
		// 名字必须各不相同：accountRef 由它派生，同名会造出同一个账号，
		// 让「多账号」的前置条件悄悄失效。
		candidate, credential := newRecruitmentCandidate(
			t,
			"codex",
			int64(index+1),
			fmt.Sprintf("soft-cooldown-%d", index+1),
		)
		candidates = append(candidates, candidate)
		resolutions[candidate.Ref()] = credentialResolution{credential: credential}
	}
	registry, err := runtimeapp.NewRegistry(func() time.Time {
		return time.Now()
	})
	if err != nil {
		t.Fatalf("NewRegistry() error = %v", err)
	}
	var eligibilitySource RuntimeEligibilitySource = registry
	if len(overrides) > 0 {
		byRef := map[accountcore.AccountRef]runtimecore.Eligibility{}
		for index, eligibility := range overrides {
			byRef[candidates[index].Ref()] = eligibility
		}
		eligibilitySource = &overrideEligibilitySource{
			base:      registry,
			overrides: byRef,
		}
	}
	recruiter := newTestRecruiterWithRuntime(
		t,
		&recruitmentCandidateSource{candidates: candidates},
		eligibilitySource,
		newRecruitmentCredentialResolver(resolutions),
	)
	request := newTestRequest(t, "codex", "", size)
	return softCooldownFixture{
		recruiter:  recruiter,
		registry:   registry,
		request:    request,
		candidates: candidates,
		modelID:    request.ModelID().String(),
	}
}

// overrideEligibilitySource 在真实运行态之上按账号覆盖资格。
//
// 硬阻塞（额度、凭据、策略）不由运行态 Registry 承载——RecordFailure 只给出
// quota_block 指令，真正的阻塞落在账号库。这里只覆盖被指名的账号，其余仍走真实
// Registry，从而在同一条测试里同时具备「真实软冷却」和「硬阻塞」两种状态。
type overrideEligibilitySource struct {
	base      RuntimeEligibilitySource
	overrides map[accountcore.AccountRef]runtimecore.Eligibility
}

// CheckEligibility 命中覆盖时返回预设资格，否则交给真实运行态。
func (source *overrideEligibilitySource) CheckEligibility(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	if eligibility, found := source.overrides[route.AccountRef()]; found {
		return eligibility, nil
	}
	return source.base.CheckEligibility(ctx, route)
}

// coolRoute 用真实运行态策略把 (账号,模型) 打进软冷却。
func coolRoute(
	t *testing.T,
	ctx context.Context,
	registry *runtimeapp.Registry,
	accountRef accountcore.AccountRef,
	modelID string,
) {
	t.Helper()

	route, err := runtimecore.NewModelRoute(accountRef, modelID)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	for range 2 {
		if _, err := registry.RecordFailure(
			ctx,
			route,
			runtimecore.FailureConnectionReset,
			0,
		); err != nil {
			t.Fatalf("RecordFailure() error = %v", err)
		}
	}
	eligibility, err := registry.CheckEligibility(ctx, route)
	if err != nil {
		t.Fatalf("CheckEligibility() error = %v", err)
	}
	if eligibility.Status() != runtimecore.EligibilityModelCooldown {
		t.Fatalf("账号未进入软冷却，前置条件不成立: status=%s", eligibility.Status())
	}
}

// TestRecruiterServesSoftCooledAccountsRatherThanClaimingNoAccount 锁定逃生阀。
//
// 一次本地代理抖动就能把仅有的账号连续打进 (账号,模型) 软冷却。此时若交回
// ErrNoRoutableAccount，调用方只能合成一条与账号无关的「没有可调度账号」，把网络
// 故障讲成账号故障。软冷却记录的是上一次请求的遭遇，不是这一次的判决。
func TestRecruiterServesSoftCooledAccountsRatherThanClaimingNoAccount(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fixture := newSoftCooldownFixture(t, 2, nil)
	for _, candidate := range fixture.candidates {
		coolRoute(t, ctx, fixture.registry, candidate.Ref(), fixture.modelID)
	}

	session, err := fixture.recruiter.Begin(ctx, fixture.request, allowAllCredentialTransport{})
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}

	// 逃生阀必须是粘性的：两个账号都要被交出来。只放行一次的话第一个失败后又会
	// 退回「无账号」，客户端照样收到谎报。
	served := map[accountcore.AccountRef]bool{}
	for range 2 {
		result, nextErr := session.Next(ctx)
		if nextErr != nil {
			t.Fatalf("Next() error = %v（软冷却账号未被放行）", nextErr)
		}
		ref := result.Account().Ref()
		if served[ref] {
			t.Fatalf("同一账号在一次请求内被重复交出: %v", ref)
		}
		served[ref] = true
	}
	if len(served) != 2 {
		t.Fatalf("被放行的账号数 = %d, want 2", len(served))
	}

	// 重放完毕后必须如实交回「没有可征召账号」，不能无限循环。
	if _, err := session.Next(ctx); err != ErrNoRoutableAccount {
		t.Fatalf("Next() error = %v, want ErrNoRoutableAccount", err)
	}
}

// TestRecruiterPrefersHealthyAccountBeforeOpeningFallback 验证不提前打开逃生阀。
//
// 逃生阀是兜底不是常态：还有干净账号时必须先用它，冷却账号只在整轮落空后重放。
func TestRecruiterPrefersHealthyAccountBeforeOpeningFallback(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fixture := newSoftCooldownFixture(t, 2, nil)
	cooled := fixture.candidates[0]
	coolRoute(t, ctx, fixture.registry, cooled.Ref(), fixture.modelID)

	session, err := fixture.recruiter.Begin(ctx, fixture.request, allowAllCredentialTransport{})
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	result, err := session.Next(ctx)
	if err != nil {
		t.Fatalf("Next() error = %v", err)
	}
	if result.Account().Ref() == cooled.Ref() {
		t.Fatal("有干净账号时先交出了被冷却的账号")
	}

	// 干净账号用尽后，冷却账号才作为兜底被重放。
	fallback, err := session.Next(ctx)
	if err != nil {
		t.Fatalf("兜底重放失败: %v", err)
	}
	if fallback.Account().Ref() != cooled.Ref() {
		t.Fatalf("兜底交出的账号 = %v, want %v", fallback.Account().Ref(), cooled.Ref())
	}
}

// TestRecruiterFallbackNeverBypassesHardBlocks 验证硬阻塞不被逃生阀放行。
//
// 逃生阀只越过「软」的那一层。额度耗尽不会随时间自动恢复，放行它只会白打一次上游，
// 还会把真实原因盖掉。
func TestRecruiterFallbackNeverBypassesHardBlocks(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	fixture := newSoftCooldownFixture(t, 2, map[int]runtimecore.Eligibility{
		1: runtimecore.QuotaBlockedEligibility(),
	})
	cooled := fixture.candidates[0]
	coolRoute(t, ctx, fixture.registry, cooled.Ref(), fixture.modelID)

	session, err := fixture.recruiter.Begin(ctx, fixture.request, allowAllCredentialTransport{})
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	result, err := session.Next(ctx)
	if err != nil {
		t.Fatalf("Next() error = %v（软冷却账号未被放行）", err)
	}
	if result.Account().Ref() != cooled.Ref() {
		t.Fatalf("交出的账号 = %v, want 被软冷却的 %v", result.Account().Ref(), cooled.Ref())
	}
	if _, err := session.Next(ctx); err != ErrNoRoutableAccount {
		t.Fatalf("额度硬阻塞被逃生阀放行了: err = %v", err)
	}
}
