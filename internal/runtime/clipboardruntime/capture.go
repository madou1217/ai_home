// Package clipboardruntime hosts the server-side clipboard capture loop.
package clipboardruntime

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/runtime/clipboardio"
)

const (
	defaultPollInterval           = 900 * time.Millisecond
	defaultSettingsReloadInterval = 2 * time.Second
	defaultDebounceWindow         = 2 * time.Second
	defaultPruneInterval          = time.Hour
	debounceRetentionWindow       = 10 * time.Second
)

// Capture polls the local OS clipboard when enabled and ingests snapshots into clipboard.Service.
type Capture struct {
	service                *clipboard.Service
	io                     clipboardio.Reader
	pollInterval           time.Duration
	settingsReloadInterval time.Duration
	debounceWindow         time.Duration
	pruneInterval          time.Duration
	clock                  func() time.Time

	mu           sync.Mutex
	capability   clipboardio.Capability
	enabled      bool
	active       bool
	lastHash     string
	recentHashes map[string]time.Time
	onIngest     func()
	wakeCh       chan struct{}
}

// NewCapture creates a Capture runtime bound to service and platform IO.
func NewCapture(service *clipboard.Service, reader clipboardio.Reader) *Capture {
	capStatus := clipboardio.Capability{Supported: false, Reason: "clipboard IO reader not configured"}
	if reader != nil {
		capStatus = reader.Probe()
	}
	return &Capture{
		service:                service,
		io:                     reader,
		pollInterval:           defaultPollInterval,
		settingsReloadInterval: defaultSettingsReloadInterval,
		debounceWindow:         defaultDebounceWindow,
		pruneInterval:          defaultPruneInterval,
		clock:                  time.Now,
		capability:             capStatus,
		recentHashes:           make(map[string]time.Time),
		wakeCh:                 make(chan struct{}, 1),
	}
}

// SetOnIngest registers a cheap callback fired after a successful local
// ingest, used by the syncer to start a priority metadata pass immediately.
func (c *Capture) SetOnIngest(fn func()) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.onIngest = fn
	c.mu.Unlock()
}

func (c *Capture) notifyIngest() {
	if c == nil {
		return
	}
	c.mu.Lock()
	fn := c.onIngest
	c.mu.Unlock()
	if fn != nil {
		fn()
	}
}

// SetEnabled toggles capture state immediately and wakes the run loop.
func (c *Capture) SetEnabled(enabled bool) {
	if c == nil {
		return
	}
	c.mu.Lock()
	c.enabled = enabled
	c.mu.Unlock()
	select {
	case c.wakeCh <- struct{}{}:
	default:
	}
}

// Status reports current capture capability and run state.
func (c *Capture) Status() clipboard.CaptureStatus {
	if c == nil {
		return clipboard.CaptureStatus{Supported: false, Reason: "capture runtime unavailable"}
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return clipboard.CaptureStatus{
		Enabled:   c.enabled,
		Supported: c.capability.Supported,
		Running:   c.active && c.enabled && c.capability.Supported,
		Reason:    c.capability.Reason,
	}
}

// CaptureStatus implements clipboard.RuntimeProbe.
func (c *Capture) CaptureStatus() clipboard.CaptureStatus {
	return c.Status()
}

// SyncStatus implements clipboard.RuntimeProbe.
func (c *Capture) SyncStatus() clipboard.SyncStatus {
	return clipboard.SyncStatus{}
}

// Transports implements clipboard.RuntimeProbe.
func (c *Capture) Transports() []clipboard.TransportStatus {
	return []clipboard.TransportStatus{}
}

// Run drives the clipboard polling and settings-reload loop until ctx is canceled.
func (c *Capture) Run(ctx context.Context) {
	if c == nil || c.service == nil || ctx == nil {
		return
	}
	c.reloadSettings(ctx)

	c.mu.Lock()
	c.active = true
	shouldPollInitially := c.enabled && c.capability.Supported
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.active = false
		c.mu.Unlock()
	}()

	if shouldPollInitially {
		c.pollOnce(ctx)
	}

	pollTicker := time.NewTicker(c.pollInterval)
	defer pollTicker.Stop()
	settingsTicker := time.NewTicker(c.settingsReloadInterval)
	defer settingsTicker.Stop()
	pruneTicker := time.NewTicker(c.pruneInterval)
	defer pruneTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-c.wakeCh:
			if c.canPoll() {
				c.pollOnce(ctx)
			}
		case <-settingsTicker.C:
			prev := c.isEnabled()
			c.reloadSettings(ctx)
			if !prev && c.canPoll() {
				c.pollOnce(ctx)
			}
		case <-pollTicker.C:
			if c.canPoll() {
				c.pollOnce(ctx)
			}
		case <-pruneTicker.C:
			pruneCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			_, _ = c.service.Prune(pruneCtx)
			cancel()
		}
	}
}

func (c *Capture) reloadSettings(ctx context.Context) {
	readCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	settings, err := c.service.GetSettings(readCtx)
	if err != nil {
		return
	}
	c.mu.Lock()
	c.enabled = settings.CaptureEnabled
	c.mu.Unlock()
}

func (c *Capture) isEnabled() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.enabled
}

func (c *Capture) canPoll() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.active && c.enabled && c.capability.Supported && c.io != nil
}

// pollOnce prefers richer payloads: file references, then images, then text.
// Text-first misclassified Finder/Linux file copies and browser "copy image"
// because those pasteboards also carry a filename/URL string.
func (c *Capture) pollOnce(ctx context.Context) {
	if c.io == nil {
		return
	}
	now := c.clock()

	// 1. File references (multi-file aware) win over their text shadow.
	rawFiles, ok, err := c.io.ReadFiles(ctx)
	files := clipboard.FilterIgnoredClipboardFiles(rawFiles)
	if err == nil && ok && len(rawFiles) > 0 && len(files) == 0 {
		// UU Remote's encrypted scratch files must not fall through to the
		// text/image readers and be captured through their shadow formats.
		return
	}
	if err == nil && ok && len(files) > 0 {
		canonical := canonicalFilesBytes(files)
		if len(canonical) > 0 {
			hash := hashBytes(canonical)
			if c.shouldSkip(hash, now) {
				return
			}
			if _, ingestErr := c.service.Ingest(ctx, clipboard.IngestInput{
				Kind:  clipboard.KindFile,
				Files: files,
			}); ingestErr == nil {
				c.recordSeen(hash, now)
				c.notifyIngest()
			}
			return
		}
	}

	// 2. Image bytes when no file reference exists.
	data, mime, ok, err := c.io.ReadImage(ctx, clipboard.MaxImageBytes)
	if err == nil && ok && len(data) > 0 {
		hash := hashBytes(data)
		if c.shouldSkip(hash, now) {
			return
		}
		if _, ingestErr := c.service.Ingest(ctx, clipboard.IngestInput{
			Kind: clipboard.KindImage,
			MIME: mime,
			Data: data,
		}); ingestErr == nil {
			c.recordSeen(hash, now)
			c.notifyIngest()
		}
		return
	}

	// 3. Plain text/link last.
	text, ok, err := c.io.ReadText(ctx, clipboard.MaxTextBytes)
	if err != nil {
		return
	}
	if ok && strings.TrimSpace(text) != "" {
		hash := hashBytes([]byte(text))
		if c.shouldSkip(hash, now) {
			return
		}
		if _, ingestErr := c.service.Ingest(ctx, clipboard.IngestInput{Text: text}); ingestErr == nil {
			c.recordSeen(hash, now)
			c.notifyIngest()
		}
	}
}

func (c *Capture) shouldSkip(hash string, now time.Time) bool {
	if hash == "" {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if hash == c.lastHash {
		return true
	}
	if prev, seen := c.recentHashes[hash]; seen && now.Sub(prev) < c.debounceWindow {
		return true
	}
	return false
}

func (c *Capture) recordSeen(hash string, now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastHash = hash
	c.recentHashes[hash] = now
	for k, ts := range c.recentHashes {
		if now.Sub(ts) > debounceRetentionWindow {
			delete(c.recentHashes, k)
		}
	}
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func canonicalFilesBytes(files []string) []byte {
	seen := make(map[string]struct{}, len(files))
	out := make([]string, 0, len(files))
	for _, raw := range files {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" {
			continue
		}
		abs, err := filepath.Abs(trimmed)
		if err != nil {
			continue
		}
		abs = filepath.Clean(abs)
		if _, dup := seen[abs]; dup {
			continue
		}
		seen[abs] = struct{}{}
		out = append(out, abs)
	}
	if len(out) == 0 {
		return nil
	}
	sort.Strings(out)
	return []byte(strings.Join(out, "\n"))
}

var _ clipboard.RuntimeProbe = (*Capture)(nil)
