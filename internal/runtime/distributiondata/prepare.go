package distributiondata

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
)

// Prepare only prepares private artifacts. ALL source writers must already be
// stopped, and stay stopped through publication. Partial/failed artifacts and
// original backups are retained for the installer; no live rollback is attempted.
func Prepare(ctx context.Context, opts Options) (report Report, resultErr error) {
	report.State = "preparing"
	defer func() {
		if resultErr != nil {
			report.State, report.Error = "failed", resultErr.Error()
		}
		if report.ReportPath != "" {
			if err := writeJSON(report.ReportPath, report); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("distributiondata: save report: %w", err))
				report.State, report.Error = "failed", resultErr.Error()
			}
		}
	}()
	if err := ctx.Err(); err != nil {
		return report, err
	}
	l, err := allocate(opts, &report)
	if err != nil {
		return report, err
	}
	if err := capture(ctx, l, &report); err != nil {
		return report, err
	}
	if err := initialize(ctx, opts, l, &report); err != nil {
		return report, err
	}
	if err := ensureCompatibilitySchema(ctx, businessdb.Path(l.scratch)); err != nil {
		return report, err
	}
	for _, name := range databaseNames {
		if err := snapshot(ctx, filepath.Join(l.scratch, name), filepath.Join(report.PreparedHome, name)); err != nil {
			return report, err
		}
	}
	if err := verifyPrepared(ctx, &report); err != nil {
		return report, err
	}
	if err := VerifySource(ctx, report.SourceFingerprint); err != nil {
		return report, err
	}
	for _, dir := range []string{report.PreparedHome, report.BackupHome, l.root} {
		if err := syncDir(dir); err != nil {
			return report, err
		}
	}
	report.State = "prepared"
	return report, nil
}

func capture(ctx context.Context, l layout, report *Report) error {
	source, err := fingerprint(ctx, report.Home, report.OriginalBackup)
	report.SourceFingerprint = source
	if err != nil {
		return err
	}
	if err := VerifySource(ctx, source); err != nil {
		return err
	}
	if err := syncDir(report.OriginalBackup); err != nil {
		return err
	}
	if err := writeJSON(report.FingerprintPath, source); err != nil {
		return err
	}
	for _, file := range source.Files {
		if file.Exists {
			if err := copyPrivate(ctx, filepath.Join(report.OriginalBackup, file.Name), filepath.Join(l.capture, file.Name)); err != nil {
				return err
			}
		}
	}
	for _, name := range databaseNames {
		if !present(source, name) {
			for _, suffix := range sidecars[1:] {
				if present(source, name+suffix) {
					return fmt.Errorf("distributiondata: orphaned source sidecar: %s", name+suffix)
				}
			}
			continue
		}
		if err := checkJournal(filepath.Join(l.capture, name+"-journal")); err != nil {
			return err
		}
		if err := snapshot(ctx, filepath.Join(l.capture, name), filepath.Join(report.BackupHome, name)); err != nil {
			return fmt.Errorf("distributiondata: capture %s: %w", name, err)
		}
	}
	report.Fresh = !present(source, businessdb.FileName)
	return syncDir(report.BackupHome)
}

func initialize(ctx context.Context, opts Options, l layout, report *Report) error {
	hasCanonical := present(report.SourceFingerprint, businessdb.FileName)
	report.SourceState = "fresh"
	if hasCanonical {
		report.SourceState = "canonical_only"
		original := businessdb.Path(report.BackupHome)
		id, version, err := identity(ctx, original)
		if err != nil {
			return err
		}
		report.AlreadyReady = id == sqliteaccount.ApplicationID && version == sqliteaccount.SchemaVersion && businessdb.CheckReady(ctx, original) == nil
		if id == sqliteaccount.ApplicationID {
			counts, err := accountCounts(ctx, original)
			if err != nil {
				return err
			}
			report.Accounts.BeforeAccounts, report.Accounts.BeforeCredentials = counts[0], counts[1]
		} else {
			report.SourceState = "compatibility_only"
			report.Accounts.InitializedDuringPrepare = true
		}
		if err := snapshot(ctx, original, businessdb.Path(l.scratch)); err != nil {
			return err
		}
	} else {
		report.Accounts.InitializedDuringPrepare = true
	}
	catalog := opts.Catalog
	if catalog == nil {
		var err error
		catalog, err = providers.NewCatalog(providers.BuiltinManifest())
		if err != nil {
			return err
		}
	}
	// This private directory has no database yet. Initialize only the schema:
	// normal Open also reconciles aliases and removes credentials, which would
	// mutate preserved account content before the bidirectional equality check.
	if err := sqliteaccount.InitializeSchema(ctx, sqliteaccount.OpenOptions{AIHomeDir: l.scratch, Catalog: catalog}); err != nil {
		return fmt.Errorf("distributiondata: initialize private canonical: %w", err)
	}
	return nil
}

func identity(ctx context.Context, path string) (id, version int, resultErr error) {
	db, err := openDB(ctx, path, true)
	if err != nil {
		return 0, 0, err
	}
	defer func() { resultErr = errors.Join(resultErr, db.Close()) }()
	if err := db.QueryRowContext(ctx, "PRAGMA application_id").Scan(&id); err != nil {
		return 0, 0, err
	}
	err = db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version)
	return id, version, err
}
