package inferencegateway_test

import (
	"context"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/core/inference"
)

// recordingRewriter 记录每次改写看到的 Provider，原样返回请求（满足 RequestRewriter 合同）。
type recordingRewriter struct {
	mu        sync.Mutex
	providers []inference.ProviderID
}

func (rewriter *recordingRewriter) Rewrite(request inference.Request, providerID inference.ProviderID) inference.Request {
	rewriter.mu.Lock()
	defer rewriter.mu.Unlock()
	rewriter.providers = append(rewriter.providers, providerID)
	return request
}

// TestCoordinatorAppliesInjectedRequestRewriter 回归：NewCoordinator 曾经漏拷 Dependencies.RequestRewriter，
// 组装层注入的 vision guard 在 Go 推理路径上被静默丢弃，图片照样发给不支持视觉的模型。
func TestCoordinatorAppliesInjectedRequestRewriter(t *testing.T) {
	t.Parallel()

	fixture := newCoordinatorFixture(t, "codex", 1)
	upstream := newScriptedUpstream(
		inference.ProtocolCodexResponses,
		func(
			_ context.Context,
			_ inferencegateway.Invocation,
			emit inferencegateway.EventSink,
		) (inferencegateway.AttemptResult, error) {
			for _, event := range successfulEvents(t, "resp_rewritten") {
				if err := emit(event); err != nil {
					return inferencegateway.AttemptResult{}, err
				}
			}
			return inferencegateway.CompletedAttempt(), nil
		},
	)
	registry, err := inferencegateway.NewUpstreamRegistry(upstream)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	rewriter := &recordingRewriter{}
	coordinator, err := inferencegateway.NewCoordinator(
		inferencegateway.Dependencies{
			Catalog:                fixture.catalog,
			Routes:                 staticRouteResolver{routes: []inferencegateway.Route{fixture.route}},
			Recruiter:              fixture.recruit,
			Upstreams:              registry,
			Attempts:               &attemptRecorder{},
			CredentialObservations: alwaysCurrentCredentialObservations{},
			Clock:                  coordinatorCredentialObservedAt,
			ModelRefreshes:         fixture.refreshes,
			RequestRewriter:        rewriter,
		},
	)
	if err != nil {
		t.Fatalf("NewCoordinator() error = %v", err)
	}
	if err := coordinator.Execute(
		context.Background(),
		newTextRequest(t, "gpt-5.6-sol", false),
		func(inference.StreamEvent) error { return nil },
	); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	rewriter.mu.Lock()
	defer rewriter.mu.Unlock()
	if len(rewriter.providers) == 0 || rewriter.providers[0] != fixture.route.ProviderID() {
		t.Fatalf("injected RequestRewriter was not applied; saw providers %v", rewriter.providers)
	}
}
