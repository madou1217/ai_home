package aihserver

import (
	"context"
	"io"
	"time"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/adapters/clipboardstore"
	"github.com/madou1217/ai_home/internal/transport/http/webuiclipboardapi"
)

// clipboardRuntime owns the clipboard SQLite store and domain service for the server lifecycle.
type clipboardRuntime struct {
	store   *clipboardstore.Store
	service *clipboard.Service
}

// Close releases the clipboard database pool cleanly.
func (r *clipboardRuntime) Close() error {
	if r == nil || r.store == nil {
		return nil
	}
	return r.store.Close()
}

// newClipboardRuntime wires clipboard storage, service, and management/WebUI HTTP routes.
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
	handler, err := webuiclipboardapi.NewHandler(dependencies.Authorizer, service)
	if err != nil {
		_ = store.Close()
		return nil, nil, err
	}
	runtime := &clipboardRuntime{
		store:   store,
		service: service,
	}
	// Management routes under /v1/management/webui/clipboard automatically get /v0/webui/clipboard
	// aliases via router.mountPublicManagementAliases. Sync routes remain management-only.
	routes := []webuiRoute{
		{Pattern: webuiclipboardapi.Path + "/items", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/items/", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/settings", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/status", Handler: handler},
		{Pattern: webuiclipboardapi.Path + "/sync/", Handler: handler, SkipPublicAlias: true},
	}
	return runtime, routes, nil
}

var _ io.Closer = (*clipboardRuntime)(nil)
