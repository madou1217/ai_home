package inferencegateway_test

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// TestCoordinatorCommitsSuccessTerminalAfterStateRecord 验证成功终态不会早于状态提交。
func TestCoordinatorCommitsSuccessTerminalAfterStateRecord(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	events := make([]inference.StreamEvent, 0, 2)
	recorder := &attemptRecorder{
		onSuccess: func(runtimecore.ModelRoute) error {
			if len(events) != 1 ||
				events[0].Kind() != inference.EventResponseStarted {
				return errors.New("成功状态记录前已经提交终态")
			}
			return nil
		},
	}
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			for _, event := range successfulEvents(t, "resp_success") {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	coordinator := fixture.newCoordinator(t, upstream, recorder)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", false),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(events) != 2 ||
		events[0].Kind() != inference.EventResponseStarted ||
		events[1].Kind() != inference.EventResponseCompleted ||
		recorder.SuccessCount() != 1 ||
		recorder.FailureCount() != 0 {
		t.Fatalf(
			"events=%v success=%d failures=%d",
			eventKinds(events),
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
	invocation := upstream.Invocations()[0]
	if invocation.Account().Ref() != fixture.accounts[0].Ref() ||
		invocation.Route().EffectiveModel() != "gpt-5.6-sol" ||
		invocation.Credential().ProviderID() != "codex" {
		t.Fatalf("Invocation = %#v", invocation)
	}
}

// TestCoordinatorDistributesHealthyRequestsFairly 验证连续请求不会长期集中到
// AccountRef 最小的健康账号。
func TestCoordinatorDistributesHealthyRequestsFairly(t *testing.T) {
	t.Parallel()

	const requestCount = 30
	fixture := newCoordinatorFixture(t, "codex", 3)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			for _, event := range successfulEvents(t, "resp_fair") {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	coordinator := fixture.newCoordinator(t, upstream, &attemptRecorder{})
	request := newTextRequest(t, "gpt-5.6-sol", true)

	for range requestCount {
		if err := coordinator.Execute(
			context.Background(),
			request,
			func(inference.StreamEvent) error { return nil },
		); err != nil {
			t.Fatalf("Execute() error = %v", err)
		}
	}
	counts := make(map[accountcore.AccountRef]int, len(fixture.accounts))
	for _, invocation := range upstream.Invocations() {
		counts[invocation.Account().Ref()]++
	}
	for _, account := range fixture.accounts {
		if counts[account.Ref()] != requestCount/len(fixture.accounts) {
			t.Fatalf(
				"account=%s calls=%d distribution=%v",
				account.Ref(),
				counts[account.Ref()],
				counts,
			)
		}
	}
	t.Logf("requests=%d accounts=%d distribution=%v", requestCount, len(counts), counts)
}

// TestCoordinatorDistributesConcurrentHealthyRequestsFairly 验证并发请求仍按原子票号
// 均匀分配，不会因竞争丢票或集中到少数账号。
func TestCoordinatorDistributesConcurrentHealthyRequestsFairly(t *testing.T) {
	t.Parallel()

	const (
		accountCount = 10
		requestCount = 1_000
	)
	fixture := newCoordinatorFixture(t, "codex", accountCount)
	events := successfulEvents(t, "resp_concurrent_fair")
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			for _, event := range events {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	coordinator := fixture.newCoordinator(t, upstream, &attemptRecorder{})
	request := newTextRequest(t, "gpt-5.6-sol", true)
	errorsByRequest := make(chan error, requestCount)
	var waitGroup sync.WaitGroup
	waitGroup.Add(requestCount)
	for range requestCount {
		go func() {
			defer waitGroup.Done()
			if err := coordinator.Execute(
				context.Background(),
				request,
				func(inference.StreamEvent) error { return nil },
			); err != nil {
				errorsByRequest <- err
			}
		}()
	}
	waitGroup.Wait()
	close(errorsByRequest)
	for err := range errorsByRequest {
		t.Fatalf("Execute() error = %v", err)
	}

	counts := make(map[accountcore.AccountRef]int, accountCount)
	for _, invocation := range upstream.Invocations() {
		counts[invocation.Account().Ref()]++
	}
	for _, account := range fixture.accounts {
		if counts[account.Ref()] != requestCount/accountCount {
			t.Fatalf(
				"account=%s calls=%d distribution=%v",
				account.Ref(),
				counts[account.Ref()],
				counts,
			)
		}
	}
	t.Logf("requests=%d accounts=%d calls_per_account=%d", requestCount, accountCount, requestCount/accountCount)
}

// TestCoordinatorSkipsTransportIncompatibleAccount 验证 Adapter 的传输策略
// 在 Invocation 和失败记录前生效，并继续使用同一模型的后续账号。
func TestCoordinatorSkipsTransportIncompatibleAccount(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "claude", 2)
	nativeOnlyRef := fixture.accounts[0].Ref()
	upstream := newScriptedUpstream(
		inference.ProtocolClaudeMessages,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			for _, event := range successfulEvents(t, "resp_transport") {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	upstream.supportsCredential = func(
		credential accountapp.Credential,
	) bool {
		accountRef, err := accountcore.DeriveAccountRef(credential)
		return err == nil && accountRef != nativeOnlyRef
	}
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "claude-opus-4-6", true),
		func(inference.StreamEvent) error { return nil },
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	invocations := upstream.Invocations()
	if len(invocations) != 1 ||
		invocations[0].Account().Ref() == nativeOnlyRef ||
		recorder.SuccessCount() != 1 ||
		recorder.FailureCount() != 0 {
		t.Fatalf(
			"invocations=%v successes=%d failures=%d",
			invocations,
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
}

// TestCoordinatorRotatesOnlyBeforeVisibleOutput 验证未提交输出时才丢弃失败并换号。
func TestCoordinatorRotatesOnlyBeforeVisibleOutput(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 2)
	publicFailure, attemptFailure := overloadedFailure(t)
	call := 0
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			call++
			if call == 1 {
				failed, err := inference.NewResponseFailedEvent(
					0,
					publicFailure,
				)
				if err != nil {
					return inferencegateway.AttemptResult{}, err
				}
				if err := emit(failed); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
				return inferencegateway.FailedAttempt(attemptFailure), nil
			}
			for _, event := range successfulEvents(t, "resp_rotated") {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)
	events := make([]inference.StreamEvent, 0, 2)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	invocations := upstream.Invocations()
	if len(invocations) != 2 ||
		invocations[0].Account().Ref() == invocations[1].Account().Ref() ||
		len(events) != 2 ||
		events[0].Kind() != inference.EventResponseStarted ||
		events[1].Kind() != inference.EventResponseCompleted ||
		recorder.FailureCount() != 1 ||
		recorder.SuccessCount() != 1 {
		t.Fatalf(
			"invocations=%d events=%v success=%d failures=%d",
			len(invocations),
			eventKinds(events),
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
	started := events[0].(inference.ResponseStartedEvent)
	if started.ResponseID() != "resp_rotated" {
		t.Fatalf("visible response id = %q", started.ResponseID())
	}
	recordedFailure := recorder.Failures()[0]
	if recordedFailure.route.AccountRef() != invocations[0].Account().Ref() ||
		recordedFailure.route.ModelID().String() != "gpt-5.6-sol" {
		t.Fatalf("recorded failure = %#v", recordedFailure)
	}
}

// TestCoordinatorCommitsLastSafeFailureAfterAllAccountsFail 验证账号耗尽时不会丢失
// 最后一个已经记录且经过脱敏的失败终态。
func TestCoordinatorCommitsLastSafeFailureAfterAllAccountsFail(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 2)
	firstFailure, firstAttempt := newAttemptFailure(
		t,
		"first_overloaded",
		"First account is overloaded",
		true,
		runtimecore.FailureModelOverloaded,
	)
	lastFailure, lastAttempt := newAttemptFailure(
		t,
		"last_overloaded",
		"Last account is overloaded",
		true,
		runtimecore.FailureModelOverloaded,
	)
	attempts := []inferencegateway.AttemptFailure{
		firstAttempt,
		lastAttempt,
	}
	call := 0
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			_ inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			result := inferencegateway.FailedAttempt(attempts[call])
			call++
			return result, nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)
	events := make([]inference.StreamEvent, 0, 1)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(upstream.Invocations()) != 2 ||
		recorder.FailureCount() != 2 ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"invocations=%d failures=%d events=%v",
			len(upstream.Invocations()),
			recorder.FailureCount(),
			eventKinds(events),
		)
	}
	failed := events[0].(inference.ResponseFailedEvent)
	if sameFailure(failed.Failure(), firstFailure) ||
		!sameFailure(failed.Failure(), lastFailure) {
		t.Fatalf(
			"committed failure=(%q,%q), want last failure",
			failed.Failure().Code(),
			failed.Failure().SafeMessage(),
		)
	}
	t.Logf(
		"attempts=%d emitted=[response_failed code=%s message=%q]",
		len(upstream.Invocations()),
		failed.Failure().Code(),
		failed.Failure().SafeMessage(),
	)
}

// TestCoordinatorDoesNotRotateNonRetryableFailure 验证运行态需要阻塞时也必须尊重
// Canonical failure 的不可重试标记。
func TestCoordinatorDoesNotRotateNonRetryableFailure(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "claude", 2)
	publicFailure, attemptFailure := newAttemptFailure(
		t,
		"authentication_error",
		"Account credential was rejected",
		false,
		runtimecore.FailureCredentialRejected,
	)
	upstream := newScriptedUpstream(
		inference.ProtocolClaudeMessages,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			_ inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			return inferencegateway.FailedAttempt(attemptFailure), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)
	events := make([]inference.StreamEvent, 0, 1)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "claude-opus-4-6", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(upstream.Invocations()) != 1 ||
		recorder.FailureCount() != 1 ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"invocations=%d failures=%d events=%v",
			len(upstream.Invocations()),
			recorder.FailureCount(),
			eventKinds(events),
		)
	}
	failed := events[0].(inference.ResponseFailedEvent)
	if !sameFailure(failed.Failure(), publicFailure) {
		t.Fatalf("committed failure = %#v", failed.Failure())
	}
}

// TestCoordinatorRefreshesOnlyExplicitlyUnsupportedModels 验证容量、限流和 5xx 不污染模型目录。
func TestCoordinatorRefreshesOnlyExplicitlyUnsupportedModels(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		kind          runtimecore.FailureKind
		wantSchedules int
	}{
		{
			name:          "model unsupported",
			kind:          runtimecore.FailureModelUnsupported,
			wantSchedules: 1,
		},
		{
			name: "rate limited",
			kind: runtimecore.FailureRateLimited,
		},
		{
			name: "model overloaded",
			kind: runtimecore.FailureModelOverloaded,
		},
		{
			name: "upstream unavailable",
			kind: runtimecore.FailureUpstreamUnavailable,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			fixture := newCoordinatorFixture(t, "codex", 1)
			_, failure := newAttemptFailure(
				t,
				string(test.kind),
				"safe synthetic failure",
				true,
				test.kind,
			)
			upstream := newScriptedUpstream(
				inference.ProtocolCodexResponses,
				func(
					_ context.Context,
					_ inferencegateway.Invocation,
					_ inferencegateway.EventSink,
				) (inferencegateway.AttemptResult, error) {
					return inferencegateway.FailedAttempt(failure), nil
				},
			)
			coordinator := fixture.newCoordinator(
				t,
				upstream,
				&attemptRecorder{},
			)
			if err := coordinator.Execute(
				context.Background(),
				newTextRequest(t, "gpt-5.6-sol", true),
				func(inference.StreamEvent) error { return nil },
			); err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			schedules := fixture.refreshes.Schedules()
			if len(schedules) != test.wantSchedules {
				t.Fatalf(
					"refresh schedules = %#v, want %d",
					schedules,
					test.wantSchedules,
				)
			}
			if test.wantSchedules == 1 &&
				(schedules[0].accountRef != fixture.accounts[0].Ref() ||
					schedules[0].providerID != "codex") {
				t.Fatalf("refresh schedule = %#v", schedules[0])
			}
		})
	}
}

// TestCoordinatorDoesNotOverrideUpstreamFailureWhenRefreshQueueRejects
// 验证旁路刷新队列故障不会把真实模型不支持终态改写成内部错误。
func TestCoordinatorDoesNotOverrideUpstreamFailureWhenRefreshQueueRejects(
	t *testing.T,
) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	fixture.refreshes.err = errors.New("synthetic refresh queue closed")
	publicFailure, failure := newAttemptFailure(
		t,
		"model_not_found",
		"Account does not support this model",
		false,
		runtimecore.FailureModelUnsupported,
	)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			_ inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			return inferencegateway.FailedAttempt(failure), nil
		},
	)
	coordinator := fixture.newCoordinator(t, upstream, &attemptRecorder{})
	var events []inference.StreamEvent
	if err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed ||
		!sameFailure(
			events[0].(inference.ResponseFailedEvent).Failure(),
			publicFailure,
		) ||
		len(fixture.refreshes.Schedules()) != 1 {
		t.Fatalf(
			"events=%v schedules=%#v",
			eventKinds(events),
			fixture.refreshes.Schedules(),
		)
	}
}

// TestCoordinatorFallsBackAcrossOrderedRouteCandidates 验证一个模型候选耗尽后，
// Coordinator 会尝试下一候选，并且不会把前一候选失败暴露给客户端。
func TestCoordinatorFallsBackAcrossOrderedRouteCandidates(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	secondRoute, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.4",
		fixture.route.Capabilities(),
	)
	if err != nil {
		t.Fatalf("NewRoute(second) error = %v", err)
	}
	_, firstFailure := overloadedFailure(t)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			invocation inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			if invocation.Route().EffectiveModel() == fixture.route.EffectiveModel() {
				return inferencegateway.FailedAttempt(firstFailure), nil
			}
			for _, event := range successfulEventsForModel(
				t,
				"resp_route_fallback",
				secondRoute.EffectiveModel(),
			) {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	recorder := &attemptRecorder{}
	catalog := testRouteCatalog(
		t,
		testRouteRule(
			t,
			"client-model-alias",
			inferencegateway.RouteScopeAll,
			fixture.route,
			10,
		),
		testRouteRule(
			t,
			"client-model-alias",
			inferencegateway.RouteScopeAll,
			secondRoute,
			0,
		),
	)
	coordinator := fixture.newCoordinatorWithResolver(
		t,
		upstream,
		recorder,
		catalog,
	)
	events := make([]inference.StreamEvent, 0, 2)

	err = coordinator.Execute(
		context.Background(),
		newTextRequest(t, "client-model-alias", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	invocations := upstream.Invocations()
	if len(invocations) != 2 ||
		invocations[0].Route().EffectiveModel() != "gpt-5.6-sol" ||
		invocations[1].Route().EffectiveModel() != "gpt-5.4" ||
		recorder.FailureCount() != 1 ||
		recorder.SuccessCount() != 1 ||
		len(events) != 2 ||
		events[0].Kind() != inference.EventResponseStarted ||
		events[1].Kind() != inference.EventResponseCompleted {
		t.Fatalf(
			"invocations=%#v failures=%d successes=%d events=%v",
			invocations,
			recorder.FailureCount(),
			recorder.SuccessCount(),
			eventKinds(events),
		)
	}
	started := events[0].(inference.ResponseStartedEvent)
	if started.ResponseID() != "resp_route_fallback" ||
		started.Model() != "gpt-5.4" {
		t.Fatalf("visible started event = %#v", started)
	}
}

// TestCoordinatorSkipsUnsupportedRouteCandidateBeforeRecruitment 验证能力不足的
// 候选不会读取账号，并且不会阻止后续候选执行。
func TestCoordinatorSkipsUnsupportedRouteCandidateBeforeRecruitment(
	t *testing.T,
) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	textOnly, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	unsupported, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-text-only",
		textOnly,
	)
	if err != nil {
		t.Fatalf("NewRoute(unsupported) error = %v", err)
	}
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			invocation inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			for _, event := range successfulEventsForModel(
				t,
				"resp_capability_fallback",
				invocation.Route().EffectiveModel(),
			) {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinatorWithRoutes(
		t,
		upstream,
		recorder,
		unsupported,
		fixture.route,
	)

	err = coordinator.Execute(
		context.Background(),
		newToolRequest(t),
		func(inference.StreamEvent) error { return nil },
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	invocations := upstream.Invocations()
	if fixture.source.CallCount() != 1 ||
		len(invocations) != 1 ||
		invocations[0].Route() != fixture.route ||
		recorder.SuccessCount() != 1 {
		t.Fatalf(
			"recruiter calls=%d invocations=%#v successes=%d",
			fixture.source.CallCount(),
			invocations,
			recorder.SuccessCount(),
		)
	}
}

// TestCoordinatorCommitsLastFailureAcrossAllRouteCandidates 验证所有候选均耗尽时
// 只提交最后一次已记录的安全失败。
func TestCoordinatorCommitsLastFailureAcrossAllRouteCandidates(
	t *testing.T,
) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	secondRoute, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.4",
		fixture.route.Capabilities(),
	)
	if err != nil {
		t.Fatalf("NewRoute(second) error = %v", err)
	}
	firstPublic, firstFailure := newAttemptFailure(
		t,
		"first_route_overloaded",
		"First route is overloaded",
		true,
		runtimecore.FailureModelOverloaded,
	)
	lastPublic, lastFailure := newAttemptFailure(
		t,
		"last_route_overloaded",
		"Last route is overloaded",
		true,
		runtimecore.FailureModelOverloaded,
	)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			invocation inferencegateway.Invocation,
			_ inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			if invocation.Route() == fixture.route {
				return inferencegateway.FailedAttempt(firstFailure), nil
			}
			return inferencegateway.FailedAttempt(lastFailure), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinatorWithRoutes(
		t,
		upstream,
		recorder,
		fixture.route,
		secondRoute,
	)
	events := make([]inference.StreamEvent, 0, 1)

	err = coordinator.Execute(
		context.Background(),
		newTextRequest(t, "client-model-alias", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(upstream.Invocations()) != 2 ||
		recorder.FailureCount() != 2 ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"invocations=%d failures=%d events=%v",
			len(upstream.Invocations()),
			recorder.FailureCount(),
			eventKinds(events),
		)
	}
	failed := events[0].(inference.ResponseFailedEvent)
	if sameFailure(failed.Failure(), firstPublic) ||
		!sameFailure(failed.Failure(), lastPublic) {
		t.Fatalf("committed failure = %#v", failed.Failure())
	}
}

// TestCoordinatorBoundsUpstreamAttemptsForEveryRouteCandidate 验证路由候选不会共享
// 已消耗的上游调用预算，也不会让单候选突破固定上限。
func TestCoordinatorBoundsUpstreamAttemptsForEveryRouteCandidate(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(
		t,
		"codex",
		inferencegateway.DefaultUpstreamAttemptLimit+8,
	)
	secondRoute, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.4",
		fixture.route.Capabilities(),
	)
	if err != nil {
		t.Fatalf("NewRoute(second) error = %v", err)
	}
	publicFailure, attemptFailure := overloadedFailure(t)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			context.Context,
			inferencegateway.Invocation,
			inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			return inferencegateway.FailedAttempt(attemptFailure), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinatorWithRoutes(
		t,
		upstream,
		recorder,
		fixture.route,
		secondRoute,
	)
	events := make([]inference.StreamEvent, 0, 1)

	err = coordinator.Execute(
		context.Background(),
		newTextRequest(t, "client-model-alias", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	wantAttempts := inferencegateway.DefaultUpstreamAttemptLimit * 2
	if len(upstream.Invocations()) != wantAttempts ||
		recorder.FailureCount() != wantAttempts ||
		len(events) != 1 {
		t.Fatalf(
			"invocations=%d failures=%d events=%v",
			len(upstream.Invocations()),
			recorder.FailureCount(),
			eventKinds(events),
		)
	}
	failed := events[0].(inference.ResponseFailedEvent)
	if !sameFailure(failed.Failure(), publicFailure) {
		t.Fatalf("committed failure = %#v", failed.Failure())
	}
}

// TestCoordinatorStopsAtBoundedUpstreamAttemptLimit 验证大账号池也只调用固定数量，
// 不会因上游连续失败放大为全账号上游请求。
func TestCoordinatorStopsAtBoundedUpstreamAttemptLimit(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(
		t,
		"codex",
		10_000,
	)
	publicFailure, attemptFailure := overloadedFailure(t)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			_ inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			return inferencegateway.FailedAttempt(attemptFailure), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)
	events := make([]inference.StreamEvent, 0, 1)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(upstream.Invocations()) != inferencegateway.DefaultUpstreamAttemptLimit ||
		recorder.FailureCount() != inferencegateway.DefaultUpstreamAttemptLimit ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"invocations=%d failures=%d events=%v",
			len(upstream.Invocations()),
			recorder.FailureCount(),
			eventKinds(events),
		)
	}
	failed := events[0].(inference.ResponseFailedEvent)
	if !sameFailure(failed.Failure(), publicFailure) {
		t.Fatalf("committed failure = %#v", failed.Failure())
	}
	t.Logf(
		"pool=%d scanned=%d emitted=[response_failed code=%s]",
		len(fixture.accounts),
		len(upstream.Invocations()),
		failed.Failure().Code(),
	)
}

// TestCoordinatorScansTenThousandBlockedAccountsWithoutCredentialOrUpstream
// 验证候选全不可用时只做本地运行态扫描，不读取秘密也不制造上游请求风暴。
func TestCoordinatorScansTenThousandBlockedAccountsWithoutCredentialOrUpstream(
	t *testing.T,
) {
	const accountCount = 10_000

	fixture := newCoordinatorFixture(t, "codex", accountCount)
	runtimeSource := &blockedRuntime{}
	credentials := &countingCredentialResolver{}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates:  fixture.source,
			Runtime:     runtimeSource,
			Credentials: credentials,
		},
	)
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	fixture.recruit = recruiter
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			context.Context,
			inferencegateway.Invocation,
			inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			return inferencegateway.AttemptResult{}, errors.New("不应调用上游")
		},
	)
	coordinator := fixture.newCoordinator(t, upstream, &attemptRecorder{})

	err = coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(inference.StreamEvent) error { return nil },
	)
	if !errors.Is(err, inferencegateway.ErrNoRoutableAccount) ||
		runtimeSource.CallCount() != accountCount ||
		credentials.CallCount() != 0 ||
		len(upstream.Invocations()) != 0 ||
		fixture.source.CallCount() != 1 {
		t.Fatalf(
			"error=%v runtime=%d credentials=%d upstream=%d snapshots=%d",
			err,
			runtimeSource.CallCount(),
			credentials.CallCount(),
			len(upstream.Invocations()),
			fixture.source.CallCount(),
		)
	}
	t.Logf(
		"pool=%d runtime_checks=%d credential_reads=%d upstream_calls=%d",
		accountCount,
		runtimeSource.CallCount(),
		credentials.CallCount(),
		len(upstream.Invocations()),
	)
}

// TestCoordinatorKeepsAccountAfterVisibleOutput 验证开始事件之后的失败不会切换身份。
func TestCoordinatorKeepsAccountAfterVisibleOutput(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "claude", 2)
	_, attemptFailure := overloadedFailure(t)
	upstream := newScriptedUpstream(
		inference.ProtocolClaudeMessages,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			started, err := inference.NewResponseStartedEvent(
				0,
				"msg_visible_failure",
				"claude-opus-4-6",
			)
			if err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			if err := emit(started); err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			return inferencegateway.FailedAttempt(attemptFailure), nil
		},
	)
	events := make([]inference.StreamEvent, 0, 2)
	recorder := &attemptRecorder{
		onFailure: func(
			runtimecore.ModelRoute,
			inferencegateway.AttemptFailure,
		) error {
			if len(events) != 1 {
				return errors.New("失败状态记录前终态已对客户端可见")
			}
			return nil
		},
	}
	coordinator := fixture.newCoordinator(t, upstream, recorder)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "claude-opus-4-6", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(upstream.Invocations()) != 1 ||
		len(events) != 2 ||
		events[0].Kind() != inference.EventResponseStarted ||
		events[1].Kind() != inference.EventResponseFailed ||
		recorder.FailureCount() != 1 ||
		recorder.SuccessCount() != 0 {
		t.Fatalf(
			"invocations=%d events=%v success=%d failures=%d",
			len(upstream.Invocations()),
			eventKinds(events),
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
}

// TestCoordinatorRejectsUnsupportedCapabilitiesBeforeAccountRecruitment 验证能力不足不会读账号。
func TestCoordinatorRejectsUnsupportedCapabilitiesBeforeAccountRecruitment(
	t *testing.T,
) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	textOnly, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	fixture.route, err = inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.6-sol",
		textOnly,
	)
	if err != nil {
		t.Fatalf("NewRoute() error = %v", err)
	}
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			context.Context,
			inferencegateway.Invocation,
			inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			return inferencegateway.AttemptResult{},
				errors.New("能力不足时不应调用上游")
		},
	)
	coordinator := fixture.newCoordinator(t, upstream, &attemptRecorder{})

	err = coordinator.Execute(
		context.Background(),
		newToolRequest(t),
		func(inference.StreamEvent) error { return nil },
	)
	if !errors.Is(
		err,
		inferencegateway.ErrUnsupportedRouteCapabilities,
	) {
		t.Fatalf("Execute() error = %v", err)
	}
	if fixture.source.CallCount() != 0 ||
		len(upstream.Invocations()) != 0 {
		t.Fatalf(
			"capability rejection reached recruiter=%d upstream=%d",
			fixture.source.CallCount(),
			len(upstream.Invocations()),
		)
	}
}

// TestCoordinatorPropagatesClientBackpressureWithoutRecordingSuccess 验证写失败立即终止。
func TestCoordinatorPropagatesClientBackpressureWithoutRecordingSuccess(
	t *testing.T,
) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	writeErr := errors.New("synthetic client write failure")
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			started, err := inference.NewResponseStartedEvent(
				0,
				"resp_backpressure",
				"gpt-5.6-sol",
			)
			if err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			if err := emit(started); err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(inference.StreamEvent) error { return writeErr },
	)
	if !errors.Is(err, writeErr) {
		t.Fatalf("Execute() error = %v", err)
	}
	if recorder.SuccessCount() != 0 || recorder.FailureCount() != 0 {
		t.Fatalf(
			"backpressure changed state: success=%d failure=%d",
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
}

// TestCoordinatorRejectsDiscontinuousUpstreamEvents 验证 Adapter 不能跳过
// Canonical 序号，也不能在合同错误后写入账号状态。
func TestCoordinatorRejectsDiscontinuousUpstreamEvents(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			started, err := inference.NewResponseStartedEvent(
				1,
				"resp_invalid_sequence",
				"gpt-5.6-sol",
			)
			if err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			if err := emit(started); err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)
	events := make([]inference.StreamEvent, 0, 1)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if !errors.Is(
		err,
		inferencegateway.ErrInvalidUpstreamEventStream,
	) {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(events) != 0 ||
		recorder.SuccessCount() != 0 ||
		recorder.FailureCount() != 0 {
		t.Fatalf(
			"events=%v success=%d failures=%d",
			eventKinds(events),
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
}

// TestCoordinatorRejectsMismatchedFailureTerminal 验证 Adapter 的失败事件和
// AttemptResult 分类必须完全一致，避免记录错误状态或暴露矛盾响应。
func TestCoordinatorRejectsMismatchedFailureTerminal(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "claude", 1)
	eventFailure, _ := newAttemptFailure(
		t,
		"overloaded_error",
		"Model is overloaded",
		true,
		runtimecore.FailureModelOverloaded,
	)
	_, resultFailure := newAttemptFailure(
		t,
		"rate_limit_error",
		"Rate limit reached",
		true,
		runtimecore.FailureRateLimited,
	)
	upstream := newScriptedUpstream(
		inference.ProtocolClaudeMessages,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			failed, err := inference.NewResponseFailedEvent(0, eventFailure)
			if err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			if err := emit(failed); err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			return inferencegateway.FailedAttempt(resultFailure), nil
		},
	)
	recorder := &attemptRecorder{}
	coordinator := fixture.newCoordinator(t, upstream, recorder)
	events := make([]inference.StreamEvent, 0, 1)

	err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "claude-opus-4-6", true),
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	if !errors.Is(
		err,
		inferencegateway.ErrInvalidUpstreamEventStream,
	) {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(events) != 0 ||
		recorder.SuccessCount() != 0 ||
		recorder.FailureCount() != 0 {
		t.Fatalf(
			"events=%v success=%d failures=%d",
			eventKinds(events),
			recorder.SuccessCount(),
			recorder.FailureCount(),
		)
	}
}

// coordinatorFixture 保存执行器测试共用的真实 Recruiter 和显式 Route。
type coordinatorFixture struct {
	catalog   *providers.Catalog
	accounts  []accountapp.RoutingAccount
	source    *candidateSource
	recruit   *accountrouting.Recruiter
	route     inferencegateway.Route
	refreshes *modelRefreshScheduler
}

// newCoordinatorFixture 创建按 AccountRef 排序的合成账号征召边界。
func newCoordinatorFixture(
	t testing.TB,
	providerID string,
	accountCount int,
) *coordinatorFixture {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	accounts := make([]accountapp.RoutingAccount, 0, accountCount)
	credentials := make(map[accountcore.AccountRef]accountapp.Credential)
	for index := 0; index < accountCount; index++ {
		credential := coordinatorCredential{
			providerID: providerID,
			identity: fmt.Sprintf(
				"%s:coordinator:%d",
				providerID,
				index+1,
			),
		}
		accountRef, deriveErr := accountcore.DeriveAccountRef(credential)
		if deriveErr != nil {
			t.Fatalf("DeriveAccountRef() error = %v", deriveErr)
		}
		alias, aliasErr := accountcore.NewCLIAccountID(int64(index + 1))
		if aliasErr != nil {
			t.Fatalf("NewCLIAccountID() error = %v", aliasErr)
		}
		account, accountErr := accountapp.NewRoutingAccount(
			catalog,
			accountapp.RoutingAccountInput{
				Ref:          accountRef,
				ProviderID:   providerID,
				CLIAccountID: alias,
			},
		)
		if accountErr != nil {
			t.Fatalf("NewRoutingAccount() error = %v", accountErr)
		}
		accounts = append(accounts, account)
		credentials[accountRef] = credential
	}
	sort.Slice(accounts, func(left int, right int) bool {
		return accounts[left].Ref().String() < accounts[right].Ref().String()
	})
	source := &candidateSource{accounts: accounts}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates:  source,
			Runtime:     availableRuntime{},
			Credentials: credentialResolver{credentials: credentials},
		},
	)
	if err != nil {
		t.Fatalf("NewRecruiter() error = %v", err)
	}
	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityTools,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	provider := inference.ProviderID(providerID)
	protocol := inference.ProtocolCodexResponses
	model := "gpt-5.6-sol"
	if provider == inference.ProviderClaude {
		protocol = inference.ProtocolClaudeMessages
		model = "claude-opus-4-6"
	}
	route, err := inferencegateway.NewRoute(
		provider,
		protocol,
		model,
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute() error = %v", err)
	}
	return &coordinatorFixture{
		catalog:   catalog,
		accounts:  accounts,
		source:    source,
		recruit:   recruiter,
		route:     route,
		refreshes: &modelRefreshScheduler{},
	}
}

// newCoordinator 使用真实 Recruiter 和精确上游 Registry 创建执行器。
func (fixture *coordinatorFixture) newCoordinator(
	t testing.TB,
	upstream inferencegateway.UpstreamAdapter,
	recorder inferencegateway.AttemptRecorder,
) *inferencegateway.Coordinator {
	return fixture.newCoordinatorWithRoutes(
		t,
		upstream,
		recorder,
		fixture.route,
	)
}

// newCoordinatorWithRoutes 使用显式有序路由计划创建执行器。
func (fixture *coordinatorFixture) newCoordinatorWithRoutes(
	t testing.TB,
	upstream inferencegateway.UpstreamAdapter,
	recorder inferencegateway.AttemptRecorder,
	routes ...inferencegateway.Route,
) *inferencegateway.Coordinator {
	t.Helper()

	return fixture.newCoordinatorWithResolver(
		t,
		upstream,
		recorder,
		staticRouteResolver{routes: routes},
	)
}

// newCoordinatorWithResolver 使用显式路由策略创建执行器。
func (fixture *coordinatorFixture) newCoordinatorWithResolver(
	t testing.TB,
	upstream inferencegateway.UpstreamAdapter,
	recorder inferencegateway.AttemptRecorder,
	resolver inferencegateway.RouteResolver,
) *inferencegateway.Coordinator {
	t.Helper()

	registry, err := inferencegateway.NewUpstreamRegistry(upstream)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:        fixture.catalog,
			Routes:         resolver,
			Recruiter:      fixture.recruit,
			Upstreams:      registry,
			Attempts:       recorder,
			ModelRefreshes: fixture.refreshes,
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	return coordinator
}

// candidateSource 返回完整不可变候选快照并统计读取次数。
type candidateSource struct {
	mu       sync.Mutex
	accounts []accountapp.RoutingAccount
	calls    int
}

// LoadRoutingCandidates 返回指定 Provider 的完整不可变账号快照。
func (source *candidateSource) LoadRoutingCandidates(
	_ context.Context,
	providerID string,
	_ runtimecore.ModelID,
) (*accountapp.RoutingCandidates, error) {
	source.mu.Lock()
	defer source.mu.Unlock()
	source.calls++
	candidates := make([]accountapp.RoutingAccount, 0, len(source.accounts))
	for _, account := range source.accounts {
		if account.ProviderID() != providerID {
			continue
		}
		candidates = append(candidates, account)
	}
	return accountapp.NewRoutingCandidates(candidates), nil
}

// CallCount 返回候选源调用次数。
func (source *candidateSource) CallCount() int {
	source.mu.Lock()
	defer source.mu.Unlock()
	return source.calls
}

// availableRuntime 让所有合成账号模型元组保持可征召。
type availableRuntime struct{}

// CheckEligibility 返回显式 available 资格。
func (availableRuntime) CheckEligibility(
	context.Context,
	runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	return runtimecore.AvailableEligibility(), nil
}

// blockedRuntime 统计全量本地资格扫描并把每个模型元组标记为 quota block。
type blockedRuntime struct {
	mu    sync.Mutex
	calls int
}

// CheckEligibility 返回账号级 quota block，不触发任何凭据读取。
func (runtime *blockedRuntime) CheckEligibility(
	context.Context,
	runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	runtime.mu.Lock()
	runtime.calls++
	runtime.mu.Unlock()
	return runtimecore.QuotaBlockedEligibility(), nil
}

// CallCount 返回本地运行态资格检查次数。
func (runtime *blockedRuntime) CallCount() int {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return runtime.calls
}

// credentialResolver 按稳定账号身份返回合成凭据。
type credentialResolver struct {
	credentials map[accountcore.AccountRef]accountapp.Credential
}

// ResolveCredentialBinding 返回与候选身份绑定的凭据。
func (resolver credentialResolver) ResolveCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	credential, found := resolver.credentials[accountRef]
	if !found {
		return accountapp.CredentialBinding{}, accountapp.ErrCredentialNotFound
	}
	return accountapp.NewCredentialBinding(
		accountRef,
		credential.ProviderID(),
		credential,
	)
}

// countingCredentialResolver 记录不应发生的敏感凭据读取。
type countingCredentialResolver struct {
	mu    sync.Mutex
	calls int
}

// ResolveCredentialBinding 记录调用并返回缺失，供全阻塞边界测试发现越层读取。
func (resolver *countingCredentialResolver) ResolveCredentialBinding(
	context.Context,
	accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	resolver.mu.Lock()
	resolver.calls++
	resolver.mu.Unlock()
	return accountapp.CredentialBinding{}, accountapp.ErrCredentialNotFound
}

// CallCount 返回敏感凭据读取次数。
func (resolver *countingCredentialResolver) CallCount() int {
	resolver.mu.Lock()
	defer resolver.mu.Unlock()
	return resolver.calls
}

// coordinatorCredential 是不含真实秘密的测试凭据。
type coordinatorCredential struct {
	providerID string
	identity   string
}

// ProviderID 返回测试凭据所属 Provider。
func (credential coordinatorCredential) ProviderID() string {
	return credential.providerID
}

// IdentitySeed 返回测试凭据稳定身份。
func (credential coordinatorCredential) IdentitySeed() string {
	return credential.identity
}

// String 返回不暴露身份种子的安全摘要。
func (credential coordinatorCredential) String() string {
	return "coordinatorCredential{" + credential.providerID + "}"
}

// GoString 复用安全摘要。
func (credential coordinatorCredential) GoString() string {
	return credential.String()
}

// staticRouteResolver 返回测试显式指定的 Provider、协议和真实模型。
type staticRouteResolver struct {
	routes []inferencegateway.Route
	err    error
}

// Resolve 不根据模型名称猜测 Provider。
func (resolver staticRouteResolver) Resolve(
	context.Context,
	inference.Request,
) (inferencegateway.RoutePlan, error) {
	if resolver.err != nil {
		return inferencegateway.RoutePlan{}, resolver.err
	}
	return inferencegateway.NewRoutePlan(resolver.routes...)
}

// scriptedUpstream 执行单个协议脚本并记录不可变 Invocation。
type scriptedUpstream struct {
	mu                 sync.Mutex
	protocol           inference.ProtocolID
	supportsCredential func(accountapp.Credential) bool
	execute            func(
		context.Context,
		inferencegateway.Invocation,
		inferencegateway.EventSink,
	) (inferencegateway.AttemptResult, error)
	invocations []inferencegateway.Invocation
}

// newScriptedUpstream 创建测试上游策略。
func newScriptedUpstream(
	protocol inference.ProtocolID,
	execute func(
		context.Context,
		inferencegateway.Invocation,
		inferencegateway.EventSink,
	) (inferencegateway.AttemptResult, error),
) *scriptedUpstream {
	return &scriptedUpstream{
		protocol: protocol,
		execute:  execute,
	}
}

// ProtocolID 返回测试上游的精确线协议。
func (upstream *scriptedUpstream) ProtocolID() inference.ProtocolID {
	return upstream.protocol
}

// SupportsCredential 接受 Coordinator 测试中身份已绑定的合成凭据。
func (upstream *scriptedUpstream) SupportsCredential(
	credential accountapp.Credential,
) bool {
	if upstream == nil || credential == nil {
		return false
	}
	upstream.mu.Lock()
	policy := upstream.supportsCredential
	upstream.mu.Unlock()
	return policy == nil || policy(credential)
}

// Execute 记录调用后执行预设脚本。
func (upstream *scriptedUpstream) Execute(
	ctx context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	upstream.mu.Lock()
	upstream.invocations = append(upstream.invocations, invocation)
	execute := upstream.execute
	upstream.mu.Unlock()
	return execute(ctx, invocation, emit)
}

// Invocations 返回不会修改内部切片的调用快照。
func (upstream *scriptedUpstream) Invocations() []inferencegateway.Invocation {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	return append([]inferencegateway.Invocation(nil), upstream.invocations...)
}

// recordedFailure 保存一次账号模型失败记录。
type recordedFailure struct {
	route   runtimecore.ModelRoute
	failure inferencegateway.AttemptFailure
}

// attemptRecorder 保存测试需要的成功和失败事实。
type attemptRecorder struct {
	mu        sync.Mutex
	successes []runtimecore.ModelRoute
	failures  []recordedFailure
	onSuccess func(runtimecore.ModelRoute) error
	onFailure func(
		runtimecore.ModelRoute,
		inferencegateway.AttemptFailure,
	) error
}

// modelRefreshSchedule 保存 Coordinator 发出的低敏异步刷新信号。
type modelRefreshSchedule struct {
	accountRef accountcore.AccountRef
	providerID string
}

// modelRefreshScheduler 记录测试中的模型刷新调度。
type modelRefreshScheduler struct {
	mu        sync.Mutex
	schedules []modelRefreshSchedule
	err       error
}

func (scheduler *modelRefreshScheduler) ScheduleModelRefresh(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	scheduler.schedules = append(scheduler.schedules, modelRefreshSchedule{
		accountRef: accountRef,
		providerID: providerID,
	})
	return scheduler.err
}

// Schedules 返回不允许测试修改内部切片的调度快照。
func (scheduler *modelRefreshScheduler) Schedules() []modelRefreshSchedule {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	return append([]modelRefreshSchedule(nil), scheduler.schedules...)
}

// RecordSuccess 记录成功前执行可选断言。
func (recorder *attemptRecorder) RecordSuccess(
	_ context.Context,
	route runtimecore.ModelRoute,
) error {
	if recorder.onSuccess != nil {
		if err := recorder.onSuccess(route); err != nil {
			return err
		}
	}
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.successes = append(recorder.successes, route)
	return nil
}

// RecordFailure 记录失败前执行可选断言。
func (recorder *attemptRecorder) RecordFailure(
	_ context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	if recorder.onFailure != nil {
		if err := recorder.onFailure(route, failure); err != nil {
			return err
		}
	}
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	recorder.failures = append(recorder.failures, recordedFailure{
		route:   route,
		failure: failure,
	})
	return nil
}

// SuccessCount 返回成功记录数。
func (recorder *attemptRecorder) SuccessCount() int {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return len(recorder.successes)
}

// FailureCount 返回失败记录数。
func (recorder *attemptRecorder) FailureCount() int {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return len(recorder.failures)
}

// Failures 返回失败记录快照。
func (recorder *attemptRecorder) Failures() []recordedFailure {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]recordedFailure(nil), recorder.failures...)
}

// newTextRequest 创建最小文本 Canonical Request。
func newTextRequest(
	t testing.TB,
	model string,
	stream bool,
) inference.Request {
	t.Helper()

	text, err := inference.NewTextContent("你好")
	if err != nil {
		t.Fatalf("NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolAnthropicMessages,
		Model:          model,
		Messages:       []inference.Message{message},
		Stream:         stream,
	})
	if err != nil {
		t.Fatalf("NewRequest() error = %v", err)
	}
	return request
}

// newToolRequest 创建要求 tools 能力的 Canonical Request。
func newToolRequest(t *testing.T) inference.Request {
	t.Helper()

	return newToolRequestForModel(t, "gpt-5.6-sol")
}

// successfulEvents 创建只有开始和完成终态的最小成功流。
func successfulEvents(
	t testing.TB,
	responseID string,
) []inference.StreamEvent {
	return successfulEventsForModel(t, responseID, "gpt-5.6-sol")
}

// successfulEventsForModel 创建指定真实模型的最小成功流。
func successfulEventsForModel(
	t testing.TB,
	responseID string,
	model string,
) []inference.StreamEvent {
	t.Helper()

	started, err := inference.NewResponseStartedEvent(
		0,
		responseID,
		model,
	)
	if err != nil {
		t.Fatalf("NewResponseStartedEvent() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  1,
		OutputTokens: 1,
	})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	completed, err := inference.NewResponseCompletedEvent(
		1,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		t.Fatalf("NewResponseCompletedEvent() error = %v", err)
	}
	return []inference.StreamEvent{started, completed}
}

// overloadedFailure 创建可换账号的模型过载失败。
func overloadedFailure(
	t testing.TB,
) (inference.ResponseFailure, inferencegateway.AttemptFailure) {
	t.Helper()

	return newAttemptFailure(
		t,
		"overloaded_error",
		"Model is temporarily overloaded",
		true,
		runtimecore.FailureModelOverloaded,
	)
}

// newAttemptFailure 创建测试所需的一致公开失败与运行态失败。
func newAttemptFailure(
	t testing.TB,
	code string,
	safeMessage string,
	retryable bool,
	runtimeKind runtimecore.FailureKind,
) (inference.ResponseFailure, inferencegateway.AttemptFailure) {
	t.Helper()

	publicFailure, err := inference.NewResponseFailure(
		code,
		safeMessage,
		retryable,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	var blockDirective runtimecore.BlockDirective
	policy, err := runtimecore.PolicyFor(runtimeKind)
	if err != nil {
		t.Fatalf("PolicyFor() error = %v", err)
	}
	if policy.BlocksRouting() {
		blockDirective, err = runtimecore.DefaultBlockDirective(runtimeKind)
		if err != nil {
			t.Fatalf("DefaultBlockDirective() error = %v", err)
		}
	}
	attemptFailure, err := inferencegateway.NewAttemptFailure(
		inferencegateway.AttemptFailureInput{
			ResponseFailure: publicFailure,
			RuntimeKind:     runtimeKind,
			BlockDirective:  blockDirective,
		},
	)
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	return publicFailure, attemptFailure
}

// sameFailure 比较两个不包含 Provider 原文的测试失败值。
func sameFailure(
	left inference.ResponseFailure,
	right inference.ResponseFailure,
) bool {
	return left.Code() == right.Code() &&
		left.SafeMessage() == right.SafeMessage() &&
		left.Retryable() == right.Retryable()
}

// eventKinds 返回便于失败诊断的事件类别。
func eventKinds(events []inference.StreamEvent) []inference.EventKind {
	kinds := make([]inference.EventKind, len(events))
	for index, event := range events {
		kinds[index] = event.Kind()
	}
	return kinds
}
