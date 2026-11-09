// Package pluginstatestore 是 plugins.control.v1 的 SQLite 事务存储。
//
// 事务边界与 Node state-store.js 一致：BEGIN IMMEDIATE → 读当前文档 → CAS 检查
// expectedRevision → mutator → revision+1 → UPSERT。区别只在进入事务前多了一层
// run/maintenance/access.sqlite 的读租约，维护期间写入 fail closed。
package pluginstatestore

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/application/plugincontrol"
	"github.com/madou1217/ai_home/internal/adapters/accountmaintenance"
	"github.com/madou1217/ai_home/internal/pluginerr"
)

const (
	// ControlStateKey 是 Node 插件控制面在 app_kv 里的键。
	ControlStateKey = "plugins.control.v1"
	// DatabaseFileName 是 Node app-state-store 的数据库文件名。
	DatabaseFileName = "app-state.db"
	// maxStateBytes 与 application/pluginruntime.MaxControlStateBytes 一致。
	maxStateBytes = 4 << 20
	// busyTimeoutMS 与 Node DEFAULT_BUSY_TIMEOUT_MS 一致。
	busyTimeoutMS = 5000
	// walSizeLimitBytes 与 Node WAL_SIZE_LIMIT_BYTES 一致。
	walSizeLimitBytes = 64 * 1024 * 1024
	privateFileMode   = 0o600
)

// Store 在 Node 的 app-state.db 上执行插件控制状态写事务。
type Store struct {
	aiHomeDir    string
	databasePath string
}

// NewStore 创建状态存储；空数据根拒绝创建。
func NewStore(aiHomeDir string) (*Store, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, pluginerr.New(plugincontrol.CodeStateUnavailable, "缺少 aiHomeDir")
	}
	absolute, err := filepath.Abs(root)
	if err != nil {
		return nil, pluginerr.New(plugincontrol.CodeStateUnavailable, "")
	}
	return &Store{aiHomeDir: absolute, databasePath: filepath.Join(absolute, DatabaseFileName)}, nil
}

// DatabasePath 返回 app-state.db 路径（诊断用）。
func (store *Store) DatabasePath() string {
	if store == nil {
		return ""
	}
	return store.databasePath
}

// Update 在维护读租约与 SQLite 事务内完成一次 CAS 写回。
func (store *Store) Update(
	ctx context.Context,
	mutate func(*plugincontrol.State) error,
	expectedRevision *int64,
) (plugincontrol.State, error) {
	if store == nil || mutate == nil {
		return plugincontrol.EmptyState(), pluginerr.New(plugincontrol.CodeStateUnavailable, "")
	}
	lease, err := accountmaintenance.Acquire(ctx, store.aiHomeDir)
	if err != nil {
		return plugincontrol.EmptyState(), err
	}
	defer lease.Close()
	database, err := sql.Open("sqlite", store.databasePath)
	if err != nil {
		return plugincontrol.EmptyState(), pluginerr.New(plugincontrol.CodeStateUnavailable, "")
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	defer func() { _ = database.Close() }()
	connection, err := database.Conn(ctx)
	if err != nil {
		return plugincontrol.EmptyState(), mapStateError(err)
	}
	defer func() { _ = connection.Close() }()
	for _, pragma := range []string{
		fmt.Sprintf("PRAGMA busy_timeout = %d", busyTimeoutMS),
		fmt.Sprintf("PRAGMA journal_size_limit = %d", walSizeLimitBytes),
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
	} {
		if _, err := connection.ExecContext(ctx, pragma); err != nil {
			return plugincontrol.EmptyState(), mapStateError(err)
		}
	}
	var journalMode string
	if err := connection.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
		return plugincontrol.EmptyState(), mapStateError(err)
	}
	hardenDatabaseFiles(store.databasePath)
	if _, err := connection.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS app_kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`); err != nil {
		return plugincontrol.EmptyState(), mapStateError(err)
	}
	hardenDatabaseFiles(store.databasePath)
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return plugincontrol.EmptyState(), mapStateError(err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = connection.ExecContext(context.Background(), "ROLLBACK")
		}
	}()
	current := plugincontrol.EmptyState()
	var encoded string
	err = connection.QueryRowContext(ctx,
		"SELECT value FROM app_kv WHERE key = ?", ControlStateKey).Scan(&encoded)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		current = plugincontrol.EmptyState()
	case err != nil:
		return plugincontrol.EmptyState(), mapStateError(err)
	default:
		decoded, decodeErr := decodeState([]byte(encoded))
		if decodeErr != nil {
			return plugincontrol.EmptyState(), decodeErr
		}
		current = decoded
	}
	if expectedRevision != nil && current.Revision != *expectedRevision {
		return plugincontrol.EmptyState(), pluginerr.New(plugincontrol.CodeRevisionConflict, "")
	}
	next := current.Clone()
	if err := mutate(&next); err != nil {
		return plugincontrol.EmptyState(), err
	}
	next = next.Normalize()
	next.Revision = current.Revision + 1
	serialized, err := encodeState(next)
	if err != nil {
		return plugincontrol.EmptyState(), pluginerr.New(plugincontrol.CodeStateInvalid, "")
	}
	if _, err := connection.ExecContext(ctx, `
		INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`, ControlStateKey, string(serialized), nowMillis()); err != nil {
		return plugincontrol.EmptyState(), mapStateError(err)
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return plugincontrol.EmptyState(), mapStateError(err)
	}
	committed = true
	return next, nil
}

// encodeState 逐字段写回，保留 Extra 的原始 JSON；已知字段仍按 Node 的顶层形状输出。
func encodeState(state plugincontrol.State) ([]byte, error) {
	document := map[string]json.RawMessage{}
	fields := map[string]any{
		"schemaVersion":    state.SchemaVersion,
		"revision":         state.Revision,
		"installed":        state.Installed,
		"instances":        state.Instances,
		"generations":      state.Generations,
		"activeGeneration": state.ActiveGeneration,
	}
	for key, value := range fields {
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, err
		}
		document[key] = encoded
	}
	for key, value := range state.Extra {
		if knownTopLevelField(key) {
			continue
		}
		document[key] = append(json.RawMessage(nil), value...)
	}
	return json.Marshal(document)
}

// Commit 以「候选原文」为唯一事实提交一次控制状态变更（P1 的 enable/disable 写入口）。
//
// 与 Update 的区别：mutator 不在 Go 执行，候选由 Node 计算后原样传入；Go 只做
// CAS、结构/操作边界校验与落盘，绝不重排或丢弃未建模字段（artifact/directory/
// permissionsFingerprint/createdAt/generations 等）。
func (store *Store) Commit(
	ctx context.Context,
	operation plugincontrol.Operation,
	expectedRevision int64,
	candidate []byte,
) (int64, error) {
	if store == nil || len(candidate) == 0 {
		return 0, pluginerr.New(plugincontrol.CodeStateUnavailable, "")
	}
	lease, err := accountmaintenance.Acquire(ctx, store.aiHomeDir)
	if err != nil {
		return 0, err
	}
	defer lease.Close()

	// enable/disable 必须已有库与表；install 沿用 Node 的建库建表语义。
	if operation != plugincontrol.OperationInstall {
		if _, statErr := os.Stat(store.databasePath); statErr != nil {
			return 0, pluginerr.New(plugincontrol.CodeStateUnavailable, "")
		}
	}
	database, err := sql.Open("sqlite", store.databasePath)
	if err != nil {
		return 0, pluginerr.New(plugincontrol.CodeStateUnavailable, "")
	}
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)
	defer func() { _ = database.Close() }()
	connection, err := database.Conn(ctx)
	if err != nil {
		return 0, mapStateError(err)
	}
	defer func() { _ = connection.Close() }()
	for _, pragma := range []string{
		fmt.Sprintf("PRAGMA busy_timeout = %d", busyTimeoutMS),
		fmt.Sprintf("PRAGMA journal_size_limit = %d", walSizeLimitBytes),
		"PRAGMA synchronous = NORMAL",
		"PRAGMA foreign_keys = ON",
	} {
		if _, err := connection.ExecContext(ctx, pragma); err != nil {
			return 0, mapStateError(err)
		}
	}
	var journalMode string
	if err := connection.QueryRowContext(ctx, "PRAGMA journal_mode = WAL").Scan(&journalMode); err != nil {
		return 0, mapStateError(err)
	}
	hardenDatabaseFiles(store.databasePath)
	if operation == plugincontrol.OperationInstall {
		if _, err := connection.ExecContext(ctx, `
			CREATE TABLE IF NOT EXISTS app_kv (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			)
		`); err != nil {
			return 0, mapStateError(err)
		}
		hardenDatabaseFiles(store.databasePath)
	}
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return 0, mapStateError(err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = connection.ExecContext(context.Background(), "ROLLBACK")
		}
	}()

	var currentRaw []byte
	currentRevision := int64(0)
	var encoded string
	readErr := connection.QueryRowContext(ctx,
		"SELECT value FROM app_kv WHERE key = ?", ControlStateKey).Scan(&encoded)
	switch {
	case errors.Is(readErr, sql.ErrNoRows):
		if operation != plugincontrol.OperationInstall {
			return 0, pluginerr.New(plugincontrol.CodeStateUnavailable, "")
		}
	case readErr != nil:
		if strings.Contains(strings.ToLower(readErr.Error()), "no such table") {
			return 0, pluginerr.New(plugincontrol.CodeStateUnavailable, "")
		}
		return 0, mapStateError(readErr)
	default:
		currentRaw = []byte(encoded)
		decoded, decodeErr := decodeState(currentRaw)
		if decodeErr != nil {
			return 0, decodeErr
		}
		currentRevision = decoded.Revision
	}
	if currentRevision != expectedRevision {
		return 0, &plugincontrol.RevisionConflictError{Current: currentRevision}
	}
	if err := plugincontrol.ValidateCandidate(currentRaw, candidate, operation, expectedRevision); err != nil {
		return 0, err
	}
	if _, err := connection.ExecContext(ctx, `
		INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
	`, ControlStateKey, string(candidate), nowMillis()); err != nil {
		return 0, mapStateError(err)
	}
	if _, err := connection.ExecContext(ctx, "COMMIT"); err != nil {
		return 0, mapStateError(err)
	}
	committed = true
	return expectedRevision + 1, nil
}

func decodeState(data []byte) (plugincontrol.State, error) {
	if len(data) == 0 || len(data) > maxStateBytes {
		return plugincontrol.EmptyState(), pluginerr.New(plugincontrol.CodeStateInvalid, "")
	}
	if !json.Valid(data) {
		return plugincontrol.EmptyState(), pluginerr.New(plugincontrol.CodeStateInvalid, "")
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(data, &document); err != nil {
		// JSON 合法但不是对象：Node 的 normalizeState 会把它当空文档。
		return plugincontrol.EmptyState(), nil
	}
	state := plugincontrol.EmptyState()
	state.Installed = decodeRawArray(document["installed"])
	state.Instances = decodeRawArray(document["instances"])
	state.Generations = decodeRawArray(document["generations"])
	state.Revision = decodeNonNegativeInteger(document["revision"])
	state.ActiveGeneration = decodeNonNegativeInteger(document["activeGeneration"])
	for key, value := range document {
		if knownTopLevelField(key) {
			continue
		}
		state.Extra[key] = append(json.RawMessage(nil), value...)
	}
	return state, nil
}

func knownTopLevelField(key string) bool {
	switch key {
	case "schemaVersion", "revision", "installed", "instances", "generations", "activeGeneration":
		return true
	}
	return false
}

func decodeRawArray(raw json.RawMessage) []json.RawMessage {
	if len(raw) == 0 {
		return []json.RawMessage{}
	}
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return []json.RawMessage{}
	}
	if values == nil {
		return []json.RawMessage{}
	}
	return values
}

func decodeNonNegativeInteger(raw json.RawMessage) int64 {
	if len(raw) == 0 {
		return 0
	}
	var number json.Number
	if err := json.Unmarshal(raw, &number); err != nil {
		return 0
	}
	parsed, err := strconv.ParseFloat(number.String(), 64)
	if err != nil || parsed < 0 || parsed > math.MaxInt64 || parsed != math.Trunc(parsed) {
		return 0
	}
	return int64(parsed)
}

func mapStateError(err error) error {
	if err == nil {
		return nil
	}
	if coded, ok := pluginerr.From(err); ok {
		return coded
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "database is locked") || strings.Contains(message, "sqlite_busy") {
		return pluginerr.New(plugincontrol.CodeStateUnavailable, "")
	}
	return pluginerr.New(plugincontrol.CodeStateUnavailable, err.Error())
}

func hardenDatabaseFiles(databasePath string) {
	for _, file := range []string{databasePath, databasePath + "-wal", databasePath + "-shm"} {
		if _, err := os.Stat(file); err != nil {
			continue
		}
		_ = os.Chmod(file, privateFileMode)
	}
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}
