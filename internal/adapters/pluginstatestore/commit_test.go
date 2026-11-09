package pluginstatestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
	_ "modernc.org/sqlite"
)

const testAccountState = `{
  "schemaVersion": 1,
  "revision": 0,
  "installed": [{
    "pluginId": "echo",
    "version": "1.0.0",
    "digest": "digest-1",
    "artifact": "/tmp/accepted/digest-1.aih-plugin",
    "directory": "/tmp/extracted/digest-1",
    "manifest": {"pluginId":"echo","version":"1.0.0","contributes":[],"permissions":{"network":[],"filesystem":{"read":[],"write":[]},"secrets":[],"environment":[]}},
    "installedAt": 111,
    "signature": {"status":"unsigned"},
    "permissionsFingerprint": "fp-1",
    "createdAt": 42,
    "unknownField": {"keep": true}
  }],
  "instances": [],
  "generations": [{"generation": 9}],
  "activeGeneration": 9
}`

func seedState(t *testing.T, document string) (string, *Store) {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 1)`, ControlStateKey, document); err != nil {
		t.Fatalf("insert: %v", err)
	}
	_ = db.Close()
	store, err := NewStore(directory)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return directory, store
}

func candidateWith(t *testing.T, mutate func(map[string]any)) []byte {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(testAccountState), &document); err != nil {
		t.Fatalf("decode fixture: %v", err)
	}
	document["revision"] = 1
	mutate(document)
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	return encoded
}

func TestCommitEnablePreservesUnknownFields(t *testing.T) {
	directory, store := seedState(t, testAccountState)
	candidate := candidateWith(t, func(document map[string]any) {
		document["instances"] = []any{map[string]any{
			"instanceId":                     "echo",
			"pluginId":                       "echo",
			"version":                        "1.0.0",
			"enabled":                        true,
			"configuration":                  map[string]any{},
			"permissionsAcceptedAt":          1,
			"permissionsAcceptedFingerprint": "fp-1",
		}}
	})
	revision, err := store.Commit(context.Background(), plugincontrol.OperationEnable, 0, candidate)
	if err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	if revision != 1 {
		t.Fatalf("revision = %d, want 1", revision)
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer func() { _ = db.Close() }()
	var raw string
	if err := db.QueryRow(`SELECT value FROM app_kv WHERE key = ?`, ControlStateKey).Scan(&raw); err != nil {
		t.Fatalf("read: %v", err)
	}
	for _, marker := range []string{"digest-1", "/tmp/extracted/digest-1", "fp-1", "createdAt", "unknownField", "generations"} {
		if !strings.Contains(raw, marker) {
			t.Fatalf("状态丢失字段 %q: %s", marker, raw)
		}
	}
}

func TestCommitRejectsOperationOverreach(t *testing.T) {
	_, store := seedState(t, testAccountState)
	candidate := candidateWith(t, func(document map[string]any) {
		installed := document["installed"].([]any)
		record := installed[0].(map[string]any)
		record["digest"] = "digest-2"
	})
	_, err := store.Commit(context.Background(), plugincontrol.OperationEnable, 0, candidate)
	if coded, ok := pluginerr.From(err); !ok || coded.Code != plugincontrol.CodeStateInvalid {
		t.Fatalf("Commit() error = %v, want plugin_state_invalid", err)
	}
}

func TestCommitRevisionConflict(t *testing.T) {
	_, store := seedState(t, testAccountState)
	candidate := candidateWith(t, func(document map[string]any) {})
	_, err := store.Commit(context.Background(), plugincontrol.OperationEnable, 5, candidate)
	var conflict *plugincontrol.RevisionConflictError
	if !errors.As(err, &conflict) || conflict.Current != 0 {
		t.Fatalf("Commit() error = %v, want RevisionConflictError{0}", err)
	}
}

func TestCommitEnableWithoutDatabaseFailsClosed(t *testing.T) {
	directory := t.TempDir()
	store, err := NewStore(directory)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	_, err = store.Commit(context.Background(), plugincontrol.OperationEnable, 0, []byte(`{"schemaVersion":1,"revision":1,"installed":[],"instances":[],"generations":[]}`))
	if coded, ok := pluginerr.From(err); !ok || coded.Code != plugincontrol.CodeStateUnavailable {
		t.Fatalf("Commit() error = %v, want plugin_state_unavailable", err)
	}
}
