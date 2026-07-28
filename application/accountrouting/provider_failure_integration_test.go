package accountrouting

import (
	"context"
	"testing"
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
				return codexfailure.Classify(codexfailure.Input{
					StatusCode: 529,
					ErrorType:  "server_error",
				})
			},
		},
		{
			name:       "Claude 流内过载",
			providerID: "claude",
			modelID:    "claude-opus-4-1",
			siblingID:  "claude-sonnet-4",
			classify: func() (sharedfailure.Classification, error) {
				return claudefailure.Classify(claudefailure.Input{
					StatusCode: 200,
					ErrorType:  "overloaded_error",
				})
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
	source := &recruitmentCandidateSource{
		candidates: []accountapp.RoutingAccount{first, second},
	}
	registry, err := runtimeapp.NewRegistry(func() time.Time { return now })
	if err != nil {
		t.Fatalf("accountruntime.NewRegistry() error = %v", err)
	}
	overloadedRoute, err := runtimecore.NewModelRoute(
		first.Ref(),
		overloadedModel,
	)
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	transition, err := registry.RecordFailure(
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

	overloadedResult := recruitProviderFailureScenario(
		t,
		source,
		registry,
		providerID,
		overloadedModel,
		map[runtimecore.ModelRoute]accountapp.Credential{
			mustRuntimeRoute(t, first.Ref(), overloadedModel):  firstCredential,
			mustRuntimeRoute(t, second.Ref(), overloadedModel): secondCredential,
		},
	)
	if overloadedResult.Account().Ref() != second.Ref() {
		t.Fatalf(
			"overloaded model selected account = %s, want %s",
			overloadedResult.Account().Ref(),
			second.Ref(),
		)
	}

	siblingResult := recruitProviderFailureScenario(
		t,
		source,
		registry,
		providerID,
		siblingModel,
		map[runtimecore.ModelRoute]accountapp.Credential{
			mustRuntimeRoute(t, first.Ref(), siblingModel):  firstCredential,
			mustRuntimeRoute(t, second.Ref(), siblingModel): secondCredential,
		},
	)
	if siblingResult.Account().Ref() != first.Ref() {
		t.Fatalf(
			"sibling model selected account = %s, want %s",
			siblingResult.Account().Ref(),
			first.Ref(),
		)
	}

	if err := registry.RecordSuccess(
		context.Background(),
		overloadedRoute,
	); err != nil {
		t.Fatalf("RecordSuccess() error = %v", err)
	}
	recoveredResult := recruitProviderFailureScenario(
		t,
		source,
		registry,
		providerID,
		overloadedModel,
		map[runtimecore.ModelRoute]accountapp.Credential{
			mustRuntimeRoute(t, first.Ref(), overloadedModel):  firstCredential,
			mustRuntimeRoute(t, second.Ref(), overloadedModel): secondCredential,
		},
	)
	if recoveredResult.Account().Ref() != first.Ref() {
		t.Fatalf(
			"recovered model selected account = %s, want %s",
			recoveredResult.Account().Ref(),
			first.Ref(),
		)
	}
	t.Logf(
		"provider=%s account_a=%s overloaded_model=%s overloaded_selected=%s sibling_model=%s sibling_selected=%s recovered_selected=%s",
		providerID,
		first.Ref(),
		overloadedModel,
		overloadedResult.Account().Ref(),
		siblingModel,
		siblingResult.Account().Ref(),
		recoveredResult.Account().Ref(),
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
	result, err := recruiter.Recruit(context.Background(), request)
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
