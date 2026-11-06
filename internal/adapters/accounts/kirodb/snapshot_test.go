package kirodb

import (
	"context"
	"database/sql"
	"encoding/json"
	"path/filepath"
	"testing"
)

// ReadSnapshot 必须从只读连接里拿到 VACUUM INTO 的完整副本，并且包含已提交
// 但尚未 checkpoint 的 WAL 页面——否则 CLI 常驻时采纳到的仍是旧 token。
func TestReadSnapshotIncludesCommittedWAL(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "data.sqlite3")
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = database.Close()
	}()
	if _, err := database.Exec("PRAGMA journal_mode = WAL"); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Exec("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatal(err)
	}
	const row = `{"access_token":"wal-access","refresh_token":"wal-refresh","region":"us-east-1"}`
	if _, err := database.Exec("INSERT INTO auth_kv(key, value) VALUES(?, ?)", "kirocli:odic:token", row); err != nil {
		t.Fatal(err)
	}

	snapshot, err := ReadSnapshot(context.Background(), databasePath)
	if err != nil {
		t.Fatalf("ReadSnapshot() error = %v", err)
	}
	if !snapshot.AuthFound || len(snapshot.Database) == 0 {
		t.Fatalf("快照为空: found=%v bytes=%d", snapshot.AuthFound, len(snapshot.Database))
	}
	var auth map[string]json.RawMessage
	if err := json.Unmarshal(snapshot.Auth.Raw, &auth); err != nil {
		t.Fatal(err)
	}
	if TokenBinding(auth) == "" {
		t.Fatal("快照中的 token 无法计算 tokenBinding")
	}
	var access string
	if err := json.Unmarshal(auth["access_token"], &access); err != nil || access != "wal-access" {
		t.Fatalf("快照 token = %q, want wal-access", access)
	}
}
