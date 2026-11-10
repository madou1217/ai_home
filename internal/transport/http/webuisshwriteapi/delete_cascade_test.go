package webuisshwriteapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

const (
	workspaceID           = "ws_0123456789abcdef"
	unrelatedWorkspaceID  = "ws_fedcba9876543210"
	orphanWorkspaceID     = "ws_aaaaaaaaaaaaaaaa"
	untetheredWorkspaceID = "ws_bbbbbbbbbbbbbbbb"
)

func seedWorkspaces(t *testing.T, databasePath string, workspaces []map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(workspaces)
	if err != nil {
		t.Fatalf("marshal workspaces: %v", err)
	}
	if err := appstate.WriteKV(context.Background(), databasePath, workspacesKey, string(encoded), time.Now().UnixMilli()); err != nil {
		t.Fatalf("seed workspaces: %v", err)
	}
}

func readStoredWorkspaces(t *testing.T, databasePath string) []map[string]any {
	t.Helper()
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, workspacesKey)
	if err != nil {
		t.Fatalf("ReadKV(workspaces) error = %v", err)
	}
	if !found {
		t.Fatalf("ssh_workspaces missing")
	}
	var workspaces []map[string]any
	if err := json.Unmarshal([]byte(raw), &workspaces); err != nil {
		t.Fatalf("stored workspaces %q: %v", raw, err)
	}
	return workspaces
}

func workspaceIDs(workspaces []map[string]any) []string {
	ids := make([]string, 0, len(workspaces))
	for _, workspace := range workspaces {
		id, _ := workspace["id"].(string)
		ids = append(ids, id)
	}
	return ids
}

func TestDeleteCascadesOnlyMatchingWorkspaces(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{
		{"id": passwordConnectionID, "label": "a", "host": "10.0.0.1", "port": 22, "user": "dev", "authType": "agent"},
		{"id": keyConnectionID, "label": "b", "host": "10.0.0.2", "port": 22, "user": "dev", "authType": "agent", "egressConnectionId": passwordConnectionID},
	})
	seedWorkspaces(t, databasePath, []map[string]any{
		{"id": workspaceID, "connectionId": passwordConnectionID, "label": "dev", "remoteRoot": "/srv/app"},
		{"id": unrelatedWorkspaceID, "connectionId": keyConnectionID, "label": "keep", "remoteRoot": "/srv/keep", "extra": map[string]any{"pinned": true}},
		{"id": untetheredWorkspaceID, "connectionId": missingConnectionID, "label": "other", "remoteRoot": "/"},
	})

	recorder := doRequest(handler, http.MethodDelete, itemPath(passwordConnectionID), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}

	stored := readStoredConnections(t, databasePath)
	if len(stored) != 1 || stored[0]["id"] != keyConnectionID {
		t.Fatalf("connections = %#v", stored)
	}
	if stored[0]["egressConnectionId"] != "" {
		t.Fatalf("dangling egress = %#v", stored[0]["egressConnectionId"])
	}

	workspaces := readStoredWorkspaces(t, databasePath)
	if got := fmt.Sprint(workspaceIDs(workspaces)); got != fmt.Sprint([]string{unrelatedWorkspaceID, untetheredWorkspaceID}) {
		t.Fatalf("workspaces = %v", got)
	}
	extra, ok := workspaces[0]["extra"].(map[string]any)
	if !ok || extra["pinned"] != true {
		t.Fatalf("unknown field lost: %#v", workspaces[0])
	}
	if workspaces[1]["remoteRoot"] != "/" || workspaces[1]["label"] != "other" {
		t.Fatalf("untethered workspace changed: %#v", workspaces[1])
	}
}

func TestDeleteCascadeRollsBackBothKeysWhenWorkspacesCorrupt(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{
		{"id": passwordConnectionID, "label": "a", "host": "10.0.0.1", "port": 22, "user": "dev", "authType": "agent"},
	})
	connectionsBefore := readRawStored(t, databasePath)
	corrupt := `{"not":"array"}`
	if err := appstate.WriteKV(context.Background(), databasePath, workspacesKey, corrupt, 1); err != nil {
		t.Fatalf("seed corrupt workspaces: %v", err)
	}

	recorder := doRequest(handler, http.MethodDelete, itemPath(passwordConnectionID), "")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if failure := decodeFailure(t, recorder); failure.Error != "ssh_workspaces_invalid" {
		t.Fatalf("error = %q", failure.Error)
	}
	// 连接与工作区必须在同一事务里回滚：连接不能已经删掉。
	if raw := readRawStored(t, databasePath); raw != connectionsBefore {
		t.Fatalf("connections committed despite rollback: %s", raw)
	}
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, workspacesKey)
	if err != nil || !found {
		t.Fatalf("ReadKV(workspaces) found=%v err=%v", found, err)
	}
	if raw != corrupt {
		t.Fatalf("corrupt workspaces overwritten: %s", raw)
	}
}

func TestDeleteCascadeCreatesWorkspacesKeyWhenAbsent(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{
		{"id": passwordConnectionID, "label": "a", "host": "10.0.0.1", "port": 22, "user": "dev", "authType": "agent"},
	})
	recorder := doRequest(handler, http.MethodDelete, itemPath(passwordConnectionID), "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	if workspaces := readStoredWorkspaces(t, databasePath); len(workspaces) != 0 {
		t.Fatalf("workspaces = %#v", workspaces)
	}
}

func TestConcurrentDeletesCascadeWithoutLosingWorkspaces(t *testing.T) {
	handler, databasePath := newTestHandler(t)
	seedConnections(t, databasePath, []map[string]any{
		{"id": passwordConnectionID, "label": "a", "host": "10.0.0.1", "port": 22, "user": "dev", "authType": "agent"},
		{"id": keyConnectionID, "label": "b", "host": "10.0.0.2", "port": 22, "user": "dev", "authType": "agent"},
	})
	seedWorkspaces(t, databasePath, []map[string]any{
		{"id": workspaceID, "connectionId": passwordConnectionID, "label": "a", "remoteRoot": "/a"},
		{"id": unrelatedWorkspaceID, "connectionId": keyConnectionID, "label": "b", "remoteRoot": "/b"},
		{"id": orphanWorkspaceID, "connectionId": missingConnectionID, "label": "c", "remoteRoot": "/c"},
	})

	statuses := make(chan int, 2)
	var waitGroup sync.WaitGroup
	for _, id := range []string{passwordConnectionID, keyConnectionID} {
		waitGroup.Add(1)
		go func(target string) {
			defer waitGroup.Done()
			statuses <- doRequest(handler, http.MethodDelete, itemPath(target), "").Code
		}(id)
	}
	waitGroup.Wait()
	close(statuses)
	for status := range statuses {
		if status != http.StatusOK {
			t.Fatalf("concurrent delete status = %d", status)
		}
	}
	if stored := readStoredConnections(t, databasePath); len(stored) != 0 {
		t.Fatalf("connections = %#v", stored)
	}
	workspaces := readStoredWorkspaces(t, databasePath)
	if got := fmt.Sprint(workspaceIDs(workspaces)); got != fmt.Sprint([]string{orphanWorkspaceID}) {
		t.Fatalf("workspaces = %v", got)
	}
}

func TestDeleteConnectionAndWorkspacesReportsMissingKeys(t *testing.T) {
	root := t.TempDir()
	source, err := OpenSource(root)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	var sawConnections, sawWorkspaces KV
	err = source.DeleteConnectionAndWorkspaces(context.Background(), func(connections KV, workspaces KV) (string, string, error) {
		sawConnections, sawWorkspaces = connections, workspaces
		return "[]", "[]", nil
	})
	if err != nil {
		t.Fatalf("DeleteConnectionAndWorkspaces() error = %v", err)
	}
	if sawConnections.Found || sawWorkspaces.Found {
		t.Fatalf("found = %v/%v", sawConnections.Found, sawWorkspaces.Found)
	}
	databasePath, err := appstate.DatabasePath(root)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if workspaces := readStoredWorkspaces(t, databasePath); len(workspaces) != 0 {
		t.Fatalf("workspaces = %#v", workspaces)
	}
}
