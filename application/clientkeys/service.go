// Package clientkeys 维护托管客户端 API Key 的应用服务。
//
// 职责：生成/创建/轮换/停用 Key，维护鉴权用的原子快照，并把 last_used
// 批量写回。持久化通过 Store 端口注入，本包不依赖 SQLite、HTTP 或配置。
package clientkeys

import (
	"context"
	"crypto/subtle"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	coreclientkeys "github.com/madou1217/ai_home/core/clientkeys"
)

var (
	// ErrUnavailable 表示服务缺少存储或未初始化。
	ErrUnavailable = errors.New("客户端 API Key 服务不可用")
	// ErrInvalidName 表示名称不合法。
	ErrInvalidName = errors.New("客户端 API Key 名称无效")
	// ErrNotFound 表示 Key 不存在或已撤销。
	ErrNotFound = errors.New("客户端 API Key 不存在")
	// ErrMasterCollision 表示新生成的密钥与总 key 冲突。
	ErrMasterCollision = errors.New("客户端 API Key 与总 key 冲突")
)

const (
	defaultReloadInterval = 2 * time.Second
	defaultFlushInterval  = 30 * time.Second
	defaultPruneInterval  = time.Hour
	minuteRetention       = 7 * 24 * time.Hour
	maxNameRunes          = 80
)

// Store 是 Key 持久化端口。
type Store interface {
	ListClientKeys(ctx context.Context) ([]coreclientkeys.Key, error)
	GetClientKey(ctx context.Context, keyID string) (coreclientkeys.Key, bool, error)
	CreateClientKey(ctx context.Context, key coreclientkeys.Key, hash [32]byte) error
	UpdateClientKey(ctx context.Context, keyID string, mutate func(*coreclientkeys.Key) error) (coreclientkeys.Key, error)
	RevokeClientKey(ctx context.Context, keyID string) error
	RotateClientKeySecret(ctx context.Context, keyID string, hash [32]byte) error
	TouchClientKeyLastUsed(ctx context.Context, keyID string, atMS int64) error
	LoadActiveClientKeys(ctx context.Context) ([]coreclientkeys.AuthRecord, error)
	ClientKeyRevision(ctx context.Context) (int64, int64, error)
	PruneClientKeyMinuteStats(ctx context.Context, cutoffMS int64) error
}

type snapshot struct {
	byID map[string]coreclientkeys.AuthRecord
}

// Service 持有鉴权快照与 last_used 缓冲。
type Service struct {
	store  Store
	master func() string
	now    func() time.Time

	reloadMu    sync.Mutex
	current     atomic.Pointer[snapshot]
	revisionMax int64
	revisionCnt int64

	usedMu sync.Mutex
	used   map[string]int64
}

// NewService 创建服务并加载第一份快照。
func NewService(store Store, master func() string, now func() time.Time) (*Service, error) {
	if store == nil {
		return nil, ErrUnavailable
	}
	if now == nil {
		now = time.Now
	}
	service := &Service{store: store, master: master, now: now, used: map[string]int64{}}
	if err := service.Reload(context.Background()); err != nil {
		return nil, err
	}
	return service, nil
}

// Authenticate 校验明文 Key 并返回调用方身份。
//
// 总 key 优先按常量时间比较；托管 Key 先按前缀里的 key_id 定位快照，再比较摘要。
func (service *Service) Authenticate(raw string) (coreclientkeys.Identity, bool) {
	if service == nil || service.store == nil {
		return coreclientkeys.Identity{}, false
	}
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return coreclientkeys.Identity{}, false
	}
	if service.master != nil {
		master := strings.TrimSpace(service.master())
		if master != "" {
			expected := coreclientkeys.HashSecret(master)
			provided := coreclientkeys.HashSecret(trimmed)
			if subtle.ConstantTimeCompare(expected[:], provided[:]) == 1 {
				return coreclientkeys.MasterIdentity(), true
			}
		}
	}
	keyID, ok := coreclientkeys.ParseSecret(trimmed)
	if !ok {
		return coreclientkeys.Identity{}, false
	}
	snap := service.current.Load()
	if snap == nil {
		return coreclientkeys.Identity{}, false
	}
	record, found := snap.byID[keyID]
	if !found {
		return coreclientkeys.Identity{}, false
	}
	provided := coreclientkeys.HashSecret(trimmed)
	if subtle.ConstantTimeCompare(record.Hash[:], provided[:]) != 1 {
		return coreclientkeys.Identity{}, false
	}
	service.markUsed(keyID, service.now())
	return coreclientkeys.Identity{KeyID: record.KeyID, Name: record.Name, Prefix: record.Prefix}, true
}

// Create 生成并保存一把新 Key，明文只在此处返回一次。
func (service *Service) Create(
	ctx context.Context,
	name string,
	limits coreclientkeys.Limits,
) (coreclientkeys.Key, string, error) {
	if service == nil || service.store == nil {
		return coreclientkeys.Key{}, "", ErrUnavailable
	}
	normalized := strings.TrimSpace(name)
	if normalized == "" || len([]rune(normalized)) > maxNameRunes {
		return coreclientkeys.Key{}, "", ErrInvalidName
	}
	raw, keyID, prefix, hash, err := coreclientkeys.Generate()
	if err != nil {
		return coreclientkeys.Key{}, "", err
	}
	if service.master != nil {
		master := strings.TrimSpace(service.master())
		if master != "" && hash == coreclientkeys.HashSecret(master) {
			return coreclientkeys.Key{}, "", ErrMasterCollision
		}
	}
	key := coreclientkeys.Key{
		ID:          keyID,
		Name:        normalized,
		Prefix:      prefix,
		Enabled:     true,
		CreatedAtMS: service.now().UnixMilli(),
		UpdatedAtMS: service.now().UnixMilli(),
		Limits:      limits,
	}
	if err := service.store.CreateClientKey(ctx, key, hash); err != nil {
		return coreclientkeys.Key{}, "", err
	}
	if err := service.Reload(ctx); err != nil {
		return coreclientkeys.Key{}, "", err
	}
	return key, raw, nil
}

// List 返回全部 Key（含停用/撤销）。
func (service *Service) List(ctx context.Context) ([]coreclientkeys.Key, error) {
	if service == nil || service.store == nil {
		return nil, ErrUnavailable
	}
	return service.store.ListClientKeys(ctx)
}

// Get 读取单把 Key。
func (service *Service) Get(ctx context.Context, keyID string) (coreclientkeys.Key, error) {
	if service == nil || service.store == nil {
		return coreclientkeys.Key{}, ErrUnavailable
	}
	key, found, err := service.store.GetClientKey(ctx, keyID)
	if err != nil {
		return coreclientkeys.Key{}, err
	}
	if !found || key.RevokedAtMS != 0 {
		return coreclientkeys.Key{}, ErrNotFound
	}
	return key, nil
}

// Update 修改名称/启用状态/限流字段。
func (service *Service) Update(
	ctx context.Context,
	keyID string,
	mutate func(*coreclientkeys.Key) error,
) (coreclientkeys.Key, error) {
	if service == nil || service.store == nil {
		return coreclientkeys.Key{}, ErrUnavailable
	}
	key, err := service.store.UpdateClientKey(ctx, keyID, mutate)
	if err != nil {
		return coreclientkeys.Key{}, err
	}
	if err := service.Reload(ctx); err != nil {
		return coreclientkeys.Key{}, err
	}
	return key, nil
}

// Revoke 软删除一把 Key；同步刷新快照，下一个请求立即失效。
func (service *Service) Revoke(ctx context.Context, keyID string) error {
	if service == nil || service.store == nil {
		return ErrUnavailable
	}
	if err := service.store.RevokeClientKey(ctx, keyID); err != nil {
		return err
	}
	return service.Reload(ctx)
}

// Rotate 生成新的明文并替换摘要，旧明文同步失效。
func (service *Service) Rotate(ctx context.Context, keyID string) (string, error) {
	if service == nil || service.store == nil {
		return "", ErrUnavailable
	}
	raw, _, _, hash, err := coreclientkeys.Generate()
	if err != nil {
		return "", err
	}
	if service.master != nil {
		master := strings.TrimSpace(service.master())
		if master != "" && hash == coreclientkeys.HashSecret(master) {
			return "", ErrMasterCollision
		}
	}
	if err := service.store.RotateClientKeySecret(ctx, keyID, hash); err != nil {
		return "", err
	}
	if err := service.Reload(ctx); err != nil {
		return "", err
	}
	return raw, nil
}

// Reload 重新加载活动 Key 快照（管理写路径同步调用）。
func (service *Service) Reload(ctx context.Context) error {
	if service == nil || service.store == nil {
		return ErrUnavailable
	}
	service.reloadMu.Lock()
	defer service.reloadMu.Unlock()
	revisionMax, revisionCnt, err := service.store.ClientKeyRevision(ctx)
	if err != nil {
		return err
	}
	records, err := service.store.LoadActiveClientKeys(ctx)
	if err != nil {
		return err
	}
	next := &snapshot{byID: make(map[string]coreclientkeys.AuthRecord, len(records))}
	for _, record := range records {
		next.byID[record.KeyID] = record
	}
	service.current.Store(next)
	service.revisionMax = revisionMax
	service.revisionCnt = revisionCnt
	return nil
}

// Start 运行热更新/刷盘/清理循环，直到 ctx 结束。
func (service *Service) Start(ctx context.Context) {
	if service == nil {
		return
	}
	reloadTicker := time.NewTicker(defaultReloadInterval)
	flushTicker := time.NewTicker(defaultFlushInterval)
	pruneTicker := time.NewTicker(defaultPruneInterval)
	defer reloadTicker.Stop()
	defer flushTicker.Stop()
	defer pruneTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			service.FlushLastUsed(context.Background())
			return
		case <-reloadTicker.C:
			service.reloadIfChanged(ctx)
		case <-flushTicker.C:
			service.FlushLastUsed(ctx)
		case <-pruneTicker.C:
			cutoff := service.now().Add(-minuteRetention).UnixMilli()
			_ = service.store.PruneClientKeyMinuteStats(ctx, cutoff)
		}
	}
}

func (service *Service) reloadIfChanged(ctx context.Context) {
	revisionMax, revisionCnt, err := service.store.ClientKeyRevision(ctx)
	if err != nil {
		return
	}
	service.reloadMu.Lock()
	unchanged := revisionMax == service.revisionMax && revisionCnt == service.revisionCnt
	service.reloadMu.Unlock()
	if unchanged {
		return
	}
	_ = service.Reload(ctx)
}

func (service *Service) markUsed(keyID string, at time.Time) {
	if service == nil || strings.TrimSpace(keyID) == "" || at.IsZero() {
		return
	}
	now := at.UnixMilli()
	service.usedMu.Lock()
	if previous, found := service.used[keyID]; !found || now > previous {
		service.used[keyID] = now
	}
	service.usedMu.Unlock()
}

// FlushLastUsed 把缓冲的最后使用时间写回数据库。
func (service *Service) FlushLastUsed(ctx context.Context) {
	if service == nil || service.store == nil {
		return
	}
	service.usedMu.Lock()
	pending := service.used
	service.used = map[string]int64{}
	service.usedMu.Unlock()
	for keyID, atMS := range pending {
		_ = service.store.TouchClientKeyLastUsed(ctx, keyID, atMS)
	}
}
