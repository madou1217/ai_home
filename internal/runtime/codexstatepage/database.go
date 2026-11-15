package codexstatepage

import (
	"context"
	"database/sql"
	"os"

	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	_ "modernc.org/sqlite"
)

// openVendorReadOnly is the only database opener used by these projections.
// Missing paths are never created; mode=ro and query_only both stay enabled.
func openVendorReadOnly(ctx context.Context, path string) (*sql.DB, *sql.Tx, error) {
	info, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, ErrSchema
	}
	uri := sqlitefile.URL(path)
	query := uri.Query()
	query.Set("mode", "ro")
	query.Add("_pragma", "query_only(1)")
	query.Add("_pragma", "busy_timeout(1000)")
	uri.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", uri.String())
	if err != nil {
		return nil, nil, err
	}
	db.SetMaxOpenConns(1)
	tx, err := db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		_ = db.Close()
		return nil, nil, err
	}
	return db, tx, nil
}
