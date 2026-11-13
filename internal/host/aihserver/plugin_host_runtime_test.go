package aihserver

import (
	"context"
	"net/http"
	"testing"
)

type stubPluginAuthorizer struct{}

func (stubPluginAuthorizer) Authorized(request *http.Request) bool { return true }

func TestNewLocalPluginHandlersWiresOperatorWithoutNodeURL(t *testing.T) {
	aiHomeDir := t.TempDir()
	bundle := newLocalPluginHandlers(localPluginHandlerOptions{
		ManagementAuthorizer: stubPluginAuthorizer{},
		ClientAuthorizer:     stubPluginAuthorizer{},
		AIHomeDir:            aiHomeDir,
		HostVersion:          "1.0.0",
	})
	if bundle.HostService == nil {
		t.Fatalf("expected non-nil HostService")
	}
	defer func() {
		if err := bundle.Close(); err != nil {
			t.Fatalf("Close failed: %v", err)
		}
	}()

	if bundle.Handlers.gate == nil || bundle.Handlers.projection == nil {
		t.Fatalf("expected gate and projection handlers to be initialized")
	}
	if bundle.Handlers.list == nil || bundle.Handlers.trust == nil || bundle.Handlers.control == nil {
		t.Fatalf("expected list, trust, and control handlers to be initialized locally")
	}
	if err := bundle.HostService.Start(context.Background()); err != nil {
		t.Fatalf("HostService.Start with empty state failed: %v", err)
	}
	status := bundle.HostService.Status(context.Background())
	if status.State != "idle" {
		t.Fatalf("expected idle state with 0 enabled plugins, got %s", status.State)
	}
}
