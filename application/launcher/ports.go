package launcher

import "context"

// Catalog scans and caches installed applications for the current platform.
type Catalog interface {
	Platform() string
	Supported() bool
	List(ctx context.Context, refresh bool) (CatalogSnapshot, error)
	Status(ctx context.Context) CatalogSnapshot
}

// Launcher executes the platform-specific action to open an application.
type Launcher interface {
	Open(ctx context.Context, app App) error
}

// UsageStore persists recent application open timestamps and counts.
type UsageStore interface {
	Load(ctx context.Context) (UsageSnapshot, error)
	RecordOpen(ctx context.Context, appID string, openedAtMs int64) error
}
