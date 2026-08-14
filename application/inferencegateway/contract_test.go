package inferencegateway_test

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
)

// TestRouteRequiresExplicitProviderProtocolOwnership 验证路由不能根据模型名称
// 隐式跨 Provider 或跨上游协议。
func TestRouteRequiresExplicitProviderProtocolOwnership(t *testing.T) {
	t.Parallel()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	route, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.6-sol",
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute() error = %v", err)
	}
	if route.ProviderID() != inference.ProviderCodex ||
		route.ProtocolID() != inference.ProtocolCodexResponses ||
		route.EffectiveModel() != "gpt-5.6-sol" ||
		route.Capabilities() != capabilities ||
		!route.Supports(capabilities) ||
		!route.IsValid() {
		t.Fatalf("route = %#v", route)
	}

	invalidRoutes := []struct {
		name         string
		providerID   inference.ProviderID
		protocolID   inference.ProtocolID
		model        string
		capabilities inference.CapabilitySet
	}{
		{
			name:         "Provider 与协议交叉",
			providerID:   inference.ProviderCodex,
			protocolID:   inference.ProtocolClaudeMessages,
			model:        "claude-opus-4-6",
			capabilities: capabilities,
		},
		{
			name:         "模型含空白",
			providerID:   inference.ProviderClaude,
			protocolID:   inference.ProtocolClaudeMessages,
			model:        " claude-opus-4-6",
			capabilities: capabilities,
		},
		{
			name:         "能力为空",
			providerID:   inference.ProviderClaude,
			protocolID:   inference.ProtocolClaudeMessages,
			model:        "claude-opus-4-6",
			capabilities: 0,
		},
	}
	for _, test := range invalidRoutes {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if _, err := inferencegateway.NewRoute(
				test.providerID,
				test.protocolID,
				test.model,
				test.capabilities,
			); !errors.Is(err, inferencegateway.ErrInvalidRoute) {
				t.Fatalf("NewRoute() error = %v", err)
			}
		})
	}
}

// TestRoutePlanPreservesBoundedCandidateOrder 验证路由计划保持候选顺序、
// 防御性复制，并拒绝空计划、重复路由和无界候选。
func TestRoutePlanPreservesBoundedCandidateOrder(t *testing.T) {
	t.Parallel()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("NewCapabilitySet() error = %v", err)
	}
	first, err := inferencegateway.NewRoute(
		inference.ProviderCodex,
		inference.ProtocolCodexResponses,
		"gpt-5.6-sol",
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute(first) error = %v", err)
	}
	second, err := inferencegateway.NewRoute(
		inference.ProviderClaude,
		inference.ProtocolClaudeMessages,
		"claude-opus-4-6",
		capabilities,
	)
	if err != nil {
		t.Fatalf("NewRoute(second) error = %v", err)
	}
	plan, err := inferencegateway.NewRoutePlan(first, second)
	if err != nil {
		t.Fatalf("NewRoutePlan() error = %v", err)
	}
	candidates := plan.Candidates()
	if !plan.IsValid() ||
		len(candidates) != 2 ||
		candidates[0] != first ||
		candidates[1] != second {
		t.Fatalf("plan candidates = %#v", candidates)
	}
	candidates[0] = second
	if plan.Candidates()[0] != first {
		t.Fatal("Candidates() 返回值修改了 RoutePlan")
	}
	if _, err := inferencegateway.NewRoutePlan(); !errors.Is(
		err,
		inferencegateway.ErrRouteNotFound,
	) {
		t.Fatalf("NewRoutePlan(empty) error = %v", err)
	}
	if _, err := inferencegateway.NewRoutePlan(
		inferencegateway.Route{},
	); !errors.Is(err, inferencegateway.ErrInvalidRoutePlan) {
		t.Fatalf("NewRoutePlan(invalid) error = %v", err)
	}
	if _, err := inferencegateway.NewRoutePlan(first, first); !errors.Is(
		err,
		inferencegateway.ErrInvalidRoutePlan,
	) {
		t.Fatalf("NewRoutePlan(duplicate) error = %v", err)
	}
	tooMany := make(
		[]inferencegateway.Route,
		inferencegateway.MaxRouteCandidates+1,
	)
	for index := range tooMany {
		tooMany[index], err = inferencegateway.NewRoute(
			inference.ProviderCodex,
			inference.ProtocolCodexResponses,
			fmt.Sprintf("gpt-route-%d", index),
			capabilities,
		)
		if err != nil {
			t.Fatalf("NewRoute(%d) error = %v", index, err)
		}
	}
	if _, err := inferencegateway.NewRoutePlan(tooMany...); !errors.Is(
		err,
		inferencegateway.ErrInvalidRoutePlan,
	) {
		t.Fatalf("NewRoutePlan(too many) error = %v", err)
	}
}

// TestUpstreamRegistryResolvesOnlyExactProtocol 验证 Registry 拒绝空集合、重复项
// 和相邻协议回退。
func TestUpstreamRegistryResolvesOnlyExactProtocol(t *testing.T) {
	t.Parallel()

	codex := inertUpstream{protocol: inference.ProtocolCodexResponses}
	claude := inertUpstream{protocol: inference.ProtocolClaudeMessages}
	registry, err := inferencegateway.NewUpstreamRegistry(codex, claude)
	if err != nil {
		t.Fatalf("NewUpstreamRegistry() error = %v", err)
	}
	resolved, err := registry.Resolve(inference.ProtocolClaudeMessages)
	if err != nil || resolved.ProtocolID() != inference.ProtocolClaudeMessages {
		t.Fatalf("Resolve() adapter=%#v error=%v", resolved, err)
	}
	if _, err := registry.Resolve(inference.ProtocolID("future")); !errors.Is(
		err,
		inferencegateway.ErrUpstreamProtocolNotRegistered,
	) {
		t.Fatalf("Resolve(unregistered) error = %v", err)
	}
	if _, err := inferencegateway.NewUpstreamRegistry(); !errors.Is(
		err,
		inferencegateway.ErrInvalidUpstreamAdapter,
	) {
		t.Fatalf("NewUpstreamRegistry(empty) error = %v", err)
	}
	if _, err := inferencegateway.NewUpstreamRegistry(codex, codex); !errors.Is(
		err,
		inferencegateway.ErrDuplicateUpstreamProtocol,
	) {
		t.Fatalf("NewUpstreamRegistry(duplicate) error = %v", err)
	}
}

// TestAttemptFailureRequiresConsistentRuntimeHint 验证恢复提示只允许用于模型级
// cooldown，且所有公开访问器保留构造值。
func TestAttemptFailureRequiresConsistentRuntimeHint(t *testing.T) {
	t.Parallel()

	responseFailure, err := inference.NewResponseFailure(
		"rate_limit_error",
		"Retry later",
		true,
	)
	if err != nil {
		t.Fatalf("NewResponseFailure() error = %v", err)
	}
	failure, err := inferencegateway.NewAttemptFailure(
		inferencegateway.AttemptFailureInput{
			ResponseFailure:                        responseFailure,
			RuntimeKind:                            runtimecore.FailureRateLimited,
			RetryAfter:                             1500 * time.Millisecond,
			DeferAccountFailureUntilRequestOutcome: true,
		},
	)
	if err != nil {
		t.Fatalf("NewAttemptFailure() error = %v", err)
	}
	if !failure.IsValid() ||
		failure.ResponseFailure().Code() != responseFailure.Code() ||
		failure.RuntimeKind() != runtimecore.FailureRateLimited ||
		failure.RetryAfter() != 1500*time.Millisecond ||
		!failure.DefersAccountFailureUntilRequestOutcome() ||
		!failure.BlockDirective().IsZero() {
		t.Fatalf("failure = %#v", failure)
	}
	if !inferencegateway.FailedAttempt(failure).IsValid() ||
		!inferencegateway.CompletedAttempt().IsValid() ||
		(inferencegateway.AttemptResult{}).IsValid() {
		t.Fatal("AttemptResult 终态有效性错误")
	}

	modelBlock, err := runtimecore.NewBlockDirective(
		runtimecore.FailureModelUnsupported,
		runtimecore.BlockScopeAccountModel,
	)
	if err != nil {
		t.Fatalf("NewBlockDirective() error = %v", err)
	}
	invalidFailures := []struct {
		name  string
		input inferencegateway.AttemptFailureInput
	}{
		{
			name: "公开失败为空",
			input: inferencegateway.AttemptFailureInput{
				RuntimeKind: runtimecore.FailureRateLimited,
				RetryAfter:  time.Second,
			},
		},
		{
			name: "失败分类未知",
			input: inferencegateway.AttemptFailureInput{
				ResponseFailure: responseFailure,
				RuntimeKind:     runtimecore.FailureKind("future"),
				RetryAfter:      time.Second,
			},
		},
		{
			name: "硬阻塞携带 cooldown",
			input: inferencegateway.AttemptFailureInput{
				ResponseFailure: responseFailure,
				RuntimeKind:     runtimecore.FailureCredentialRejected,
				RetryAfter:      time.Second,
			},
		},
		{
			name: "恢复提示超过上限",
			input: inferencegateway.AttemptFailureInput{
				ResponseFailure: responseFailure,
				RuntimeKind:     runtimecore.FailureRateLimited,
				RetryAfter: runtimecore.MaxCooldownHint +
					time.Second,
			},
		},
		{
			name: "quota 缺少作用域",
			input: inferencegateway.AttemptFailureInput{
				ResponseFailure: responseFailure,
				RuntimeKind:     runtimecore.FailureQuotaExhausted,
			},
		},
		{
			name: "阻塞指令属于其他失败",
			input: inferencegateway.AttemptFailureInput{
				ResponseFailure: responseFailure,
				RuntimeKind:     runtimecore.FailureCredentialRejected,
				BlockDirective:  modelBlock,
			},
		},
	}
	for _, test := range invalidFailures {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()

			if _, err := inferencegateway.NewAttemptFailure(
				test.input,
			); !errors.Is(err, inferencegateway.ErrInvalidAttemptFailure) {
				t.Fatalf("NewAttemptFailure() error = %v", err)
			}
		})
	}
}

// inertUpstream 是只用于 Registry 合同测试的无状态 Adapter。
type inertUpstream struct {
	protocol inference.ProtocolID
}

// ProtocolID 返回显式注册协议。
func (upstream inertUpstream) ProtocolID() inference.ProtocolID {
	return upstream.protocol
}

// SupportsCredential 接受合同测试中的非空合成凭据。
func (inertUpstream) SupportsCredential(
	credential accountapp.Credential,
) bool {
	return credential != nil
}

// Execute 不应在 Registry 合同测试中被调用。
func (inertUpstream) Execute(
	context.Context,
	inferencegateway.Invocation,
	inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	return inferencegateway.AttemptResult{}, errors.New("inert upstream")
}
