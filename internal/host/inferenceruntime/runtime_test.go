package inferenceruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/attemptfailure"
)

const (
	overloadedModel = "gpt-overloaded"
	siblingModel    = "gpt-sibling"
)

// TestRuntimeKeepsCooldownAtAccountModelGranularity 验证生产组合使用同一个
// 稀疏运行态索引完成征召资格和失败记录，不会把模型故障扩大为账号故障。
func TestRuntimeKeepsCooldownAtAccountModelGranularity(t *testing.T) {
	t.Parallel()

	fixture := newRuntimeFixture(t)
	runtime, err := New(fixture.dependencies())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	firstEvents, err := executeRequest(runtime, newTextRequest(t, overloadedModel))
	if err != nil {
		t.Fatalf("Execute(overloaded first) error = %v", err)
	}
	if len(firstEvents) != 1 ||
		firstEvents[0].Kind() != inference.EventResponseFailed {
		t.Fatalf("first events = %#v", firstEvents)
	}
	failed := firstEvents[0].(inference.ResponseFailedEvent)
	if failed.Failure().Code() != string(runtimecore.FailureModelOverloaded) {
		t.Fatalf("failure = %#v", failed.Failure())
	}

	secondEvents, err := executeRequest(runtime, newTextRequest(t, overloadedModel))
	if !errors.Is(err, inferencegateway.ErrNoRoutableAccount) ||
		len(secondEvents) != 0 {
		t.Fatalf("second execute events=%#v error=%v", secondEvents, err)
	}
	if fixture.upstream.CallCount() != 1 {
		t.Fatalf("cooldown 后 upstream calls = %d, want 1", fixture.upstream.CallCount())
	}

	siblingEvents, err := executeRequest(runtime, newTextRequest(t, siblingModel))
	if err != nil {
		t.Fatalf("Execute(sibling) error = %v", err)
	}
	if len(siblingEvents) == 0 ||
		siblingEvents[len(siblingEvents)-1].Kind() !=
			inference.EventResponseCompleted {
		t.Fatalf("sibling events = %#v", siblingEvents)
	}
	if fixture.upstream.CallCount() != 2 ||
		fixture.store.CredentialReadCount() != 2 {
		t.Fatalf(
			"calls upstream=%d credentials=%d, want 2/2",
			fixture.upstream.CallCount(),
			fixture.store.CredentialReadCount(),
		)
	}
	t.Logf(
		"运行态效果: %s 首次失败=%s, 第二次未调用上游, %s 成功完成",
		overloadedModel,
		failed.Failure().Code(),
		siblingModel,
	)
}

// TestRuntimeSchedulesModelRefreshAfterUnsupportedFailure 验证模型不支持失败
// 通过注入端口异步修复目录，而不是在当前推理请求内同步访问上游目录。
func TestRuntimeSchedulesModelRefreshAfterUnsupportedFailure(t *testing.T) {
	t.Parallel()

	fixture := newRuntimeFixture(t)
	fixture.upstream.failureKind = runtimecore.FailureModelUnsupported
	runtime, err := New(fixture.dependencies())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}

	events, err := executeRequest(runtime, newTextRequest(t, overloadedModel))
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if len(events) != 1 ||
		events[0].Kind() != inference.EventResponseFailed ||
		fixture.refreshes.CallCount() != 1 {
		t.Fatalf(
			"events=%#v refresh calls=%d",
			events,
			fixture.refreshes.CallCount(),
		)
	}
	accountRef, providerID := fixture.refreshes.LastCall()
	if accountRef != fixture.account.Ref() || providerID != codex.ProviderID {
		t.Fatalf("refresh call = (%s,%s)", accountRef, providerID)
	}

	secondEvents, err := executeRequest(
		runtime,
		newTextRequest(t, overloadedModel),
	)
	if !errors.Is(err, inferencegateway.ErrNoRoutableAccount) ||
		len(secondEvents) != 0 ||
		fixture.upstream.CallCount() != 1 ||
		fixture.store.CredentialReadCount() != 1 ||
		fixture.refreshes.CallCount() != 1 {
		t.Fatalf(
			"policy block events=%#v error=%v upstream=%d credentials=%d refreshes=%d",
			secondEvents,
			err,
			fixture.upstream.CallCount(),
			fixture.store.CredentialReadCount(),
			fixture.refreshes.CallCount(),
		)
	}
	t.Logf(
		"策略阻塞效果: 首次 model_unsupported 调度刷新=%d, 第二次凭据读取=%d, 上游调用=%d",
		fixture.refreshes.CallCount(),
		fixture.store.CredentialReadCount(),
		fixture.upstream.CallCount(),
	)
}

// TestNewRejectsIncompleteDependencies 验证账号存储、完整运行态、路由、刷新
// 策略、上游、模型刷新调度或时钟缺失时，Runtime 在启动阶段失败关闭。
func TestNewRejectsIncompleteDependencies(t *testing.T) {
	t.Parallel()

	fixture := newRuntimeFixture(t)
	valid := fixture.dependencies()
	testCases := []Dependencies{
		{},
		{
			Store:                valid.Store,
			Runtime:              valid.Runtime,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			ModelRefreshes:       valid.ModelRefreshes,
			Clock:                valid.Clock,
		},
		{
			Catalog:              valid.Catalog,
			Runtime:              valid.Runtime,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			ModelRefreshes:       valid.ModelRefreshes,
			Clock:                valid.Clock,
		},
		{
			Catalog:              valid.Catalog,
			Store:                valid.Store,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			ModelRefreshes:       valid.ModelRefreshes,
			Clock:                valid.Clock,
		},
		{
			Catalog:              valid.Catalog,
			Store:                valid.Store,
			Runtime:              valid.Runtime,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			ModelRefreshes:       valid.ModelRefreshes,
			Clock:                valid.Clock,
		},
		{
			Catalog:        valid.Catalog,
			Store:          valid.Store,
			Runtime:        valid.Runtime,
			Routes:         valid.Routes,
			Upstreams:      valid.Upstreams,
			ModelRefreshes: valid.ModelRefreshes,
			Clock:          valid.Clock,
		},
		{
			Catalog:              valid.Catalog,
			Store:                valid.Store,
			Runtime:              valid.Runtime,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			ModelRefreshes:       valid.ModelRefreshes,
			Clock:                valid.Clock,
		},
		{
			Catalog:              valid.Catalog,
			Store:                valid.Store,
			Runtime:              valid.Runtime,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			Clock:                valid.Clock,
		},
		{
			Catalog:              valid.Catalog,
			Store:                valid.Store,
			Runtime:              valid.Runtime,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			ModelRefreshes:       valid.ModelRefreshes,
		},
		{
			Catalog:              valid.Catalog,
			Store:                valid.Store,
			Runtime:              valid.Runtime,
			Routes:               valid.Routes,
			CredentialStrategies: valid.CredentialStrategies,
			Upstreams:            valid.Upstreams,
			ModelRefreshes:       valid.ModelRefreshes,
			Clock:                valid.Clock,
			AccountScanLimit:     inferencegateway.DefaultAccountScanLimit + 1,
		},
	}
	for index, dependencies := range testCases {
		if _, err := New(dependencies); !errors.Is(
			err,
			ErrInvalidDependencies,
		) {
			t.Fatalf("New(case %d) error = %v", index, err)
		}
	}
}

// runtimeFixture 保存一组只使用合成凭据和上游的完整生产应用组件。
type runtimeFixture struct {
	catalog   *providers.Catalog
	store     *runtimeStore
	routes    *inferencegateway.RouteCatalog
	upstream  *scriptedUpstream
	refreshes *refreshScheduler
	runtime   *runtimeState
	account   accountapp.RoutingAccount
	clock     time.Time
}

// newRuntimeFixture 创建两个模型共享同一 Codex 账号的运行时夹具。
func newRuntimeFixture(t *testing.T) *runtimeFixture {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	credential, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
		APIKey:  "synthetic-runtime-api-key",
		BaseURL: "https://example.invalid/v1",
	})
	if err != nil {
		t.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accountcore.DeriveAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("accountcore.NewCLIAccountID() error = %v", err)
	}
	account, err := accountapp.NewRoutingAccount(
		catalog,
		accountapp.RoutingAccountInput{
			Ref:          accountRef,
			ProviderID:   codex.ProviderID,
			CLIAccountID: cliAccountID,
		},
	)
	if err != nil {
		t.Fatalf("accountapp.NewRoutingAccount() error = %v", err)
	}
	clock := time.Date(2026, time.July, 30, 8, 0, 0, 0, time.UTC)
	snapshot, err := accountapp.NewCredentialSnapshot(
		accountRef,
		credential,
		clock.Add(-time.Hour),
	)
	if err != nil {
		t.Fatalf("accountapp.NewCredentialSnapshot() error = %v", err)
	}
	modelRuntime, err := runtimeapp.NewRegistry(
		func() time.Time { return clock },
	)
	if err != nil {
		t.Fatalf("runtimeapp.NewRegistry() error = %v", err)
	}
	return &runtimeFixture{
		catalog: catalog,
		store: &runtimeStore{
			account:  account,
			snapshot: snapshot,
			models: map[string]struct{}{
				overloadedModel: {},
				siblingModel:    {},
			},
		},
		routes:    newRouteCatalog(t),
		upstream:  &scriptedUpstream{failureKind: runtimecore.FailureModelOverloaded},
		refreshes: &refreshScheduler{},
		runtime: &runtimeState{
			models: modelRuntime,
			blocks: make(map[runtimecore.ModelRoute]runtimecore.Eligibility),
		},
		account: account,
		clock:   clock,
	}
}

// dependencies 返回构造 Runtime 所需的全部显式端口。
func (fixture *runtimeFixture) dependencies() Dependencies {
	return Dependencies{
		Catalog: fixture.catalog,
		Store:   fixture.store,
		Runtime: fixture.runtime,
		Routes:  fixture.routes,
		CredentialStrategies: []accountcredentials.RefreshStrategy{
			staticCredentialStrategy{},
		},
		Upstreams:      []inferencegateway.UpstreamAdapter{fixture.upstream},
		ModelRefreshes: fixture.refreshes,
		Clock:          func() time.Time { return fixture.clock },
	}
}

// runtimeStore 同时实现账号候选与版本化凭据读取端口。
type runtimeStore struct {
	mu              sync.Mutex
	account         accountapp.RoutingAccount
	snapshot        accountapp.CredentialSnapshot
	models          map[string]struct{}
	credentialReads int
}

// ListRoutingCandidates 从两个合成模型的本地倒排返回同一账号。
func (store *runtimeStore) ListRoutingCandidates(
	ctx context.Context,
	query accountapp.RoutingQuery,
) ([]accountapp.RoutingAccount, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if query.ProviderID() != store.account.ProviderID() ||
		query.AfterRef() != "" {
		return nil, nil
	}
	if _, found := store.models[query.ModelID().String()]; !found {
		return nil, nil
	}
	return []accountapp.RoutingAccount{store.account}, nil
}

// GetCredentialSnapshot 返回不会过期的合成 API Key 快照。
func (store *runtimeStore) GetCredentialSnapshot(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialSnapshot, error) {
	if err := ctx.Err(); err != nil {
		return accountapp.CredentialSnapshot{}, err
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if accountRef != store.account.Ref() {
		return accountapp.CredentialSnapshot{}, accountapp.ErrCredentialNotFound
	}
	store.credentialReads++
	return store.snapshot, nil
}

// ReplaceCredential 防止 API Key 测试意外进入 OAuth 刷新写路径。
func (*runtimeStore) ReplaceCredential(
	context.Context,
	accountapp.CredentialReplacement,
) error {
	return errors.New("合成 API Key 不应刷新")
}

// CredentialReadCount 返回真正越过运行态资格检查的凭据读取次数。
func (store *runtimeStore) CredentialReadCount() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.credentialReads
}

// runtimeState 在测试中显式分发全部失败动作，避免把硬阻塞误当作 cooldown。
type runtimeState struct {
	mu     sync.RWMutex
	models *runtimeapp.Registry
	blocks map[runtimecore.ModelRoute]runtimecore.Eligibility
}

// CheckEligibility 原子读取硬阻塞，并回退到模型级稀疏 cooldown 索引。
func (state *runtimeState) CheckEligibility(
	ctx context.Context,
	route runtimecore.ModelRoute,
) (runtimecore.Eligibility, error) {
	state.mu.RLock()
	defer state.mu.RUnlock()
	if eligibility, found := state.blocks[route]; found {
		return eligibility, nil
	}
	return state.models.CheckEligibility(ctx, route)
}

// RecordSuccess 清理当前测试元组的硬阻塞与瞬态模型状态。
func (state *runtimeState) RecordSuccess(
	ctx context.Context,
	route runtimecore.ModelRoute,
) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	if err := state.models.RecordSuccess(ctx, route); err != nil {
		return err
	}
	delete(state.blocks, route)
	return nil
}

// RecordFailure 根据领域 Transition 把失败交给唯一状态边界。
func (state *runtimeState) RecordFailure(
	ctx context.Context,
	route runtimecore.ModelRoute,
	failure inferencegateway.AttemptFailure,
) error {
	state.mu.Lock()
	defer state.mu.Unlock()
	transition, err := state.models.RecordFailure(
		ctx,
		route,
		failure.RuntimeKind(),
		failure.RetryAfter(),
	)
	if err != nil {
		return err
	}
	switch transition.Action() {
	case runtimecore.ActionNoStateChange,
		runtimecore.ActionModelCooldown:
		return nil
	case runtimecore.ActionCredentialBlock:
		state.blocks[route] = runtimecore.CredentialBlockedEligibility()
	case runtimecore.ActionQuotaBlock:
		state.blocks[route] = runtimecore.QuotaBlockedEligibility()
	case runtimecore.ActionPolicyBlock:
		state.blocks[route] = runtimecore.PolicyBlockedEligibility()
	default:
		return errors.New("测试运行态收到未知失败动作")
	}
	return nil
}

// staticCredentialStrategy 让 API Key 通过统一凭据 Resolver 而不执行刷新。
type staticCredentialStrategy struct{}

// ProviderID 返回该测试策略负责的 Codex Provider。
func (staticCredentialStrategy) ProviderID() string {
	return codex.ProviderID
}

// ExpiresAt 表示 API Key 没有 OAuth 过期时间。
func (staticCredentialStrategy) ExpiresAt(
	accountapp.Credential,
) (time.Time, bool) {
	return time.Time{}, false
}

// Refresh 在测试中永远不应被调用。
func (staticCredentialStrategy) Refresh(
	context.Context,
	accountapp.Credential,
	time.Time,
) (accountapp.Credential, error) {
	return nil, errors.New("合成 API Key 不应刷新")
}

// scriptedUpstream 对过载模型返回稳定失败，对兄弟模型返回完整成功事件。
type scriptedUpstream struct {
	mu          sync.Mutex
	failureKind runtimecore.FailureKind
	calls       []inferencegateway.Invocation
}

// ProtocolID 返回夹具使用的 Codex Responses 上游协议。
func (*scriptedUpstream) ProtocolID() inference.ProtocolID {
	return inference.ProtocolCodexResponses
}

// Execute 按真实模型选择失败或成功结果。
func (upstream *scriptedUpstream) Execute(
	_ context.Context,
	invocation inferencegateway.Invocation,
	emit inferencegateway.EventSink,
) (inferencegateway.AttemptResult, error) {
	upstream.mu.Lock()
	upstream.calls = append(upstream.calls, invocation)
	failureKind := upstream.failureKind
	upstream.mu.Unlock()
	if invocation.Route().EffectiveModel() == overloadedModel {
		failure, err := attemptfailure.NewClassified(failureKind)
		if err != nil {
			return inferencegateway.AttemptResult{}, err
		}
		return inferencegateway.FailedAttempt(failure), nil
	}
	events, err := successfulEvents(invocation.Route().EffectiveModel())
	if err != nil {
		return inferencegateway.AttemptResult{}, err
	}
	for _, event := range events {
		if err := emit(event); err != nil {
			return inferencegateway.AttemptResult{}, err
		}
	}
	return inferencegateway.CompletedAttempt(), nil
}

// CallCount 返回真正进入上游 Adapter 的调用数量。
func (upstream *scriptedUpstream) CallCount() int {
	upstream.mu.Lock()
	defer upstream.mu.Unlock()
	return len(upstream.calls)
}

// refreshScheduler 记录模型不支持失败产生的旁路刷新信号。
type refreshScheduler struct {
	mu        sync.Mutex
	accounts  []accountcore.AccountRef
	providers []string
}

// ScheduleModelRefresh 只记录低敏账号和 Provider，不执行远端请求。
func (scheduler *refreshScheduler) ScheduleModelRefresh(
	_ context.Context,
	accountRef accountcore.AccountRef,
	providerID string,
) error {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	scheduler.accounts = append(scheduler.accounts, accountRef)
	scheduler.providers = append(scheduler.providers, providerID)
	return nil
}

// CallCount 返回已调度任务数量。
func (scheduler *refreshScheduler) CallCount() int {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	return len(scheduler.accounts)
}

// LastCall 返回最后一次模型刷新信号。
func (scheduler *refreshScheduler) LastCall() (accountcore.AccountRef, string) {
	scheduler.mu.Lock()
	defer scheduler.mu.Unlock()
	if len(scheduler.accounts) == 0 {
		return "", ""
	}
	last := len(scheduler.accounts) - 1
	return scheduler.accounts[last], scheduler.providers[last]
}

// newRouteCatalog 创建两个模型到同一 Codex 上游的精确规则。
func newRouteCatalog(t *testing.T) *inferencegateway.RouteCatalog {
	t.Helper()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
	)
	if err != nil {
		t.Fatalf("inference.NewCapabilitySet() error = %v", err)
	}
	rules := make([]inferencegateway.RouteRule, 0, 2)
	for _, model := range []string{overloadedModel, siblingModel} {
		route, err := inferencegateway.NewRoute(
			inference.ProviderCodex,
			inference.ProtocolCodexResponses,
			model,
			capabilities,
		)
		if err != nil {
			t.Fatalf("inferencegateway.NewRoute(%s) error = %v", model, err)
		}
		rule, err := inferencegateway.NewRouteRule(
			inferencegateway.RouteRuleInput{
				Pattern: model,
				Scope:   inferencegateway.RouteScopeCodex,
				Route:   route,
			},
		)
		if err != nil {
			t.Fatalf("inferencegateway.NewRouteRule(%s) error = %v", model, err)
		}
		rules = append(rules, rule)
	}
	catalog, err := inferencegateway.NewRouteCatalog(rules...)
	if err != nil {
		t.Fatalf("inferencegateway.NewRouteCatalog() error = %v", err)
	}
	return catalog
}

// newTextRequest 创建当前 OpenAI 默认作用域的最小 Canonical 文本请求。
func newTextRequest(t *testing.T, model string) inference.Request {
	t.Helper()

	text, err := inference.NewTextContent("hello")
	if err != nil {
		t.Fatalf("inference.NewTextContent() error = %v", err)
	}
	message, err := inference.NewMessage(inference.RoleUser, text)
	if err != nil {
		t.Fatalf("inference.NewMessage() error = %v", err)
	}
	request, err := inference.NewRequest(inference.RequestInput{
		ClientProtocol: inference.ClientProtocolOpenAIResponses,
		Model:          model,
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

// executeRequest 收集一次 Canonical 执行产生的完整客户端事件。
func executeRequest(
	executor inferencegateway.Executor,
	request inference.Request,
) ([]inference.StreamEvent, error) {
	events := make([]inference.StreamEvent, 0, 10)
	err := executor.Execute(
		context.Background(),
		request,
		func(event inference.StreamEvent) error {
			events = append(events, event)
			return nil
		},
	)
	return events, err
}

// successfulEvents 创建严格连续且只有一个成功终态的文本事件流。
func successfulEvents(model string) ([]inference.StreamEvent, error) {
	usage, err := inference.NewUsage(inference.UsageInput{
		InputTokens:  2,
		OutputTokens: 1,
	})
	if err != nil {
		return nil, err
	}
	started, err := inference.NewResponseStartedEvent(
		0,
		"resp_runtime_1",
		model,
	)
	if err != nil {
		return nil, err
	}
	itemStarted, err := inference.NewOutputItemStartedEvent(
		1,
		0,
		"message_runtime_1",
		inference.OutputItemMessage,
	)
	if err != nil {
		return nil, err
	}
	blockStarted, err := inference.NewContentBlockStartedEvent(
		2,
		0,
		0,
		inference.ContentText,
	)
	if err != nil {
		return nil, err
	}
	delta, err := inference.NewTextDeltaEvent(3, 0, 0, "ok")
	if err != nil {
		return nil, err
	}
	textCompleted, err := inference.NewTextCompletedEvent(4, 0, 0, "ok")
	if err != nil {
		return nil, err
	}
	itemCompleted, err := inference.NewOutputItemCompletedEvent(
		6,
		0,
		"message_runtime_1",
	)
	if err != nil {
		return nil, err
	}
	usageUpdated, err := inference.NewUsageUpdatedEvent(7, usage)
	if err != nil {
		return nil, err
	}
	completed, err := inference.NewResponseCompletedEvent(
		8,
		inference.StopReasonEndTurn,
		"",
		usage,
	)
	if err != nil {
		return nil, err
	}
	return []inference.StreamEvent{
		started,
		itemStarted,
		blockStarted,
		delta,
		textCompleted,
		inference.NewContentBlockCompletedEvent(5, 0, 0),
		itemCompleted,
		usageUpdated,
		completed,
	}, nil
}

// 编译期确认测试存储覆盖 Runtime 需要的复合账号端口。
var _ AccountStore = (*runtimeStore)(nil)

// 编译期确认测试运行态同时实现征召资格和终态记录端口。
var _ AccountRuntime = (*runtimeState)(nil)

// 编译期确认 Runtime 测试执行器遵守账号征召和模型刷新边界。
var (
	_ inferencegateway.UpstreamAdapter       = (*scriptedUpstream)(nil)
	_ inferencegateway.ModelRefreshScheduler = (*refreshScheduler)(nil)
	_ accountrouting.CandidateSource         = (*runtimeStore)(nil)
)
