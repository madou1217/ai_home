package accountusage_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
)

// TestServiceRefreshPersistsAndProjectsExhaustedWindows 验证额度快照保存后精确投影模型族。
func TestServiceRefreshPersistsAndProjectsExhaustedWindows(t *testing.T) {
	t.Parallel()

	now := serviceTestTime()
	credential := serviceCredential{
		providerID: "claude",
		identity:   "oauth:claude:usage-service",
	}
	accountRef := deriveServiceRef(t, credential)
	store := &serviceStore{}
	runtime := &runtimeProjectionStub{}
	strategy := &strategyStub{
		providerID: "claude",
		build: func(capturedAt time.Time) usagecore.Snapshot {
			return mustServiceSnapshot(t, usagecore.SnapshotInput{
				AccountRef: accountRef,
				ProviderID: "claude",
				Source:     "claude_oauth_usage",
				CapturedAt: capturedAt,
				Entries: []usagecore.EntryInput{
					{
						Bucket:       "seven_day_opus",
						Kind:         usagecore.KindWindow,
						Scope:        usagecore.ScopeModelFamily,
						ScopeKey:     "opus",
						Availability: usagecore.AvailabilityExhausted,
					},
					{
						Bucket:       "extra_usage",
						Kind:         usagecore.KindCredits,
						Scope:        usagecore.ScopeAccount,
						Availability: usagecore.AvailabilityExhausted,
					},
				},
			})
		},
	}
	service := newServiceSubject(
		t,
		store,
		credentialResolverStub{credential: credential},
		modelReaderStub{models: []accountapp.AccountModel{
			mustServiceModel(t, accountRef, "claude-opus-5"),
			mustServiceModel(t, accountRef, "claude-sonnet-4-6"),
		}},
		runtime,
		strategy,
		func() time.Time { return now },
	)

	result, err := service.RefreshUsage(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("RefreshUsage() error = %v", err)
	}
	if result.Stale() ||
		!result.Snapshot().CapturedAt().Equal(now) ||
		store.replaceCalls.Load() != 1 {
		t.Fatalf("RefreshUsage() result=%#v calls=%d", result, store.replaceCalls.Load())
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.accountBlocked ||
		len(runtime.modelIDs) != 1 ||
		runtime.modelIDs[0].String() != "claude-opus-5" {
		t.Fatalf(
			"runtime projection account=%t models=%#v",
			runtime.accountBlocked,
			runtime.modelIDs,
		)
	}
}

// TestServiceCoalescesConcurrentRefreshAndKeepsReadSideOffline 验证并发刷新合并且 GET 不访问 Provider。
func TestServiceCoalescesConcurrentRefreshAndKeepsReadSideOffline(t *testing.T) {
	t.Parallel()

	now := serviceTestTime()
	credential := serviceCredential{
		providerID: "codex",
		identity:   "oauth:codex:usage-singleflight",
	}
	accountRef := deriveServiceRef(t, credential)
	store := &serviceStore{}
	started := make(chan struct{})
	release := make(chan struct{})
	var startedOnce sync.Once
	strategy := &strategyStub{
		providerID: "codex",
		build: func(capturedAt time.Time) usagecore.Snapshot {
			startedOnce.Do(func() {
				close(started)
			})
			<-release
			return mustServiceSnapshot(t, usagecore.SnapshotInput{
				AccountRef: accountRef,
				ProviderID: "codex",
				Source:     "codex_wham_usage",
				CapturedAt: capturedAt,
				Entries: []usagecore.EntryInput{{
					Bucket:               "primary",
					Kind:                 usagecore.KindWindow,
					Scope:                usagecore.ScopeAccount,
					HasRemaining:         true,
					RemainingBasisPoints: 5_000,
					Availability:         usagecore.AvailabilityAvailable,
				}},
			})
		},
	}
	service := newServiceSubject(
		t,
		store,
		credentialResolverStub{credential: credential},
		modelReaderStub{},
		&runtimeProjectionStub{},
		strategy,
		func() time.Time { return now },
	)

	const callers = 32
	start := make(chan struct{})
	ready := make(chan struct{}, callers)
	errs := make(chan error, callers)
	var waitGroup sync.WaitGroup
	waitGroup.Add(callers)
	for range callers {
		go func() {
			defer waitGroup.Done()
			ready <- struct{}{}
			<-start
			_, err := service.RefreshUsage(context.Background(), accountRef)
			errs <- err
		}()
	}
	for range callers {
		<-ready
	}
	close(start)
	<-started
	// 让已经同时起跑的等待者进入同一个活动 flight。
	time.Sleep(20 * time.Millisecond)
	close(release)
	waitGroup.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent RefreshUsage() error = %v", err)
		}
	}
	if strategy.calls.Load() != 1 || store.replaceCalls.Load() != 1 {
		t.Fatalf(
			"fetch calls=%d replace calls=%d",
			strategy.calls.Load(),
			store.replaceCalls.Load(),
		)
	}
	if _, err := service.GetUsage(context.Background(), accountRef); err != nil {
		t.Fatalf("GetUsage() error = %v", err)
	}
	if strategy.calls.Load() != 1 {
		t.Fatalf("GetUsage() accessed Provider: calls=%d", strategy.calls.Load())
	}
}

// TestServiceForgetAccountCancelsAndDetachesOldRefresh 验证删除取消旧请求且新代次不会等待旧请求退出。
func TestServiceForgetAccountCancelsAndDetachesOldRefresh(t *testing.T) {
	t.Parallel()

	now := serviceTestTime()
	credential := serviceCredential{
		providerID: "codex",
		identity:   "oauth:codex:usage-forget",
	}
	accountRef := deriveServiceRef(t, credential)
	store := &serviceStore{}
	strategy := &cancelableStrategy{
		accountRef:    accountRef,
		firstStarted:  make(chan struct{}),
		firstCanceled: make(chan struct{}),
		releaseFirst:  make(chan struct{}),
	}
	service := newServiceSubject(
		t,
		store,
		credentialResolverStub{credential: credential},
		modelReaderStub{},
		&runtimeProjectionStub{},
		strategy,
		func() time.Time { return now },
	)

	firstDone := make(chan error, 1)
	go func() {
		_, err := service.RefreshUsage(context.Background(), accountRef)
		firstDone <- err
	}()
	select {
	case <-strategy.firstStarted:
	case <-time.After(time.Second):
		t.Fatal("等待旧额度刷新启动超时")
	}
	service.ForgetAccount(accountRef)
	select {
	case <-strategy.firstCanceled:
	case <-time.After(time.Second):
		t.Fatal("ForgetAccount() 没有取消旧额度刷新")
	}

	second, err := service.RefreshUsage(context.Background(), accountRef)
	if err != nil ||
		!second.Snapshot().IsValid() ||
		store.replaceCalls.Load() != 1 {
		t.Fatalf(
			"second refresh result=%#v replace=%d error=%v",
			second,
			store.replaceCalls.Load(),
			err,
		)
	}
	close(strategy.releaseFirst)
	select {
	case err := <-firstDone:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("first refresh error = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("等待旧额度刷新退出超时")
	}
	if strategy.calls.Load() != 2 || store.replaceCalls.Load() != 1 {
		t.Fatalf(
			"fetch=%d replace=%d",
			strategy.calls.Load(),
			store.replaceCalls.Load(),
		)
	}
}

// TestServiceMarksSnapshotStaleAtFiveMinutes 验证陈旧边界使用采集时间而非读取时间续期。
func TestServiceMarksSnapshotStaleAtFiveMinutes(t *testing.T) {
	t.Parallel()

	capturedAt := serviceTestTime()
	credential := serviceCredential{
		providerID: "codex",
		identity:   "oauth:codex:usage-stale",
	}
	accountRef := deriveServiceRef(t, credential)
	store := &serviceStore{
		snapshot: mustServiceSnapshot(t, usagecore.SnapshotInput{
			AccountRef: accountRef,
			ProviderID: "codex",
			Source:     "codex_wham_usage",
			CapturedAt: capturedAt,
			Entries: []usagecore.EntryInput{{
				Bucket:       "primary",
				Kind:         usagecore.KindWindow,
				Scope:        usagecore.ScopeAccount,
				Availability: usagecore.AvailabilityUnknown,
			}},
		}),
	}
	service := newServiceSubject(
		t,
		store,
		credentialResolverStub{credential: credential},
		modelReaderStub{},
		&runtimeProjectionStub{},
		&strategyStub{providerID: "codex"},
		func() time.Time { return capturedAt.Add(usageapp.DefaultFreshness) },
	)
	result, err := service.GetUsage(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("GetUsage() error = %v", err)
	}
	if !result.Stale() {
		t.Fatal("五分钟边界没有标记 stale")
	}
}

// serviceCredential 是不包含真实密钥的测试身份源。
type serviceCredential struct {
	providerID string
	identity   string
}

func (credential serviceCredential) ProviderID() string   { return credential.providerID }
func (credential serviceCredential) IdentitySeed() string { return credential.identity }
func (credential serviceCredential) String() string       { return "serviceCredential<redacted>" }
func (credential serviceCredential) GoString() string     { return credential.String() }

// credentialResolverStub 返回固定领域凭据。
type credentialResolverStub struct {
	credential accountapp.Credential
}

func (stub credentialResolverStub) ResolveCredential(
	_ context.Context,
	_ accountcore.AccountRef,
) (accountapp.Credential, error) {
	return stub.credential, nil
}

// serviceStore 保存测试最近一次快照。
type serviceStore struct {
	mu           sync.Mutex
	snapshot     usagecore.Snapshot
	replaceCalls atomic.Int64
}

func (store *serviceStore) ReplaceUsageSnapshot(
	_ context.Context,
	snapshot usagecore.Snapshot,
) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.snapshot = snapshot
	store.replaceCalls.Add(1)
	return nil
}

func (store *serviceStore) GetUsageSnapshot(
	_ context.Context,
	_ accountcore.AccountRef,
) (usagecore.Snapshot, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if !store.snapshot.IsValid() {
		return usagecore.Snapshot{}, usageapp.ErrSnapshotNotFound
	}
	return store.snapshot, nil
}

// modelReaderStub 返回固定排序模型关系。
type modelReaderStub struct {
	models []accountapp.AccountModel
}

func (stub modelReaderStub) ListAccountModels(
	_ context.Context,
	_ accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	return append([]accountapp.AccountModel(nil), stub.models...), nil
}

// runtimeProjectionStub 记录服务发布的权威额度阻塞集合。
type runtimeProjectionStub struct {
	mu             sync.Mutex
	accountBlocked bool
	modelIDs       []runtimecore.ModelID
}

func (stub *runtimeProjectionStub) ReplaceUsageProjection(
	_ context.Context,
	_ accountcore.AccountRef,
	accountBlocked bool,
	modelIDs []runtimecore.ModelID,
) error {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	stub.accountBlocked = accountBlocked
	stub.modelIDs = append([]runtimecore.ModelID(nil), modelIDs...)
	return nil
}

// strategyStub 以函数生成 Provider 快照并匹配测试模型族。
type strategyStub struct {
	providerID string
	build      func(time.Time) usagecore.Snapshot
	calls      atomic.Int64
}

// cancelableStrategy 让第一代刷新等待取消，第二代刷新返回有效快照。
type cancelableStrategy struct {
	accountRef    accountcore.AccountRef
	firstStarted  chan struct{}
	firstCanceled chan struct{}
	releaseFirst  chan struct{}
	calls         atomic.Int64
}

// ProviderID 返回测试策略支持的规范 Provider。
func (*cancelableStrategy) ProviderID() string { return "codex" }

// FetchUsage 暴露旧代次取消事实，并为新代次生成确定快照。
func (strategy *cancelableStrategy) FetchUsage(
	ctx context.Context,
	_ accountcore.AccountRef,
	_ accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	call := strategy.calls.Add(1)
	if call == 1 {
		close(strategy.firstStarted)
		<-ctx.Done()
		close(strategy.firstCanceled)
		<-strategy.releaseFirst
		return usagecore.Snapshot{}, ctx.Err()
	}
	snapshot, err := usagecore.NewSnapshot(usagecore.SnapshotInput{
		AccountRef: strategy.accountRef,
		ProviderID: "codex",
		Source:     "codex_wham_usage",
		CapturedAt: capturedAt,
		Entries: []usagecore.EntryInput{{
			Bucket:       "primary",
			Kind:         usagecore.KindWindow,
			Scope:        usagecore.ScopeAccount,
			Availability: usagecore.AvailabilityUnknown,
		}},
	})
	return snapshot, err
}

// MatchesModelFamily 表示该测试不使用模型族投影。
func (*cancelableStrategy) MatchesModelFamily(
	string,
	runtimecore.ModelID,
) bool {
	return false
}

func (stub *strategyStub) ProviderID() string { return stub.providerID }

func (stub *strategyStub) FetchUsage(
	_ context.Context,
	_ accountcore.AccountRef,
	_ accountapp.Credential,
	capturedAt time.Time,
) (usagecore.Snapshot, error) {
	stub.calls.Add(1)
	if stub.build == nil {
		return usagecore.Snapshot{}, usageapp.ErrRefreshFailed
	}
	return stub.build(capturedAt), nil
}

func (stub *strategyStub) MatchesModelFamily(
	scopeKey string,
	modelID runtimecore.ModelID,
) bool {
	return scopeKey == "opus" &&
		(modelID.String() == "claude-opus-5" ||
			modelID.String() == "claude-opus-4-6")
}

// newServiceSubject 创建使用内置 Provider Catalog 的测试服务。
func newServiceSubject(
	t testing.TB,
	store usageapp.SnapshotStore,
	credentials usageapp.CredentialResolver,
	models usageapp.AccountModelReader,
	runtime usageapp.RuntimeProjection,
	strategy usageapp.ProviderStrategy,
	clock usageapp.Clock,
) *usageapp.Service {
	t.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	service, err := usageapp.NewService(usageapp.Dependencies{
		Catalog:     catalog,
		Store:       store,
		Credentials: credentials,
		Models:      models,
		Runtime:     runtime,
		Strategies:  []usageapp.ProviderStrategy{strategy},
		Clock:       clock,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service
}

// mustServiceSnapshot 创建已经完成领域校验的测试快照。
func mustServiceSnapshot(
	t testing.TB,
	input usagecore.SnapshotInput,
) usagecore.Snapshot {
	t.Helper()

	snapshot, err := usagecore.NewSnapshot(input)
	if err != nil {
		t.Fatalf("NewSnapshot() error = %v", err)
	}
	return snapshot
}

// mustServiceModel 创建默认有效的账号模型关系。
func mustServiceModel(
	t testing.TB,
	accountRef accountcore.AccountRef,
	modelID string,
) accountapp.AccountModel {
	t.Helper()

	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           modelID,
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         serviceTestTime(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel(%q) error = %v", modelID, err)
	}
	return model
}

// deriveServiceRef 从合成凭据得到稳定账号引用。
func deriveServiceRef(
	t testing.TB,
	credential serviceCredential,
) accountcore.AccountRef {
	t.Helper()

	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("DeriveAccountRef(%s) error = %v", fmt.Sprint(credential), err)
	}
	return accountRef
}

// serviceTestTime 返回毫秒精度的固定采集时间。
func serviceTestTime() time.Time {
	return time.Date(2026, time.July, 31, 2, 0, 0, 0, time.UTC)
}
