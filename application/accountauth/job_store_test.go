package accountauth

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// memoryJobStore 是测试用的 JobStore：用内存 map 模拟 aih.db，
// 并允许注入读写故障来验证持久化失败不影响 OAuth 主流程。
type memoryJobStore struct {
	mu       sync.Mutex
	records  map[string]JobRecord
	upserts  int
	writeErr error
	readErr  error
}

func newMemoryJobStore() *memoryJobStore {
	return &memoryJobStore{records: make(map[string]JobRecord)}
}

func (store *memoryJobStore) UpsertJob(_ context.Context, record JobRecord) error {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.upserts++
	if store.writeErr != nil {
		return store.writeErr
	}
	store.records[record.ID] = record
	return nil
}

func (store *memoryJobStore) GetJob(
	_ context.Context,
	jobID string,
) (JobRecord, bool, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.readErr != nil {
		return JobRecord{}, false, store.readErr
	}
	record, found := store.records[jobID]
	return record, found, nil
}

func (store *memoryJobStore) ListJobs(
	_ context.Context,
	activeOnly bool,
) ([]JobRecord, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.readErr != nil {
		return nil, store.readErr
	}
	records := make([]JobRecord, 0, len(store.records))
	for _, record := range store.records {
		if activeOnly && record.Status != StatusPending &&
			record.Status != StatusProcessing {
			continue
		}
		records = append(records, record)
	}
	return records, nil
}

func (store *memoryJobStore) ExpirePendingJobs(
	_ context.Context,
	now time.Time,
) (int64, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.writeErr != nil {
		return 0, store.writeErr
	}
	var expired int64
	for jobID, record := range store.records {
		if record.Status != StatusPending && record.Status != StatusProcessing {
			continue
		}
		record.Status = StatusExpired
		record.UpdatedAt = now
		record.ErrorCode = "expired"
		store.records[jobID] = record
		expired++
	}
	return expired, nil
}

func (store *memoryJobStore) upsertCount() int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return store.upserts
}

// seed 直接写入预置快照，模拟上一次进程留下的记录。
func (store *memoryJobStore) seed(records ...JobRecord) {
	store.mu.Lock()
	defer store.mu.Unlock()
	for _, record := range records {
		store.records[record.ID] = record
	}
}

// testClock 让测试可以推进时间，验证过期与保留期清理。
type testClock struct {
	mu  sync.Mutex
	now time.Time
}

func newTestClock(now time.Time) *testClock {
	return &testClock{now: now}
}

func (clock *testClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *testClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	clock.now = clock.now.Add(duration)
}

var testNow = time.Date(2026, time.November, 5, 10, 0, 0, 0, time.UTC)

type fakeOAuthProvider struct {
	providerID string
}

func (provider fakeOAuthProvider) ProviderID() string { return provider.providerID }

func (provider fakeOAuthProvider) Begin(context.Context) (OAuthFlow, error) {
	return fakeOAuthFlow{
		authorizationURL: "https://example.test/authorize?provider=" + provider.providerID,
	}, nil
}

type fakeOAuthFlow struct {
	authorizationURL string
}

func (flow fakeOAuthFlow) AuthorizationURL() string { return flow.authorizationURL }

func (flow fakeOAuthFlow) Exchange(context.Context, string) ([]byte, error) {
	return []byte("artifacts"), nil
}

type fakeCredential struct {
	providerID string
}

func (credential fakeCredential) ProviderID() string { return credential.providerID }

func (credential fakeCredential) IdentitySeed() string { return "credential-seed" }

func (credential fakeCredential) String() string { return "fake-credential" }

func (credential fakeCredential) GoString() string { return "fakeCredential{}" }

type fakeProfile struct {
	providerID string
}

func (profile fakeProfile) ProviderID() string { return profile.providerID }

func (profile fakeProfile) IdentitySeed() string { return "profile-seed" }

func (profile fakeProfile) IsValid() bool { return true }

func (profile fakeProfile) DisplayName() string { return "Test User" }

func (profile fakeProfile) Email() string { return "test@example.test" }

func (profile fakeProfile) SubscriptionKind() string { return "" }

func (profile fakeProfile) SubscriptionRaw() string { return "" }

type fakeDecoder struct {
	err error
}

func (decoder fakeDecoder) Decode(
	providerID string,
	_ []byte,
) (accountapp.Credential, accountapp.PublicProfile, error) {
	if decoder.err != nil {
		return nil, nil, decoder.err
	}
	return fakeCredential{providerID: providerID}, fakeProfile{providerID: providerID}, nil
}

type fakeRegistrar struct {
	onRegister func()
}

func (registrar fakeRegistrar) Register(
	context.Context,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	if registrar.onRegister != nil {
		registrar.onRegister()
	}
	return accountcore.Account{}, nil
}

type fakeReauth struct{}

func (fakeReauth) ValidateTarget(
	context.Context,
	accountcore.AccountRef,
	string,
) error {
	return nil
}

func (fakeReauth) Reauthenticate(
	context.Context,
	accountcore.AccountRef,
	accountapp.Credential,
	accountapp.PublicProfile,
) (accountcore.Account, error) {
	return accountcore.Account{}, nil
}

type testOptions struct {
	store     JobStore
	decoder   NativeAccountDecoder
	registrar Registrar
	clock     *testClock
}

func newTestService(t *testing.T, options testOptions) *Service {
	t.Helper()
	clock := options.clock
	if clock == nil {
		clock = newTestClock(testNow)
	}
	decoder := options.decoder
	if decoder == nil {
		decoder = fakeDecoder{}
	}
	registrar := options.registrar
	if registrar == nil {
		registrar = fakeRegistrar{}
	}
	var sequence int
	service, err := newService(Dependencies{
		Providers: []OAuthProvider{
			fakeOAuthProvider{providerID: "codex"},
			fakeOAuthProvider{providerID: "claude"},
		},
		Decoder:   decoder,
		Registrar: registrar,
		Reauth:    fakeReauth{},
		Clock:     clock.Now,
		GenerateID: func() (string, error) {
			sequence++
			return fmt.Sprintf("%032x", sequence), nil
		},
		JobStore: options.store,
	}, serviceSettings{
		jobTTL:            DefaultJobTTL,
		terminalRetention: DefaultTerminalRetention,
		maxJobs:           DefaultMaxJobs,
	})
	if err != nil {
		t.Fatalf("newService() error = %v", err)
	}
	return service
}

func TestStartPersistsPendingSnapshot(t *testing.T) {
	store := newMemoryJobStore()
	service := newTestService(t, testOptions{store: store})

	result, err := service.Start(context.Background(), StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	record, found, err := store.GetJob(context.Background(), result.Job().ID())
	if err != nil || !found {
		t.Fatalf("GetJob() = %+v, found = %v, err = %v", record, found, err)
	}
	if record.Status != StatusPending {
		t.Fatalf("Status = %q, want %q", record.Status, StatusPending)
	}
	if record.ProviderID != "codex" || record.Purpose != PurposeRegister {
		t.Fatalf("ProviderID/Purpose = %q/%q", record.ProviderID, record.Purpose)
	}
	if record.TargetRef != "" {
		t.Fatalf("TargetRef = %q, want empty", record.TargetRef)
	}
	if !record.CreatedAt.Equal(testNow) ||
		!record.ExpiresAt.Equal(testNow.Add(DefaultJobTTL)) ||
		!record.UpdatedAt.Equal(testNow) {
		t.Fatalf(
			"时间字段 = %v/%v/%v",
			record.CreatedAt,
			record.ExpiresAt,
			record.UpdatedAt,
		)
	}
	if record.ErrorCode != "" {
		t.Fatalf("ErrorCode = %q, want empty", record.ErrorCode)
	}
}

func TestCompletePersistsProcessingThenCompleted(t *testing.T) {
	store := newMemoryJobStore()
	clock := newTestClock(testNow)
	var jobID string
	var processingSnapshot JobRecord
	var processingFound bool
	registrar := fakeRegistrar{onRegister: func() {
		// 注册发生在 processing 与 completed 之间：此刻库里必须是 processing，
		// 这样进程在写账号时崩溃，重启后也能被收敛成 expired。
		processingSnapshot, processingFound, _ = store.GetJob(
			context.Background(),
			jobID,
		)
	}}
	service := newTestService(t, testOptions{
		store:     store,
		clock:     clock,
		registrar: registrar,
	})

	start, err := service.Start(context.Background(), StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	jobID = start.Job().ID()
	clock.Advance(time.Minute)

	job, err := service.Complete(context.Background(), jobID, "code=test")
	if err != nil {
		t.Fatalf("Complete() error = %v", err)
	}
	if job.Status() != StatusCompleted {
		t.Fatalf("Complete() status = %q", job.Status())
	}
	if !processingFound || processingSnapshot.Status != StatusProcessing {
		t.Fatalf(
			"注册时快照 = %+v, found = %v, want processing",
			processingSnapshot,
			processingFound,
		)
	}
	record, found, err := store.GetJob(context.Background(), jobID)
	if err != nil || !found {
		t.Fatalf("GetJob() found = %v, err = %v", found, err)
	}
	if record.Status != StatusCompleted || record.ErrorCode != "" {
		t.Fatalf("终态快照 = %+v", record)
	}
	if !record.UpdatedAt.Equal(testNow.Add(time.Minute)) {
		t.Fatalf("UpdatedAt = %v", record.UpdatedAt)
	}
}

func TestCancelPersistsCancelledSnapshot(t *testing.T) {
	store := newMemoryJobStore()
	service := newTestService(t, testOptions{store: store})

	start, err := service.Start(context.Background(), StartRequest{ProviderID: "claude"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := service.Cancel(start.Job().ID()); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	record, found, err := store.GetJob(context.Background(), start.Job().ID())
	if err != nil || !found {
		t.Fatalf("GetJob() found = %v, err = %v", found, err)
	}
	if record.Status != StatusCancelled || record.ErrorCode != "cancelled" {
		t.Fatalf("取消快照 = %+v", record)
	}
}

func TestPersistFailureDoesNotBreakOAuthFlow(t *testing.T) {
	store := newMemoryJobStore()
	store.writeErr = errors.New("disk full")
	service := newTestService(t, testOptions{store: store})

	// 创建失败时 Job 仍必须可用，否则一次磁盘故障会让用户无法登录。
	start, err := service.Start(context.Background(), StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() 不应因持久化失败而失败: %v", err)
	}
	completed, err := service.Complete(context.Background(), start.Job().ID(), "code=test")
	if err != nil {
		t.Fatalf("Complete() 不应因持久化失败而失败: %v", err)
	}
	if completed.Status() != StatusCompleted {
		t.Fatalf("Complete() status = %q", completed.Status())
	}

	cancelledStart, err := service.Start(
		context.Background(),
		StartRequest{ProviderID: "claude"},
	)
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	cancelled, err := service.Cancel(cancelledStart.Job().ID())
	if err != nil {
		t.Fatalf("Cancel() 不应因持久化失败而失败: %v", err)
	}
	if cancelled.Status() != StatusCancelled {
		t.Fatalf("Cancel() status = %q", cancelled.Status())
	}
	if store.upsertCount() == 0 {
		t.Fatal("存储没有被调用，写失败路径没有被覆盖")
	}
}

func TestRehydrateExpiresUnfinishedJobs(t *testing.T) {
	store := newMemoryJobStore()
	store.seed(
		JobRecord{
			ID:         "pending-job",
			ProviderID: "codex",
			Purpose:    PurposeRegister,
			Status:     StatusPending,
			CreatedAt:  testNow.Add(-time.Hour),
			ExpiresAt:  testNow.Add(-50 * time.Minute),
			UpdatedAt:  testNow.Add(-time.Hour),
		},
		JobRecord{
			ID:         "processing-job",
			ProviderID: "claude",
			Purpose:    PurposeReauth,
			Status:     StatusProcessing,
			CreatedAt:  testNow.Add(-time.Hour),
			ExpiresAt:  testNow.Add(-50 * time.Minute),
			UpdatedAt:  testNow.Add(-40 * time.Minute),
		},
		JobRecord{
			ID:         "completed-job",
			ProviderID: "codex",
			Purpose:    PurposeRegister,
			Status:     StatusCompleted,
			CreatedAt:  testNow.Add(-time.Hour),
			ExpiresAt:  testNow.Add(-50 * time.Minute),
			UpdatedAt:  testNow.Add(-30 * time.Minute),
		},
	)
	service := newTestService(t, testOptions{store: store})

	if err := service.Rehydrate(context.Background()); err != nil {
		t.Fatalf("Rehydrate() error = %v", err)
	}
	for _, jobID := range []string{"pending-job", "processing-job"} {
		record, found, err := store.GetJob(context.Background(), jobID)
		if err != nil || !found {
			t.Fatalf("%s: found = %v, err = %v", jobID, found, err)
		}
		if record.Status != StatusExpired || record.ErrorCode != "expired" {
			t.Fatalf("%s: 快照 = %+v, want expired", jobID, record)
		}
		if !record.UpdatedAt.Equal(testNow) {
			t.Fatalf("%s: UpdatedAt = %v", jobID, record.UpdatedAt)
		}
	}
	completed, _, _ := store.GetJob(context.Background(), "completed-job")
	if completed.Status != StatusCompleted ||
		!completed.UpdatedAt.Equal(testNow.Add(-30*time.Minute)) {
		t.Fatalf("已经完成的 Job 不应被改写: %+v", completed)
	}
}

func TestRehydrateWithoutStoreIsNoop(t *testing.T) {
	service := newTestService(t, testOptions{})
	if err := service.Rehydrate(context.Background()); err != nil {
		t.Fatalf("Rehydrate() error = %v", err)
	}
}

func TestGetFallsBackToPersistedTerminalSnapshot(t *testing.T) {
	store := newMemoryJobStore()
	clock := newTestClock(testNow)
	first := newTestService(t, testOptions{store: store, clock: clock})

	start, err := first.Start(context.Background(), StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	jobID := start.Job().ID()
	if _, err := first.Complete(context.Background(), jobID, "code=test"); err != nil {
		t.Fatalf("Complete() error = %v", err)
	}

	// 模拟重启：新 Service 的内存为空，但 aih.db 里的快照仍在。
	restarted := newTestService(t, testOptions{store: store, clock: clock})
	job, err := restarted.Get(jobID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if job.Status() != StatusCompleted || job.ProviderID() != "codex" {
		t.Fatalf("回落快照 = %+v", job)
	}
	if job.FinishedAt().IsZero() {
		t.Fatal("终态快照应带有完成时间")
	}
	if _, err := restarted.Get("ffffffffffffffffffffffffffffffff"); !errors.Is(
		err,
		ErrJobNotFound,
	) {
		t.Fatalf("未知 Job 的 Get() error = %v", err)
	}
}

func TestGetFallsBackAfterMemoryRetentionElapsed(t *testing.T) {
	store := newMemoryJobStore()
	clock := newTestClock(testNow)
	service := newTestService(t, testOptions{store: store, clock: clock})

	start, err := service.Start(context.Background(), StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	jobID := start.Job().ID()
	if _, err := service.Cancel(jobID); err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	// 超过进程内终态保留期后内存记录会被清理，此时查询应回落到持久化快照。
	clock.Advance(DefaultTerminalRetention + time.Second)
	job, err := service.Get(jobID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if job.Status() != StatusCancelled || job.FailureCode() != "cancelled" {
		t.Fatalf("回落快照 = %+v", job)
	}
}

func TestGetJobHidesUnfinishedPersistedSnapshot(t *testing.T) {
	store := newMemoryJobStore()
	store.seed(JobRecord{
		ID:         "legacy-pending",
		ProviderID: "codex",
		Purpose:    PurposeRegister,
		Status:     StatusPending,
		CreatedAt:  testNow,
		ExpiresAt:  testNow.Add(DefaultJobTTL),
		UpdatedAt:  testNow,
	})
	service := newTestService(t, testOptions{store: store})

	// 尚未 Rehydrate 的 pending 快照没有对应的内存 Flow，重启后不可能完成，
	// 因此只能当作不存在，不能让客户端继续等待。
	if _, err := service.GetJob(
		context.Background(),
		"legacy-pending",
	); !errors.Is(err, ErrJobNotFound) {
		t.Fatalf("GetJob() error = %v", err)
	}
}

func TestServiceWithoutJobStoreKeepsWorking(t *testing.T) {
	service := newTestService(t, testOptions{})

	start, err := service.Start(context.Background(), StartRequest{ProviderID: "codex"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if _, err := service.Get(start.Job().ID()); err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if _, err := service.Get("ffffffffffffffffffffffffffffffff"); !errors.Is(
		err,
		ErrJobNotFound,
	) {
		t.Fatalf("未知 Job 的 Get() error = %v", err)
	}
}
