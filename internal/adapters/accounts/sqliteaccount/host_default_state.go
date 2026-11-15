package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// HostDefaultState is a versioned recovery preimage. Account selection is read
// only from account_defaults; the receipt identifies the exact host transaction.
type HostDefaultState struct {
	Ref         string `json:"ref"`
	Version     int64  `json:"version"`
	Operation   string `json:"operation"`
	ExpectedRef string `json:"expectedRef"`
	Profile     string `json:"profile"`
	Owner       string `json:"owner"`
	Legacy      string `json:"legacy"`
}

func hostStateAt(ctx context.Context, connection *sql.Conn) (HostDefaultState, error) {
	var out HostDefaultState
	err := connection.QueryRowContext(ctx, "SELECT account_ref,updated_at_ms FROM account_defaults WHERE provider_id='codex'").Scan(&out.Ref, &out.Version)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	err = connection.QueryRowContext(ctx, "SELECT operation_id,COALESCE(expected_ref,'') FROM account_default_ownership WHERE provider_id='codex'").Scan(&out.Operation, &out.ExpectedRef)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	for _, item := range []struct {
		key   string
		value *string
	}{{"provider:default:codex", &out.Profile}, {"owner:default:codex", &out.Owner}, {"account:default:codex", &out.Legacy}} {
		var raw string
		err := connection.QueryRowContext(ctx, "SELECT value FROM main.app_kv WHERE key=?", item.key).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return out, err
		}
		if json.Unmarshal([]byte(raw), item.value) != nil {
			return out, fmt.Errorf("codex_default_state_invalid")
		}
	}
	return out, nil
}

// ReadCodexHostDefaultState takes one snapshot of account and compatibility state.
func (store *Store) ReadCodexHostDefaultState(ctx context.Context, root string) (HostDefaultState, error) {
	var zero HostDefaultState
	connection, err := store.db.Conn(ctx)
	if err != nil {
		return zero, err
	}
	defer connection.Close()
	if _, err = connection.ExecContext(ctx, "BEGIN"); err != nil {
		return zero, err
	}
	defer connection.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
	// New installs may not have a Node compatibility table yet.
	var count int
	if err = connection.QueryRowContext(ctx, "SELECT count(*) FROM main.sqlite_master WHERE type='table' AND name='app_kv'").Scan(&count); err != nil {
		return zero, err
	}
	if count == 0 {
		_, _ = connection.ExecContext(ctx, "ROLLBACK")
		if _, err = connection.ExecContext(ctx, "CREATE TABLE IF NOT EXISTS main.app_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)"); err != nil {
			return zero, err
		}
		if _, err = connection.ExecContext(ctx, "BEGIN"); err != nil {
			return zero, err
		}
	}
	return hostStateAt(ctx, connection)
}

// ReadCodexDefaultOwnership exposes only the authoritative receipt mode.
func (store *Store) ReadCodexDefaultOwnership(ctx context.Context) (owned, gateway bool, err error) {
	var expected sql.NullString
	err = store.db.QueryRowContext(ctx, "SELECT expected_ref FROM account_default_ownership WHERE provider_id='codex' AND owner='go'").Scan(&expected)
	if errors.Is(err, sql.ErrNoRows) {
		return false, false, nil
	}
	return err == nil, !expected.Valid, err
}
