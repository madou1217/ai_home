package sqliteaccount

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

func TestAssignNodeCLIAlias(t *testing.T) {
	aliases := make(map[string]map[string]int64)

	// First assignment
	assignNodeCLIAlias(aliases, "opencode", "ref-1", 5)
	if got := aliases["opencode"]["ref-1"]; got != 5 {
		t.Fatalf("expected alias 5, got %d", got)
	}

	// Larger id should NOT overwrite smaller id
	assignNodeCLIAlias(aliases, "opencode", "ref-1", 10)
	if got := aliases["opencode"]["ref-1"]; got != 5 {
		t.Fatalf("expected alias to remain 5, got %d", got)
	}

	// Smaller id SHOULD overwrite larger id
	assignNodeCLIAlias(aliases, "opencode", "ref-1", 2)
	if got := aliases["opencode"]["ref-1"]; got != 2 {
		t.Fatalf("expected alias to update to 2, got %d", got)
	}
}

func TestReadNodeAccountLinks(t *testing.T) {
	ctx := context.Background()
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "test.db")

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer func() { _ = db.Close() }()

	// Table does not exist
	links := readNodeAccountLinks(ctx, db)
	if len(links) != 0 {
		t.Fatalf("expected empty links for missing table, got %v", links)
	}

	// Create table app_kv
	if _, err := db.ExecContext(ctx, `CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatalf("create app_kv error = %v", err)
	}

	// Empty key
	links = readNodeAccountLinks(ctx, db)
	if len(links) != 0 {
		t.Fatalf("expected empty links when key missing, got %v", links)
	}

	// Corrupted JSON
	if _, err := db.ExecContext(ctx, `INSERT INTO app_kv (key, value) VALUES (?, ?)`, "go-account-sync:state", "invalid-json"); err != nil {
		t.Fatalf("insert error = %v", err)
	}
	links = readNodeAccountLinks(ctx, db)
	if len(links) != 0 {
		t.Fatalf("expected empty links for invalid json, got %v", links)
	}

	// Valid JSON
	validJSON := `{"links":{"node-ref-1":{"goRef":"go-ref-1"},"node-ref-2":{"goRef":"go-ref-2"}}}`
	if _, err := db.ExecContext(ctx, `UPDATE app_kv SET value = ? WHERE key = ?`, validJSON, "go-account-sync:state"); err != nil {
		t.Fatalf("update error = %v", err)
	}
	links = readNodeAccountLinks(ctx, db)
	if len(links) != 2 || links["node-ref-1"] != "go-ref-1" || links["node-ref-2"] != "go-ref-2" {
		t.Fatalf("unexpected links: %v", links)
	}
}

func TestReadNodeCLIAliasesWithLinks(t *testing.T) {
	ctx := context.Background()
	aiHomeDir := t.TempDir()
	dbPath := filepath.Join(aiHomeDir, "app-state.db")

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	defer func() { _ = db.Close() }()

	if _, err := db.ExecContext(ctx, `
		CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT);
		CREATE TABLE account_cli_aliases (provider TEXT, account_ref TEXT, cli_account_id INTEGER);
	`); err != nil {
		t.Fatalf("create tables error = %v", err)
	}

	validJSON := `{"links":{"node-ref-1":{"goRef":"go-ref-1"}}}`
	if _, err := db.ExecContext(ctx, `INSERT INTO app_kv (key, value) VALUES (?, ?)`, "go-account-sync:state", validJSON); err != nil {
		t.Fatalf("insert app_kv error = %v", err)
	}

	if _, err := db.ExecContext(ctx, "INSERT INTO account_cli_aliases (provider, account_ref, cli_account_id) VALUES (?, ?, ?)", "opencode", "node-ref-1", 42); err != nil {
		t.Fatalf("insert aliases error = %v", err)
	}

	aliases := readNodeCLIAliases(ctx, aiHomeDir)
	if got := aliases["opencode"]["node-ref-1"]; got != 42 {
		t.Fatalf("expected node-ref-1 to have alias 42, got %d", got)
	}
	if got := aliases["opencode"]["go-ref-1"]; got != 42 {
		t.Fatalf("expected linked go-ref-1 to also have alias 42, got %d", got)
	}
}
