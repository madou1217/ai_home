package inferencegateway_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

// errCredentialStoreUnavailable 代表凭据仓库自身故障：它既不是「账号不可用」
// 也不是「没有可调度账号」，因此会作为内部故障中断整个编排。
var errCredentialStoreUnavailable = errors.New("凭据仓库不可用")

// interruptingCredentialResolver 在第 failAt 次解析时返回仓库级故障。
// 用来制造「征召被内部故障中断」而不是「候选耗尽」，这是两条不同的收尾路径。
type interruptingCredentialResolver struct {
	mu       sync.Mutex
	delegate credentialResolver
	failAt   int
	calls    int
}

// ResolveObservedCredentialBinding 按调用序号决定是正常解析还是抛出仓库级故障。
func (resolver *interruptingCredentialResolver) ResolveObservedCredentialBinding(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (
	accountapp.CredentialBinding,
	accountcredentials.CredentialObservation,
	error,
) {
	resolver.mu.Lock()
	resolver.calls++
	failing := resolver.calls == resolver.failAt
	resolver.mu.Unlock()
	if failing {
		return accountapp.CredentialBinding{},
			accountcredentials.CredentialObservation{},
			errCredentialStoreUnavailable
	}
	return resolver.delegate.ResolveObservedCredentialBinding(ctx, accountRef)
}

// TestCoordinatorCommitsRecordedFailureWhenRecruitmentIsInterrupted 验证编排被
// 内部故障中断时，已经记录的真实上游失败仍然交付给客户端。
//
// 场景：第一个账号真实限流（可换号），换号途中凭据仓库故障。此前这条路径直接
// 上抛内部故障，真实 429 被丢弃，客户端只看到「服务不可用」——限流因此被当成
// 网关故障而立即重试，与退避语义相反。
func TestCoordinatorCommitsRecordedFailureWhenRecruitmentIsInterrupted(
	t *testing.T,
) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 2)
	rateLimited, attemptFailure := newAttemptFailure(
		t,
		"rate_limited",
		"Upstream rate limited this account",
		true,
		runtimecore.FailureRateLimited,
	)
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
	coordinator := fixture.newCoordinatorWithCredentials(
		t,
		upstream,
		recorder,
		&interruptingCredentialResolver{
			delegate: credentialResolver{credentials: fixture.credentials},
			failAt:   2,
		},
	)
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
	if len(upstream.Invocations()) != 1 ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed {
		t.Fatalf(
			"invocations=%d events=%v",
			len(upstream.Invocations()),
			eventKinds(events),
		)
	}
	failed, ok := events[0].(inference.ResponseFailedEvent)
	if !ok || !sameFailure(failed.Failure(), rateLimited) {
		t.Fatalf("committed terminal = %#v, want 真实限流失败", events[0])
	}
}

// TestCoordinatorDropsRecordedFailureAfterVisibleOutput 验证补发有明确边界：
// 一旦本次调用已经向客户端写出事件，更早记录的失败不能再补发，否则会在已经
// 开始的事件序列上插入第二个序号 0 的终态，把可诊断的故障变成协议错误。
func TestCoordinatorDropsRecordedFailureAfterVisibleOutput(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 2)
	_, attemptFailure := newAttemptFailure(
		t,
		"rate_limited",
		"Upstream rate limited this account",
		true,
		runtimecore.FailureRateLimited,
	)
	upstreamFault := errors.New("上游调用在写出之后失败")
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
				return inferencegateway.FailedAttempt(attemptFailure), nil
			}
			started, err := inference.NewResponseStartedEvent(
				0,
				"resp_visible_then_fault",
				"gpt-5.6-sol",
			)
			if err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			if err := emit(started); err != nil {
				return inferencegateway.AttemptResult{}, err
			}
			return inferencegateway.AttemptResult{}, upstreamFault
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
	if err == nil {
		t.Fatal("Execute() error = nil, want 内部故障上抛")
	}
	if len(upstream.Invocations()) != 2 ||
		len(events) != 1 ||
		events[0].Kind() != inference.EventResponseStarted {
		t.Fatalf(
			"invocations=%d events=%v err=%v",
			len(upstream.Invocations()),
			eventKinds(events),
			err,
		)
	}
}
