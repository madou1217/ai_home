package clipboard

import (
	"context"
	"time"
)

// Clock supplies the current time.
type Clock func() time.Time

// Store is the persistence port backed by aih.db.
type Store interface {
	UpsertItem(ctx context.Context, item Item) (persisted Item, deduplicated bool, err error)
	ListItems(ctx context.Context, filter ListFilter) ([]Item, error)
	GetItemByID(ctx context.Context, id string) (Item, bool, error)
	GetItemBySHA(ctx context.Context, sha string) (Item, bool, error)
	GetItemByPrefix(ctx context.Context, prefix string) (Item, bool, error)
	GetItemByIndex(ctx context.Context, oneBasedIndex int) (Item, bool, error)
	SetPinned(ctx context.Context, id string, pinned bool) (Item, bool, error)
	SoftDelete(ctx context.Context, id string, deletedAtMs int64) (bool, error)
	SoftDeleteAll(ctx context.Context, includePinned bool, deletedAtMs int64) (int, error)
	Prune(ctx context.Context, retentionCutoffMs int64, maxItems int, softDeleteCutoffMs int64) (PruneStoreResult, error)
	CountItems(ctx context.Context) (total int, pinned int, err error)
	UpsertDevice(ctx context.Context, device Device) error
	ListDevices(ctx context.Context) ([]Device, error)
	GetSetting(ctx context.Context, key string) (string, bool, error)
	SetSetting(ctx context.Context, key string, value string, updatedAtMs int64) error
	SetSettingIfAbsent(ctx context.Context, key string, value string, updatedAtMs int64) (string, error)
	GetAllSettings(ctx context.Context) (map[string]string, error)
	GetSyncState(ctx context.Context, key string) (string, bool, error)
	SetSyncState(ctx context.Context, key string, value string, updatedAtMs int64) error
	ListUnsyncedItems(ctx context.Context, limit int) ([]Item, error)
	MarkItemsSynced(ctx context.Context, ids []string, atMs int64) error
	ListItemsSince(ctx context.Context, sinceMs int64, limit int) ([]Item, error)
	RequestContent(ctx context.Context, sha string, nowMs int64) error
	ListContentRequests(ctx context.Context, limit int) ([]string, error)
	ClearContentRequest(ctx context.Context, sha string) error
}

// BlobStore manages on-disk clipboard blobs under ~/.ai_home/clipboard/blobs/.
type BlobStore interface {
	Write(sha256Hex string, data []byte) (relativePath string, err error)
	Read(relativePath string) ([]byte, error)
	ResolvePath(relativePath string) (string, error)
	Delete(relativePath string) error
	MaterializeFiles(sha256Hex string, files []MaterializedFile) (paths []string, totalBytes int64, err error)
}

// RuntimeProbe optionally reports live capture/sync/transport state to Status.
type RuntimeProbe interface {
	CaptureStatus() CaptureStatus
	SyncStatus() SyncStatus
	Transports() []TransportStatus
}
