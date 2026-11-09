package pluginstatestore

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

func TestCurrentRevisionReturnsSeededRevision(t *testing.T) {
	_, store := seedState(t, testAccountState)
	revision, err := store.CurrentRevision(context.Background())
	if err != nil {
		t.Fatalf("CurrentRevision() error = %v", err)
	}
	if revision != 0 {
		t.Fatalf("revision = %d, want 0", revision)
	}
}

func TestCurrentRevisionReadsNonZeroRevision(t *testing.T) {
	_, store := seedState(t, strings.Replace(testAccountState, `"revision": 0`, `"revision": 7`, 1))
	revision, err := store.CurrentRevision(context.Background())
	if err != nil {
		t.Fatalf("CurrentRevision() error = %v", err)
	}
	if revision != 7 {
		t.Fatalf("revision = %d, want 7", revision)
	}
}

func TestCurrentRevisionMissingDatabaseIsUnavailable(t *testing.T) {
	store, _ := newTestStore(t)
	_, err := store.CurrentRevision(context.Background())
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeStateUnavailable {
		t.Fatalf("error = %v, want plugin_state_unavailable", err)
	}
}

func TestCurrentRevisionMissingTableIsUnavailable(t *testing.T) {
	home := t.TempDir()
	database, err := sql.Open("sqlite", filepath.Join(home, DatabaseFileName))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := database.Exec("CREATE TABLE unrelated (id INTEGER PRIMARY KEY)"); err != nil {
		t.Fatalf("create: %v", err)
	}
	_ = database.Close()
	store, err := NewStore(home)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	_, err = store.CurrentRevision(context.Background())
	coded, ok := pluginerr.From(err)
	if !ok || coded.Code != plugincontrol.CodeStateUnavailable {
		t.Fatalf("error = %v, want plugin_state_unavailable", err)
	}
}
