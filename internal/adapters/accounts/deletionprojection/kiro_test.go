package deletionprojection_test

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accounts/deletionprojection"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirodb"
	_ "modernc.org/sqlite"
)

func mustRawJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

func mustRawObject(t *testing.T, object map[string]json.RawMessage) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(object)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}

// kiroNativePayload 造一份 nativeaccount 能接受的 kiro 凭据：
// 身份只来自 identityEvidence，tokenBinding 必须绑定当前的 access/refresh。
func kiroNativePayload(t *testing.T, access, refresh, expiresAt string) string {
	t.Helper()
	auth := map[string]json.RawMessage{
		"access_token":  mustRawJSON(t, access),
		"refresh_token": mustRawJSON(t, refresh),
		"region":        mustRawJSON(t, "us-east-1"),
	}
	if expiresAt != "" {
		auth["expires_at"] = mustRawJSON(t, expiresAt)
	}
	document := map[string]json.RawMessage{
		"auth": mustRawObject(t, auth),
		"identityEvidence": mustRawObject(t, map[string]json.RawMessage{
			"version":      json.RawMessage("1"),
			"source":       mustRawJSON(t, "aws-codewhisperer:GetUsageLimits"),
			"endpoint":     mustRawJSON(t, "https://codewhisperer.us-east-1.amazonaws.com"),
			"subject":      mustRawJSON(t, "user-kiro-1"),
			"tokenBinding": mustRawJSON(t, "placeholder"),
			"observedAtMs": json.RawMessage("1700000000000"),
		}),
	}
	var authObject map[string]json.RawMessage
	if err := json.Unmarshal(document["auth"], &authObject); err != nil {
		t.Fatal(err)
	}
	if !kiro.RebindIdentityEvidence(document, authObject) {
		t.Fatal("重绑 kiro identityEvidence 失败")
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func createKiroDatabase(t *testing.T, root string, rows map[string]string) {
	t.Helper()
	if err := os.MkdirAll(root, 0o700); err != nil {
		t.Fatal(err)
	}
	databasePath := filepath.Join(root, "data.sqlite3")
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
}

// writeKiroProjectionExtras 覆盖调研清单里的全部私有落点：WAL/SHM、绑定指纹、
// 桌面 profile、运行时私有目录，以及指向 data.sqlite3 的 file symlink。
func writeKiroProjectionExtras(t *testing.T, root string) {
	t.Helper()
	writeFile(t, filepath.Join(root, "data.sqlite3-wal"), "wal")
	writeFile(t, filepath.Join(root, "data.sqlite3-shm"), "shm")
	writeFile(t, filepath.Join(root, ".aih-kiro-auth-binding"), "binding")
	writeFile(t, filepath.Join(root, "electron-user-data", "Default", "Cookies"), "cookie")
	writeFile(t, filepath.Join(root, "tmp", "model", "images", "a.png"), "png")
	writeFile(t, filepath.Join(root, ".config", "kiro", "settings.json"), "{}")
	writeFile(t, filepath.Join(root, ".local", "share", "kiro-cli", "state.json"), "state")
	writeFile(t, filepath.Join(root, "Library", "Keychains", "login.keychain-db"), "keychain")
	link := filepath.Join(root, "Library", "Application Support", "kiro-cli", "data.sqlite3")
	if err := os.MkdirAll(filepath.Dir(link), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "data.sqlite3"), link); err != nil {
		t.Fatal(err)
	}
}

func writeKiroHost(t *testing.T, hostHome string) {
	t.Helper()
	writeFile(t, filepath.Join(hostHome, ".kiro", "settings", "cli.json"), "host-kiro-settings")
	writeFile(t, filepath.Join(hostHome, ".kiro", "sessions", "s1", "state.json"), "host-kiro-session")
	writeFile(t, filepath.Join(hostHome, "Library", "Application Support", "kiro-cli", "data.sqlite3"), "host-native-database")
}

func kiroAuthRow(access, refresh, expiresAt string) string {
	row := fmt.Sprintf(`{"access_token":%q,"refresh_token":%q,"region":"us-east-1"`, access, refresh)
	if expiresAt != "" {
		row += fmt.Sprintf(`,"expires_at":%q`, expiresAt)
	}
	return row + "}"
}

type kiroDeletionRun struct {
	account     accountcore.Account
	credentials *memoryCredentialStore
	root        string
	hostHome    string
	hostBefore  hostSnapshot
	err         error
}

func runKiroDeletion(t *testing.T, storedPayload string, rows map[string]string) kiroDeletionRun {
	t.Helper()
	ctx := context.Background()
	aiHome := realDir(t)
	hostHome := realDir(t)
	catalog := mustCatalog(t)
	stored := mustNativeCredential(t, "kiro", storedPayload)
	account := mustAccount(t, catalog, stored)
	root := projectionRoot(aiHome, "kiro", account.Ref().String())
	createKiroDatabase(t, root, rows)
	writeKiroProjectionExtras(t, root)
	writeKiroHost(t, hostHome)
	hostBefore := snapshotTree(t, hostHome)

	snapshot, err := accountapp.NewCredentialSnapshot(
		account.Ref(), "kiro", stored, time.UnixMilli(1000).UTC(),
	)
	if err != nil {
		t.Fatal(err)
	}
	credentials := &memoryCredentialStore{snapshot: snapshot}
	preparer, err := deletionprojection.New(deletionprojection.Options{
		AIHomeDir:   aiHome,
		HostHomeDir: hostHome,
		Credentials: credentials,
		Clock:       func() time.Time { return time.UnixMilli(2000).UTC() },
	})
	if err != nil {
		t.Fatal(err)
	}
	return kiroDeletionRun{
		account:     account,
		credentials: credentials,
		root:        root,
		hostHome:    hostHome,
		hostBefore:  hostBefore,
		err:         preparer.PrepareAccountDeletion(ctx, account),
	}
}

func assertKiroHostUnchanged(t *testing.T, run kiroDeletionRun) {
	t.Helper()
	assertSnapshotsEqual(t, run.hostBefore, snapshotTree(t, run.hostHome))
}

func TestKiroDeletionAdoptsNewerSQLiteCredential(t *testing.T) {
	run := runKiroDeletion(t,
		kiroNativePayload(t, "old-access", "old-refresh", "2026-01-01T00:00:00.000Z"),
		map[string]string{
			"kirocli:odic:token": kiroAuthRow("new-access", "new-refresh", "2026-01-01T01:00:00.000Z"),
			"aih:kiro:auth-meta": `{"authMethod":"builder-id"}`,
		},
	)
	if run.err != nil {
		t.Fatalf("删除准备失败: %v", run.err)
	}
	if _, err := os.Lstat(run.root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("投影应被删除, lstat err = %v", err)
	}
	assertKiroHostUnchanged(t, run)
	if run.credentials.replacements != 1 {
		t.Fatalf("CAS 采纳次数 = %d, want 1", run.credentials.replacements)
	}
	current := run.credentials.snapshot.Credential().(*accountcore.NativeCredential)
	payload := string(current.Payload())
	if !strings.Contains(payload, "new-access") || strings.Contains(payload, "old-access") {
		t.Fatalf("数据库凭据未采纳投影的新 token: %s", payload)
	}
	// 采纳后的 tokenBinding 必须绑定新 token，否则 decoder 下次会拒绝整份凭据。
	var document map[string]json.RawMessage
	if err := json.Unmarshal(current.Payload(), &document); err != nil {
		t.Fatal(err)
	}
	var auth map[string]json.RawMessage
	if err := json.Unmarshal(document["auth"], &auth); err != nil {
		t.Fatal(err)
	}
	var evidence map[string]json.RawMessage
	if err := json.Unmarshal(document["identityEvidence"], &evidence); err != nil {
		t.Fatal(err)
	}
	var binding string
	if err := json.Unmarshal(evidence["tokenBinding"], &binding); err != nil {
		t.Fatal(err)
	}
	if binding != kirodb.TokenBinding(auth) {
		t.Fatalf("tokenBinding 未重绑: %q", binding)
	}
}

func TestKiroDeletionKeepsOlderSQLiteCredential(t *testing.T) {
	run := runKiroDeletion(t,
		kiroNativePayload(t, "db-access", "db-refresh", "2026-01-01T01:00:00.000Z"),
		map[string]string{
			"kirocli:odic:token": kiroAuthRow("stale-access", "stale-refresh", "2026-01-01T00:00:00.000Z"),
		},
	)
	if run.err != nil {
		t.Fatalf("删除准备失败: %v", run.err)
	}
	assertKiroHostUnchanged(t, run)
	if run.credentials.replacements != 0 {
		t.Fatalf("旧投影不应覆盖数据库, replacements = %d", run.credentials.replacements)
	}
	current := run.credentials.snapshot.Credential().(*accountcore.NativeCredential)
	if !strings.Contains(string(current.Payload()), "db-access") {
		t.Fatal("数据库凭据被旧投影改写")
	}
}

func TestKiroDeletionSkipsSameGrant(t *testing.T) {
	// access+refresh 相同就是 Node tokenBinding 的同一份 grant；expires_at 的
	// 秒级格式差异不应触发 CAS。
	run := runKiroDeletion(t,
		kiroNativePayload(t, "same-access", "same-refresh", "2026-01-01T00:00:00Z"),
		map[string]string{
			"kirocli:odic:token": kiroAuthRow("same-access", "same-refresh", "2026-01-01T00:00:00.000Z"),
		},
	)
	if run.err != nil {
		t.Fatalf("删除准备失败: %v", run.err)
	}
	assertKiroHostUnchanged(t, run)
	if run.credentials.replacements != 0 {
		t.Fatalf("同代凭据不应 CAS, replacements = %d", run.credentials.replacements)
	}
}

func TestKiroDeletionKeepsEqualGeneration(t *testing.T) {
	// 代际相同但 token 字节不同：无法证明投影更新，保留数据库版本。
	run := runKiroDeletion(t,
		kiroNativePayload(t, "db-access", "db-refresh", "2026-01-01T01:00:00Z"),
		map[string]string{
			"kirocli:odic:token": kiroAuthRow("other-access", "other-refresh", "2026-01-01T01:00:00.000Z"),
		},
	)
	if run.err != nil {
		t.Fatalf("删除准备失败: %v", run.err)
	}
	if _, err := os.Lstat(run.root); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("投影应被删除, lstat err = %v", err)
	}
	assertKiroHostUnchanged(t, run)
	if run.credentials.replacements != 0 {
		t.Fatalf("同代凭据不应 CAS, replacements = %d", run.credentials.replacements)
	}
	current := run.credentials.snapshot.Credential().(*accountcore.NativeCredential)
	if !strings.Contains(string(current.Payload()), "db-access") {
		t.Fatal("同代不同字节时不应改写数据库凭据")
	}
}

func TestKiroDeletionFailsClosedWhenGenerationsNotComparable(t *testing.T) {
	run := runKiroDeletion(t,
		kiroNativePayload(t, "db-access", "db-refresh", "2026-01-01T00:00:00.000Z"),
		map[string]string{
			// 没有 expires_at，access 也不是 JWT：两边都拿不到可排序的代际事实。
			"kirocli:odic:token": kiroAuthRow("unknown-access", "unknown-refresh", ""),
		},
	)
	if run.err == nil {
		t.Fatal("代际不可比较时必须 fail-closed")
	}
	assertKiroHostUnchanged(t, run)
	if run.credentials.replacements != 0 {
		t.Fatalf("不可比较时不应改写凭据, replacements = %d", run.credentials.replacements)
	}
	if _, err := os.Lstat(run.root); err != nil {
		t.Fatalf("失败时投影应保留, lstat err = %v", err)
	}
}
