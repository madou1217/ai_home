package distributiondata

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

func verifyPrepared(ctx context.Context, report *Report) (resultErr error) {
	id, version, err := identity(ctx, businessdb.Path(report.PreparedHome))
	if err != nil {
		return err
	}
	report.ApplicationID, report.UserVersion = id, version
	if id != sqliteaccount.ApplicationID || version != sqliteaccount.SchemaVersion {
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
	if err := integrity(ctx, db); err != nil {
		return err
	}
	hasBefore := present(report.SourceFingerprint, businessdb.FileName)
	hasLegacy := present(report.SourceFingerprint, businessdb.LegacyFileName)
	if hasBefore {
		if err := attach(ctx, db, businessdb.Path(report.BackupHome), "before"); err != nil {
			return err
		}
	}
	merged := map[string]bool{}
	if hasLegacy {
		for _, entry := range []struct{ home, schema string }{{report.BackupHome, "legacy_before"}, {report.PreparedHome, "sealed"}} {
			if err := attach(ctx, db, filepath.Join(entry.home, businessdb.LegacyFileName), entry.schema); err != nil {
				return err
			}
		}
		legacy, err := tables(ctx, db, "legacy_before")
		if err != nil {
			return err
		}
		for _, table := range legacy {
			check, err := compareTable(ctx, db, "legacy_before", table, "sealed", table)
			if err != nil {
				return err
			}
			report.Checks = append(report.Checks, check)
			// A matched receipt is historical: canonical rows can legitimately
			// have changed AFTER the original cutover. Preserve both snapshots,
			// rather than importing stale sealed rows back over live data.
			if report.Unification.State != "already_complete" && table != businessdb.SealTable {
				target := businessdb.CompatibilityTable(table)
				check, err := compareUnion(ctx, db, table, target, hasBefore)
				if err != nil {
					return err
				}
				report.Checks = append(report.Checks, check)
				merged[target] = true
			}
		}
	}
	if hasBefore {
		before, err := tables(ctx, db, "before")
		if err != nil {
			return err
		}
		for _, table := range before {
			if merged[table] {
				continue // Already checked against BOTH originals, above.
			}
			check, err := compareTable(ctx, db, "before", table, "main", table)
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
	a.CompatibilityAccounts, a.CompatibilityCredentials = counts[2], counts[3]
	a.NodeImportDeferred = counts[2] > 0 || counts[3] > 0
	a.ImportGuidance = []string{
		"Canonical account schema is initialized; compatibility rows are NOT canonical accounts or fabricated credentials.",
		"After publication, reuse lib/server/go-account-sync.js with lib/account/go-bridge/go-import-translator.js and go-management-client.js; preparation never runs a service or importer.",
		"The translator uses /v1/management/account-imports for real native artifacts and /v1/management/accounts for static credentials; preserve its identity/generation/deletion checks instead of INSERTing guessed Go credentials.",
	}
	return nil
}

func accountCounts(ctx context.Context, path string) (counts [4]int64, resultErr error) {
	db, err := openDB(ctx, path, true)
	if err != nil {
		return counts, err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	for i, table := range []string{"accounts", "account_credentials", "account_refs", "compat_account_credentials"} {
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
