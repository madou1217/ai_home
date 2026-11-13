package webuisshwriteapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const testWorkspaceID = "ws_0123456789abcdef"

func newTestWorkspacesHandler(t *testing.T, onChanged func(context.Context)) (*WorkspacesHandler, string) {
	t.Helper()
	root := t.TempDir()
	source, err := OpenSource(root)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	handler, err := NewWorkspacesHandler(WorkspaceDependencies{
		Authorizer:          allowAll{},
		Store:               source,
		OnWorkspacesChanged: onChanged,
	})
	if err != nil {
		t.Fatalf("NewWorkspacesHandler() error = %v", err)
	}
	databasePath, err := appstate.DatabasePath(root)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	return handler, databasePath
}

func TestWorkspacesAuthAndMethodValidation(t *testing.T) {
	root := t.TempDir()
	source, err := OpenSource(root)
	if err != nil {
		t.Fatalf("OpenSource: %v", err)
	}
	unauth, err := NewWorkspacesHandler(WorkspaceDependencies{Authorizer: denyAll{}, Store: source})
	if err != nil {
		t.Fatalf("NewWorkspacesHandler: %v", err)
	}
	rec := doRequest(unauth, http.MethodPost, WorkspacesPath, `{}`)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}

	handler, _ := newTestWorkspacesHandler(t, nil)
	if rec := doRequest(handler, http.MethodGet, WorkspacesPath, ""); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET collection status = %d, want 405", rec.Code)
	}
	if rec := doRequest(handler, http.MethodPost, WorkspacesPath+"/"+testWorkspaceID, `{}`); rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST item status = %d, want 405", rec.Code)
	}
	if rec := doRequest(handler, http.MethodPut, WorkspacesPath+"/bad-id", `{}`); rec.Code != http.StatusBadRequest {
		t.Fatalf("PUT bad id status = %d, want 400", rec.Code)
	}
}

func TestWorkspacesCreateUpdateDeleteLifecycle(t *testing.T) {
	changedCount := 0
	handler, dbPath := newTestWorkspacesHandler(t, func(context.Context) {
		changedCount++
	})
	seedConnections(t, dbPath, []map[string]any{
		{"id": passwordConnectionID, "label": "prod", "host": "10.0.0.1", "user": "dev"},
		{"id": keyConnectionID, "label": "stage", "host": "10.0.0.2", "user": "dev"},
	})

	// Create
	rec := doRequest(handler, http.MethodPost, WorkspacesPath,
		`{"connectionId":"`+passwordConnectionID+`","label":"backend","remoteRoot":"/srv/backend"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("create status = %d body = %s", rec.Code, rec.Body.String())
	}
	var createResp workspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &createResp); err != nil {
		t.Fatalf("decode create: %v", err)
	}
	id, _ := createResp.Workspace["id"].(string)
	if !workspaceIDPattern.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
	if changedCount != 1 {
		t.Fatalf("changedCount = %d, want 1", changedCount)
	}

	// Inject unknown field directly to ensure PUT preserves it.
	stored := readStoredWorkspaces(t, dbPath)
	stored[0]["dialect"] = "posix"
	rawSeed, _ := json.Marshal(stored)
	if err := appstate.WriteKV(context.Background(), dbPath, workspacesKey, string(rawSeed), time.Now().UnixMilli()); err != nil {
		t.Fatalf("WriteKV: %v", err)
	}

	// Update
	rec = doRequest(handler, http.MethodPut, WorkspacesPath+"/"+id,
		`{"label":"backend-v2","connectionId":"`+keyConnectionID+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("update status = %d body = %s", rec.Code, rec.Body.String())
	}
	var updateResp workspaceResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &updateResp); err != nil {
		t.Fatalf("decode update: %v", err)
	}
	if updateResp.Workspace["label"] != "backend-v2" ||
		updateResp.Workspace["connectionId"] != keyConnectionID ||
		updateResp.Workspace["remoteRoot"] != "/srv/backend" ||
		updateResp.Workspace["dialect"] != "posix" {
		t.Fatalf("updated = %#v", updateResp.Workspace)
	}
	if changedCount != 2 {
		t.Fatalf("changedCount = %d, want 2", changedCount)
	}

	// Delete
	rec = doRequest(handler, http.MethodDelete, WorkspacesPath+"/"+id, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status = %d body = %s", rec.Code, rec.Body.String())
	}
	if len(readStoredWorkspaces(t, dbPath)) != 0 {
		t.Fatalf("expected empty workspaces after delete")
	}
	if changedCount != 3 {
		t.Fatalf("changedCount = %d, want 3", changedCount)
	}

	// Delete missing is idempotent and does not fire spurious change notification.
	rec = doRequest(handler, http.MethodDelete, WorkspacesPath+"/"+id, "")
	if rec.Code != http.StatusOK || changedCount != 3 {
		t.Fatalf("idempotent delete status=%d changedCount=%d", rec.Code, changedCount)
	}
}

func TestWorkspacesValidationErrors(t *testing.T) {
	handler, dbPath := newTestWorkspacesHandler(t, nil)
	seedConnections(t, dbPath, []map[string]any{
		{"id": passwordConnectionID, "label": "prod", "host": "10.0.0.1", "user": "dev"},
	})
	rawWS, _ := json.Marshal([]map[string]any{{
		"id": testWorkspaceID, "connectionId": passwordConnectionID, "label": "ws", "remoteRoot": "/srv",
	}})
	_ = appstate.WriteKV(context.Background(), dbPath, workspacesKey, string(rawWS), time.Now().UnixMilli())

	cases := []struct {
		method string
		path   string
		body   string
		status int
		code   string
	}{
		{http.MethodPost, WorkspacesPath, `{}`, http.StatusBadRequest, "missing_fields"},
		{http.MethodPost, WorkspacesPath, `{"connectionId":"conn_missing","label":"ws","remoteRoot":"/srv"}`, http.StatusBadRequest, "invalid_connection"},
		{http.MethodPost, WorkspacesPath, `{"connectionId":"` + passwordConnectionID + `","label":"ws\n","remoteRoot":"/srv"}`, http.StatusBadRequest, "invalid_fields"},
		{http.MethodPost, WorkspacesPath, `{"connectionId":"` + passwordConnectionID + `","label":"ws","remoteRoot":"/srv\u0000"}`, http.StatusBadRequest, "invalid_fields"},
		{http.MethodPut, WorkspacesPath + "/" + testWorkspaceID, `{"connectionId":"conn_missing"}`, http.StatusBadRequest, "invalid_connection"},
		{http.MethodPut, WorkspacesPath + "/" + testWorkspaceID, `{"label":""}`, http.StatusBadRequest, "invalid_fields"},
		{http.MethodPut, WorkspacesPath + "/ws_aaaaaaaaaaaaaaaa", `{"label":"x"}`, http.StatusNotFound, "not_found"},
	}
	for _, tc := range cases {
		rec := doRequest(handler, tc.method, tc.path, tc.body)
		if rec.Code != tc.status {
			t.Fatalf("%s %s status=%d want %d body=%s", tc.method, tc.path, rec.Code, tc.status, rec.Body.String())
		}
		if got := decodeFailure(t, rec).Error; got != tc.code {
			t.Fatalf("%s %s code=%q want %q", tc.method, tc.path, got, tc.code)
		}
	}
}

func TestConnectionsCallbacksAndIdentityHostValidation(t *testing.T) {
	homeDir := t.TempDir()
	sshDir := filepath.Join(homeDir, ".ssh")
	if err := os.MkdirAll(sshDir, 0o700); err != nil {
		t.Fatalf("mkdir .ssh: %v", err)
	}
	validKey := filepath.Join(sshDir, "id_test")
	if err := os.WriteFile(validKey, []byte("PRIVATE"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	outsideKey := filepath.Join(homeDir, "outside_key")
	if err := os.WriteFile(outsideKey, []byte("PRIVATE"), 0o600); err != nil {
		t.Fatalf("write outside key: %v", err)
	}

	root := t.TempDir()
	source, err := OpenSource(root)
	if err != nil {
		t.Fatalf("OpenSource: %v", err)
	}
	dbPath, _ := appstate.DatabasePath(root)
	connChanges := 0
	wsChanges := 0
	handler, err := NewHandler(Dependencies{
		Authorizer:  allowAll{},
		Store:       source,
		HostHomeDir: homeDir,
		OnConnectionsChanged: func(_ context.Context, raw []byte) {
			if len(raw) > 0 {
				connChanges++
			}
		},
		OnWorkspacesChanged: func(context.Context) {
			wsChanges++
		},
	})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}

	// Reject outside key with reason.
	rec := doRequest(handler, http.MethodPost, CollectionPath,
		`{"label":"prod","host":"10.0.0.1","user":"dev","authType":"key-file","identityFile":"`+filepath.ToSlash(outsideKey)+`"}`)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	failure := decodeFailure(t, rec)
	if failure.Error != "invalid_identity_file" || failure.Reason != "identity_file_outside_ssh_dir" {
		t.Fatalf("failure = %+v", failure)
	}

	// Accept valid key inside ~/.ssh and trigger OnConnectionsChanged.
	rec = doRequest(handler, http.MethodPost, CollectionPath,
		`{"label":"prod","host":"10.0.0.1","user":"dev","authType":"key-file","identityFile":"~/.ssh/id_test"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	conn := decodeConnection(t, rec)
	connID := conn["id"].(string)

	// Attach a workspace so cascade delete triggers OnWorkspacesChanged too.
	rawWS, _ := json.Marshal([]map[string]any{{
		"id": testWorkspaceID, "connectionId": connID, "label": "ws", "remoteRoot": "/srv",
	}})
	_ = appstate.WriteKV(context.Background(), dbPath, workspacesKey, string(rawWS), time.Now().UnixMilli())

	rec = doRequest(handler, http.MethodDelete, itemPath(connID), "")
	if rec.Code != http.StatusOK {
		t.Fatalf("delete status=%d body=%s", rec.Code, rec.Body.String())
	}
	if connChanges != 2 {
		t.Fatalf("connChanges = %d, want 2", connChanges)
	}
	if wsChanges != 1 {
		t.Fatalf("wsChanges = %d, want 1", wsChanges)
	}
	if !strings.Contains(string(rawWS), testWorkspaceID) {
		t.Fatal("sanity")
	}
}
