// Package appcatalog scans, deduplicates, and caches installed desktop applications across platforms.
package appcatalog

import (
	"context"
	"errors"
	"runtime"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

// DefaultCacheTTL is the 5-minute catalog cache window specified by §2.7.
const DefaultCacheTTL = 5 * time.Minute

// Options customizes catalog timing and scan behavior.
type Options struct {
	TTL   time.Duration
	Clock func() time.Time
}

// Catalog caches platform application scans and satisfies launcher.Catalog.
type Catalog struct {
	platform  string
	supported bool
	ttl       time.Duration
	clock     func() time.Time
	scanFn    func(context.Context) ([]launcher.App, error)

	scanMu      sync.Mutex
	stateMu     sync.RWMutex
	cached      []launcher.App
	generatedAt time.Time
	lastError   string
	hasScanned  bool
}

// New constructs a platform application catalog with default 5-minute caching.
func New() *Catalog {
	return NewWithOptions(Options{})
}

// NewWithOptions constructs a platform application catalog with custom options.
func NewWithOptions(opts Options) *Catalog {
	ttl := opts.TTL
	if ttl <= 0 {
		ttl = DefaultCacheTTL
	}
	clock := opts.Clock
	if clock == nil {
		clock = time.Now
	}
	return &Catalog{
		platform:  runtime.GOOS,
		supported: platformSupported(),
		ttl:       ttl,
		clock:     clock,
		scanFn:    scanApps,
	}
}

// Platform returns the normalized GOOS identifier.
func (c *Catalog) Platform() string {
	if c == nil {
		return runtime.GOOS
	}
	return c.platform
}

// Supported reports whether the current platform supports application scanning.
func (c *Catalog) Supported() bool {
	if c == nil {
		return false
	}
	return c.supported
}

// Status returns the current cached catalog metadata without triggering a scan.
func (c *Catalog) Status(_ context.Context) launcher.CatalogSnapshot {
	if c == nil {
		return launcher.CatalogSnapshot{Platform: runtime.GOOS}
	}
	c.stateMu.RLock()
	defer c.stateMu.RUnlock()
	return c.snapshotLocked()
}

// List returns cached applications if fresh, or performs a platform scan when expired or refresh=true.
func (c *Catalog) List(ctx context.Context, refresh bool) (launcher.CatalogSnapshot, error) {
	if c == nil {
		return launcher.CatalogSnapshot{Platform: runtime.GOOS}, launcher.ErrUnavailable
	}
	if !c.supported {
		c.stateMu.Lock()
		c.hasScanned = true
		c.lastError = launcher.ErrUnsupported.Error()
		snap := c.snapshotLocked()
		c.stateMu.Unlock()
		return snap, launcher.ErrUnsupported
	}

	now := c.clock()
	if !refresh {
		c.stateMu.RLock()
		if c.hasScanned && !c.generatedAt.IsZero() && now.Sub(c.generatedAt) < c.ttl {
			snap := c.snapshotLocked()
			c.stateMu.RUnlock()
			return snap, nil
		}
		c.stateMu.RUnlock()
	}

	c.scanMu.Lock()
	defer c.scanMu.Unlock()

	now = c.clock()
	if !refresh {
		c.stateMu.RLock()
		if c.hasScanned && !c.generatedAt.IsZero() && now.Sub(c.generatedAt) < c.ttl {
			snap := c.snapshotLocked()
			c.stateMu.RUnlock()
			return snap, nil
		}
		c.stateMu.RUnlock()
	}

	rawApps, err := c.scanFn(ctx)
	if err != nil {
		// Caller cancellation/timeout must not poison lastError and block subsequent initial scans.
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			c.stateMu.RLock()
			snap := c.snapshotLocked()
			c.stateMu.RUnlock()
			return snap, err
		}
		c.stateMu.Lock()
		c.hasScanned = true
		c.lastError = err.Error()
		snap := c.snapshotLocked()
		c.stateMu.Unlock()
		return snap, err
	}

	normalized := normalizeAndDeduplicate(rawApps)
	scannedAt := c.clock()

	c.stateMu.Lock()
	c.cached = normalized
	c.generatedAt = scannedAt
	c.lastError = ""
	c.hasScanned = true
	snap := c.snapshotLocked()
	c.stateMu.Unlock()
	return snap, nil
}

func (c *Catalog) snapshotLocked() launcher.CatalogSnapshot {
	appsCopy := make([]launcher.App, len(c.cached))
	copy(appsCopy, c.cached)
	var generatedAt int64
	if !c.generatedAt.IsZero() {
		generatedAt = c.generatedAt.UnixMilli()
	}
	return launcher.CatalogSnapshot{
		Platform:    c.platform,
		Supported:   c.supported,
		GeneratedAt: generatedAt,
		Apps:        appsCopy,
		LastError:   c.lastError,
	}
}

func normalizeAndDeduplicate(apps []launcher.App) []launcher.App {
	if len(apps) == 0 {
		return []launcher.App{}
	}
	seen := make(map[string]struct{}, len(apps))
	out := make([]launcher.App, 0, len(apps))
	for _, app := range apps {
		clean := launcher.NormalizeApp(app)
		if clean.ID == "" || clean.Name == "" {
			continue
		}
		if _, dup := seen[clean.ID]; dup {
			continue
		}
		seen[clean.ID] = struct{}{}
		out = append(out, clean)
	}
	return out
}

var _ launcher.Catalog = (*Catalog)(nil)
