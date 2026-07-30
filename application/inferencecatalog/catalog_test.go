package inferencecatalog_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/inferencecatalog"
	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

// TestBuilderCreatesExactCrossClientRoutes 验证生产 Builder 只根据本地模型
// 快照生成精确路由，且客户端协议不会限制真实 Provider。
func TestBuilderCreatesExactCrossClientRoutes(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	reader := &modelReader{
		models: []accountapp.RoutableModel{
			newRoutableModel(t, catalog, "claude", "claude-opus-5"),
			newRoutableModel(t, catalog, "codex", "gpt-5.6-sol"),
		},
	}
	builder := newBuilder(t, reader)
	snapshot, err := builder.Build(context.Background())
	if err != nil {
		t.Fatalf("Builder.Build() error = %v", err)
	}
	if snapshot.ModelCount() != 2 || snapshot.RouteCount() != 2 {
		t.Fatalf(
			"snapshot model_count=%d route_count=%d",
			snapshot.ModelCount(),
			snapshot.RouteCount(),
		)
	}

	testCases := []struct {
		model          string
		clientProtocol inference.ClientProtocolID
		wantProvider   inference.ProviderID
		wantProtocol   inference.ProtocolID
	}{
		{
			model:          "gpt-5.6-sol",
			clientProtocol: inference.ClientProtocolAnthropicMessages,
			wantProvider:   inference.ProviderCodex,
			wantProtocol:   inference.ProtocolCodexResponses,
		},
		{
			model:          "claude-opus-5",
			clientProtocol: inference.ClientProtocolOpenAIChatCompletions,
			wantProvider:   inference.ProviderClaude,
			wantProtocol:   inference.ProtocolClaudeMessages,
		},
	}
	for _, testCase := range testCases {
		request := newTextRequest(t, testCase.clientProtocol, testCase.model)
		plan, resolveErr := snapshot.Resolve(context.Background(), request)
		if resolveErr != nil {
			t.Fatalf(
				"Resolve(%s, %s) error = %v",
				testCase.clientProtocol,
				testCase.model,
				resolveErr,
			)
		}
		routes := plan.Candidates()
		if len(routes) != 1 ||
			routes[0].ProviderID() != testCase.wantProvider ||
			routes[0].ProtocolID() != testCase.wantProtocol ||
			routes[0].EffectiveModel() != testCase.model {
			t.Fatalf("Resolve(%s) routes = %#v", testCase.model, routes)
		}
	}
}

// TestBuilderRejectsAmbiguousOrInvalidSnapshots 验证同名跨 Provider 模型、
// 无序输入和未注册 Factory 不会产生隐式 fallback。
func TestBuilderRejectsAmbiguousOrInvalidSnapshots(t *testing.T) {
	t.Parallel()

	catalog := newProviderCatalog(t)
	testCases := []struct {
		name    string
		models  []accountapp.RoutableModel
		factory []inferencecatalog.ProviderRouteFactory
		wantErr error
	}{
		{
			name: "ambiguous provider",
			models: []accountapp.RoutableModel{
				newRoutableModel(t, catalog, "claude", "shared-model"),
				newRoutableModel(t, catalog, "codex", "shared-model"),
			},
			factory: testFactories(t),
			wantErr: inferencecatalog.ErrAmbiguousModelRoute,
		},
		{
			name: "unordered snapshot",
			models: []accountapp.RoutableModel{
				newRoutableModel(t, catalog, "codex", "z-model"),
				newRoutableModel(t, catalog, "codex", "a-model"),
			},
			factory: testFactories(t),
			wantErr: inferencecatalog.ErrInvalidModelSnapshot,
		},
		{
			name: "missing factory",
			models: []accountapp.RoutableModel{
				newRoutableModel(t, catalog, "claude", "claude-opus-5"),
			},
			factory: []inferencecatalog.ProviderRouteFactory{
				newRouteFactory(t, inference.ProviderCodex),
			},
			wantErr: inferencecatalog.ErrProviderRouteFactoryNotFound,
		},
	}
	for _, testCase := range testCases {
		testCase := testCase
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			builder, err := inferencecatalog.NewBuilder(
				&modelReader{models: testCase.models},
				testCase.factory...,
			)
			if err != nil {
				t.Fatalf("NewBuilder() error = %v", err)
			}
			if _, err := builder.Build(context.Background()); !errors.Is(
				err,
				testCase.wantErr,
			) {
				t.Fatalf("Builder.Build() error = %v, want %v", err, testCase.wantErr)
			}
		})
	}
}

// TestAtomicCatalogPublishesWholeSnapshotsAndRetainsLastKnownGood 验证并发读取
// 只观察完整快照，失败刷新只标记 stale 而不会清空旧目录。
func TestAtomicCatalogPublishesWholeSnapshotsAndRetainsLastKnownGood(t *testing.T) {
	t.Parallel()

	clock := newTestClock()
	active, err := inferencecatalog.NewAtomicCatalog(clock.Now)
	if err != nil {
		t.Fatalf("NewAtomicCatalog() error = %v", err)
	}
	if _, err := active.ListRoutableModels(context.Background()); !errors.Is(
		err,
		inferencecatalog.ErrRouteCatalogUnavailable,
	) {
		t.Fatalf("uninitialized ListRoutableModels() error = %v", err)
	}
	if err := active.Publish(&inferencecatalog.Snapshot{}); !errors.Is(
		err,
		inferencecatalog.ErrInvalidRouteSnapshot,
	) {
		t.Fatalf("Publish(forged) error = %v", err)
	}

	catalog := newProviderCatalog(t)
	first := buildSnapshot(t, []accountapp.RoutableModel{
		newRoutableModel(t, catalog, "codex", "gpt-first"),
	})
	if err := active.Publish(first); err != nil {
		t.Fatalf("Publish(first) error = %v", err)
	}
	clock.Advance(time.Second)
	active.RecordRefreshFailure()
	status := active.Status()
	if !status.Ready || !status.Stale ||
		status.ModelCount != 1 ||
		status.RouteCount != 1 {
		t.Fatalf("stale status = %#v", status)
	}
	models, err := active.ListRoutableModels(context.Background())
	if err != nil || len(models) != 1 ||
		models[0].ModelID().String() != "gpt-first" {
		t.Fatalf("last-known-good models=%#v error=%v", models, err)
	}

	second := buildSnapshot(t, []accountapp.RoutableModel{
		newRoutableModel(t, catalog, "claude", "claude-second"),
	})
	var wait sync.WaitGroup
	for range 8 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			for range 500 {
				models, readErr := active.ListRoutableModels(context.Background())
				if readErr != nil || len(models) != 1 {
					t.Errorf("concurrent models=%#v error=%v", models, readErr)
					return
				}
				modelID := models[0].ModelID().String()
				if modelID != "gpt-first" && modelID != "claude-second" {
					t.Errorf("observed partial model %q", modelID)
					return
				}
			}
		}()
	}
	clock.Advance(time.Second)
	if err := active.Publish(second); err != nil {
		t.Fatalf("Publish(second) error = %v", err)
	}
	wait.Wait()
	status = active.Status()
	if !status.Ready || status.Stale ||
		status.ModelCount != 1 ||
		status.RouteCount != 1 {
		t.Fatalf("fresh status = %#v", status)
	}
}

// TestRefreshCoordinatorCoalescesSignals 验证刷新风暴不会为每次写操作创建
// 一个 goroutine 或一次完整目录重建。
func TestRefreshCoordinatorCoalescesSignals(t *testing.T) {
	t.Parallel()

	clock := newTestClock()
	active, err := inferencecatalog.NewAtomicCatalog(clock.Now)
	if err != nil {
		t.Fatalf("NewAtomicCatalog() error = %v", err)
	}
	builder := &blockingSnapshotBuilder{
		started:  make(chan struct{}, 4),
		release:  make(chan struct{}),
		snapshot: buildSnapshot(t, nil),
	}
	coordinator, err := inferencecatalog.NewRefreshCoordinator(
		inferencecatalog.RefreshCoordinatorOptions{
			Builder: builder,
			Catalog: active,
		},
	)
	if err != nil {
		t.Fatalf("NewRefreshCoordinator() error = %v", err)
	}
	t.Cleanup(func() {
		_ = coordinator.Close()
	})

	coordinator.RoutableModelsChanged()
	waitSignal(t, builder.started)
	for range 1_000 {
		coordinator.RoutableModelsChanged()
	}
	builder.release <- struct{}{}
	waitSignal(t, builder.started)
	builder.release <- struct{}{}
	waitForCalls(t, builder, 2)
	time.Sleep(20 * time.Millisecond)
	if calls := builder.CallCount(); calls != 2 {
		t.Fatalf("Builder.Build() calls = %d, want 2", calls)
	}
}

// modelReader 返回独立的本地模型快照。
type modelReader struct {
	models []accountapp.RoutableModel
	err    error
}

func (reader *modelReader) ListRoutableModels(
	context.Context,
) ([]accountapp.RoutableModel, error) {
	return append([]accountapp.RoutableModel(nil), reader.models...), reader.err
}

// routeFactory 是测试使用的显式 Provider 路由策略。
type routeFactory struct {
	providerID   inference.ProviderID
	protocolID   inference.ProtocolID
	capabilities inference.CapabilitySet
}

func (factory routeFactory) ProviderID() inference.ProviderID {
	return factory.providerID
}

func (factory routeFactory) BuildRoute(
	modelID runtimecore.ModelID,
) (inferencegateway.Route, error) {
	return inferencegateway.NewRoute(
		factory.providerID,
		factory.protocolID,
		modelID.String(),
		factory.capabilities,
	)
}

// blockingSnapshotBuilder 让测试精确控制每次异步构建的边界。
type blockingSnapshotBuilder struct {
	mu       sync.Mutex
	calls    int
	started  chan struct{}
	release  chan struct{}
	snapshot *inferencecatalog.Snapshot
}

func (builder *blockingSnapshotBuilder) Build(
	ctx context.Context,
) (*inferencecatalog.Snapshot, error) {
	builder.mu.Lock()
	builder.calls++
	builder.mu.Unlock()
	builder.started <- struct{}{}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-builder.release:
		return builder.snapshot, nil
	}
}

func (builder *blockingSnapshotBuilder) CallCount() int {
	builder.mu.Lock()
	defer builder.mu.Unlock()
	return builder.calls
}

// testClock 提供并发测试中可控且非零的目录发布时间。
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock() *testClock {
	return &testClock{
		now: time.Date(2026, time.July, 30, 0, 0, 0, 0, time.UTC),
	}
}

func (clock *testClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *testClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(duration)
	clock.mu.Unlock()
}

func newProviderCatalog(t testing.TB) *providers.Catalog {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("providers.NewCatalog() error = %v", err)
	}
	return catalog
}

func newRoutableModel(
	t testing.TB,
	catalog *providers.Catalog,
	providerID string,
	modelID string,
) accountapp.RoutableModel {
	t.Helper()

	model, err := accountapp.NewRoutableModel(catalog, providerID, modelID)
	if err != nil {
		t.Fatalf("accounts.NewRoutableModel() error = %v", err)
	}
	return model
}

func newRouteFactory(
	t testing.TB,
	providerID inference.ProviderID,
) inferencecatalog.ProviderRouteFactory {
	t.Helper()

	capabilities, err := inference.NewCapabilitySet(
		inference.CapabilityTextGeneration,
		inference.CapabilityImageInput,
		inference.CapabilityDocumentInput,
		inference.CapabilityTools,
		inference.CapabilityReasoning,
		inference.CapabilityStructuredOutput,
		inference.CapabilityStreaming,
	)
	if err != nil {
		t.Fatalf("inference.NewCapabilitySet() error = %v", err)
	}
	protocolID := inference.ProtocolCodexResponses
	if providerID == inference.ProviderClaude {
		protocolID = inference.ProtocolClaudeMessages
	}
	return routeFactory{
		providerID:   providerID,
		protocolID:   protocolID,
		capabilities: capabilities,
	}
}

func testFactories(t testing.TB) []inferencecatalog.ProviderRouteFactory {
	t.Helper()
	return []inferencecatalog.ProviderRouteFactory{
		newRouteFactory(t, inference.ProviderCodex),
		newRouteFactory(t, inference.ProviderClaude),
	}
}

func newBuilder(
	t testing.TB,
	reader accountapp.RoutableModelReader,
) *inferencecatalog.Builder {
	t.Helper()

	builder, err := inferencecatalog.NewBuilder(reader, testFactories(t)...)
	if err != nil {
		t.Fatalf("inferencecatalog.NewBuilder() error = %v", err)
	}
	return builder
}

func buildSnapshot(
	t testing.TB,
	models []accountapp.RoutableModel,
) *inferencecatalog.Snapshot {
	t.Helper()

	snapshot, err := newBuilder(t, &modelReader{models: models}).Build(
		context.Background(),
	)
	if err != nil {
		t.Fatalf("Builder.Build() error = %v", err)
	}
	return snapshot
}

func newTextRequest(
	t testing.TB,
	protocolID inference.ClientProtocolID,
	modelID string,
) inference.Request {
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
		ClientProtocol: protocolID,
		Model:          modelID,
		Messages:       []inference.Message{message},
	})
	if err != nil {
		t.Fatalf("inference.NewRequest() error = %v", err)
	}
	return request
}

func waitSignal(t *testing.T, signal <-chan struct{}) {
	t.Helper()
	select {
	case <-signal:
	case <-time.After(time.Second):
		t.Fatal("等待异步目录构建超时")
	}
}

func waitForCalls(
	t *testing.T,
	builder *blockingSnapshotBuilder,
	expected int,
) {
	t.Helper()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if builder.CallCount() == expected {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf(
		"Builder.Build() calls = %d, want %d",
		builder.CallCount(),
		expected,
	)
}
