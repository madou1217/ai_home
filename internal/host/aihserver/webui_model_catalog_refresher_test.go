package aihserver

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/transport/http/webuiopenaimodelswriteapi"
)

// 本文件锁定「全局模型目录刷新」的扇出语义：
//   - 游标翻页枚举全部账号，不按 Provider 写分支；
//   - 单账号失败不阻断其它账号，错误摘要只保留首个；
//   - 有界并发，不把上万账号一次打出去；
//   - ctx 取消后不再派发新任务。

var refreshTestTime = time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

// fakeRefreshAccounts 按调用次数返回预置分页。
type fakeRefreshAccounts struct {
	pages [][]accountapp.AccountOverview
	calls atomic.Int32
	err   error
}

func (store *fakeRefreshAccounts) ListAccountOverviews(
	_ context.Context,
	_ accountapp.OverviewQuery,
) ([]accountapp.AccountOverview, error) {
	index := int(store.calls.Add(1)) - 1
	if store.err != nil {
		return nil, store.err
	}
	if index >= len(store.pages) {
		return nil, nil
	}
	return store.pages[index], nil
}

// fakeModelRefresher 记录刷新调用并按账号返回结果。
type fakeModelRefresher struct {
	mu        sync.Mutex
	calls     []accountcore.AccountRef
	failRef   accountcore.AccountRef
	failErr   error
	models    int
	block     chan struct{}
	inflight  atomic.Int32
	maxFlight atomic.Int32
}

func (refresher *fakeModelRefresher) RefreshAccountModels(
	ctx context.Context,
	accountRef accountcore.AccountRef,
) ([]accountapp.AccountModel, error) {
	current := refresher.inflight.Add(1)
	defer refresher.inflight.Add(-1)
	for {
		max := refresher.maxFlight.Load()
		if current <= max || refresher.maxFlight.CompareAndSwap(max, current) {
			break
		}
	}
	if refresher.block != nil {
		select {
		case <-refresher.block:
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	refresher.mu.Lock()
	refresher.calls = append(refresher.calls, accountRef)
	refresher.mu.Unlock()
	if refresher.failErr != nil && accountRef == refresher.failRef {
		return nil, refresher.failErr
	}
	count := refresher.models
	if count <= 0 {
		count = 1
	}
	models := make([]accountapp.AccountModel, 0, count)
	for index := 0; index < count; index++ {
		model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
			AccountRef:        accountRef,
			ModelID:           fmt.Sprintf("model-%02d", index),
			UpstreamAvailable: true,
			ManualPolicy:      accountapp.ModelPolicyInherit,
			UpdatedAt:         refreshTestTime,
		})
		if err != nil {
			return nil, err
		}
		models = append(models, model)
	}
	return models, nil
}

func (refresher *fakeModelRefresher) callCount() int {
	refresher.mu.Lock()
	defer refresher.mu.Unlock()
	return len(refresher.calls)
}

func refreshTestRef(index int) accountcore.AccountRef {
	return accountcore.AccountRef(fmt.Sprintf("acct_%020x", index))
}

func refreshTestOverview(t *testing.T, catalog *providers.Catalog, index int) accountapp.AccountOverview {
	t.Helper()
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          refreshTestRef(index),
		ProviderID:   "claude",
		CLIAccountID: accountcore.CLIAccountID(index + 1),
		Enabled:      true,
		CreatedAt:    refreshTestTime,
		UpdatedAt:    refreshTestTime,
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	overview, err := accountapp.NewAccountOverview(accountapp.AccountOverviewInput{Account: account})
	if err != nil {
		t.Fatalf("NewAccountOverview() error = %v", err)
	}
	return overview
}

func refreshTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func TestWebUIModelCatalogRefresherPagesThroughAllAccounts(t *testing.T) {
	catalog := refreshTestCatalog(t)
	firstPage := make([]accountapp.AccountOverview, 0, webuiModelRefreshPageSize)
	for index := 0; index < webuiModelRefreshPageSize; index++ {
		firstPage = append(firstPage, refreshTestOverview(t, catalog, index))
	}
	secondPage := []accountapp.AccountOverview{
		refreshTestOverview(t, catalog, webuiModelRefreshPageSize),
	}
	accounts := &fakeRefreshAccounts{pages: [][]accountapp.AccountOverview{firstPage, secondPage}}
	models := &fakeModelRefresher{models: 2}

	refresher := newWebUIModelCatalogRefresher(accounts, models, func() time.Time {
		return refreshTestTime
	})
	result, err := refresher.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	if result.Accounts != webuiModelRefreshPageSize+1 {
		t.Fatalf("Accounts = %d, want %d", result.Accounts, webuiModelRefreshPageSize+1)
	}
	if result.Models != (webuiModelRefreshPageSize+1)*2 {
		t.Fatalf("Models = %d, want %d", result.Models, (webuiModelRefreshPageSize+1)*2)
	}
	if result.Sources != 1 {
		t.Fatalf("Sources = %d, want 1", result.Sources)
	}
	if result.Source != "probe" {
		t.Fatalf("Source = %q, want probe", result.Source)
	}
	if result.UpdatedAtMS != refreshTestTime.UnixMilli() {
		t.Fatalf("UpdatedAtMS = %d, want %d", result.UpdatedAtMS, refreshTestTime.UnixMilli())
	}
	if models.callCount() != webuiModelRefreshPageSize+1 {
		t.Fatalf("RefreshAccountModels calls = %d, want %d", models.callCount(), webuiModelRefreshPageSize+1)
	}
}

func TestWebUIModelCatalogRefresherKeepsGoingAfterOneFailure(t *testing.T) {
	catalog := refreshTestCatalog(t)
	accounts := &fakeRefreshAccounts{pages: [][]accountapp.AccountOverview{{
		refreshTestOverview(t, catalog, 0),
		refreshTestOverview(t, catalog, 1),
	}}}
	models := &fakeModelRefresher{
		failRef: refreshTestRef(1),
		failErr: errors.New("upstream_probe_failed: 401"),
	}

	refresher := newWebUIModelCatalogRefresher(accounts, models, time.Now)
	result, err := refresher.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}

	if result.Accounts != 2 {
		t.Fatalf("Accounts = %d, want 2", result.Accounts)
	}
	if result.Models != 1 {
		t.Fatalf("Models = %d, want 1（失败账号不计模型）", result.Models)
	}
	if !strings.Contains(result.FirstError, "upstream_probe_failed") {
		t.Fatalf("FirstError = %q, want 包含上游错误", result.FirstError)
	}
	if result.Sources != 1 {
		t.Fatalf("Sources = %d, want 1（仍有账号成功）", result.Sources)
	}
}

func TestWebUIModelCatalogRefresherBoundsConcurrency(t *testing.T) {
	catalog := refreshTestCatalog(t)
	overviews := make([]accountapp.AccountOverview, 0, 12)
	for index := 0; index < 12; index++ {
		overviews = append(overviews, refreshTestOverview(t, catalog, index))
	}
	accounts := &fakeRefreshAccounts{pages: [][]accountapp.AccountOverview{overviews}}
	block := make(chan struct{})
	models := &fakeModelRefresher{block: block}

	refresher := newWebUIModelCatalogRefresher(accounts, models, time.Now)
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := refresher.Refresh(context.Background()); err != nil {
			t.Errorf("Refresh() error = %v", err)
		}
	}()
	// 等所有并发槽位占满，再放行。
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && models.inflight.Load() < webuiModelRefreshConcurrency {
		time.Sleep(time.Millisecond)
	}
	close(block)
	<-done

	if max := models.maxFlight.Load(); max > webuiModelRefreshConcurrency {
		t.Fatalf("并发峰值 = %d, want <= %d", max, webuiModelRefreshConcurrency)
	}
	if models.callCount() != 12 {
		t.Fatalf("RefreshAccountModels calls = %d, want 12", models.callCount())
	}
}

func TestWebUIModelCatalogRefresherEmptyDirectory(t *testing.T) {
	accounts := &fakeRefreshAccounts{}
	models := &fakeModelRefresher{}

	refresher := newWebUIModelCatalogRefresher(accounts, models, time.Now)
	result, err := refresher.Refresh(context.Background())
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if result.Source != "empty" {
		t.Fatalf("Source = %q, want empty", result.Source)
	}
	if result.Accounts != 0 || result.Models != 0 {
		t.Fatalf("Accounts/Models = %d/%d, want 0/0", result.Accounts, result.Models)
	}
}

func TestWebUIModelCatalogRefresherStopsOnCancel(t *testing.T) {
	catalog := refreshTestCatalog(t)
	accounts := &fakeRefreshAccounts{pages: [][]accountapp.AccountOverview{{
		refreshTestOverview(t, catalog, 0),
		refreshTestOverview(t, catalog, 1),
	}}}
	models := &fakeModelRefresher{}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	refresher := newWebUIModelCatalogRefresher(accounts, models, time.Now)
	result, err := refresher.Refresh(ctx)
	if err != nil {
		t.Fatalf("Refresh() error = %v", err)
	}
	if result.Accounts != 0 {
		t.Fatalf("Accounts = %d, want 0（取消后不再派发）", result.Accounts)
	}
	if !strings.Contains(result.FirstError, "context canceled") {
		t.Fatalf("FirstError = %q, want context canceled", result.FirstError)
	}
}

func TestNewWebUIOpenAIModelsRefresherRequiresDependencies(t *testing.T) {
	if refresher := newWebUIModelCatalogRefresher(nil, &fakeModelRefresher{}, time.Now); refresher != nil {
		t.Fatalf("缺少账号端口时必须返回 nil，保持 501 语义")
	}
	if refresher := newWebUIModelCatalogRefresher(&fakeRefreshAccounts{}, nil, time.Now); refresher != nil {
		t.Fatalf("缺少刷新端口时必须返回 nil，保持 501 语义")
	}
	var _ webuiopenaimodelswriteapi.Refresher = newWebUIModelCatalogRefresher(
		&fakeRefreshAccounts{},
		&fakeModelRefresher{},
		time.Now,
	)
}
