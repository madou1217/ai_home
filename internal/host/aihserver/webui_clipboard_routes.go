package aihserver

import (
	"context"
	"io"
	"net/http"
	"sync"
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

	if settings, err := service.GetSettings(ctx); err == nil {
		capture.SetEnabled(settings.CaptureEnabled)
	}

	handler, err := webuiclipboardapi.NewHandler(dependencies.Authorizer, service)
	if err != nil {
		_ = store.Close()
		return nil, nil, err
	}
	handler.Servers = serverProfiles.List
	handler.SyncRun = func(runCtx context.Context) error {
		return syncer.SyncOnce(runCtx)
	}
	handler.OnSettingsChanged = func(settings clipboard.Settings) {
		capture.SetEnabled(settings.CaptureEnabled)
		if settings.SyncEnabled && settings.SyncTargetProfileID != "" {
			syncer.Trigger()
		}
	}

	runCtx, runCancel := context.WithCancel(ctx)
	runtime := &clipboardRuntime{
		store:   store,
		service: service,
		capture: capture,
		syncer:  syncer,
		cancel:  runCancel,
	}
	runtime.wg.Add(2)
	go func() {
		defer runtime.wg.Done()
		capture.Run(runCtx)
	}()
	go func() {
		defer runtime.wg.Done()
		syncer.Run(runCtx)
	}()

	// Management routes under /v1/management/webui/clipboard automatically get /v0/webui/clipboard
	// aliases via router.mountPublicManagementAliases. Sync routes remain management-only.
	routes := []webuiRoute{
		{Pattern: webuiclipboardapi.Path + "/items", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/items/", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/settings", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/status", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/servers", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/sync-run", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/sync/", Handler: handler, SkipPublicAlias: true},
	}
	return runtime, routes, nil
}

var _ io.Closer = (*clipboardRuntime)(nil)
