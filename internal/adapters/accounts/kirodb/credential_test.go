package kirodb

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

func createDatabase(t *testing.T, rows map[string]string) string {
	t.Helper()
	databasePath := filepath.Join(t.TempDir(), "data.sqlite3")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = database.Close()
	}()
	if _, err := database.Exec(`CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)`); err != nil {
		t.Fatal(err)
	}
	for key, value := range rows {
		if _, err := database.Exec(`INSERT INTO auth_kv(key, value) VALUES(?, ?)`, key, value); err != nil {
			t.Fatal(err)
		}
	}
	return databasePath
}

func authObject(t *testing.T, auth Auth) map[string]json.RawMessage {
	t.Helper()
	var object map[string]json.RawMessage
	if err := json.Unmarshal(auth.Raw, &object); err != nil || object == nil {
		t.Fatalf("auth JSON 无效: %v", err)
	}
	return object
}

func TestReadAuthUsesNodeSlotPriorityAndMergesMeta(t *testing.T) {
	databasePath := createDatabase(t, map[string]string{
		"kirocli:odic:token":   `{"access_token":"odic-access","refresh_token":"odic-refresh","region":"us-east-1","expires_at":"2026-01-01T00:00:00.000Z"}`,
		"kirocli:social:token": `{"access_token":"social-access","refresh_token":"social-refresh","provider":"google"}`,
		"aih:kiro:auth-meta":   `{"authMethod":"builder-id","access_token":"meta-must-not-win"}`,
	})
	auth, found, err := ReadAuth(context.Background(), databasePath)
	if err != nil || !found {
		t.Fatalf("ReadAuth = %+v, %v, %v", auth, found, err)
	}
	if auth.Slot != "kirocli:odic:token" || auth.Flavour != "odic" {
		t.Fatalf("命中槽位 = %q/%q", auth.Slot, auth.Flavour)
	}
	object := authObject(t, auth)
	if string(object["access_token"]) != `"odic-access"` {
		t.Fatalf("token 应覆盖 meta 的同名字段, got %s", object["access_token"])
	}
	if string(object["authMethod"]) != `"builder-id"` {
		t.Fatalf("meta 字段未合并, got %s", object["authMethod"])
	}
}

func TestReadAuthSkipsEmptySlotAndNormalizesAliases(t *testing.T) {
	databasePath := createDatabase(t, map[string]string{
		"kirocli:odic:token":   `{}`,
		"kirocli:social:token": `{"accessToken":"social-access","refreshToken":"social-refresh","provider":"github"}`,
	})
	auth, found, err := ReadAuth(context.Background(), databasePath)
	if err != nil || !found {
		t.Fatalf("ReadAuth = %+v, %v, %v", auth, found, err)
	}
	if auth.Slot != "kirocli:social:token" || auth.Flavour != "social" {
		t.Fatalf("命中槽位 = %q/%q", auth.Slot, auth.Flavour)
	}
	object := authObject(t, auth)
	if string(object["access_token"]) != `"social-access"` || string(object["refresh_token"]) != `"social-refresh"` {
		t.Fatalf("camelCase 未归一: %s", auth.Raw)
	}
	if _, exists := object["accessToken"]; exists {
		t.Fatal("归一后不应保留 camelCase 别名")
	}
}

func TestReadAuthMissingFileAndSymlink(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "data.sqlite3")
	auth, found, err := ReadAuth(context.Background(), missing)
	if err != nil || found || len(auth.Raw) != 0 {
		t.Fatalf("缺失文件应返回 found=false: %+v, %v, %v", auth, found, err)
	}

	databasePath := createDatabase(t, map[string]string{
		"kirocli:odic:token": `{"access_token":"a","refresh_token":"r"}`,
	})
	link := filepath.Join(t.TempDir(), "linked.sqlite3")
	if err := os.Symlink(databasePath, link); err != nil {
		t.Fatal(err)
	}
	if _, _, err := ReadAuth(context.Background(), link); !errors.Is(err, ErrInvalidDatabase) {
		t.Fatalf("symlink 必须 fail-closed, got %v", err)
	}
}

func TestReadAuthRejectsWrongSchema(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "data.sqlite3")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec(`CREATE TABLE not_auth_kv (key TEXT)`); err != nil {
		t.Fatal(err)
	}
	_ = database.Close()
	if _, _, err := ReadAuth(context.Background(), databasePath); !errors.Is(err, ErrInvalidDatabase) {
		t.Fatalf("schema 不符必须 fail-closed, got %v", err)
	}
}

func TestTokenBindingMatchesNodeVector(t *testing.T) {
	// 期望值由 Node 计算：
	// crypto.createHash('sha256').update(JSON.stringify([
	//   'https://codewhisperer.us-east-1.amazonaws.com', 'access<&>', 'refresh'
	// ])).digest('hex')
	// HTML 字符不转义，正好验证 SetEscapeHTML(false) 与 JSON.stringify 一致。
	auth := map[string]json.RawMessage{
		"access_token":  json.RawMessage(`"access<&>"`),
		"refresh_token": json.RawMessage(`"refresh"`),
	}
	const expected = "a0225bc0b7ae5a16df072f1937843bb12a99f744dc7c4ad8eb81fb13addbe863"
	if got := TokenBinding(auth); got != expected {
		t.Fatalf("tokenBinding = %q, want %q", got, expected)
	}
	// 缺 access、region 非法或字段带前后空白时不可比较，必须返回空串。
	if got := TokenBinding(map[string]json.RawMessage{"refresh_token": json.RawMessage(`"r"`)}); got != "" {
		t.Fatalf("缺 access 应返回空串, got %q", got)
	}
	if got := TokenBinding(map[string]json.RawMessage{
		"access_token": json.RawMessage(`"a"`),
		"region":       json.RawMessage(`"not-a-region"`),
	}); got != "" {
		t.Fatalf("非法 region 应返回空串, got %q", got)
	}
	if got := TokenBinding(map[string]json.RawMessage{
		"access_token": json.RawMessage(`" a"`),
	}); got != "" {
		t.Fatalf("带空白 access 应返回空串, got %q", got)
	}
}

func TestOpenReadOnlyEnforcesPragmas(t *testing.T) {
	databasePath := createDatabase(t, map[string]string{
		"kirocli:odic:token": `{"access_token":"a","refresh_token":"r"}`,
	})
	database, err := openReadOnly(databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = database.Close()
	}()
	var queryOnly int
	if err := database.QueryRow(`PRAGMA query_only`).Scan(&queryOnly); err != nil || queryOnly != 1 {
		t.Fatalf("PRAGMA query_only = %d, %v", queryOnly, err)
	}
	var busyTimeout int
	if err := database.QueryRow(`PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil || busyTimeout != busyTimeoutMillis {
		t.Fatalf("PRAGMA busy_timeout = %d, %v", busyTimeout, err)
	}
	if _, err := database.Exec(`DELETE FROM auth_kv`); err == nil || !strings.Contains(strings.ToLower(err.Error()), "readonly") {
		t.Fatalf("只读连接仍可写: %v", err)
	}
}
