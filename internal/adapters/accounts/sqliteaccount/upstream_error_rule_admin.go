package sqliteaccount

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"

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

// PlanLegacyRules is a read-only SQLite snapshot, not AuthoritySnapshot (which
// may persist newly admitted accounts). It never returns rule/credential text.
func (repository *UpstreamErrorRuleRepository) PlanLegacyRules(ctx context.Context) (rulesapp.LegacyPlan, error) {
	if !repository.available(ctx) {
		return rulesapp.LegacyPlan{}, rulesapp.ErrServiceUnavailable
	}
	conn, err := repository.store.db.Conn(ctx)
	if err != nil {
		return rulesapp.LegacyPlan{}, err
	}
	if _, err := conn.ExecContext(ctx, "BEGIN"); err != nil {
		_ = conn.Close()
		return rulesapp.LegacyPlan{}, err
	}
	tx := &ruleTransaction{Conn: conn, ctx: ctx}
	defer tx.Rollback()
	doc, found, err := readRuleAuthority(ctx, tx)
	if err != nil {
		return rulesapp.LegacyPlan{}, err
	}
	canonical, err := validatedRuleRecords(ctx, tx)
	if err != nil {
		return rulesapp.LegacyPlan{}, err
	}
	source, err := readLegacyRuleSource(ctx, tx)
	if err != nil {
		return rulesapp.LegacyPlan{}, err
	}
	current, err := ruleCurrentAccounts(ctx, tx)
	if err != nil {
		return rulesapp.LegacyPlan{}, err
	}
	return ruleSourcePlan(ctx, tx, doc, found, canonical, current, source)
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

func sortedRuleRefs(records map[string]rulesapp.Record) []string {
	refs := make([]string, 0, len(records))
	for ref := range records {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	return refs
}

// ruleSourcePlan is also called under confirm's BEGIN IMMEDIATE, before any
// stage. Its digest includes exact selected source bytes, links, canonical row
// ordering/JSON, current account providers and the exact marker row.
func ruleSourcePlan(ctx context.Context, tx *ruleTransaction, doc ruleAuthority, found bool, canonical map[string]rulesapp.Record, current map[string]string, source ruleSource) (rulesapp.LegacyPlan, error) {
	plan := rulesapp.LegacyPlan{Source: rulesapp.LegacyRulesSource, SelectorVersion: rulesapp.LegacyRulesSelectorVersion, CanonicalAccounts: len(current), LegacyAccounts: len(source.records)}
	if found {
		plan.AuthorityRevision = doc.Revision
	}
	for ref, state := range doc.Accounts {
		if state.State == "cleared" {
			plan.ClearedAccounts++
			if _, nonempty := canonical[ref]; nonempty {
				return rulesapp.LegacyPlan{}, errors.New("upstream_rule_cleared_conflict")
			}
		}
	}
	for ref := range source.records {
		if _, exists := current[ref]; !exists {
			return rulesapp.LegacyPlan{}, rulesapp.ErrLegacySourceConfirmationRequired
		}
		_, nonempty := canonical[ref]
		state, owned := doc.Accounts[ref]
		if !nonempty && !(owned && state.State == "cleared") {
			plan.PendingAccounts++
		}
	}
	var marker string
	err := tx.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key=?", ruleAuthorityKey).Scan(&marker)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return rulesapp.LegacyPlan{}, err
	}
	hash := sha256.New()
	encoder := json.NewEncoder(hash)
	if err := encoder.Encode(struct {
		Source      string
		Version     int
		MarkerFound bool
		Marker      string
		Links       string
		Current     map[string]string
		Selected    [][3]string
	}{plan.Source, plan.SelectorVersion, found, marker, source.rawLinks, current, source.selected}); err != nil {
		return rulesapp.LegacyPlan{}, err
	}
	// Hash raw canonical bytes as well as their validated form: normalization
	// cannot make a changed source compare equal to the owner's previous plan.
	for _, query := range []string{
		"SELECT account_ref, source, position, rule_json FROM account_upstream_error_rule ORDER BY account_ref, source, position",
		"SELECT account_ref, '', position, group_id FROM account_upstream_error_group ORDER BY account_ref, position",
	} {
		if err := encoder.Encode(query); err != nil {
			return rulesapp.LegacyPlan{}, err
		}
		rows, err := tx.QueryContext(ctx, query)
		if err != nil {
			return rulesapp.LegacyPlan{}, err
		}
		for rows.Next() {
			var ref, src, raw string
			var position int
			if err := rows.Scan(&ref, &src, &position, &raw); err != nil {
				_ = rows.Close()
				return rulesapp.LegacyPlan{}, err
			}
			if err := encoder.Encode([]any{ref, src, position, raw}); err != nil {
				_ = rows.Close()
				return rulesapp.LegacyPlan{}, err
			}
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return rulesapp.LegacyPlan{}, err
		}
	}
	plan.Digest = hex.EncodeToString(hash.Sum(nil))
	return plan, nil
}
