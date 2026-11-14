package aihserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/sshhostbrowse"
	"github.com/madou1217/ai_home/internal/adapters/sshremote"
	"github.com/madou1217/ai_home/internal/runtime/pty"
	"github.com/madou1217/ai_home/internal/runtime/sshtunnel"
	"github.com/madou1217/ai_home/internal/runtime/terminalsession"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshhostbrowseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshprobeapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshreverseapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuisshwriteapi"
	"github.com/madou1217/ai_home/internal/transport/http/webuiterminalapi"
)

type sshRoutesTestAuthorizer struct{}

func (sshRoutesTestAuthorizer) Authorized(*http.Request) bool { return true }

func TestBuildWebUISSHExtraRoutesNoConflictAndCRUD(t *testing.T) {
	aiHomeDir := t.TempDir()
	hostHomeDir := t.TempDir()
	deps := webuiRouteDependencies{
		Authorizer:  sshRoutesTestAuthorizer{},
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
	}

	sshSource, err := webuisshapi.OpenSource(aiHomeDir)
	if err != nil {
		t.Fatalf("webuisshapi.OpenSource() error = %v", err)
	}
	sshConns, err := webuisshapi.NewHandler(webuisshapi.Dependencies{Authorizer: deps.Authorizer, Store: sshSource})
	if err != nil {
		t.Fatalf("webuisshapi.NewHandler() error = %v", err)
	}
	sshWorkspacesRead, err := webuisshapi.NewWorkspacesHandler(webuisshapi.Dependencies{Authorizer: deps.Authorizer}, sshSource, aiHomeDir)
	if err != nil {
		t.Fatalf("webuisshapi.NewWorkspacesHandler() error = %v", err)
	}
	sshSessionsRead, err := webuisshapi.NewSessionsHandler(webuisshapi.Dependencies{Authorizer: deps.Authorizer}, sshSource, nil)
	if err != nil {
		t.Fatalf("webuisshapi.NewSessionsHandler() error = %v", err)
	}
	sshProbeGet, err := webuisshprobeapi.NewHandler(webuisshprobeapi.Dependencies{
		Authorizer: deps.Authorizer, Connections: sshSource, Prober: sshremote.Prober{HomeDir: hostHomeDir},
	})
	if err != nil {
		t.Fatalf("webuisshprobeapi.NewHandler() error = %v", err)
	}
	sshBrowseGet, err := webuisshhostbrowseapi.NewHandler(webuisshhostbrowseapi.Dependencies{
		Authorizer: deps.Authorizer, Connections: sshSource, Runner: sshhostbrowse.Runner{HomeDir: hostHomeDir},
	})
	if err != nil {
		t.Fatalf("webuisshhostbrowseapi.NewHandler() error = %v", err)
	}
	tunnels := sshtunnel.New(hostHomeDir)
	defer tunnels.Close()
	sshReverse, err := webuisshreverseapi.NewHandler(webuisshreverseapi.Dependencies{
		Authorizer: deps.Authorizer, Connections: sshSource, Supervisor: tunnels,
	})
	if err != nil {
		t.Fatalf("webuisshreverseapi.NewHandler() error = %v", err)
	}
	sshWriteSource, err := webuisshwriteapi.OpenSource(aiHomeDir)
	if err != nil {
		t.Fatalf("webuisshwriteapi.OpenSource() error = %v", err)
	}
	sshWrite, err := webuisshwriteapi.NewHandler(webuisshwriteapi.Dependencies{Authorizer: deps.Authorizer, Store: sshWriteSource})
	if err != nil {
		t.Fatalf("webuisshwriteapi.NewHandler() error = %v", err)
	}

	mux := http.NewServeMux()
	for _, existing := range []webuiRoute{
		{Pattern: "GET " + webuisshapi.Path, Handler: sshConns},
		{Pattern: "GET " + webuisshapi.WorkspacesPath, Handler: sshWorkspacesRead},
		{Pattern: "GET " + webuisshapi.WorkspaceSessionsPath, Handler: sshSessionsRead},
		{Pattern: "GET " + webuisshprobeapi.Path, Handler: sshProbeGet},
		{Pattern: "GET " + webuisshhostbrowseapi.Path, Handler: sshBrowseGet},
		{Pattern: "GET " + webuisshreverseapi.Path, Handler: sshReverse},
		{Pattern: "GET " + webuisshreverseapi.WatchPath, Handler: sshReverse},
		{Pattern: "POST " + webuisshreverseapi.ReconcilePath, Handler: sshReverse},
		{Pattern: "POST " + webuisshreverseapi.Path + "/{connectionId}/reconnect", Handler: sshReverse},
		{Pattern: "POST " + webuisshwriteapi.CollectionPath, Handler: sshWrite},
		{Pattern: "PUT " + webuisshwriteapi.ItemPath, Handler: sshWrite},
		{Pattern: "DELETE " + webuisshwriteapi.ItemPath, Handler: sshWrite},
	} {
		mux.Handle(existing.Pattern, existing.Handler)
	}

	extraRoutes, err := buildWebUISSHExtraRoutes(deps)
	if err != nil {
		t.Fatalf("buildWebUISSHExtraRoutes() error = %v", err)
	}
	want := map[string]bool{
		"POST " + webuisshprobeapi.Path:                true,
		"POST " + webuisshhostbrowseapi.Path:           true,
		"POST " + webuisshwriteapi.WorkspacesPath:      true,
		"PUT " + webuisshwriteapi.WorkspaceItemPath:    true,
		"DELETE " + webuisshwriteapi.WorkspaceItemPath: true,
		"POST " + webuisshapi.WorkspaceTerminalPath:    true,
	}
	if len(extraRoutes) != len(want) {
		t.Fatalf("extraRoutes len = %d, want %d", len(extraRoutes), len(want))
	}
	for _, route := range extraRoutes {
		if !want[route.Pattern] {
			t.Fatalf("unexpected route pattern %q", route.Pattern)
		}
		delete(want, route.Pattern)
		mux.Handle(route.Pattern, route.Handler)
	}
	if len(want) != 0 {
		t.Fatalf("missing patterns: %v", want)
	}

	connReq := httptest.NewRequest(http.MethodPost, webuisshwriteapi.CollectionPath,
		bytes.NewBufferString(`{"label":"devbox","host":"10.0.0.10","user":"dev"}`))
	connRec := httptest.NewRecorder()
	mux.ServeHTTP(connRec, connReq)
	if connRec.Code != http.StatusOK {
		t.Fatalf("create conn status=%d body=%s", connRec.Code, connRec.Body.String())
	}
	var connResp struct {
		Connection struct {
			ID string `json:"id"`
		} `json:"connection"`
	}
	if err := json.Unmarshal(connRec.Body.Bytes(), &connResp); err != nil || connResp.Connection.ID == "" {
		t.Fatalf("decode conn = %v (%s)", err, connRec.Body.String())
	}

	wsReq := httptest.NewRequest(http.MethodPost, webuisshwriteapi.WorkspacesPath,
		bytes.NewBufferString(`{"connectionId":"`+connResp.Connection.ID+`","label":"api","remoteRoot":"/srv/api"}`))
	wsRec := httptest.NewRecorder()
	mux.ServeHTTP(wsRec, wsReq)
	if wsRec.Code != http.StatusOK {
		t.Fatalf("create workspace status=%d body=%s", wsRec.Code, wsRec.Body.String())
	}
	var wsResp struct {
		Workspace struct {
			ID string `json:"id"`
		} `json:"workspace"`
	}
	if err := json.Unmarshal(wsRec.Body.Bytes(), &wsResp); err != nil || wsResp.Workspace.ID == "" {
		t.Fatalf("decode workspace = %v (%s)", err, wsRec.Body.String())
	}

	putReq := httptest.NewRequest(http.MethodPut, webuisshwriteapi.WorkspacesPath+"/"+wsResp.Workspace.ID,
		bytes.NewBufferString(`{"label":"api-v2"}`))
	putRec := httptest.NewRecorder()
	mux.ServeHTTP(putRec, putReq)
	if putRec.Code != http.StatusOK {
		t.Fatalf("update workspace status=%d body=%s", putRec.Code, putRec.Body.String())
	}

	listReq := httptest.NewRequest(http.MethodGet, webuisshapi.WorkspacesPath, nil)
	listRec := httptest.NewRecorder()
	mux.ServeHTTP(listRec, listReq)
	if listRec.Code != http.StatusOK || !bytes.Contains(listRec.Body.Bytes(), []byte("api-v2")) {
		t.Fatalf("list workspaces status=%d body=%s", listRec.Code, listRec.Body.String())
	}

	probeReq := httptest.NewRequest(http.MethodPost, webuisshprobeapi.Path, bytes.NewBufferString(`{}`))
	probeRec := httptest.NewRecorder()
	mux.ServeHTTP(probeRec, probeReq)
	if probeRec.Code != http.StatusBadRequest {
		t.Fatalf("probe empty status=%d body=%s", probeRec.Code, probeRec.Body.String())
	}

	browseReq := httptest.NewRequest(http.MethodPost, webuisshhostbrowseapi.Path, bytes.NewBufferString(`{}`))
	browseRec := httptest.NewRecorder()
	mux.ServeHTTP(browseRec, browseReq)
	if browseRec.Code != http.StatusBadRequest {
		t.Fatalf("browse empty status=%d body=%s", browseRec.Code, browseRec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, webuisshwriteapi.WorkspacesPath+"/"+wsResp.Workspace.ID, nil)
	delRec := httptest.NewRecorder()
	mux.ServeHTTP(delRec, delReq)
	if delRec.Code != http.StatusOK {
		t.Fatalf("delete workspace status=%d body=%s", delRec.Code, delRec.Body.String())
	}
}

func TestBuildWebUISSHExtraRoutesWithTerminalAdapter(t *testing.T) {
	aiHomeDir := t.TempDir()
	hostHomeDir := t.TempDir()
	termSvc := terminalsession.NewService(pty.NewStarter(), terminalsession.Options{
		ExitRetention: 50 * time.Millisecond,
	})
	defer func() { _ = termSvc.Close() }()

	termHandler, err := webuiterminalapi.NewHandler(webuiterminalapi.Dependencies{
		Authorizer: sshRoutesTestAuthorizer{},
		Sessions:   termSvc,
		HomeDir:    hostHomeDir,
	})
	if err != nil {
		t.Fatalf("webuiterminalapi.NewHandler() error = %v", err)
	}

	routes, err := buildWebUISSHExtraRoutesWithPorts(webuiRouteDependencies{
		Authorizer:  sshRoutesTestAuthorizer{},
		AIHomeDir:   aiHomeDir,
		HostHomeDir: hostHomeDir,
	}, webUISSHPorts{
		TerminalHandler: termHandler,
	})
	if err != nil {
		t.Fatalf("buildWebUISSHExtraRoutesWithPorts() error = %v", err)
	}
	mux := http.NewServeMux()
	for _, route := range routes {
		mux.Handle(route.Pattern, route.Handler)
	}
	req := httptest.NewRequest(http.MethodPost, webuisshwriteapi.WorkspacesPath+"/ws_0123456789abcdef/terminal", bytes.NewBufferString(`{}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if _, statErr := os.Stat(filepath.Join(aiHomeDir, "run", "remote-workspaces", "ws_0123456789abcdef")); !os.IsNotExist(statErr) {
		t.Fatalf("unexpected shadow dir stat err = %v", statErr)
	}
}
