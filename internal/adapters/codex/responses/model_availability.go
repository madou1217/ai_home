package responses

import (
	"container/list"
	"context"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/accountrouting"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	codexauth "github.com/madou1217/ai_home/core/accounts/codex"
)

const (
	// modelCatalogTTL 平衡权限变化传播速度与远端目录请求数量。
	modelCatalogTTL = 5 * time.Minute
	// maxCachedModelCatalogs 只保留热账号，避免一万账号全部常驻内存。
	maxCachedModelCatalogs = 512
	// maxConcurrentModelCatalogLoads 限制目录预检对上游连接池的压力。
	maxConcurrentModelCatalogLoads = 16
)

// AccountModelAvailability 按账号惰性读取 Codex 模型目录。
//
// 该适配器只保存有界、短生命周期的模型标识，不保存凭据，也不写账号表。
type AccountModelAvailability struct {
	client     HTTPClient
	clock      Clock
	ttl        time.Duration
	maxEntries int
	loadSlots  chan struct{}

	mu       sync.Mutex
	cache    map[accountcore.AccountRef]*list.Element
	lru      *list.List
	inflight map[accountcore.AccountRef]*modelCatalogCall
}

// 编译期确认账号模型权限适配器完整实现征召端口。
var _ accountrouting.ModelAvailabilitySource = (*AccountModelAvailability)(nil)

// cachedModelCatalog 保存一个热账号的目录和过期时间。
type cachedModelCatalog struct {
	accountRef accountcore.AccountRef
	catalog    modelCatalog
	expiresAt  time.Time
}

// modelCatalogCall 合并同一账号的并发目录请求。
type modelCatalogCall struct {
	done    chan struct{}
	catalog modelCatalog
	err     error
}

// modelAvailabilityConfig 只供确定性测试覆盖有界参数。
type modelAvailabilityConfig struct {
	ttl           time.Duration
	maxEntries    int
	maxConcurrent int
}

// NewAccountModelAvailability 创建使用生产边界的账号模型权限适配器。
func NewAccountModelAvailability(
	client HTTPClient,
	clock Clock,
) (*AccountModelAvailability, error) {
	return newAccountModelAvailability(
		client,
		clock,
		modelAvailabilityConfig{
			ttl:           modelCatalogTTL,
			maxEntries:    maxCachedModelCatalogs,
			maxConcurrent: maxConcurrentModelCatalogLoads,
		},
	)
}

// newAccountModelAvailability 创建可由测试缩短 TTL 和容量的适配器。
func newAccountModelAvailability(
	client HTTPClient,
	clock Clock,
	config modelAvailabilityConfig,
) (*AccountModelAvailability, error) {
	if client == nil ||
		clock == nil ||
		config.ttl <= 0 ||
		config.maxEntries <= 0 ||
		config.maxConcurrent <= 0 {
		return nil, ErrInvalidDependencies
	}
	return &AccountModelAvailability{
		client:     client,
		clock:      clock,
		ttl:        config.ttl,
		maxEntries: config.maxEntries,
		loadSlots:  make(chan struct{}, config.maxConcurrent),
		cache:      make(map[accountcore.AccountRef]*list.Element, config.maxEntries),
		lru:        list.New(),
		inflight:   make(map[accountcore.AccountRef]*modelCatalogCall),
	}, nil
}

// CheckAvailability 判断当前账号是否拥有目标真实模型。
func (source *AccountModelAvailability) CheckAvailability(
	ctx context.Context,
	route runtimecore.ModelRoute,
	credential accountapp.Credential,
) (bool, error) {
	if source == nil ||
		source.client == nil ||
		source.clock == nil ||
		source.lru == nil ||
		ctx == nil ||
		!route.IsValid() ||
		credential == nil ||
		credential.ProviderID() != codexauth.ProviderID {
		return false, ErrInvalidInvocation
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil || accountRef != route.AccountRef() {
		return false, ErrInvalidInvocation
	}
	auth, err := projectAuth(credential)
	if err != nil {
		return false, err
	}
	catalog, err := source.catalogFor(ctx, accountRef, auth)
	if err != nil {
		return false, err
	}
	return catalog.contains(route.ModelID().String()), nil
}

// catalogFor 优先读取热缓存，并合并同一账号的并发加载。
func (source *AccountModelAvailability) catalogFor(
	ctx context.Context,
	accountRef accountcore.AccountRef,
	auth authProjection,
) (modelCatalog, error) {
	now := source.clock()
	if !validModelCatalogTime(now) {
		return modelCatalog{}, ErrInvalidDependencies
	}
	source.mu.Lock()
	if catalog, found := source.cachedCatalogLocked(accountRef, now); found {
		source.mu.Unlock()
		return catalog, nil
	}
	if call, found := source.inflight[accountRef]; found {
		source.mu.Unlock()
		return waitForModelCatalog(ctx, call)
	}
	call := &modelCatalogCall{done: make(chan struct{})}
	source.inflight[accountRef] = call
	source.mu.Unlock()

	catalog, err := source.loadCatalog(ctx, auth)
	loadedAt := source.clock()
	if err == nil && !validModelCatalogTime(loadedAt) {
		err = ErrInvalidDependencies
	}
	source.finishCatalogLoad(accountRef, call, catalog, loadedAt, err)
	return catalog, err
}

// loadCatalog 在全局并发槽内完成一次远端目录请求。
func (source *AccountModelAvailability) loadCatalog(
	ctx context.Context,
	auth authProjection,
) (modelCatalog, error) {
	select {
	case source.loadSlots <- struct{}{}:
		defer func() { <-source.loadSlots }()
	case <-ctx.Done():
		return modelCatalog{}, ctx.Err()
	}
	return fetchModelCatalog(ctx, source.client, auth)
}

// finishCatalogLoad 发布单飞结果，并只缓存成功目录。
func (source *AccountModelAvailability) finishCatalogLoad(
	accountRef accountcore.AccountRef,
	call *modelCatalogCall,
	catalog modelCatalog,
	loadedAt time.Time,
	err error,
) {
	source.mu.Lock()
	defer source.mu.Unlock()
	call.catalog = catalog
	call.err = err
	if err == nil {
		source.storeCatalogLocked(
			accountRef,
			catalog,
			loadedAt.Add(source.ttl),
		)
	}
	delete(source.inflight, accountRef)
	close(call.done)
}

// cachedCatalogLocked 返回未过期目录，并维护最近使用顺序。
func (source *AccountModelAvailability) cachedCatalogLocked(
	accountRef accountcore.AccountRef,
	now time.Time,
) (modelCatalog, bool) {
	element, found := source.cache[accountRef]
	if !found {
		return modelCatalog{}, false
	}
	entry := element.Value.(*cachedModelCatalog)
	if !now.Before(entry.expiresAt) {
		source.removeCatalogLocked(element)
		return modelCatalog{}, false
	}
	source.lru.MoveToFront(element)
	return entry.catalog, true
}

// storeCatalogLocked 写入热目录，并淘汰最久未使用账号。
func (source *AccountModelAvailability) storeCatalogLocked(
	accountRef accountcore.AccountRef,
	catalog modelCatalog,
	expiresAt time.Time,
) {
	if element, found := source.cache[accountRef]; found {
		entry := element.Value.(*cachedModelCatalog)
		entry.catalog = catalog
		entry.expiresAt = expiresAt
		source.lru.MoveToFront(element)
		return
	}
	element := source.lru.PushFront(&cachedModelCatalog{
		accountRef: accountRef,
		catalog:    catalog,
		expiresAt:  expiresAt,
	})
	source.cache[accountRef] = element
	for source.lru.Len() > source.maxEntries {
		source.removeCatalogLocked(source.lru.Back())
	}
}

// removeCatalogLocked 从索引和 LRU 链表同时删除目录。
func (source *AccountModelAvailability) removeCatalogLocked(element *list.Element) {
	if element == nil {
		return
	}
	entry := element.Value.(*cachedModelCatalog)
	delete(source.cache, entry.accountRef)
	source.lru.Remove(element)
}

// waitForModelCatalog 等待同账号加载，同时尊重当前调用方取消。
func waitForModelCatalog(
	ctx context.Context,
	call *modelCatalogCall,
) (modelCatalog, error) {
	select {
	case <-call.done:
		return call.catalog, call.err
	case <-ctx.Done():
		return modelCatalog{}, ctx.Err()
	}
}

// validModelCatalogTime 拒绝零值或无法安全持久表达的业务时间。
func validModelCatalogTime(value time.Time) bool {
	return !value.IsZero() && value.Year() >= 1970 && value.Year() <= 9999
}
