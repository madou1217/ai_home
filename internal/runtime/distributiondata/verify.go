package distributiondata

import (
	"context"
	"errors"
	"fmt"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

func verifyPrepared(ctx context.Context, report *Report) (resultErr error) {
	id, err := identity(ctx, businessdb.Path(report.PreparedHome))
	if err != nil {
		return err
	}
	report.ApplicationID = id
	if id != sqliteaccount.ApplicationID {
		return errors.New("distributiondata: prepared canonical schema identity mismatch")
	}
	if err := businessdb.CheckReady(ctx, businessdb.Path(report.PreparedHome)); err != nil {
		return err
	}
	db, err := openDB(ctx, businessdb.Path(report.PreparedHome), true)
	if err != nil {
		return err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	if err := sqliteaccount.ValidateSchema(ctx, db); err != nil {
		return fmt.Errorf("distributiondata: prepared schema capabilities: %w", err)
	}
	if err := integrity(ctx, db); err != nil {
		return err
	}
	if present(report.SourceFingerprint, businessdb.FileName) {
		if err := attach(ctx, db, businessdb.Path(report.BackupHome), "before"); err != nil {
			return err
		}
		before, err := tables(ctx, db, "before")
		if err != nil {
			return err
		}
		for _, table := range before {
			var check TableCheck
			var err error
			if table == "usage_ledger_daily" {
				check, err = verifyLedgerDaily(ctx, db)
			} else {
				check, err = compareTable(ctx, db, "before", table, "main", table)
			}
			if err != nil {
				return err
			}
			report.Checks = append(report.Checks, check)
		}
	}
	for _, table := range []string{"accounts", "account_credentials", "app_kv"} {
		found, err := exists(ctx, db, "main", table)
		if err != nil {
			return err
		}
		if !found {
			return fmt.Errorf("distributiondata: prepared required table missing: %s", table)
		}
	}
	counts, err := accountCounts(ctx, businessdb.Path(report.PreparedHome))
	if err != nil {
		return err
	}
	a := &report.Accounts
	a.SchemaInitialized = true
	a.CanonicalAccounts, a.CanonicalCredentials = counts[0], counts[1]
	a.CompatibilityAccounts, a.CompatibilityCredentials = 0, 0
	a.NodeImportDeferred = false
	a.ImportGuidance = []string{
		"Canonical account schema is initialized; legacy compatibility tables are retired.",
		"After publication, import compatibility rows with the Go account importer (/v1/management/account-imports for native artifacts, /v1/management/accounts for static credentials); preparation never runs a service or importer.",
		"The importer preserves identity/generation/deletion checks; do not INSERT guessed Go credentials.",
	}
	return nil
}

func accountCounts(ctx context.Context, path string) (counts [2]int64, resultErr error) {
	db, err := openDB(ctx, path, true)
	if err != nil {
		return counts, err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	for i, table := range []string{"accounts", "account_credentials"} {
		found, err := exists(ctx, db, "main", table)
		if err != nil {
			return counts, err
		}
		if found {
			if err := db.QueryRowContext(ctx, "SELECT count(*) FROM "+quote(table)).Scan(&counts[i]); err != nil {
				return counts, err
			}
		}
	}
	return counts, nil
}
