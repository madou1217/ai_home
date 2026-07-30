package accountrouting

import (
	"context"
	"io"
	"net/http"
	"strings"
	"testing"
	"testing/iotest"
	"time"

	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudefailure "github.com/madou1217/ai_home/internal/adapters/claude/upstreamfailure"
	codexfailure "github.com/madou1217/ai_home/internal/adapters/codex/upstreamfailure"
	sharedfailure "github.com/madou1217/ai_home/internal/adapters/upstreamfailure"
)

// TestProviderModelOverloadChangesOnlyMatchingRecruitment 验证两个 Provider 到征召结果的模型隔离闭环。
func TestProviderModelOverloadChangesOnlyMatchingRecruitment(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name       string
		providerID string
		modelID    string
		siblingID  string
		classify   func() (sharedfailure.Classification, error)
	}{
		{
			name:       "Codex HTTP 529",
			providerID: "codex",
			modelID:    "gpt-5.6-sol",
			siblingID:  "gpt-5.4",
			classify: func() (sharedfailure.Classification, error) {
				return codexfailure.ObserveHTTP(&http.Response{
					StatusCode: 529,
					Header:     make(http.Header),
					Body: io.NopCloser(strings.NewReader(
						`{"error":{"type":"server_error"}}`,
					)),
				}, time.Date(2026, 7, 28, 15, 0, 0, 0, time.UTC))
			},
		},
		{
			name:       "Claude 流内过载",
			providerID: "claude",
			modelID:    "claude-opus-4-1",
			siblingID:  "claude-sonnet-4",
			classify: func() (sharedfailure.Classification, error) {
				classification, observed, err := claudefailure.ObserveSSE(
					sharedfailure.SSEInput{
						EventType: "error",
						Data: iotest.OneByteReader(strings.NewReader(
							`{"type":"error","error":{"type":"overloaded_error"}}`,
						)),
						ObservedAt: time.Date(
							2026,
							7,
							28,
							15,
							0,
							0,
							0,
							time.UTC,
						),
					},
				)
				if err != nil || !observed {
					return sharedfailure.Classification{}, err
				}
				return classification, nil
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			classification, err := test.classify()
			if err != nil {
				t.Fatalf("classify() error = %v", err)
			}
			verifyModelOverloadIsolation(
				t,
				test.providerID,
				test.modelID,
				test.siblingID,
				classification,
			)
		})
	}
}

// TestIncompleteStreamRequiresTwoMatchingFailures 验证单次流抖动不制造假 no_available_account。
func TestIncompleteStreamRequiresTwoMatchingFailures(t *testing.T) {
	t.Parallel()

	now := time.Date(2026, 7, 28, 15, 0, 0, 0, time.UTC)
	fixture := newProviderFailureFixture(t, "codex", now)
	modelID := "gpt-5.6-sol"
	siblingID := "gpt-5.4"
	route := mustRuntimeRoute(t, fixture.first.Ref(), modelID)
	classification, err := sharedfailure.ClassifyIncompleteStream(
		io.ErrUnexpectedEOF,
	)
	if err != nil {
		t.Fatalf("ClassifyIncompleteStream() error = %v", err)
	}

	firstTransition, err := fixture.registry.RecordFailure(
		context.Background(),
		route,
		classification.Kind(),
		classification.RetryAfter(),
	)
	if err != nil ||
		firstTransition.FailureCount() != 1 ||
		firstTransition.CoolingDown() {
		t.Fatalf(
			"first RecordFailure() transition=%#v error=%v",
			firstTransition,
			err,
		)
	}
	afterFirstFailure := fixture.recruit(t, modelID)
	if afterFirstFailure.Account().Ref() != fixture.first.Ref() {
		t.Fatalf(
			"first stream failure selected = %s, want %s",
			afterFirstFailure.Account().Ref(),
			fixture.first.Ref(),
		)
	}

	secondTransition, err := fixture.registry.RecordFailure(
		context.Background(),
		route,
		classification.Kind(),
		classification.RetryAfter(),
	)
	if err != nil ||
		secondTransition.FailureCount() != 2 ||
		!secondTransition.CoolingDown() {
		t.Fatalf(
			"second RecordFailure() transition=%#v error=%v",
			secondTransition,
			err,
		)
	}
	afterSecondFailure := fixture.recruit(t, modelID)
	if afterSecondFailure.Account().Ref() != fixture.second.Ref() {
		t.Fatalf(
			"second stream failure selected = %s, want %s",
			afterSecondFailure.Account().Ref(),
			fixture.second.Ref(),
		)
	}
	siblingResult := fixture.recruit(t, siblingID)
	if siblingResult.Account().Ref() != fixture.first.Ref() {
		t.Fatalf(
			"sibling model selected = %s, want %s",
			siblingResult.Account().Ref(),
			fixture.first.Ref(),
		)
	}
	t.Logf(
		"failure=%s account_a=%s first_failure_selected=%s second_failure_selected=%s sibling_model=%s sibling_selected=%s",
		classification.Kind(),
		fixture.first.Ref(),
		afterFirstFailure.Account().Ref(),
		afterSecondFailure.Account().Ref(),
		siblingID,
		siblingResult.Account().Ref(),
	)
}

// verifyModelOverloadIsolation 使用真实 Registry 验证单个 Provider 的模型隔离。
func verifyModelOverloadIsolation(
	t *testing.T,
	providerID string,
	overloadedModel string,
	siblingModel string,
	classification sharedfailure.Classification,
) {
	t.Helper()

	now := time.Date(2026, 7, 28, 15, 0, 0, 0, time.UTC)
	fixture := newProviderFailureFixture(t, providerID, now)
	overloadedRoute, err := runtimecore.NewModelRoute(
		fixture.first.Ref(),
		overloadedModel,
	)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	transition, err := fixture.registry.RecordFailure(
		context.Background(),
		overloadedRoute,
		classification.Kind(),
		classification.RetryAfter(),
	)
	if err != nil || !transition.CoolingDown() {
		t.Fatalf(
			"RecordFailure() transition=%#v error=%v",
			transition,
			err,
		)
	}

	overloadedResult := fixture.recruit(t, overloadedModel)
	if overloadedResult.Account().Ref() != fixture.second.Ref() {
		t.Fatalf(
			"overloaded model selected account = %s, want %s",
			overloadedResult.Account().Ref(),
			fixture.second.Ref(),
		)
	}

	siblingResult := fixture.recruit(t, siblingModel)
	if siblingResult.Account().Ref() != fixture.first.Ref() {
		t.Fatalf(
			"sibling model selected account = %s, want %s",
			siblingResult.Account().Ref(),
			fixture.first.Ref(),
		)
	}

	if err := fixture.registry.RecordSuccess(
		context.Background(),
		overloadedRoute,
	); err != nil {
		t.Fatalf("RecordSuccess() error = %v", err)
	}
	recoveredResult := fixture.recruit(t, overloadedModel)
	if recoveredResult.Account().Ref() != fixture.first.Ref() {
		t.Fatalf(
			"recovered model selected account = %s, want %s",
			recoveredResult.Account().Ref(),
			fixture.first.Ref(),
		)
	}
	t.Logf(
		"provider=%s account_a=%s overloaded_model=%s overloaded_selected=%s sibling_model=%s sibling_selected=%s recovered_selected=%s",
		providerID,
		fixture.first.Ref(),
		overloadedModel,
		overloadedResult.Account().Ref(),
		siblingModel,
		siblingResult.Account().Ref(),
		recoveredResult.Account().Ref(),
	)
}

// providerFailureFixture 集中复用两个账号、Registry 和凭据解析测试边界。
type providerFailureFixture struct {
	providerID       string
	first            accountapp.RoutingAccount
	second           accountapp.RoutingAccount
	firstCredential  accountapp.Credential
	secondCredential accountapp.Credential
	source           *recruitmentCandidateSource
	registry         *runtimeapp.Registry
}

// newProviderFailureFixture 创建不读取真实账号数据库的隔离征召场景。
func newProviderFailureFixture(
	t *testing.T,
	providerID string,
	now time.Time,
) providerFailureFixture {
	t.Helper()

	first, firstCredential := newRecruitmentCandidate(
		t,
		providerID,
		1,
		providerID+"-failure-first",
	)
	second, secondCredential := newRecruitmentCandidate(
		t,
		providerID,
		2,
		providerID+"-failure-second",
	)
	registry, err := runtimeapp.NewRegistry(func() time.Time { return now })
	if err != nil {
		t.Fatalf("accountruntime.NewRegistry() error = %v", err)
	}
	return providerFailureFixture{
		providerID:       providerID,
		first:            first,
		second:           second,
		firstCredential:  firstCredential,
		secondCredential: secondCredential,
		source: &recruitmentCandidateSource{
			candidates: []accountapp.RoutingAccount{first, second},
		},
		registry: registry,
	}
}

// recruit 使用固定两个候选执行一次真实 Recruiter 征召。
func (fixture providerFailureFixture) recruit(
	t *testing.T,
	modelID string,
) Result {
	t.Helper()

	return recruitProviderFailureScenario(
		t,
		fixture.source,
		fixture.registry,
		fixture.providerID,
		modelID,
		map[runtimecore.ModelRoute]accountapp.Credential{
			mustRuntimeRoute(t, fixture.first.Ref(), modelID):  fixture.firstCredential,
			mustRuntimeRoute(t, fixture.second.Ref(), modelID): fixture.secondCredential,
		},
	)
}

// recruitProviderFailureScenario 使用真实 Registry 执行一次模型征召。
func recruitProviderFailureScenario(
	t *testing.T,
	source CandidateSource,
	registry RuntimeEligibilitySource,
	providerID string,
	modelID string,
	credentials map[runtimecore.ModelRoute]accountapp.Credential,
) Result {
	t.Helper()

	resolutions := make(
		map[accountcore.AccountRef]credentialResolution,
		len(credentials),
	)
	for route, credential := range credentials {
		resolutions[route.AccountRef()] = credentialResolution{
			credential: credential,
		}
	}
	recruiter := newTestRecruiterWithRuntime(
		t,
		source,
		registry,
		newRecruitmentCredentialResolver(resolutions),
	)
	request, err := NewRequest(
		testRecruitmentCatalog(t),
		providerID,
		modelID,
		"",
		2,
	)
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	result, err := recruiter.Recruit(
		context.Background(),
		request,
		allowAllCredentialTransport{},
	)
	if err != nil {
		t.Fatalf("Recruit() error = %v", err)
	}
	return result
}

// mustRuntimeRoute 创建测试使用的账号模型元组。
func mustRuntimeRoute(
	t *testing.T,
	accountRef accountcore.AccountRef,
	modelID string,
) runtimecore.ModelRoute {
	t.Helper()

	route, err := runtimecore.NewModelRoute(accountRef, modelID)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	return route
}
