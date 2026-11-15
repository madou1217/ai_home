package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

const portableSupplementPrefix = "backup:portable-supplement:"

type portableSupplement struct {
	CredentialVersion int64           `json:"credentialVersion"`
	Payload           json.RawMessage `json:"payload"`
}

func writePortableSupplement(ctx context.Context, conn *sql.Conn, ref accountcore.AccountRef, version int64, raw json.RawMessage) error {
	if len(raw) == 0 {
		return nil
	}
	if _, err := conn.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS app_kv(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL)`); err != nil {
		return err
	}
	document, err := json.Marshal(portableSupplement{CredentialVersion: version, Payload: raw})
	if err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, `INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, portableSupplementPrefix+ref.String(), string(document), version)
	return err
}

// ReadPortableSupplement never mixes metadata attached to a previous credential
// generation with a newer live authentication snapshot.
func (store *Store) ReadPortableSupplement(ctx context.Context, ref accountcore.AccountRef, version int64) (json.RawMessage, bool, error) {
	var count int
	if err := store.db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='app_kv'").Scan(&count); err != nil {
		return nil, false, err
	}
	if count == 0 {
		return nil, false, nil
	}
	var raw string
	err := store.db.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key=?", portableSupplementPrefix+ref.String()).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	var value portableSupplement
	if json.Unmarshal([]byte(raw), &value) != nil {
		return nil, false, errors.New("backup_portable_supplement_invalid")
	}
	if value.CredentialVersion != version {
		return nil, false, nil
	}
	return value.Payload, true, nil
}
