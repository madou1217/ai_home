// Package clipboardstore persists clipboard history, devices, settings, and sync state in aih.db.
package clipboardstore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/application/clipboard"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
)

const schema = `
CREATE TABLE IF NOT EXISTS clipboard_items (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  blob_path TEXT NOT NULL DEFAULT '',
  byte_size INTEGER NOT NULL DEFAULT 0,
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  preview TEXT NOT NULL DEFAULT '',
  thumbnail BLOB,
  files_json TEXT NOT NULL DEFAULT '[]',
  source_device TEXT NOT NULL DEFAULT '',
  source_app TEXT NOT NULL DEFAULT '',
  pinned INTEGER NOT NULL DEFAULT 0,
  deleted INTEGER NOT NULL DEFAULT 0,
  deleted_at_ms INTEGER NOT NULL DEFAULT 0,
  seen_count INTEGER NOT NULL DEFAULT 1,
  created_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  synced_at_ms INTEGER NOT NULL DEFAULT 0,
  remote_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS clipboard_items_recent ON clipboard_items(deleted, pinned DESC, last_seen_at_ms DESC);
CREATE INDEX IF NOT EXISTS clipboard_items_kind ON clipboard_items(deleted, kind, last_seen_at_ms DESC);

CREATE TABLE IF NOT EXISTS clipboard_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,
  last_seen_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clipboard_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clipboard_sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS clipboard_requests (
  sha256 TEXT PRIMARY KEY,
  requested_at_ms INTEGER NOT NULL
);
`

// Store implements clipboard.Store on top of aih.db.
type Store struct {
	db    *sql.DB
	blobs *BlobStore
}

// Open opens aih.db in WAL mode, initializes clipboard_* tables, and prepares the blob store.
func Open(ctx context.Context, aiHomeDir string) (*Store, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("clipboard_store_home_required")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("创建 AIH 数据目录失败: %w", err)
	}
	blobs, err := NewBlobStore(root)
	if err != nil {
		return nil, err
	}
	dbPath := businessdb.Path(root)
	if err := businessdb.CheckReady(ctx, dbPath); err != nil {
		return nil, err
	}
	fileURL := sqlitefile.URL(dbPath)
	query := fileURL.Query()
	query.Set("mode", "rwc")
	// Deferred read→write upgrades return SQLITE_BUSY_SNAPSHOT without retry.
	query.Set("_txlock", "immediate")
	query.Add("_pragma", "busy_timeout(5000)")
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(NORMAL)")
	fileURL.RawQuery = query.Encode()

	db, err := sql.Open("sqlite", fileURL.String())
	if err != nil {
		return nil, fmt.Errorf("打开剪贴板数据库失败: %w", err)
	}
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(30 * time.Minute)

	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化剪贴板表失败: %w", err)
	}
	// Additive migrations for existing databases; duplicate-column errors are ignored.
	for _, statement := range []string{
		`ALTER TABLE clipboard_items ADD COLUMN materialized INTEGER NOT NULL DEFAULT 1`,
		`ALTER TABLE clipboard_items ADD COLUMN remote_source TEXT NOT NULL DEFAULT ''`,
	} {
		_, _ = db.ExecContext(ctx, statement)
	}
	// The DB (and any WAL sidecar already present) holds plaintext and the sync
	// key; tighten after creation so a CLI-first open cannot leave 0644.
	for _, path := range []string{dbPath, dbPath + "-wal", dbPath + "-shm"} {
		if _, statErr := os.Stat(path); statErr == nil {
			_ = os.Chmod(path, 0o600)
		}
	}
	store := &Store{db: db, blobs: blobs}
	if err := store.ensureColumns(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("升级剪贴板表列失败: %w", err)
	}
	return store, nil
}

// Blobs returns the paired on-disk BlobStore.
func (s *Store) Blobs() *BlobStore {
	if s == nil {
		return nil
	}
	return s.blobs
}

// Close closes the underlying database pool.
func (s *Store) Close() error {
	if s == nil || s.db == nil {
		return nil
	}
	return s.db.Close()
}

func (s *Store) ensureColumns(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `PRAGMA table_info(clipboard_items)`)
	if err != nil {
		return err
	}
	columns := map[string]bool{}
	for rows.Next() {
		var cid int
		var name, colType string
		var notNull, pk int
		var defaultVal any
		if err := rows.Scan(&cid, &name, &colType, &notNull, &defaultVal, &pk); err != nil {
			_ = rows.Close()
			return err
		}
		columns[name] = true
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if !columns["deleted_at_ms"] {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE clipboard_items ADD COLUMN deleted_at_ms INTEGER NOT NULL DEFAULT 0`); err != nil {
			return err
		}
	}
	if !columns["file_hashes_json"] {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE clipboard_items ADD COLUMN file_hashes_json TEXT NOT NULL DEFAULT '[]'`); err != nil {
			return err
		}
	}
	return nil
}

// UpsertItem atomically inserts a new item or updates an existing SHA-256 entry.
func (s *Store) UpsertItem(ctx context.Context, item clipboard.Item) (clipboard.Item, bool, error) {
	filesJSON, err := encodeFilesJSON(item.Files)
	if err != nil {
		return clipboard.Item{}, false, err
	}
	hashesJSON, err := encodeFilesJSON(item.FileHashes)
	if err != nil {
		return clipboard.Item{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return clipboard.Item{}, false, err
	}
	defer func() { _ = tx.Rollback() }()

	const upsertSQL = `
INSERT INTO clipboard_items (
  id, sha256, kind, mime, text, blob_path, byte_size, width, height,
  preview, thumbnail, files_json, file_hashes_json, source_device, source_app,
  pinned, deleted, deleted_at_ms, seen_count, created_at_ms, last_seen_at_ms,
  synced_at_ms, remote_id, materialized, remote_source
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 1, ?, ?, ?, ?, ?, ?)
ON CONFLICT(sha256) DO UPDATE SET
  last_seen_at_ms = CASE
    WHEN excluded.last_seen_at_ms > clipboard_items.last_seen_at_ms THEN excluded.last_seen_at_ms
    ELSE clipboard_items.last_seen_at_ms
  END,
  seen_count = clipboard_items.seen_count + 1,
  deleted = 0,
  deleted_at_ms = 0,
  text = CASE WHEN excluded.materialized = 1 THEN excluded.text ELSE clipboard_items.text END,
  blob_path = CASE WHEN excluded.materialized = 1 THEN excluded.blob_path WHEN clipboard_items.blob_path = '' THEN excluded.blob_path ELSE clipboard_items.blob_path END,
  files_json = CASE WHEN excluded.materialized = 1 THEN excluded.files_json ELSE clipboard_items.files_json END,
  file_hashes_json = CASE WHEN excluded.file_hashes_json <> '[]' THEN excluded.file_hashes_json ELSE clipboard_items.file_hashes_json END,
  byte_size = CASE WHEN excluded.materialized = 1 THEN excluded.byte_size ELSE clipboard_items.byte_size END,
  materialized = CASE WHEN excluded.materialized = 1 THEN 1 ELSE clipboard_items.materialized END,
  preview = CASE WHEN excluded.preview <> '' THEN excluded.preview ELSE clipboard_items.preview END,
  remote_source = CASE WHEN excluded.remote_source <> '' THEN excluded.remote_source ELSE clipboard_items.remote_source END,
  thumbnail = CASE WHEN clipboard_items.thumbnail IS NULL OR length(clipboard_items.thumbnail) = 0 THEN excluded.thumbnail ELSE clipboard_items.thumbnail END,
  width = CASE WHEN clipboard_items.width = 0 THEN excluded.width ELSE clipboard_items.width END,
  height = CASE WHEN clipboard_items.height = 0 THEN excluded.height ELSE clipboard_items.height END,
  source_device = CASE WHEN excluded.source_device <> '' THEN excluded.source_device ELSE clipboard_items.source_device END,
  source_app = CASE WHEN excluded.source_app <> '' THEN excluded.source_app ELSE clipboard_items.source_app END,
  synced_at_ms = CASE WHEN clipboard_items.synced_at_ms > 0 THEN clipboard_items.synced_at_ms ELSE excluded.synced_at_ms END,
  remote_id = CASE WHEN excluded.remote_id <> '' THEN excluded.remote_id ELSE clipboard_items.remote_id END
`
	if _, err := tx.ExecContext(ctx, upsertSQL,
		item.ID,
		item.SHA256,
		string(item.Kind),
		item.MIME,
		item.Text,
		item.BlobPath,
		item.ByteSize,
		item.Width,
		item.Height,
		item.Preview,
		item.Thumbnail,
		filesJSON,
		hashesJSON,
		item.SourceDevice,
		item.SourceApp,
		boolToInt(item.Pinned),
		item.CreatedAtMs,
		item.LastSeenAtMs,
		item.SyncedAtMs,
		item.RemoteID,
		boolToInt(item.Materialized),
		item.RemoteSource,
	); err != nil {
		return clipboard.Item{}, false, err
	}

	persisted, found, err := queryFullItem(ctx, tx, `WHERE sha256 = ?`, item.SHA256)
	if err != nil {
		return clipboard.Item{}, false, err
	}
	if !found {
		return clipboard.Item{}, false, errors.New("clipboard_upsert_missing_row")
	}
	if err := tx.Commit(); err != nil {
		return clipboard.Item{}, false, err
	}
	deduplicated := persisted.ID != item.ID
	return persisted, deduplicated, nil
}

// ListItems returns lightweight item rows without loading large inline text or blobs.
func (s *Store) ListItems(ctx context.Context, filter clipboard.ListFilter) ([]clipboard.Item, error) {
	where := make([]string, 0, 4)
	args := make([]any, 0, 6)

	if !filter.IncludeDeleted {
		where = append(where, "deleted = 0")
	}
	if filter.Kind != "" {
		where = append(where, "kind = ?")
		args = append(args, string(filter.Kind))
	}
	if filter.BeforeMs > 0 {
		where = append(where, "last_seen_at_ms < ?")
		args = append(args, filter.BeforeMs)
	}
	if q := strings.TrimSpace(filter.Query); q != "" {
		pattern := "%" + escapeLike(strings.ToLower(q)) + "%"
		where = append(where, `(LOWER(preview) LIKE ? ESCAPE '\' OR LOWER(files_json) LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern)
	}

	limit := filter.Limit
	if limit <= 0 {
		limit = clipboard.DefaultListLimit
	}
	if limit > clipboard.MaxListLimit {
		limit = clipboard.MaxListLimit
	}

	var query strings.Builder
	query.WriteString(`
SELECT id, sha256, kind, mime, blob_path, byte_size, width, height,
       preview, thumbnail, files_json, file_hashes_json, source_device, source_app,
       pinned, deleted, deleted_at_ms, seen_count, created_at_ms, last_seen_at_ms,
       synced_at_ms, remote_id, materialized, remote_source
FROM clipboard_items`)
	if len(where) > 0 {
		query.WriteString(" WHERE ")
		query.WriteString(strings.Join(where, " AND "))
	}
	query.WriteString(" ORDER BY pinned DESC, last_seen_at_ms DESC, id ASC LIMIT ?")
	args = append(args, limit)

	rows, err := s.db.QueryContext(ctx, query.String(), args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]clipboard.Item, 0, minInt(limit, 32))
	for rows.Next() {
		item, scanErr := scanListItem(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return items, nil
}

// GetItemByID loads a full item row by exact ID.
func (s *Store) GetItemByID(ctx context.Context, id string) (clipboard.Item, bool, error) {
	// Deleted rows stay only as tombstones for a short retention window; they
	// must not be readable through detail/content or CLI paste.
	return queryFullItem(ctx, s.db, `WHERE id = ? AND deleted = 0`, id)
}

// GetItemByPrefix resolves a unique ID prefix across active items first, then all items.
// GetItemBySHA finds an item by its content hash (used to serve on-demand sync content).
func (s *Store) GetItemBySHA(ctx context.Context, sha string) (clipboard.Item, bool, error) {
	return queryFullItem(ctx, s.db, `WHERE sha256 = ? AND deleted = 0`, strings.ToLower(strings.TrimSpace(sha)))
}

// RequestContent records that a synced stub needs its full content from a peer.
func (s *Store) RequestContent(ctx context.Context, sha string, nowMs int64) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO clipboard_requests (sha256, requested_at_ms) VALUES (?, ?) ON CONFLICT(sha256) DO UPDATE SET requested_at_ms = excluded.requested_at_ms`, strings.ToLower(strings.TrimSpace(sha)), nowMs)
	return err
}

// ListContentRequests returns pending content hashes in request order.
func (s *Store) ListContentRequests(ctx context.Context, limit int) ([]string, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	rows, err := s.db.QueryContext(ctx, `SELECT sha256 FROM clipboard_requests ORDER BY requested_at_ms ASC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := make([]string, 0, limit)
	for rows.Next() {
		var sha string
		if err := rows.Scan(&sha); err != nil {
			return nil, err
		}
		out = append(out, sha)
	}
	return out, rows.Err()
}

// ClearContentRequest removes a fulfilled request.
func (s *Store) ClearContentRequest(ctx context.Context, sha string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM clipboard_requests WHERE sha256 = ?`, strings.ToLower(strings.TrimSpace(sha)))
	return err
}

func (s *Store) GetItemByPrefix(ctx context.Context, prefix string) (clipboard.Item, bool, error) {
	pattern := escapeLike(prefix) + "%"
	const query = fullItemSelect + ` WHERE deleted = 0 AND id LIKE ? ESCAPE '\' LIMIT 2`
	rows, err := s.db.QueryContext(ctx, query, pattern)
	if err != nil {
		return clipboard.Item{}, false, err
	}
	defer func() { _ = rows.Close() }()
	var matches []clipboard.Item
	for rows.Next() {
		item, scanErr := scanFullItem(rows)
		if scanErr != nil {
			return clipboard.Item{}, false, scanErr
		}
		matches = append(matches, item)
	}
	if err := rows.Err(); err != nil {
		return clipboard.Item{}, false, err
	}
	if len(matches) == 1 {
		return matches[0], true, nil
	}
	return clipboard.Item{}, false, nil
}

// GetItemByIndex returns the 1-based item ordered by pinned DESC, last_seen_at_ms DESC, deleted = 0.
func (s *Store) GetItemByIndex(ctx context.Context, oneBasedIndex int) (clipboard.Item, bool, error) {
	if oneBasedIndex < 1 {
		return clipboard.Item{}, false, nil
	}
	return queryFullItem(ctx, s.db, `WHERE deleted = 0 ORDER BY pinned DESC, last_seen_at_ms DESC, id ASC LIMIT 1 OFFSET ?`, oneBasedIndex-1)
}

// SetPinned updates pinned state and returns the updated item.
func (s *Store) SetPinned(ctx context.Context, id string, pinned bool) (clipboard.Item, bool, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE clipboard_items SET pinned = ? WHERE id = ? AND deleted = 0`, boolToInt(pinned), id)
	if err != nil {
		return clipboard.Item{}, false, err
	}
	affected, err := res.RowsAffected()
	if err != nil || affected == 0 {
		return clipboard.Item{}, false, err
	}
	return s.GetItemByID(ctx, id)
}

// SoftDelete marks an item deleted=1 without deleting its blob so ON CONFLICT(sha256) can resurrect it.
func (s *Store) SoftDelete(ctx context.Context, id string, deletedAtMs int64) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE clipboard_items SET deleted = 1, deleted_at_ms = ? WHERE id = ? AND deleted = 0`,
		deletedAtMs, id,
	)
	if err != nil {
		return false, err
	}
	affected, err := res.RowsAffected()
	return affected > 0, err
}

// SoftDeleteAll soft-deletes active items (unpinned only unless includePinned is true).
func (s *Store) SoftDeleteAll(ctx context.Context, includePinned bool, deletedAtMs int64) (int, error) {
	query := `UPDATE clipboard_items SET deleted = 1, deleted_at_ms = ? WHERE deleted = 0 AND pinned = 0`
	if includePinned {
		query = `UPDATE clipboard_items SET deleted = 1, deleted_at_ms = ? WHERE deleted = 0`
	}
	res, err := s.db.ExecContext(ctx, query, deletedAtMs)
	if err != nil {
		return 0, err
	}
	affected, err := res.RowsAffected()
	return int(affected), err
}

// Prune hard-deletes soft-deleted rows older than softDeleteCutoffMs plus expired/overflow unpinned rows,
// returning counts and orphaned blob paths safe to remove from disk.
func (s *Store) Prune(ctx context.Context, retentionCutoffMs int64, maxItems int, softDeleteCutoffMs int64) (clipboard.PruneStoreResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return clipboard.PruneStoreResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	candidateBlobs := map[string]struct{}{}
	collectBlobs := func(query string, args ...any) error {
		rows, qErr := tx.QueryContext(ctx, query, args...)
		if qErr != nil {
			return qErr
		}
		defer func() { _ = rows.Close() }()
		for rows.Next() {
			var blobPath string
			if scanErr := rows.Scan(&blobPath); scanErr != nil {
				return scanErr
			}
			if strings.TrimSpace(blobPath) != "" {
				candidateBlobs[blobPath] = struct{}{}
			}
		}
		return rows.Err()
	}

	var result clipboard.PruneStoreResult

	// 1. Hard-delete soft-deleted rows older than 7 days.
	const softCond = `deleted = 1 AND ((deleted_at_ms > 0 AND deleted_at_ms < ?) OR (deleted_at_ms = 0 AND last_seen_at_ms < ?))`
	if err := collectBlobs(`SELECT blob_path FROM clipboard_items WHERE `+softCond+` AND blob_path <> ''`, softDeleteCutoffMs, softDeleteCutoffMs); err != nil {
		return clipboard.PruneStoreResult{}, err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM clipboard_items WHERE `+softCond, softDeleteCutoffMs, softDeleteCutoffMs)
	if err != nil {
		return clipboard.PruneStoreResult{}, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		result.PurgedSoftDeleted = int(n)
	}

	// 2. Hard-delete expired unpinned rows.
	const expiredCond = `deleted = 0 AND pinned = 0 AND last_seen_at_ms < ?`
	if err := collectBlobs(`SELECT blob_path FROM clipboard_items WHERE `+expiredCond+` AND blob_path <> ''`, retentionCutoffMs); err != nil {
		return clipboard.PruneStoreResult{}, err
	}
	res, err = tx.ExecContext(ctx, `DELETE FROM clipboard_items WHERE `+expiredCond, retentionCutoffMs)
	if err != nil {
		return clipboard.PruneStoreResult{}, err
	}
	if n, _ := res.RowsAffected(); n > 0 {
		result.ExpiredItems = int(n)
	}

	// 3. Hard-delete unpinned overflow rows beyond maxItems.
	if maxItems > 0 {
		const overflowCond = `deleted = 0 AND pinned = 0 AND id NOT IN (
			SELECT id FROM clipboard_items WHERE deleted = 0 ORDER BY pinned DESC, last_seen_at_ms DESC, id ASC LIMIT ?
		)`
		if err := collectBlobs(`SELECT blob_path FROM clipboard_items WHERE `+overflowCond+` AND blob_path <> ''`, maxItems); err != nil {
			return clipboard.PruneStoreResult{}, err
		}
		res, err = tx.ExecContext(ctx, `DELETE FROM clipboard_items WHERE `+overflowCond, maxItems)
		if err != nil {
			return clipboard.PruneStoreResult{}, err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			result.OverflowItems = int(n)
		}
	}

	// 4. Filter candidate blobs to those no longer referenced by any remaining row.
	for blobPath := range candidateBlobs {
		var count int
		if err := tx.QueryRowContext(ctx, `SELECT COUNT(1) FROM clipboard_items WHERE blob_path = ?`, blobPath).Scan(&count); err != nil {
			return clipboard.PruneStoreResult{}, err
		}
		if count == 0 {
			result.OrphanBlobPaths = append(result.OrphanBlobPaths, blobPath)
		}
	}

	if err := tx.Commit(); err != nil {
		return clipboard.PruneStoreResult{}, err
	}
	return result, nil
}

// CountItems returns total active items and pinned active items.
func (s *Store) CountItems(ctx context.Context) (int, int, error) {
	var total, pinned int
	err := s.db.QueryRowContext(ctx,
		`SELECT COUNT(1), COALESCE(SUM(CASE WHEN pinned = 1 THEN 1 ELSE 0 END), 0) FROM clipboard_items WHERE deleted = 0`,
	).Scan(&total, &pinned)
	return total, pinned, err
}

// UpsertDevice records or refreshes a participating device.
func (s *Store) UpsertDevice(ctx context.Context, device clipboard.Device) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clipboard_devices (id, name, platform, last_seen_at_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  platform = excluded.platform,
  last_seen_at_ms = CASE
    WHEN excluded.last_seen_at_ms > clipboard_devices.last_seen_at_ms THEN excluded.last_seen_at_ms
    ELSE clipboard_devices.last_seen_at_ms
  END`,
		device.ID, device.Name, device.Platform, device.LastSeenAtMs,
	)
	return err
}

// ListDevices returns known devices ordered by most recently seen.
func (s *Store) ListDevices(ctx context.Context) ([]clipboard.Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, platform, last_seen_at_ms FROM clipboard_devices ORDER BY last_seen_at_ms DESC, id ASC`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	devices := make([]clipboard.Device, 0, 4)
	for rows.Next() {
		var d clipboard.Device
		if err := rows.Scan(&d.ID, &d.Name, &d.Platform, &d.LastSeenAtMs); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}

// GetSetting reads a single setting value.
func (s *Store) GetSetting(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM clipboard_settings WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// SetSetting upserts a setting key/value pair.
func (s *Store) SetSetting(ctx context.Context, key string, value string, updatedAtMs int64) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clipboard_settings (key, value, updated_at_ms) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
		key, value, updatedAtMs,
	)
	return err
}

// SetSettingIfAbsent inserts a setting only if the key does not exist yet, and returns the winning value.
func (s *Store) SetSettingIfAbsent(ctx context.Context, key string, value string, updatedAtMs int64) (string, error) {
	if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO clipboard_settings (key, value, updated_at_ms) VALUES (?, ?, ?)`,
		key, value, updatedAtMs,
	); err != nil {
		return "", err
	}
	persisted, found, err := s.GetSetting(ctx, key)
	if err != nil {
		return "", err
	}
	if !found {
		return value, nil
	}
	return persisted, nil
}

// GetAllSettings reads all key/value settings from clipboard_settings.
func (s *Store) GetAllSettings(ctx context.Context) (map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT key, value FROM clipboard_settings`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]string{}
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		out[k] = v
	}
	return out, rows.Err()
}

// GetSyncState reads a single sync state key.
func (s *Store) GetSyncState(ctx context.Context, key string) (string, bool, error) {
	var value string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM clipboard_sync_state WHERE key = ?`, key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return value, true, nil
}

// SetSyncState upserts a sync state key/value pair.
func (s *Store) SetSyncState(ctx context.Context, key string, value string, updatedAtMs int64) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO clipboard_sync_state (key, value, updated_at_ms) VALUES (?, ?, ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at_ms = excluded.updated_at_ms`,
		key, value, updatedAtMs,
	)
	return err
}

// ListUnsyncedItems returns full rows where synced_at_ms = 0 and deleted = 0, ordered oldest first.
func (s *Store) ListUnsyncedItems(ctx context.Context, limit int) ([]clipboard.Item, error) {
	if limit <= 0 {
		limit = clipboard.SyncBatchMaxItems
	}
	const query = fullItemSelect + ` WHERE synced_at_ms = 0 AND deleted = 0 ORDER BY last_seen_at_ms ASC, id ASC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]clipboard.Item, 0, minInt(limit, 32))
	for rows.Next() {
		item, scanErr := scanFullItem(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

// MarkItemsSynced sets synced_at_ms on unsynced rows matching ids.
func (s *Store) MarkItemsSynced(ctx context.Context, ids []string, atMs int64) error {
	cleaned := make([]string, 0, len(ids))
	for _, id := range ids {
		if trimmed := strings.TrimSpace(id); trimmed != "" {
			cleaned = append(cleaned, trimmed)
		}
	}
	if len(cleaned) == 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	stmt, err := tx.PrepareContext(ctx, `UPDATE clipboard_items SET synced_at_ms = ? WHERE id = ? AND synced_at_ms = 0`)
	if err != nil {
		return err
	}
	defer func() { _ = stmt.Close() }()

	for _, id := range cleaned {
		if _, execErr := stmt.ExecContext(ctx, atMs, id); execErr != nil {
			return execErr
		}
	}
	return tx.Commit()
}

// ListItemsSince returns full active rows with last_seen_at_ms > sinceMs, ordered oldest first.
func (s *Store) ListItemsSince(ctx context.Context, sinceMs int64, limit int) ([]clipboard.Item, error) {
	if limit <= 0 {
		limit = clipboard.SyncBatchMaxItems
	}
	const query = fullItemSelect + ` WHERE deleted = 0 AND last_seen_at_ms > ? ORDER BY last_seen_at_ms ASC, id ASC LIMIT ?`
	rows, err := s.db.QueryContext(ctx, query, sinceMs, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	items := make([]clipboard.Item, 0, minInt(limit, 32))
	for rows.Next() {
		item, scanErr := scanFullItem(rows)
		if scanErr != nil {
			return nil, scanErr
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

type rowQuerier interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

const fullItemSelect = `
SELECT id, sha256, kind, mime, text, blob_path, byte_size, width, height,
       preview, thumbnail, files_json, file_hashes_json, source_device, source_app,
       pinned, deleted, deleted_at_ms, seen_count, created_at_ms, last_seen_at_ms,
       synced_at_ms, remote_id, materialized, remote_source
FROM clipboard_items`

func queryFullItem(ctx context.Context, q rowQuerier, clause string, args ...any) (clipboard.Item, bool, error) {
	row := q.QueryRowContext(ctx, fullItemSelect+" "+clause, args...)
	item, err := scanFullItem(row)
	if errors.Is(err, sql.ErrNoRows) {
		return clipboard.Item{}, false, nil
	}
	if err != nil {
		return clipboard.Item{}, false, err
	}
	return item, true, nil
}

type rowScanner interface {
	Scan(dest ...any) error
}

func scanFullItem(scanner rowScanner) (clipboard.Item, error) {
	var item clipboard.Item
	var kind, filesJSON, hashesJSON string
	var pinned, deleted, materialized int
	if err := scanner.Scan(
		&item.ID,
		&item.SHA256,
		&kind,
		&item.MIME,
		&item.Text,
		&item.BlobPath,
		&item.ByteSize,
		&item.Width,
		&item.Height,
		&item.Preview,
		&item.Thumbnail,
		&filesJSON,
		&hashesJSON,
		&item.SourceDevice,
		&item.SourceApp,
		&pinned,
		&deleted,
		&item.DeletedAtMs,
		&item.SeenCount,
		&item.CreatedAtMs,
		&item.LastSeenAtMs,
		&item.SyncedAtMs,
		&item.RemoteID,
		&materialized,
		&item.RemoteSource,
	); err != nil {
		return clipboard.Item{}, err
	}
	item.Kind = clipboard.Kind(kind)
	item.Materialized = materialized != 0
	item.Pinned = pinned != 0
	item.Deleted = deleted != 0
	item.Files = decodeFilesJSON(filesJSON)
	item.FileHashes = decodeFilesJSON(hashesJSON)
	return item, nil
}

func scanListItem(scanner rowScanner) (clipboard.Item, error) {
	var item clipboard.Item
	var kind, filesJSON, hashesJSON string
	var pinned, deleted, materialized int
	if err := scanner.Scan(
		&item.ID,
		&item.SHA256,
		&kind,
		&item.MIME,
		&item.BlobPath,
		&item.ByteSize,
		&item.Width,
		&item.Height,
		&item.Preview,
		&item.Thumbnail,
		&filesJSON,
		&hashesJSON,
		&item.SourceDevice,
		&item.SourceApp,
		&pinned,
		&deleted,
		&item.DeletedAtMs,
		&item.SeenCount,
		&item.CreatedAtMs,
		&item.LastSeenAtMs,
		&item.SyncedAtMs,
		&item.RemoteID,
		&materialized,
		&item.RemoteSource,
	); err != nil {
		return clipboard.Item{}, err
	}
	item.Kind = clipboard.Kind(kind)
	item.Materialized = materialized != 0
	item.Pinned = pinned != 0
	item.Deleted = deleted != 0
	item.Files = decodeFilesJSON(filesJSON)
	item.FileHashes = decodeFilesJSON(hashesJSON)
	return item, nil
}

func encodeFilesJSON(files []string) (string, error) {
	if len(files) == 0 {
		return "[]", nil
	}
	raw, err := json.Marshal(files)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func decodeFilesJSON(raw string) []string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || trimmed == "[]" {
		return nil
	}
	var files []string
	if err := json.Unmarshal([]byte(trimmed), &files); err != nil {
		return nil
	}
	return files
}

func escapeLike(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `%`, `\%`)
	s = strings.ReplaceAll(s, `_`, `\_`)
	return s
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

var _ clipboard.Store = (*Store)(nil)
var _ clipboard.BlobStore = (*BlobStore)(nil)
