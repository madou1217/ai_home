package webuisshreverseapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
)

func TestWatchStreamsInitialTunnelSnapshot(t *testing.T) {
	supervisor := &stubSupervisor{status: []sshtunnel.Status{{ConnectionID: "c1", State: "open", RemotePort: 22022, LocalPort: 22}}}
	handler, _ := NewHandler(Dependencies{Authorizer: stubAuthorizer{ok: true}, Connections: stubConnections{}, Supervisor: supervisor})
	request := httptest.NewRequest(http.MethodGet, WatchPath, nil)
	ctx, cancel := context.WithCancel(request.Context())
	request = request.WithContext(ctx)
	recorder := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { handler.ServeHTTP(recorder, request); close(done) }()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(recorder.Body.String(), `"type":"tunnels"`) {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	cancel()
	<-done
	if !strings.Contains(recorder.Body.String(), `"connectionId":"c1"`) {
		t.Fatalf("body = %s", recorder.Body.String())
	}
}
