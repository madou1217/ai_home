package sqliteaccount

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// HostDefaultChange holds the short write transaction while the caller publishes
// prepared native files. Only Commit makes the Go default and compatibility
// gateway slot visible. Filesystem journaling/recovery belongs to the Host layer.
type HostDefaultChange struct {
	connection *sql.Conn
	ctx        context.Context
	once       sync.Once
	closed     bool
	After      HostDefaultState
}

// BeginCodexHostDefault changes the Go-owned default and the existing gateway
// slot in a single connection transaction. It never writes a second account
// default: the old Node pointer is removed, not mirrored.
func (store *Store) BeginCodexHostDefault(ctx context.Context, aiHomeDir string, ref accountcore.AccountRef, credentialVersion time.Time, gateway bool, expected HostDefaultState) (*HostDefaultChange, error) {
	if store == nil || store.db == nil || ctx == nil {
		return nil, accountapp.ErrInvalidProviderDefault
	}
	connection, err := store.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	// Compatibility state shares the account database and the same transaction.
	cleanup := func() {
		_, _ = connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		_, _ = connection.ExecContext(context.WithoutCancel(ctx), "PRAGMA main.synchronous=NORMAL")
		_, _ = connection.ExecContext(context.WithoutCancel(ctx), "PRAGMA fullfsync=OFF")
		_ = connection.Close()
	}
	// FULL WAL durability is scoped to this connection; restore pool defaults on close.
	for _, pragma := range []string{"PRAGMA main.synchronous=FULL", "PRAGMA fullfsync=ON"} {
		if _, err := connection.ExecContext(ctx, pragma); err != nil {
			cleanup()
			return nil, err
		}
	}
	if _, err := connection.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		cleanup()
		return nil, accountapp.ErrProviderDefaultConflict
	}
	if _, err := connection.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS main.app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		cleanup()
		return nil, err
	}
	current, err := hostStateAt(ctx, connection)
	if err != nil || current != expected {
		cleanup()
		return nil, accountapp.ErrProviderDefaultConflict
	}
	operationBytes := make([]byte, 16)
	if _, err := rand.Read(operationBytes); err != nil {
		cleanup()
		return nil, err
	}
	operation := hex.EncodeToString(operationBytes)
	var expectedRef any
	if !gateway {
		expectedRef = ref.String()
	}
	if _, err := connection.ExecContext(ctx, `INSERT INTO account_default_ownership(provider_id,owner,expected_ref,operation_id,updated_at_ms) VALUES('codex','go',?,?,?) ON CONFLICT(provider_id) DO UPDATE SET expected_ref=excluded.expected_ref,operation_id=excluded.operation_id,updated_at_ms=excluded.updated_at_ms`, expectedRef, operation, time.Now().UnixMilli()); err != nil {
		cleanup()
		return nil, err
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if !gateway {
		def, err := accountcore.NewProviderDefault("codex", ref, now)
		if err != nil {
			cleanup()
			return nil, err
		}
		if err := store.validateProviderDefaultTarget(ctx, connection, def); err != nil {
			cleanup()
			return nil, err
		}
		var version int64
		if err := connection.QueryRowContext(ctx, "SELECT updated_at_ms FROM account_credentials WHERE account_ref = ?", ref.String()).Scan(&version); err != nil || version != credentialVersion.UnixMilli() {
			cleanup()
			return nil, accountapp.ErrCredentialConflict
		}
		if _, err := connection.ExecContext(ctx, `INSERT INTO account_defaults(provider_id,account_ref,updated_at_ms) VALUES('codex',?,?) ON CONFLICT(provider_id) DO UPDATE SET account_ref=excluded.account_ref,updated_at_ms=excluded.updated_at_ms`, ref.String(), now.UnixMilli()); err != nil {
			cleanup()
			return nil, err
		}
		if _, err := connection.ExecContext(ctx, "DELETE FROM main.app_kv WHERE key = 'provider:default:codex'"); err != nil {
			cleanup()
			return nil, err
		}
	} else {
		if _, err := connection.ExecContext(ctx, "DELETE FROM account_defaults WHERE provider_id='codex'"); err != nil {
			cleanup()
			return nil, err
		}
		encoded, _ := json.Marshal(".aih-server")
		if _, err := connection.ExecContext(ctx, `INSERT INTO main.app_kv(key,value,updated_at) VALUES('provider:default:codex',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, string(encoded), now.UnixMilli()); err != nil {
			cleanup()
			return nil, err
		}
	}
	// Explicit ownership marker keeps legacy Node synchronization from reviving
	// its old pointer; absence preserves the pre-cutover compatibility behavior.
	if _, err := connection.ExecContext(ctx, `INSERT INTO main.app_kv(key,value,updated_at) VALUES('owner:default:codex','"go"',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, now.UnixMilli()); err != nil {
		cleanup()
		return nil, err
	}
	if _, err := connection.ExecContext(ctx, "DELETE FROM main.app_kv WHERE key='account:default:codex'"); err != nil {
		cleanup()
		return nil, err
	}
	after, err := hostStateAt(ctx, connection)
	if err != nil {
		cleanup()
		return nil, err
	}
	return &HostDefaultChange{connection: connection, ctx: ctx, After: after}, nil
}

func (change *HostDefaultChange) Commit() error {
	if change == nil || change.connection == nil || change.closed {
		return fmt.Errorf("default_change_missing")
	}
	_, err := change.connection.ExecContext(change.ctx, "COMMIT")
	if err != nil {
		return fmt.Errorf("default_change_commit_failed")
	}
	change.close()
	return nil
}

func (change *HostDefaultChange) Rollback() {
	if change == nil || change.connection == nil || change.closed {
		return
	}
	_, _ = change.connection.ExecContext(context.WithoutCancel(change.ctx), "ROLLBACK")
	change.close()
}

func (change *HostDefaultChange) close() {
	change.once.Do(func() {
		change.closed = true
		_, _ = change.connection.ExecContext(context.WithoutCancel(change.ctx), "PRAGMA main.synchronous=NORMAL")
		_, _ = change.connection.ExecContext(context.WithoutCancel(change.ctx), "PRAGMA fullfsync=OFF")
		_ = change.connection.Close()
	})
}
