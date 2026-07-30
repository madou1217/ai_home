package inferencegateway

import (
	"context"
	"errors"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
)

var (
	// ErrInvalidInvocation 表示请求、路由、账号和凭据身份不一致。
	ErrInvalidInvocation = errors.New("上游推理调用无效")
	// ErrInvalidAttemptFailure 表示公开失败和运行态分类不完整。
	ErrInvalidAttemptFailure = errors.New("上游推理失败无效")
	// ErrInvalidAttemptResult 表示上游没有返回明确成功或失败结果。
	ErrInvalidAttemptResult = errors.New("上游推理结果无效")
	// ErrInvalidUpstreamAdapter 表示上游 Adapter 缺失或协议无效。
	ErrInvalidUpstreamAdapter = errors.New("上游协议 Adapter 无效")
	// ErrDuplicateUpstreamProtocol 表示同一上游协议被重复注册。
	ErrDuplicateUpstreamProtocol = errors.New("上游协议重复注册")
	// ErrUpstreamProtocolNotRegistered 表示路由协议没有执行 Adapter。
	ErrUpstreamProtocolNotRegistered = errors.New("上游协议尚未注册")
)

// Invocation 是交给单一上游 Adapter 的身份绑定调用。
type Invocation struct {
	request    inference.Request
	route      Route
	account    accountapp.RoutingAccount
	credential accountapp.Credential
}

// newInvocation 复核账号、凭据和路由属于同一个 Provider 身份。
func newInvocation(
	request inference.Request,
	route Route,
	account accountapp.RoutingAccount,
	credential accountapp.Credential,
) (Invocation, error) {
	if !route.IsValid() ||
		account.ProviderID() != string(route.ProviderID()) ||
		credential == nil ||
		credential.ProviderID() != account.ProviderID() {
		return Invocation{}, ErrInvalidInvocation
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || accountRef != account.Ref() {
		return Invocation{}, ErrInvalidInvocation
	}
	return Invocation{
		request:    request,
		route:      route,
		account:    account,
		credential: credential,
	}, nil
}

// Request 返回不可变 Canonical Request。
func (invocation Invocation) Request() inference.Request {
	return invocation.request
}

// Route 返回显式上游路由。
func (invocation Invocation) Route() Route {
	return invocation.route
}

// Account 返回不含凭据的紧凑账号投影。
func (invocation Invocation) Account() accountapp.RoutingAccount {
	return invocation.account
}

// Credential 返回已刷新且身份复核完成的领域凭据。
func (invocation Invocation) Credential() accountapp.Credential {
	return invocation.credential
}

// AttemptFailure 同时保存客户端安全失败和运行态稳定分类。
type AttemptFailure struct {
	responseFailure inference.ResponseFailure
	runtimeKind     runtimecore.FailureKind
	retryAfter      time.Duration
	blockDirective  runtimecore.BlockDirective
}

// AttemptFailureInput 集中声明公开失败、运行态分类与硬阻塞证据。
type AttemptFailureInput struct {
	// ResponseFailure 是交给客户端 Renderer 的低敏失败。
	ResponseFailure inference.ResponseFailure
	// RuntimeKind 是账号运行态识别的稳定失败类型。
	RuntimeKind runtimecore.FailureKind
	// RetryAfter 只允许用于有限时间自动恢复的模型 cooldown。
	RetryAfter time.Duration
	// BlockDirective 只允许用于 credential、quota 或 policy 硬阻塞。
	BlockDirective runtimecore.BlockDirective
}

// NewAttemptFailure 创建不包含 Provider 原文或请求内容的失败结果。
func NewAttemptFailure(
	input AttemptFailureInput,
) (AttemptFailure, error) {
	policy, err := runtimecore.PolicyFor(input.RuntimeKind)
	if err != nil ||
		!input.ResponseFailure.IsValid() ||
		input.RetryAfter < 0 ||
		input.RetryAfter > runtimecore.MaxCooldownHint ||
		input.RetryAfter%time.Millisecond != 0 ||
		input.RetryAfter > 0 && !policy.EntersCooldown() ||
		!validAttemptBlockDirective(
			policy,
			input.RuntimeKind,
			input.BlockDirective,
		) {
		return AttemptFailure{}, ErrInvalidAttemptFailure
	}
	return AttemptFailure{
		responseFailure: input.ResponseFailure,
		runtimeKind:     input.RuntimeKind,
		retryAfter:      input.RetryAfter,
		blockDirective:  input.BlockDirective,
	}, nil
}

// ResponseFailure 返回可交给客户端 Renderer 的低敏失败。
func (failure AttemptFailure) ResponseFailure() inference.ResponseFailure {
	return failure.responseFailure
}

// RuntimeKind 返回账号运行态识别的失败类型。
func (failure AttemptFailure) RuntimeKind() runtimecore.FailureKind {
	return failure.runtimeKind
}

// RetryAfter 返回不超过领域上限的有限恢复提示。
func (failure AttemptFailure) RetryAfter() time.Duration {
	return failure.retryAfter
}

// BlockDirective 返回硬阻塞作用域和解除信号；非阻塞失败返回零值。
func (failure AttemptFailure) BlockDirective() runtimecore.BlockDirective {
	return failure.blockDirective
}

// IsValid 重新检查跨 Adapter 传递后的失败不变量。
func (failure AttemptFailure) IsValid() bool {
	restored, err := NewAttemptFailure(
		AttemptFailureInput{
			ResponseFailure: failure.responseFailure,
			RuntimeKind:     failure.runtimeKind,
			RetryAfter:      failure.retryAfter,
			BlockDirective:  failure.blockDirective,
		},
	)
	return err == nil && restored == failure
}

// validAttemptBlockDirective 验证硬阻塞必须带指令，其他失败必须保持零值。
func validAttemptBlockDirective(
	policy runtimecore.FailurePolicy,
	kind runtimecore.FailureKind,
	directive runtimecore.BlockDirective,
) bool {
	if policy.BlocksRouting() {
		return directive.IsValidFor(kind)
	}
	return directive.IsZero()
}

// retriesAnotherAccount 判断失败是否只影响当前账号或账号模型元组。
func (failure AttemptFailure) retriesAnotherAccount() bool {
	policy, err := runtimecore.PolicyFor(failure.runtimeKind)
	return err == nil &&
		failure.responseFailure.Retryable() &&
		policy.Action() != runtimecore.ActionNoStateChange
}

// attemptResultKind 是单次上游调用的内部终态标识。
type attemptResultKind uint8

const (
	// attemptCompleted 表示 Adapter 收到并解码了成功完成事件。
	attemptCompleted attemptResultKind = iota + 1
	// attemptFailed 表示 Adapter 返回了结构化低敏失败。
	attemptFailed
)

// AttemptResult 保存一次上游调用的成功或失败终态。
type AttemptResult struct {
	kind    attemptResultKind
	failure AttemptFailure
}

// CompletedAttempt 创建成功上游结果。
func CompletedAttempt() AttemptResult {
	return AttemptResult{kind: attemptCompleted}
}

// FailedAttempt 创建结构化失败上游结果。
func FailedAttempt(failure AttemptFailure) AttemptResult {
	return AttemptResult{
		kind:    attemptFailed,
		failure: failure,
	}
}

// Completed 判断 Adapter 是否明确完成。
func (result AttemptResult) Completed() bool {
	return result.kind == attemptCompleted
}

// Failed 判断 Adapter 是否返回结构化失败。
func (result AttemptResult) Failed() bool {
	return result.kind == attemptFailed
}

// Failure 返回失败结果；成功时返回零值。
func (result AttemptResult) Failure() AttemptFailure {
	return result.failure
}

// IsValid 判断结果只有一个终态且失败值完整。
func (result AttemptResult) IsValid() bool {
	if result.Completed() {
		return !result.failure.IsValid()
	}
	return result.Failed() && result.failure.IsValid()
}

// UpstreamAdapter 编码请求、执行传输并解码 Canonical Event。
type UpstreamAdapter interface {
	ProtocolID() inference.ProtocolID
	Execute(
		ctx context.Context,
		invocation Invocation,
		emit EventSink,
	) (AttemptResult, error)
}

// UpstreamRegistry 保存按真实线协议注册的不可变 Adapter 集合。
type UpstreamRegistry struct {
	adapters map[inference.ProtocolID]UpstreamAdapter
}

// NewUpstreamRegistry 创建拒绝无效项和重复协议的 Registry。
func NewUpstreamRegistry(
	adapters ...UpstreamAdapter,
) (*UpstreamRegistry, error) {
	if len(adapters) == 0 {
		return nil, ErrInvalidUpstreamAdapter
	}
	registered := make(
		map[inference.ProtocolID]UpstreamAdapter,
		len(adapters),
	)
	for _, adapter := range adapters {
		if adapter == nil || !adapter.ProtocolID().IsValid() {
			return nil, ErrInvalidUpstreamAdapter
		}
		protocolID := adapter.ProtocolID()
		if _, found := registered[protocolID]; found {
			return nil, ErrDuplicateUpstreamProtocol
		}
		registered[protocolID] = adapter
	}
	return &UpstreamRegistry{adapters: registered}, nil
}

// Resolve 精确返回路由协议 Adapter，不做相邻协议回退。
func (registry *UpstreamRegistry) Resolve(
	protocolID inference.ProtocolID,
) (UpstreamAdapter, error) {
	if registry == nil || !protocolID.IsValid() {
		return nil, ErrUpstreamProtocolNotRegistered
	}
	adapter, found := registry.adapters[protocolID]
	if !found {
		return nil, ErrUpstreamProtocolNotRegistered
	}
	return adapter, nil
}

// AttemptRecorder 在终态提交客户端前按完整 BlockDirective 更新账号运行态边界。
type AttemptRecorder interface {
	RecordSuccess(
		ctx context.Context,
		route runtimecore.ModelRoute,
	) error
	RecordFailure(
		ctx context.Context,
		route runtimecore.ModelRoute,
		failure AttemptFailure,
	) error
}
