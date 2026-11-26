package aihserver

import (
	"context"
	"io"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/adapters/clipboardstore"
	"github.com/madou1217/ai_home/internal/runtime/clipboardio"
	"github.com/madou1217/ai_home/internal/runtime/clipboardruntime"
	"github.com/madou1217/ai_home/internal/transport/http/webuiclipboardapi"
)

// clipboardRuntime owns the clipboard store, service, capture loop, and syncer.
type clipboardRuntime struct {
	store   *clipboardstore.Store
	service *clipboard.Service
	capture *clipboardruntime.Capture
	syncer  *clipboardruntime.Syncer
	cancel  context.CancelFunc
	wg      sync.WaitGroup

	desktopEnabled     atomic.Bool
	quickOrbitPosition atomic.Value
	hooksMu            sync.Mutex
	settingsHooks      []func()
}

// DesktopEnabled reports capture||sync for the native desktop shortcut.
func (r *clipboardRuntime) DesktopEnabled() bool {
	if r == nil {
		return false
	}
	return r.desktopEnabled.Load()
}

// QuickOrbitPosition returns the configured Quick Orbit anchor (bottom|left|right).
func (r *clipboardRuntime) QuickOrbitPosition() string {
	if r == nil {
		return clipboard.DefaultQuickOrbitPosition
	}
	if pos, ok := r.quickOrbitPosition.Load().(string); ok && pos != "" {
		return pos
	}
	return clipboard.DefaultQuickOrbitPosition
}

// AddSettingsHook registers a callback for clipboard settings changes, whether
// they arrive through the management API or are written by the CLI.
func (r *clipboardRuntime) AddSettingsHook(hook func()) {
	if r == nil || hook == nil {
		return
	}
	r.hooksMu.Lock()
	r.settingsHooks = append(r.settingsHooks, hook)
	r.hooksMu.Unlock()
}

func (r *clipboardRuntime) notifySettings(settings clipboard.Settings) {
	if r == nil {
		return
	}
	// HTTP PATCH and the 2s watcher both observe the same write; only notify
	// lifecycle hooks when desktop-relevant settings actually change.
	enabled := settings.CaptureEnabled || settings.SyncEnabled
	pos, valid := clipboard.NormalizeQuickOrbitPosition(settings.QuickOrbitPosition)
	if !valid {
		pos = clipboard.DefaultQuickOrbitPosition
	}
	enabledChanged := r.desktopEnabled.Swap(enabled) != enabled
	prevPos, _ := r.quickOrbitPosition.Swap(pos).(string)
	if !enabledChanged && prevPos == pos {
		return
	}
	r.hooksMu.Lock()
	hooks := append([]func(){}, r.settingsHooks...)
	r.hooksMu.Unlock()
	for _, hook := range hooks {
		hook()
	}
}

// Close stops background loops before closing the SQLite database pool.
func (r *clipboardRuntime) Close() error {
	if r == nil {
		return nil
	}
	if r.cancel != nil {
		r.cancel()
	}
	r.wg.Wait()
	if r.store == nil {
		return nil
	}
	return r.store.Close()
}

// newClipboardRuntime wires clipboard storage, service, capture, syncer, and HTTP routes.
func newClipboardRuntime(ctx context.Context, dependencies webuiRouteDependencies) (*clipboardRuntime, []webuiRoute, error) {
	store, err := clipboardstore.Open(ctx, dependencies.AIHomeDir)
	if err != nil {
		return nil, nil, err
	}
	service, err := clipboard.NewService(store, store.Blobs(), time.Now)
	if err != nil {
		_ = store.Close()
		return nil, nil, err
	}
	if _, err := service.EnsureDevice(ctx); err != nil {
		_ = store.Close()
		return nil, nil, err
	}

	serverProfiles := clipboardServerProfiles{home: dependencies.AIHomeDir}
	capture := clipboardruntime.NewCapture(service, clipboardio.NewSystem())
	syncer := clipboardruntime.NewSyncer(
		service,
		serverProfiles.Resolve,
		&http.Client{Timeout: 30 * time.Second, CheckRedirect: rejectOAuthRedirect},
		time.Now,
	)
	service.SetRuntimeProbe(clipboardruntime.NewProbe(capture, syncer))

	runCtx, runCancel := context.WithCancel(ctx)
	runtime := &clipboardRuntime{
		store:   store,
		service: service,
		capture: capture,
		syncer:  syncer,
		cancel:  runCancel,
	}
	runtime.quickOrbitPosition.Store(clipboard.DefaultQuickOrbitPosition)
	if settings, err := service.GetSettings(ctx); err == nil {
		capture.SetEnabled(settings.CaptureEnabled)
		runtime.desktopEnabled.Store(settings.CaptureEnabled || settings.SyncEnabled)
		if pos, valid := clipboard.NormalizeQuickOrbitPosition(settings.QuickOrbitPosition); valid {
			runtime.quickOrbitPosition.Store(pos)
		}
	}
	// Enforce retention on startup: short-lived/CLI-only hosts never hit the hourly tick.
	if pruneCtx, cancel := context.WithTimeout(ctx, 15*time.Second); true {
		_, _ = service.Prune(pruneCtx)
		cancel()
	}

	applySettings := func(settings clipboard.Settings) {
		capture.SetEnabled(settings.CaptureEnabled)
		if settings.SyncEnabled && settings.SyncTargetProfileID != "" {
			syncer.Trigger()
		}
		runtime.notifySettings(settings)
	}

	handler, err := webuiclipboardapi.NewHandler(dependencies.Authorizer, service)
	if err != nil {
		runCancel()
		_ = store.Close()
		return nil, nil, err
	}
	handler.Servers = serverProfiles.List
	handler.SyncRun = func(runCtx context.Context) error {
		return syncer.SyncOnce(runCtx)
	}
	handler.OnSettingsChanged = applySettings

	runtime.wg.Add(3)
	go func() {
		defer runtime.wg.Done()
		capture.Run(runCtx)
	}()
	go func() {
		defer runtime.wg.Done()
		syncer.Run(runCtx)
	}()
	// `aih clip enable|disable` and other writers bypass the HTTP handler; watch the
	// persisted flags so the desktop shortcut follows them without a restart.
	go func() {
		defer runtime.wg.Done()
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var last clipboard.Settings
		if settings, err := service.GetSettings(runCtx); err == nil {
			last = settings
		}
		for {
			select {
			case <-runCtx.Done():
				return
			case <-ticker.C:
				settings, err := service.GetSettings(runCtx)
				if err != nil {
					continue
				}
				if settings.CaptureEnabled == last.CaptureEnabled &&
					settings.SyncEnabled == last.SyncEnabled &&
					settings.SyncTargetProfileID == last.SyncTargetProfileID &&
					settings.QuickOrbitPosition == last.QuickOrbitPosition {
					last = settings
					continue
				}
				last = settings
				runtime.notifySettings(settings)
			}
		}
	}()

	// Management routes under /v1/management/webui/clipboard automatically get /v0/webui/clipboard
	// aliases via router.mountPublicManagementAliases. Sync routes remain management-only.
	routes := []webuiRoute{
		{Pattern: webuiclipboardapi.Path + "/items", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/items/", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/settings", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/status", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/events", Handler: handler, SkipPublicAlias: true},
		{Pattern: webuiclipboardapi.Path + "/servers", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/sync-run", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/sync/", Handler: handler, SkipPublicAlias: true},
	}
	return runtime, routes, nil
}

var _ io.Closer = (*clipboardRuntime)(nil)
