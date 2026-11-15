package sqliteaccount

import (
	"context"
	"database/sql"
	"os"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
)

// OpenReadOnly exposes existing canonical account facts without initialization,
// migration, alias reconciliation, chmod or orphan cleanup. It cannot be used
// for mutation; SQLite query_only also enforces that boundary on every connection.
func OpenReadOnly(ctx context.Context, home string, catalog *providers.Catalog) (*Store, error) {
	p, e := DatabasePath(home)
	if e != nil {
		return nil, e
	}
	if _, e = os.Stat(p); e != nil {
		return nil, e
	}
	if e = businessdb.CheckReady(ctx, p); e != nil {
		return nil, e
	}
	uri := sqlitefile.URL(p)
	q := uri.Query()
	q.Set("mode", "ro")
	q.Add("_pragma", "query_only(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	uri.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", uri.String())
	if e != nil {
		return nil, e
	}
	if e = db.PingContext(ctx); e != nil {
		db.Close()
		return nil, e
	}
	return &Store{db: db, catalog: catalog, credentials: newCredentialRegistry(), profiles: newProfileRegistry()}, nil
}
