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
	if SchemaVersion != 2 {
		t.Fatalf("SchemaVersion = %d, want 2", SchemaVersion)
	}
	if !strings.Contains(SchemaV1, fmt.Sprintf("PRAGMA application_id = %d;", ApplicationID)) {
		t.Fatal("SchemaV1 缺少规范 application_id")
	}
	if !strings.Contains(SchemaV1, "PRAGMA user_version = 1;") {
		t.Fatal("SchemaV1 缺少固定 v1 user_version")
	}
	if !strings.Contains(SchemaV2, fmt.Sprintf("PRAGMA user_version = %d;", SchemaVersion)) {
		t.Fatal("SchemaV2 缺少规范 user_version")
	}
}

func TestSchemaV2AddsAccountModelForwardAndReverseIndexes(t *testing.T) {
	t.Parallel()

	if strings.Count(SchemaV2, "CREATE TABLE account_models ") != 1 {
		t.Fatal("SchemaV2 应且只应声明一次 account_models")
	}
	for _, required := range []string{
		"PRIMARY KEY (account_ref, model_id)",
		"REFERENCES accounts(account_ref) ON DELETE CASCADE",
		"upstream_available INTEGER NOT NULL",
		"manual_policy TEXT NOT NULL",
		"CREATE INDEX idx_account_models_effective",
		"ON account_models (model_id, account_ref)",
		"manual_policy = 'force_enable'",
		"manual_policy = 'inherit' AND upstream_available = 1",
	} {
		if !strings.Contains(SchemaV2, required) {
			t.Fatalf("SchemaV2 缺少账号模型合同 %q", required)
		}
	}
	if strings.Contains(SchemaV2, "provider_id") {
		t.Fatal("账号模型关系不应冗余 Provider")
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
