package webuisshapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/runtime/workspaceconnector"
)

type fakeConnectorWorkspaces struct{}

func (fakeConnectorWorkspaces) Find(context.Context, string) (workspaceconnector.Workspace, bool, error) {
	return workspaceconnector.Workspace{}, false, nil
}

func TestConnectorAgentTerminalRejectsAGYExplicitly(t *testing.T) {
	handler, err := NewConnectorAgentTerminalHandler(ConnectorAgentTerminalDependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Workspaces: fakeConnectorWorkspaces{},
		IssueToolToken: func(context.Context, string, time.Duration) (string, int64, error) {
			return "test-token", 0, nil
		},
	})
	if err != nil {
		t.Fatalf("NewConnectorAgentTerminalHandler() error = %v", err)
	}

	request := httptest.NewRequest(
		http.MethodPost,
		"/webui/workspace-connectors/ws-1/agent-terminal",
		strings.NewReader(`{"agent":"agy"}`),
	)
	request.SetPathValue("workspaceId", "ws-1")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d; body=%s", recorder.Code, http.StatusConflict, recorder.Body.String())
	}
	var payload struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(recorder.Body).Decode(&payload); err != nil {
		t.Fatalf("decode error response: %v", err)
	}
	if payload.OK || payload.Error != "agy_remote_workspace_unsupported" {
		t.Fatalf("unexpected error payload: %+v", payload)
	}
}
