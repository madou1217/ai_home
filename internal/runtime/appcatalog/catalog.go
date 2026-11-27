// Package appcatalog scans, deduplicates, and caches installed desktop applications across platforms.
package appcatalog

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/launcher"
)

// DefaultCacheTTL is the 5-minute catalog cache window specified by §2.7.
const DefaultCacheTTL = 5 * time.Minute

// CacheVersion 是持久化快照的格式版本；字段变化时必须递增。
const CacheVersion = 1

// Options customizes catalog timing and scan behavior.
type Options struct {
	TTL   time.Duration
	Clock func() time.Time
	// CachePath 非空时把扫描快照持久化到该文件。Server 内存缓存只覆盖自身进程；
	// TAB 补全与 `aih app` 都是短生命周期进程，必须共享同一次平台扫描结果
	// （Windows 的 Shell AppsFolder 枚举可能需要数秒）。
	CachePath string
}

// Catalog caches platform application scans and satisfies launcher.Catalog.
type Catalog struct {
	platform  string
	supported bool
	ttl       time.Duration
	clock     func() time.Time
	scanFn    func(context.Context) ([]launcher.App, error)
	cachePath string

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
		cachePath: strings.TrimSpace(opts.CachePath),
	}
}

// CachePath 返回 CLI 与 Server 共享的平台快照路径。
func CachePath(aiHomeDir string) string {
	home := strings.TrimSpace(aiHomeDir)
	if home == "" {
		return ""
	}
	return filepath.Join(home, "run", "appcatalog", "apps.json")
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

		// 本进程还没扫描过：先复用其它进程（Server / 上一次 TAB）写下的快照。
		if snapshot, ok := c.loadPersisted(now); ok {
			return snapshot, nil
		}
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
		if snapshot, ok := c.loadPersisted(now); ok {
			return snapshot, nil
		}
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
	c.persist(normalized, scannedAt)
	return snap, nil
}

// cacheDocument 是跨进程共享的扫描快照；内部字段（DesktopID/Exec）不能丢，
// 否则 Linux 上从快照启动应用会缺少 Exec 命令。
type cacheDocument struct {
	Version       int        `json:"version"`
	Platform      string     `json:"platform"`
	GeneratedAtMs int64      `json:"generatedAtMs"`
	Apps          []cacheApp `json:"apps"`
}

type cacheApp struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	Subtitle     string   `json:"subtitle"`
	Path         string   `json:"path"`
	Kind         string   `json:"kind"`
	Icon         string   `json:"icon"`
	Terminal     bool     `json:"terminal,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
	ModifiedAtMs int64    `json:"modifiedAtMs,omitempty"`
	DesktopID    string   `json:"desktopId,omitempty"`
	Exec         string   `json:"exec,omitempty"`
}

// loadPersisted 读取未过期的跨进程快照；任何读/解析错误都退回真实扫描。
func (c *Catalog) loadPersisted(now time.Time) (launcher.CatalogSnapshot, bool) {
	if c == nil || c.cachePath == "" {
		return launcher.CatalogSnapshot{}, false
	}
	raw, err := os.ReadFile(c.cachePath)
	if err != nil {
		return launcher.CatalogSnapshot{}, false
	}
	var document cacheDocument
	if json.Unmarshal(raw, &document) != nil ||
		document.Version != CacheVersion ||
		document.Platform != c.platform ||
		document.GeneratedAtMs <= 0 {
		return launcher.CatalogSnapshot{}, false
	}
	generatedAt := time.UnixMilli(document.GeneratedAtMs)
	age := now.Sub(generatedAt)
	if age < 0 {
		age = 0
	}
	if age >= c.ttl {
		return launcher.CatalogSnapshot{}, false
	}
	apps := make([]launcher.App, 0, len(document.Apps))
	for _, entry := range document.Apps {
		apps = append(apps, launcher.App{
			ID:           entry.ID,
			Name:         entry.Name,
			Subtitle:     entry.Subtitle,
			Path:         entry.Path,
			Kind:         launcher.Kind(entry.Kind),
			Icon:         entry.Icon,
			Terminal:     entry.Terminal,
			Aliases:      append([]string(nil), entry.Aliases...),
			ModifiedAtMs: entry.ModifiedAtMs,
			DesktopID:    entry.DesktopID,
			Exec:         entry.Exec,
		})
	}

	c.stateMu.Lock()
	defer c.stateMu.Unlock()
	// 另一个 goroutine 可能已经完成扫描；内存里的结果更新，直接用它。
	if c.hasScanned && !c.generatedAt.IsZero() && now.Sub(c.generatedAt) < c.ttl {
		return c.snapshotLocked(), true
	}
	c.cached = apps
	c.generatedAt = generatedAt
	c.lastError = ""
	c.hasScanned = true
	return c.snapshotLocked(), true
}

// persist 原子写入快照；失败只影响下一次扫描成本，不影响本次结果。
func (c *Catalog) persist(apps []launcher.App, generatedAt time.Time) {
	if c == nil || c.cachePath == "" {
		return
	}
	document := cacheDocument{
		Version:       CacheVersion,
		Platform:      c.platform,
		GeneratedAtMs: generatedAt.UnixMilli(),
		Apps:          make([]cacheApp, 0, len(apps)),
	}
	for _, app := range apps {
		document.Apps = append(document.Apps, cacheApp{
			ID:           app.ID,
			Name:         app.Name,
			Subtitle:     app.Subtitle,
			Path:         app.Path,
			Kind:         string(app.Kind),
			Icon:         app.Icon,
			Terminal:     app.Terminal,
			Aliases:      append([]string(nil), app.Aliases...),
			ModifiedAtMs: app.ModifiedAtMs,
			DesktopID:    app.DesktopID,
			Exec:         app.Exec,
		})
	}
	raw, err := json.Marshal(document)
	if err != nil {
		return
	}
	directory := filepath.Dir(c.cachePath)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return
	}
	temporary, err := os.CreateTemp(directory, ".apps-*.json")
	if err != nil {
		return
	}
	temporaryPath := temporary.Name()
	if _, err := temporary.Write(raw); err != nil {
		_ = temporary.Close()
		_ = os.Remove(temporaryPath)
		return
	}
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return
	}
	_ = os.Chmod(temporaryPath, 0o644)
	if err := os.Rename(temporaryPath, c.cachePath); err != nil {
		_ = os.Remove(temporaryPath)
	}
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
