package sqliteaccount

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
)

// OpenUpstreamRuleAdmin opens an existing canonical DB only. In particular it
// does not call Open/openSchemaStore: no initialization, model policy migration,
// orphan cleanup, alias reconciliation, watcher, chmod or directory creation.
// The caller owns the offline writer lease for a writable confirmation.
func OpenUpstreamRuleAdmin(ctx context.Context, home string, writable bool) (*Store, error) {
	if ctx == nil {
		return nil, rulesapp.ErrServiceUnavailable
	}
	p, err := DatabasePath(home)
	if err != nil {
		return nil, err
	}
	resolved, err := filepath.EvalSymlinks(p)
	if err != nil || resolved != p {
		return nil, errors.New("upstream_rule_existing_database_required")
	}
	before, err := os.Lstat(p)
	if err != nil || !before.Mode().IsRegular() {
		return nil, errors.New("upstream_rule_existing_database_required")
	}
	if err := businessdb.CheckReady(ctx, p); err != nil {
		return nil, err
	}
	u := sqlitefile.URL(p)
	q := u.Query()
	q.Set("mode", "ro")
	if writable {
		q.Set("mode", "rw")
	} else {
		q.Add("_pragma", "query_only(1)")
	}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "foreign_keys(ON)")
	q.Add("_pragma", "trusted_schema(OFF)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*Store, error) { return nil, errors.Join(err, db.Close()) }
	if err := db.PingContext(ctx); err != nil {
		return fail(err)
	}
	after, err := os.Lstat(p)
	if err != nil || !after.Mode().IsRegular() || !os.SameFile(before, after) {
		return fail(errors.New("upstream_rule_database_changed"))
	}
	for _, table := range []string{"accounts", "app_kv", "account_upstream_error_rule", "account_upstream_error_group"} {
		var kind string
		if err := db.QueryRowContext(ctx, "SELECT type FROM sqlite_master WHERE name=?", table).Scan(&kind); err != nil || kind != "table" {
			return fail(errors.New("upstream_rule_existing_schema_required"))
		}
	}
	return &Store{db: db}, nil
}

func ruleCurrentAccounts(ctx context.Context, tx *ruleTransaction) (map[string]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT account_ref, provider_id FROM accounts ORDER BY account_ref")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	current := map[string]string{}
	for rows.Next() {
		var ref, provider string
		if err := rows.Scan(&ref, &provider); err != nil {
			return nil, err
		}
		if _, err := accountcore.ParseAccountRef(ref); err != nil {
			return nil, err
		}
		if provider == "" {
			return nil, rulesapp.ErrInvalidImport
		}
		current[ref] = provider
	}
	return current, rows.Err()
}
