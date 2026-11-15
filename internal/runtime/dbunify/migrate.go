// Package dbunify performs an explicitly offline, lossless AIH storage cutover.
// It never scans provider-native databases and never removes either source file.
package dbunify

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	_ "modernc.org/sqlite"
)

type Options struct {
	Root, BackupDir string
	Apply, Offline  bool
}
type TableResult struct {
	Source       string `json:"source"`
	Target       string `json:"target"`
	SourceRows   int64  `json:"source_rows"`
	ExistingRows int64  `json:"existing_rows"`
	InsertedRows int64  `json:"inserted_rows"`
	FinalRows    int64  `json:"final_rows"`
}
type Report struct {
	Root    string        `json:"root"`
	State   string        `json:"state"`
	Backup  string        `json:"backup,omitempty"`
	Receipt string        `json:"receipt,omitempty"`
	Tables  []TableResult `json:"tables"`
}

func Run(ctx context.Context, opts Options) (report Report, resultErr error) {
	if opts.Root == "" {
		return report, errors.New("explicit --home is required")
	}
	root, err := filepath.Abs(opts.Root)
	if err != nil {
		return report, err
	}
	report.Root = root
	canonical, err := filepath.EvalSymlinks(root)
	if err != nil {
		return report, err
	}
	root = canonical
	report.Root = root
	target := businessdb.Path(root)
	source := filepath.Join(root, businessdb.LegacyFileName)
	for _, path := range []string{target, source} {
		info, e := os.Lstat(path)
		if e != nil {
			return report, e
		}
		if !info.Mode().IsRegular() {
			return report, errors.New("database_file_must_be_regular")
		}
	}
	a, _ := os.Stat(target)
	b, _ := os.Stat(source)
	if os.SameFile(a, b) {
		return report, errors.New("source_and_target_are_same_file")
	}
	u := sqlitefile.URL(target)
	q := u.Query()
	q.Set("mode", "rw")
	q.Add("_pragma", "busy_timeout(5000)")
	if !opts.Apply {
		q.Set("mode", "ro")
	}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return report, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	c, err := db.Conn(ctx)
	if err != nil {
		return report, err
	}
	defer c.Close()
	sourceURL := sqlitefile.URL(source)
	sq := sourceURL.Query()
	sq.Set("mode", "ro")
	if opts.Apply {
		sq.Set("mode", "rw")
	}
	sourceURL.RawQuery = sq.Encode()
	if _, err = c.ExecContext(ctx, "ATTACH DATABASE ? AS legacy", sourceURL.String()); err != nil {
		return report, err
	}
	defer c.ExecContext(context.WithoutCancel(ctx), "DETACH DATABASE legacy")
	var appID, version int
	if err = c.QueryRowContext(ctx, "PRAGMA main.application_id").Scan(&appID); err != nil {
		return report, err
	}
	if appID != 1095321649 {
		return report, errors.New("target_is_not_an_initialized_aih_database")
	}
	if err = c.QueryRowContext(ctx, "PRAGMA main.user_version").Scan(&version); err != nil {
		return report, err
	}
	if version < 30 {
		return report, errors.New("target_requires_account_schema_upgrade_before_unification")
	}
	if ok, err := completed(ctx, c, &report); err != nil || ok {
		return report, err
	}
	sourceObjects, err := objects(ctx, c, "legacy")
	if err != nil {
		return report, err
	}
	for _, o := range sourceObjects {
		if o.name == businessdb.SealTable {
			return report, errors.New("legacy_sealed_without_matching_target_receipt")
		}
		if o.kind == "table" && !businessdb.IsCompatibilityTable(businessdb.CompatibilityTable(o.name)) {
			return report, fmt.Errorf("unrecognized_legacy_table: %s", o.name)
		}
	}
	names := mappedNames(sourceObjects)
	if !opts.Apply {
		report.State = "planned"
		for _, o := range sourceObjects {
			if o.kind != "table" {
				continue
			}
			r := TableResult{Source: o.name, Target: names[o.name]}
			if err = c.QueryRowContext(ctx, "SELECT count(*) FROM legacy."+quote(o.name)).Scan(&r.SourceRows); err != nil {
				return report, err
			}
			report.Tables = append(report.Tables, r)
		}
		return report, nil
	}
	if !opts.Offline {
		return report, errors.New("--apply requires --offline after stopping every consumer; never a live startup migration")
	}
	if opts.BackupDir == "" {
		return report, errors.New("--backup-dir is required for apply")
	}
	// DELETE mode + FULL + EXCLUSIVE on both files is deliberate: SQLite's super
	// journal makes the data copy, receipt and legacy write fences one atomic commit.
	// A running WAL reader/writer prevents this transition; do not work around BUSY.
	for _, schema := range []string{"main", "legacy"} {
		var mode string
		if err = c.QueryRowContext(ctx, "PRAGMA "+schema+".journal_mode=DELETE").Scan(&mode); err != nil {
			return report, fmt.Errorf("offline_required: %w", err)
		}
		if mode != "delete" {
			return report, errors.New("offline_required: journal transition refused")
		}
		if _, err = c.ExecContext(ctx, "PRAGMA "+schema+".synchronous=FULL"); err != nil {
			return report, err
		}
	}
	if _, err = c.ExecContext(ctx, "PRAGMA fullfsync=ON"); err != nil {
		return report, err
	}
	if _, err = c.ExecContext(ctx, "PRAGMA foreign_keys=OFF"); err != nil {
		return report, err
	}
	if _, err = c.ExecContext(ctx, "BEGIN EXCLUSIVE"); err != nil {
		return report, fmt.Errorf("offline_required: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_, _ = c.ExecContext(context.WithoutCancel(ctx), "ROLLBACK")
		}
	}()
	if ok, e := completed(ctx, c, &report); e != nil || ok {
		return report, e
	}
	backup, err := os.MkdirTemp(opts.BackupDir, "aih-db-before-unify-")
	if err != nil {
		return report, err
	}
	report.Backup = backup
	for _, file := range []string{businessdb.FileName, businessdb.LegacyFileName} {
		if err = copyBackup(filepath.Join(root, file), filepath.Join(backup, file)); err != nil {
			return report, err
		}
	}
	if err = syncDirectory(backup); err != nil {
		return report, err
	}
	if err = syncDirectory(opts.BackupDir); err != nil {
		return report, err
	}
	for _, schema := range []string{"main", "legacy"} {
		if err = integrity(ctx, c, schema); err != nil {
			return report, err
		}
	}
	for _, o := range sourceObjects {
		if o.kind != "table" {
			continue
		}
		r, e := copyTable(ctx, c, o, names)
		report.Tables = append(report.Tables, r)
		if e != nil {
			return report, e
		}
	}
	existing, err := objects(ctx, c, "main")
	if err != nil {
		return report, err
	}
	known := map[string]string{}
	for _, o := range existing {
		known[o.name] = o.ddl
	}
	for _, o := range sourceObjects {
		if o.kind == "table" {
			continue
		}
		name := o.name
		if n, ok := names[name]; ok {
			name = n
		}
		ddl := rewriteDDL(o.ddl, names)
		if prev, ok := known[name]; ok {
			if !sameDDL(prev, ddl) {
				return report, fmt.Errorf("schema_object_conflict: %s", name)
			}
			continue
		}
		if _, err = c.ExecContext(ctx, ddl); err != nil {
			return report, fmt.Errorf("schema_object %s: %w", name, err)
		}
	}
	if err = integrity(ctx, c, "main"); err != nil {
		return report, err
	}
	entropy := make([]byte, 24)
	if _, err = rand.Read(entropy); err != nil {
		return report, err
	}
	report.Receipt = hex.EncodeToString(entropy)
	report.State = "complete"
	encoded, err := json.Marshal(report)
	if err != nil {
		return report, err
	}
	for _, item := range []struct{ schema, table string }{{"main", businessdb.ReceiptTable}, {"legacy", businessdb.SealTable}} {
		if _, err = c.ExecContext(ctx, "CREATE TABLE "+item.schema+"."+item.table+"(migration_id TEXT PRIMARY KEY,receipt TEXT NOT NULL,completed_at_ms INTEGER NOT NULL,report_json TEXT NOT NULL)"); err != nil {
			return report, err
		}
		if _, err = c.ExecContext(ctx, "INSERT INTO "+item.schema+"."+item.table+" VALUES(?,?,?,?)", businessdb.MigrationID, report.Receipt, time.Now().UnixMilli(), string(encoded)); err != nil {
			return report, err
		}
	}
	// Old processes/binaries must fail loudly instead of silently writing a stale
	// business database. The original contents remain readable for recovery/audit.
	for _, o := range sourceObjects {
		if o.kind != "table" {
			continue
		}
		for _, op := range []string{"INSERT", "UPDATE", "DELETE"} {
			ddl := "CREATE TRIGGER legacy." + quote("aih_sealed_"+o.name+"_"+op) + " BEFORE " + op + " ON " + quote(o.name) + " BEGIN SELECT RAISE(ABORT,'aih_database_migrated_use_aih_db'); END"
			if _, err = c.ExecContext(ctx, ddl); err != nil {
				return report, err
			}
		}
	}
	if _, err = c.ExecContext(ctx, "COMMIT"); err != nil {
		return report, err
	}
	committed = true
	if err = os.Chmod(target, 0600); err != nil {
		return report, err
	}
	if _, err = c.ExecContext(ctx, "PRAGMA main.journal_mode=WAL"); err != nil {
		return report, err
	}
	return report, nil
}

func completed(ctx context.Context, c *sql.Conn, report *Report) (bool, error) {
	var count int
	if err := c.QueryRowContext(ctx, "SELECT count(*) FROM main.sqlite_schema WHERE type='table' AND name=?", businessdb.ReceiptTable).Scan(&count); err != nil {
		return false, err
	}
	if count == 0 {
		return false, nil
	}
	var receipt, encoded string
	if err := c.QueryRowContext(ctx, "SELECT receipt,report_json FROM main."+businessdb.ReceiptTable+" WHERE migration_id=?", businessdb.MigrationID).Scan(&receipt, &encoded); err != nil {
		return false, err
	}
	var seal string
	if err := c.QueryRowContext(ctx, "SELECT receipt FROM legacy."+businessdb.SealTable+" WHERE migration_id=?", businessdb.MigrationID).Scan(&seal); err != nil || receipt != seal {
		return false, errors.New("cutover_receipt_mismatch")
	}
	if err := json.Unmarshal([]byte(encoded), report); err != nil {
		return false, err
	}
	report.State = "already_complete"
	return true, nil
}

func integrity(ctx context.Context, c *sql.Conn, schema string) error {
	var result string
	if err := c.QueryRowContext(ctx, "PRAGMA "+schema+".integrity_check").Scan(&result); err != nil {
		return err
	}
	if result != "ok" {
		return fmt.Errorf("integrity_check_failed: %s", schema)
	}
	rows, err := c.QueryContext(ctx, "PRAGMA "+schema+".foreign_key_check")
	if err != nil {
		return err
	}
	defer rows.Close()
	if rows.Next() {
		return fmt.Errorf("foreign_key_check_failed: %s", schema)
	}
	return rows.Err()
}
func copyBackup(source, target string) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	closeErr := out.Close()
	if err != nil {
		return err
	}
	return closeErr
}
func syncDirectory(path string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	return f.Sync()
}
