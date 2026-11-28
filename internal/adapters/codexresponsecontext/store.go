// Package codexresponsecontext 把 Codex 响应上下文与账号归属持久化到唯一的 aih.db。
//
// 写路径在 WS 热路径上：SaveItems/SaveAccount 只入队并立即返回，由单个后台
// 协程批量写库；队列满时丢弃本次持久化（进程内 journal 仍然可用），绝不阻塞
// 推理流。读路径只在内存 journal/registry 未命中时发生（典型是服务重启后）。
package codexresponsecontext

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"github.com/madou1217/ai_home/application/codexcontext"
)

// 持久化参数。TTL 比进程内 journal 长：重启后仍可能需要续接；容量上限避免
// 长会话把 aih.db 撑大，超限按最旧优先淘汰。
const (
	RecordTTL              = 24 * time.Hour
	MaxRecords             = 4096
	MaxBytes         int64 = 128 * 1024 * 1024
	writeQueueSize         = 256
	pruneEveryWrites       = 64
)

const schema = `
CREATE TABLE IF NOT EXISTS codex_response_contexts (
    response_id TEXT PRIMARY KEY,
    account_ref TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    items_json BLOB NOT NULL DEFAULT X'',
    bytes INTEGER NOT NULL DEFAULT 0,
    updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS codex_response_contexts_updated
    ON codex_response_contexts(updated_at_ms);
`

type writeKind int

const (
	writeItems writeKind = iota
	writeAccount
)

type writeOp struct {
	kind       writeKind
	responseID string
	accountRef string
	model      string
	items      []json.RawMessage
	updatedAt  time.Time
}

// Store 是 codexcontext.Store 的 SQLite 实现。
type Store struct {
	db     *sql.DB
	queue  chan writeOp
	done   chan struct{}
	once   sync.Once
	writes int
}

var _ codexcontext.Store = (*Store)(nil)

// Open 打开 aih.db 并确保响应上下文表存在，同时启动后台写协程。
func Open(ctx context.Context, aiHomeDir string) (*Store, error) {
	root := strings.TrimSpace(aiHomeDir)
	if root == "" {
		return nil, errors.New("codex_response_context_home_required")
	}
	if err := os.MkdirAll(root, 0o700); err != nil {
		return nil, fmt.Errorf("创建 AIH 数据目录失败: %w", err)
	}
	path := filepath.Join(root, "aih.db")
	dsn := "file:" + path + "?_txlock=immediate&_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开响应上下文数据库失败: %w", err)
	}
	db.SetMaxOpenConns(2)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(30 * time.Minute)
	if _, err := db.ExecContext(ctx, schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("初始化响应上下文表失败: %w", err)
	}
	// 旧版本已建表时 CREATE IF NOT EXISTS 不会补列；model 用于 HTTP 续接帧补回。
	if _, err := db.ExecContext(ctx,
		`ALTER TABLE codex_response_contexts ADD COLUMN model TEXT NOT NULL DEFAULT ''`); err != nil &&
		!strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		_ = db.Close()
		return nil, fmt.Errorf("迁移响应上下文 model 列失败: %w", err)
	}
	store := &Store{
		db:    db,
		queue: make(chan writeOp, writeQueueSize),
		done:  make(chan struct{}),
	}
	go store.run()
	return store, nil
}

// Close 停止后台写协程并关闭数据库连接。
func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	store.once.Do(func() { close(store.done) })
	return store.db.Close()
}

// SaveItems 入队保存完整上下文；队列满时丢弃本次持久化。
func (store *Store) SaveItems(responseID string, items []json.RawMessage, updatedAt time.Time) {
	if store == nil || strings.TrimSpace(responseID) == "" || len(items) == 0 {
		return
	}
	// 只入队原始 item，JSON 编码放到后台协程，避免在 WS 读路径上做 MB 级拷贝。
	store.enqueue(writeOp{kind: writeItems, responseID: responseID, items: items, updatedAt: updatedAt})
}

// SaveBinding 入队保存账号归属与模型；队列满时丢弃。
func (store *Store) SaveBinding(responseID, accountRef, model string, updatedAt time.Time) {
	if store == nil || strings.TrimSpace(responseID) == "" || strings.TrimSpace(accountRef) == "" {
		return
	}
	store.enqueue(writeOp{kind: writeAccount, responseID: responseID, accountRef: accountRef, model: model, updatedAt: updatedAt})
}

// Load 读取一条未过期的持久化记录。
func (store *Store) Load(ctx context.Context, responseID string) (codexcontext.Record, bool, error) {
	if store == nil || store.db == nil || strings.TrimSpace(responseID) == "" {
		return codexcontext.Record{}, false, nil
	}
	var accountRef string
	var model string
	var items []byte
	var updatedAtMS int64
	err := store.db.QueryRowContext(ctx,
		`SELECT account_ref, model, items_json, updated_at_ms FROM codex_response_contexts WHERE response_id = ?`,
		responseID,
	).Scan(&accountRef, &model, &items, &updatedAtMS)
	if errors.Is(err, sql.ErrNoRows) {
		return codexcontext.Record{}, false, nil
	}
	if err != nil {
		return codexcontext.Record{}, false, err
	}
	updatedAt := time.UnixMilli(updatedAtMS)
	if time.Since(updatedAt) > RecordTTL {
		return codexcontext.Record{}, false, nil
	}
	record := codexcontext.Record{AccountRef: accountRef, Model: model, UpdatedAt: updatedAt}
	if len(items) > 0 {
		if err := json.Unmarshal(items, &record.Items); err != nil {
			return codexcontext.Record{}, false, nil
		}
	}
	return record, true, nil
}

func (store *Store) enqueue(op writeOp) {
	select {
	case store.queue <- op:
	default:
		// 持久化是尽力而为：热路径优先，队列满时不阻塞。
	}
}

func (store *Store) run() {
	for {
		select {
		case <-store.done:
			return
		case op := <-store.queue:
			store.apply(op)
			store.writes++
			if store.writes%pruneEveryWrites == 0 {
				store.prune()
			}
		}
	}
}

func (store *Store) apply(op writeOp) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	nowMS := op.updatedAt.UnixMilli()
	switch op.kind {
	case writeItems:
		encoded, err := json.Marshal(op.items)
		if err != nil {
			return
		}
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO codex_response_contexts (response_id, account_ref, items_json, bytes, updated_at_ms)
VALUES (?, '', ?, ?, ?)
ON CONFLICT(response_id) DO UPDATE SET
    items_json = excluded.items_json,
    bytes = excluded.bytes,
    updated_at_ms = excluded.updated_at_ms`,
			op.responseID, encoded, int64(len(encoded)), nowMS); err != nil {
			log.Printf("codex response context: 保存上下文失败 response_id=%s err=%v", op.responseID, err)
		}
	case writeAccount:
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO codex_response_contexts (response_id, account_ref, model, items_json, bytes, updated_at_ms)
VALUES (?, ?, ?, X'', 0, ?)
ON CONFLICT(response_id) DO UPDATE SET
    account_ref = excluded.account_ref,
    model = CASE WHEN excluded.model <> '' THEN excluded.model ELSE model END,
    updated_at_ms = excluded.updated_at_ms`,
			op.responseID, op.accountRef, op.model, nowMS); err != nil {
			log.Printf("codex response context: 保存账号归属失败 response_id=%s err=%v", op.responseID, err)
		}
	}
}

// prune 删除过期记录，并按字节/条数上限淘汰最旧记录。
func (store *Store) prune() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cutoff := time.Now().Add(-RecordTTL).UnixMilli()
	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM codex_response_contexts WHERE updated_at_ms < ?`, cutoff); err != nil {
		return
	}
	var count int64
	var bytes int64
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM codex_response_contexts`).Scan(&count, &bytes); err != nil {
		return
	}
	for count > MaxRecords || bytes > MaxBytes {
		var responseID string
		var size int64
		if err := store.db.QueryRowContext(ctx,
			`SELECT response_id, bytes FROM codex_response_contexts ORDER BY updated_at_ms ASC LIMIT 1`).
			Scan(&responseID, &size); err != nil {
			return
		}
		if _, err := store.db.ExecContext(ctx,
			`DELETE FROM codex_response_contexts WHERE response_id = ?`, responseID); err != nil {
			return
		}
		count--
		bytes -= size
	}
}
