package chatruntime

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"

	_ "modernc.org/sqlite"
)

const (
	sqliteBusyTimeoutMS       = 5000
	legacyAgyMessageMigration = "agy_message_item_id_v1"
	legacyAgyNativeMigration  = "agy_message_native_item_id_v1"
)

var (
	legacyAgyIDRe    = regexp.MustCompile(`^agy_message(?:_(\d+))?$`)
	unsafeTurnCharRe = regexp.MustCompile(`[^A-Za-z0-9_-]`)
)

// Database 封装 app-state.db 上 Chat Runtime 专属的读写连接与串行写锁。
type Database struct {
	sqlDB *sql.DB
	path  string
	mu    sync.Mutex
	clock func() int64
}

// OpenDatabase 打开 app-state.db（若不存在则创建）并执行幂等 Chat Runtime 表结构初始化及迁移。
func OpenDatabase(ctx context.Context, dbPath string, clock func() int64) (*Database, error) {
	trimmed := strings.TrimSpace(dbPath)
	if trimmed == "" {
		return nil, NewError("chat_runtime_database_unavailable", http.StatusServiceUnavailable, nil)
	}
	if clock == nil {
		return nil, NewError("chat_runtime_clock_required", http.StatusInternalServerError, nil)
	}
	if err := os.MkdirAll(filepath.Dir(trimmed), 0o700); err != nil {
		return nil, &Error{
			Code:       "chat_runtime_database_unavailable",
			StatusCode: http.StatusServiceUnavailable,
			Message:    err.Error(),
			Cause:      err,
		}
	}

	fileURL := sqlitefile.URL(trimmed)
	q := fileURL.Query()
	q.Set("mode", "rwc")
	q.Set("_txlock", "immediate")
	q.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", sqliteBusyTimeoutMS))
	q.Add("_pragma", "foreign_keys(ON)")
	q.Add("_pragma", "synchronous(NORMAL)")
	fileURL.RawQuery = q.Encode()

	rawDB, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, &Error{
			Code:       "chat_runtime_database_unavailable",
			StatusCode: http.StatusServiceUnavailable,
			Message:    err.Error(),
			Cause:      err,
		}
	}
	// 单连接 + Go 互斥锁串行化同进程写事务，与 sqliteaccount / app-state 一致。
	rawDB.SetMaxOpenConns(1)
	rawDB.SetMaxIdleConns(1)
	if err := rawDB.PingContext(ctx); err != nil {
		_ = rawDB.Close()
		return nil, &Error{
			Code:       "chat_runtime_database_unavailable",
			StatusCode: http.StatusServiceUnavailable,
			Message:    err.Error(),
			Cause:      err,
		}
	}
	_, _ = rawDB.ExecContext(ctx, "PRAGMA journal_mode = WAL")
	hardenDBPermissions(trimmed)

	db := &Database{
		sqlDB: rawDB,
		path:  trimmed,
		clock: clock,
	}
	if err := db.withTx(ctx, func(tx *sql.Tx) error {
		return db.initSchemaAndMigrations(ctx, tx)
	}); err != nil {
		_ = rawDB.Close()
		return nil, err
	}
	return db, nil
}

// Close 关闭底层 SQLite 连接。
func (d *Database) Close() error {
	if d == nil || d.sqlDB == nil {
		return nil
	}
	return d.sqlDB.Close()
}

// Path 返回数据库文件路径。
func (d *Database) Path() string {
	if d == nil {
		return ""
	}
	return d.path
}

// withTx 以互斥 + BEGIN IMMEDIATE 执行写事务。
func (d *Database) withTx(ctx context.Context, fn func(tx *sql.Tx) error) error {
	if d == nil || d.sqlDB == nil {
		return NewError("chat_runtime_database_unavailable", http.StatusServiceUnavailable, nil)
	}
	d.mu.Lock()
	defer d.mu.Unlock()

	tx, err := d.sqlDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	if err := fn(tx); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	committed = true
	return nil
}

// withRead 串行访问底层单连接执行只读查询（避免在事务进行中交叉读连接）。
func (d *Database) withRead(ctx context.Context, fn func(db *sql.DB) error) error {
	if d == nil || d.sqlDB == nil {
		return NewError("chat_runtime_database_unavailable", http.StatusServiceUnavailable, nil)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	return fn(d.sqlDB)
}

func (d *Database) initSchemaAndMigrations(ctx context.Context, tx *sql.Tx) error {
	renamed, err := migrateSessionCredentialColumn(ctx, tx)
	if err != nil {
		return err
	}
	if renamed {
		if err := detachDuplicateNativeBindings(ctx, tx); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, chatRuntimeSchemaSQL); err != nil {
		return err
	}
	if err := migrateWorkspaceModePolicy(ctx, tx); err != nil {
		return err
	}
	if err := migrateNativeHistoryOrder(ctx, tx); err != nil {
		return err
	}
	if err := migrateLegacyAgyMessageItemIDs(ctx, tx, d.clock()); err != nil {
		return err
	}
	return migrateLegacyAgyNativeThreadItemIDs(ctx, tx, d.clock())
}

func tableExistsTx(ctx context.Context, tx *sql.Tx, name string) (bool, error) {
	var present int
	err := tx.QueryRowContext(ctx, `
		SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
	`, name).Scan(&present)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return present == 1, nil
}

func listTableColumnsTx(ctx context.Context, tx *sql.Tx, table string) (map[string]struct{}, error) {
	rows, err := tx.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols := make(map[string]struct{})
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull int
		var dflt sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &colType, &notNull, &dflt, &pk); err != nil {
			return nil, err
		}
		cols[name] = struct{}{}
	}
	return cols, rows.Err()
}

func migrateSessionCredentialColumn(ctx context.Context, tx *sql.Tx) (bool, error) {
	cols, err := listTableColumnsTx(ctx, tx, "chat_runtime_sessions")
	if err != nil {
		return false, err
	}
	_, hasOld := cols["account_ref"]
	_, hasNew := cols["execution_account_ref"]
	if !hasOld || hasNew {
		return false, nil
	}
	_, err = tx.ExecContext(ctx, `
		DROP INDEX IF EXISTS idx_chat_runtime_native_session;
		ALTER TABLE chat_runtime_sessions RENAME COLUMN account_ref TO execution_account_ref;
	`)
	return err == nil, err
}

func detachDuplicateNativeBindings(ctx context.Context, tx *sql.Tx) error {
	exists, err := tableExistsTx(ctx, tx, "chat_runtime_sessions")
	if err != nil || !exists {
		return err
	}
	_, err = tx.ExecContext(ctx, fmt.Sprintf(`
		DROP INDEX IF EXISTS idx_chat_runtime_native_session;
		WITH ranked AS (
			SELECT
				session_id,
				ROW_NUMBER() OVER (
					PARTITION BY provider, %[1]s
					ORDER BY updated_at DESC, created_at DESC, session_id DESC
				) AS native_identity_rank
			FROM chat_runtime_sessions
			WHERE %[1]s IS NOT NULL
		)
		UPDATE chat_runtime_sessions
		SET runtime_binding_json = json_remove(runtime_binding_json, '$.nativeSessionId'),
		    state = 'closed',
		    active_turn_json = NULL
		WHERE session_id IN (
			SELECT session_id FROM ranked WHERE native_identity_rank > 1
		);
	`, nativeSessionIDExpr))
	return err
}

func migrateWorkspaceModePolicy(ctx context.Context, tx *sql.Tx) error {
	exists, err := tableExistsTx(ctx, tx, "chat_runtime_sessions")
	if err != nil || !exists {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		UPDATE chat_runtime_sessions
		SET policy_json = json_remove(policy_json, '$.workspaceMode')
		WHERE CASE WHEN json_valid(policy_json)
			THEN json_type(policy_json, '$.workspaceMode') IS NOT NULL ELSE 0 END
	`)
	return err
}

func migrateNativeHistoryOrder(ctx context.Context, tx *sql.Tx) error {
	cols, err := listTableColumnsTx(ctx, tx, "chat_runtime_native_response_items")
	if err != nil {
		return err
	}
	if _, ok := cols["native_turn_id"]; !ok {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE chat_runtime_native_response_items ADD COLUMN native_turn_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return err
		}
	}
	if _, ok := cols["ordinal"]; !ok {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE chat_runtime_native_response_items ADD COLUMN ordinal INTEGER`); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `CREATE UNIQUE INDEX IF NOT EXISTS idx_chat_runtime_native_item_order ON chat_runtime_native_response_items(session_id, ordinal)`)
	return err
}

func migrationAppliedTx(ctx context.Context, tx *sql.Tx, id string) (bool, error) {
	var one int
	err := tx.QueryRowContext(ctx, `SELECT 1 FROM chat_runtime_migrations WHERE id = ?`, id).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return one == 1, nil
}

func migrateLegacyAgyMessageItemIDs(ctx context.Context, tx *sql.Tx, now int64) error {
	applied, err := migrationAppliedTx(ctx, tx, legacyAgyMessageMigration)
	if err != nil || applied {
		return err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT event_id, type, turn_id, item_id, payload_json
		FROM chat_runtime_events
		WHERE type IN (
			'timeline.item.started', 'timeline.item.updated',
			'timeline.item.completed', 'timeline.item.delta'
		) AND (
			item_id LIKE 'agy_message%' OR
			(item_id IS NULL AND payload_json LIKE '%"agy_message%')
		)
	`)
	if err != nil {
		return err
	}
	type candidate struct {
		eventID     string
		evType      string
		turnID      sql.NullString
		itemID      sql.NullString
		payloadJSON string
	}
	var list []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.eventID, &c.evType, &c.turnID, &c.itemID, &c.payloadJSON); err != nil {
			_ = rows.Close()
			return err
		}
		list = append(list, c)
	}
	_ = rows.Close()

	for _, c := range list {
		var payload map[string]any
		if err := json.Unmarshal([]byte(c.payloadJSON), &payload); err != nil || payload == nil {
			continue
		}
		itemMap, _ := payload["item"].(map[string]any)
		legacyID := strings.TrimSpace(c.itemID.String)
		if legacyID == "" && itemMap != nil {
			legacyID = strings.TrimSpace(asString(itemMap["id"]))
		}
		if legacyID == "" {
			legacyID = strings.TrimSpace(asString(payload["itemId"]))
		}
		m := legacyAgyIDRe.FindStringSubmatch(legacyID)
		if m == nil {
			continue
		}
		turnID := strings.TrimSpace(c.turnID.String)
		if turnID == "" && itemMap != nil {
			turnID = strings.TrimSpace(asString(itemMap["turnId"]))
		}
		if turnID == "" {
			turnID = strings.TrimSpace(asString(payload["turnId"]))
		}
		if turnID == "" {
			continue
		}
		idx := 0
		if m[1] != "" {
			if parsed, err := strconv.Atoi(m[1]); err == nil {
				idx = parsed
			}
		}
		nextID := fmt.Sprintf("agy_message_legacy_%s_%d", unsafeTurnCharRe.ReplaceAllString(turnID, "_"), idx)
		if c.evType == "timeline.item.delta" {
			if asString(payload["itemId"]) != legacyID {
				continue
			}
			payload["itemId"] = nextID
		} else {
			if itemMap == nil || asString(itemMap["id"]) != legacyID {
				continue
			}
			itemMap["id"] = nextID
		}
		encoded, err := json.Marshal(payload)
		if err != nil {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_events SET item_id = ?, payload_json = ? WHERE event_id = ?`, nextID, string(encoded), c.eventID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO chat_runtime_migrations (id, applied_at) VALUES (?, ?)`, legacyAgyMessageMigration, now)
	return err
}

func migrateLegacyAgyNativeThreadItemIDs(ctx context.Context, tx *sql.Tx, now int64) error {
	applied, err := migrationAppliedTx(ctx, tx, legacyAgyNativeMigration)
	if err != nil || applied {
		return err
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT session_id, native_turn_id, item_id, item_json
		FROM chat_runtime_native_thread_items
		WHERE item_id = 'agy_message' OR item_id GLOB 'agy_message_[0-9]*'
	`)
	if err != nil {
		return err
	}
	type candidate struct {
		sessionID    string
		nativeTurnID string
		itemID       string
		itemJSON     string
	}
	var list []candidate
	for rows.Next() {
		var c candidate
		if err := rows.Scan(&c.sessionID, &c.nativeTurnID, &c.itemID, &c.itemJSON); err != nil {
			_ = rows.Close()
			return err
		}
		list = append(list, c)
	}
	_ = rows.Close()

	for _, c := range list {
		m := legacyAgyIDRe.FindStringSubmatch(strings.TrimSpace(c.itemID))
		if m == nil {
			continue
		}
		var turnID sql.NullString
		err := tx.QueryRowContext(ctx, `
			SELECT turn_id FROM chat_runtime_events
			WHERE session_id = ? AND type = 'turn.phase.changed' AND payload_json LIKE ?
			ORDER BY seq LIMIT 1
		`, c.sessionID, fmt.Sprintf(`%%"nativeTurnId":"%s"%%`, c.nativeTurnID)).Scan(&turnID)
		if err != nil || strings.TrimSpace(turnID.String) == "" {
			continue
		}
		idx := 0
		if m[1] != "" {
			if parsed, err := strconv.Atoi(m[1]); err == nil {
				idx = parsed
			}
		}
		nextID := fmt.Sprintf("agy_message_legacy_%s_%d", unsafeTurnCharRe.ReplaceAllString(strings.TrimSpace(turnID.String), "_"), idx)
		var item map[string]any
		if err := json.Unmarshal([]byte(c.itemJSON), &item); err != nil || item == nil {
			continue
		}
		item["id"] = nextID
		encoded, err := json.Marshal(item)
		if err != nil {
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE chat_runtime_native_thread_items SET item_id = ?, item_json = ? WHERE session_id = ? AND item_id = ?`, nextID, string(encoded), c.sessionID, c.itemID); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO chat_runtime_migrations (id, applied_at) VALUES (?, ?)`, legacyAgyNativeMigration, now)
	return err
}

func hardenDBPermissions(dbPath string) {
	for _, p := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if info, err := os.Stat(p); err == nil && !info.IsDir() {
			_ = os.Chmod(p, 0o600)
		}
	}
}
