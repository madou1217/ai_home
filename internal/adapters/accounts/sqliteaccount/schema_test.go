package sqliteaccount

import (
	"fmt"
	"strings"
	"testing"
)

func TestSchemaV1DeclaresExpectedDatabaseIdentity(t *testing.T) {
	t.Parallel()

	if ApplicationID != 0x41494831 {
		t.Fatalf("ApplicationID = %#x, want %#x", ApplicationID, 0x41494831)
	}
	if SchemaVersion != 1 {
		t.Fatalf("SchemaVersion = %d, want 1", SchemaVersion)
	}
	if !strings.Contains(SchemaV1, fmt.Sprintf("PRAGMA application_id = %d;", ApplicationID)) {
		t.Fatal("SchemaV1 缺少规范 application_id")
	}
	if !strings.Contains(SchemaV1, fmt.Sprintf("PRAGMA user_version = %d;", SchemaVersion)) {
		t.Fatal("SchemaV1 缺少规范 user_version")
	}
}

func TestSchemaV1KeepsMinimalAccountBoundary(t *testing.T) {
	t.Parallel()

	expectedTables := []string{
		"accounts",
		"account_credentials",
		"account_profiles",
	}
	for _, tableName := range expectedTables {
		declaration := "CREATE TABLE " + tableName + " "
		if strings.Count(SchemaV1, declaration) != 1 {
			t.Fatalf("SchemaV1 应且只应声明一次 %s", tableName)
		}
	}

	for _, forbidden := range []string{
		"app-state.db",
		"oauth_sessions",
		"account_runtime",
		"account_usage",
		"account_models",
		"account_jobs",
		"account_outbox",
		"schema_migrations",
	} {
		if strings.Contains(SchemaV1, forbidden) {
			t.Fatalf("SchemaV1 不应包含未获当前需求支持的结构 %q", forbidden)
		}
	}
}

func TestSchemaV1DefinesCoveringRoutingIndex(t *testing.T) {
	t.Parallel()

	expected := `CREATE INDEX idx_accounts_routing
  ON accounts (provider_id, account_ref, cli_account_id)
  WHERE enabled = 1;`
	if !strings.Contains(SchemaV1, expected) {
		t.Fatal("SchemaV1 缺少账号征召 covering partial index")
	}
}
