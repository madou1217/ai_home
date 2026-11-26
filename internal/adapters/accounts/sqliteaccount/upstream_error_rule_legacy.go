package sqliteaccount

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"time"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

// This slot belongs only to this repository. Existing schema owns app_kv;
// account-rule admission must never create a table or reuse another owner's key.
const ruleAuthorityKey = "go-upstream-rules:authority:v1"
const maxRuleRevision int64 = 9007199254740991

type ruleAuthority struct {
	Version  int                             `json:"version"`
	Owner    string                          `json:"owner"`
	Revision int64                           `json:"revision"`
	Accounts map[string]ruleAuthorityAccount `json:"accounts"`
}
type ruleAuthorityAccount struct {
	State string `json:"state"`
}
type ruleMutation struct{ ref, state string }
type ruleTransaction struct {
	*sql.Conn
	ctx  context.Context
	done bool
}

func (repository *UpstreamErrorRuleRepository) beginRules(ctx context.Context) (*ruleTransaction, error) {
	if !repository.available(ctx) {
		return nil, rulesapp.ErrServiceUnavailable
	}
	conn, err := repository.store.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return &ruleTransaction{Conn: conn, ctx: ctx}, nil
}
func (tx *ruleTransaction) Commit() error {
	if tx.done {
		return sql.ErrTxDone
	}
	if _, err := tx.ExecContext(tx.ctx, "COMMIT"); err != nil {
		return err
	}
	tx.done = true
	return tx.Conn.Close()
}
func (tx *ruleTransaction) Rollback() error {
	if tx.done {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := tx.ExecContext(ctx, "ROLLBACK")
	tx.done = true
	closeErr := tx.Conn.Close()
	return errors.Join(err, closeErr)
}

// checkRuleAuthorityObject rejects ambiguous members before typed decoding.
// Only the actual root -> accounts -> account-state object shape can recurse.
func checkRuleAuthorityObject(decoder *json.Decoder, level int) error {
	invalid := errors.New("upstream_rule_authority_invalid")
	if level < 0 || level > 2 {
		return invalid
	}
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return invalid
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err = decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return invalid
		}
		seen[key] = true
		if level == 1 || (level == 0 && key == "accounts") {
			if err := checkRuleAuthorityObject(decoder, level+1); err != nil {
				return err
			}
			continue
		}
		// Exact names also reject case aliases accepted by encoding/json's
		// struct matching (for example owner and Owner in the same object).
		if (level == 0 && key != "version" && key != "owner" && key != "revision") ||
			(level == 2 && key != "state") {
			return invalid
		}
		value, err := decoder.Token()
		if _, nested := value.(json.Delim); err != nil || nested {
			return invalid
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return invalid
	}
	return nil
}

func readRuleAuthority(ctx context.Context, tx *ruleTransaction) (ruleAuthority, bool, error) {
	empty := ruleAuthority{Version: 1, Owner: "go", Accounts: map[string]ruleAuthorityAccount{}}
	var kind string
	if err := tx.QueryRowContext(ctx, "SELECT type FROM sqlite_master WHERE name='app_kv'").Scan(&kind); err != nil || kind != "table" {
		return empty, false, fmt.Errorf("upstream_rule_authority_slot_invalid: %w", errors.Join(err, rulesapp.ErrServiceUnavailable))
	}
	var raw string
	err := tx.QueryRowContext(ctx, "SELECT value FROM app_kv WHERE key=?", ruleAuthorityKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return empty, false, nil
	}
	if err != nil {
		return empty, false, err
	}
	memberDecoder := json.NewDecoder(strings.NewReader(raw))
	memberDecoder.UseNumber()
	if err := checkRuleAuthorityObject(memberDecoder, 0); err != nil {
		return empty, false, err
	}
	if _, err := memberDecoder.Token(); !errors.Is(err, io.EOF) {
		return empty, false, errors.New("upstream_rule_authority_invalid")
	}
	var doc ruleAuthority
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&doc); err != nil {
		return empty, false, errors.New("upstream_rule_authority_invalid")
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return empty, false, errors.New("upstream_rule_authority_invalid")
	}
	if doc.Version != 1 || doc.Owner != "go" || doc.Revision < 1 || doc.Revision > maxRuleRevision || doc.Accounts == nil {
		return empty, false, errors.New("upstream_rule_authority_invalid")
	}
	for ref, account := range doc.Accounts {
		if _, err := accountcore.ParseAccountRef(ref); err != nil || (account.State != "owned" && account.State != "cleared") {
			return empty, false, errors.New("upstream_rule_authority_invalid")
		}
	}
	return doc, true, nil
}

func validRuleRecord(record rulesapp.Record) error {
	if _, err := accountcore.ParseAccountRef(record.AccountRef); err != nil {
		return err
	}
	if _, err := rulescore.Validate(record.Rules); err != nil {
		return err
	}
	if len(record.GroupIDs) > rulesapp.MaxGroupIDs {
		return rulesapp.ErrInvalidGroupIDs
	}
	seen := map[string]bool{}
	for _, id := range record.GroupIDs {
		parsed, err := mappingcore.ParseID(id)
		if err != nil || parsed != id || seen[id] {
			return rulesapp.ErrInvalidGroupIDs
		}
		seen[id] = true
	}
	return nil
}

func validatedRuleRecords(ctx context.Context, tx *ruleTransaction) (map[string]rulesapp.Record, error) {
	var invalid int
	if err := tx.QueryRowContext(ctx, `SELECT
 (SELECT COUNT(*) FROM account_upstream_error_rule r LEFT JOIN accounts a ON a.account_ref=r.account_ref WHERE a.account_ref IS NULL OR r.source!='account') +
 (SELECT COUNT(*) FROM account_upstream_error_group g LEFT JOIN accounts a ON a.account_ref=g.account_ref WHERE a.account_ref IS NULL)`).Scan(&invalid); err != nil {
		return nil, err
	}
	if invalid != 0 {
		return nil, errors.New("upstream_rule_canonical_invalid")
	}
	records, err := loadRuleRecords(ctx, tx, "")
	if err != nil {
		return nil, err
	}
	for _, record := range records {
		if err := validRuleRecord(record); err != nil {
			return nil, fmt.Errorf("upstream_rule_canonical_invalid: %w", err)
		}
	}
	return records, nil
}

// ruleSource contains only selected rule fields, never credential env documents.
func admitRuleAuthority(ctx context.Context, tx *ruleTransaction, mutations ...ruleMutation) (rulesapp.AuthoritySnapshot, error) {
	doc, found, err := readRuleAuthority(ctx, tx)
	if err != nil {
		return rulesapp.AuthoritySnapshot{}, err
	}
	records, err := validatedRuleRecords(ctx, tx)
	if err != nil {
		return rulesapp.AuthoritySnapshot{}, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT account_ref, provider_id FROM accounts ORDER BY account_ref")
	if err != nil {
		return rulesapp.AuthoritySnapshot{}, err
	}
	current := map[string]string{}
	for rows.Next() {
		var ref, provider string
		if err := rows.Scan(&ref, &provider); err != nil {
			_ = rows.Close()
			return rulesapp.AuthoritySnapshot{}, err
		}
		current[ref] = provider
	}
	rowErr := rows.Err()
	_ = rows.Close()
	if rowErr != nil {
		return rulesapp.AuthoritySnapshot{}, rowErr
	}
	changed := !found
	for _, mutation := range mutations {
		if _, ok := current[mutation.ref]; !ok {
			return rulesapp.AuthoritySnapshot{}, rulesapp.ErrAccountNotFound
		}
		doc.Accounts[mutation.ref] = ruleAuthorityAccount{State: mutation.state}
		changed = true
	}
	refs := make([]string, 0, len(current))
	for ref := range current {
		refs = append(refs, ref)
	}
	sort.Strings(refs)
	snapshot := rulesapp.AuthoritySnapshot{Version: 1, Source: "go", Records: []rulesapp.Record{}}
	for _, ref := range refs {
		if _, err := accountcore.ParseAccountRef(ref); err != nil {
			return rulesapp.AuthoritySnapshot{}, err
		}
		record, nonempty := records[ref]
		state, owned := doc.Accounts[ref]
		if owned && state.State == "cleared" && nonempty {
			return rulesapp.AuthoritySnapshot{}, errors.New("upstream_rule_cleared_conflict")
		}
		if !owned {
			doc.Accounts[ref] = ruleAuthorityAccount{State: "owned"}
			changed = true
		}
		if !nonempty {
			record = rulesapp.Record{AccountRef: ref, Provider: current[ref], Rules: []rulescore.Rule{}, GroupIDs: []string{}}
		}
		snapshot.Records = append(snapshot.Records, record)
	}
	if changed {
		if doc.Revision >= maxRuleRevision {
			return rulesapp.AuthoritySnapshot{}, errors.New("upstream_rule_revision_exhausted")
		}
		doc.Revision++
		raw, err := json.Marshal(doc)
		if err != nil {
			return rulesapp.AuthoritySnapshot{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO app_kv(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`, ruleAuthorityKey, string(raw), time.Now().UnixMilli()); err != nil {
			return rulesapp.AuthoritySnapshot{}, err
		}
	}
	snapshot.Revision = doc.Revision
	return snapshot, nil
}

// AuthoritySnapshot admits newly encountered accounts on every read, in the same
// SQLite snapshot as links, canonical rules and the persistent authority row.
func (repository *UpstreamErrorRuleRepository) AuthoritySnapshot(ctx context.Context) (rulesapp.AuthoritySnapshot, error) {
	tx, err := repository.beginRules(ctx)
	if err != nil {
		return rulesapp.AuthoritySnapshot{}, err
	}
	defer tx.Rollback()
	snapshot, err := admitRuleAuthority(ctx, tx)
	if err != nil {
		return rulesapp.AuthoritySnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return rulesapp.AuthoritySnapshot{}, err
	}
	return snapshot, nil
}
