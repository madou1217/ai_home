// Package backupaccounts composes a short-lived, offline account transfer port.
// It uses the same Go domain importer as HTTP, never a second database or a
// network-refreshing server. Credentials travel over stdin/stdout pipes only.
package backupaccounts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/portableaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/sqlitefile"
	"github.com/madou1217/ai_home/internal/runtime/accountwriterlease"
	"github.com/madou1217/ai_home/internal/runtime/remotebackup"
)

type Request struct {
	CompatibilityProjection bool                                     `json:"compatibilityProjection,omitempty"`
	Kind                    string                                   `json:"kind"`
	Version                 int                                      `json:"version"`
	Accounts                []portableaccount.AihAccountsImportEntry `json:"accounts"`
}
type Outcome struct {
	Provider            string `json:"provider"`
	SourceRef           string `json:"sourceRef"`
	AccountRef          string `json:"accountRef,omitempty"`
	CLIAccountID        string `json:"cliAccountId,omitempty"`
	Status              string `json:"status"`
	Reason              string `json:"reason,omitempty"`
	CredentialUpdatedAt int64  `json:"credentialUpdatedAt,omitempty"`
	ProfileUpdatedAt    int64  `json:"profileUpdatedAt,omitempty"`
}

const CompatibilityProjectionProtocol = "aih-backup-compatibility-projection-v1"

// ProjectionStatus is explicit about canonical imports committed before the
// separate compatibility transaction. An unavailable reply never authorizes retry.
type ProjectionStatus struct {
	Protocol        string `json:"protocol"`
	Status          string `json:"status"`
	Applied         int    `json:"applied"`
	CanonicalStatus string `json:"canonicalStatus"`
	OutcomeUnknown  bool   `json:"outcomeUnknown"`
}

type Result struct {
	canonicalCommitted      bool
	canonicalUncertain      bool
	CompatibilityProjection *ProjectionStatus             `json:"compatibilityProjection,omitempty"`
	ProtocolVersion         int                           `json:"protocolVersion"`
	OK                      bool                          `json:"ok"`
	Error                   string                        `json:"error,omitempty"`
	Summary                 map[string]int                `json:"summary,omitempty"`
	Accounts                []Outcome                     `json:"accounts,omitempty"`
	Document                *Request                      `json:"document,omitempty"`
	Skipped                 []remotebackup.SkippedAccount `json:"skipped,omitempty"`
}

func open(ctx context.Context, home string) (*sqliteaccount.Store, *providers.Catalog, error) {
	catalog, e := providers.NewCatalog(providers.BuiltinManifest())
	if e != nil {
		return nil, nil, e
	}
	store, e := sqliteaccount.Open(ctx, sqliteaccount.OpenOptions{AIHomeDir: home, Catalog: catalog})
	return store, catalog, e
}
func Import(ctx context.Context, home string, request Request, dryRun bool) (Result, error) {
	result := Result{ProtocolVersion: 1, OK: false, Summary: map[string]int{"total": len(request.Accounts), "created": 0, "updated": 0, "unchanged": 0, "invalid": 0, "failed": 0}}
	if request.Kind != "aih-accounts" || request.Version != 1 || len(request.Accounts) > 5000 {
		return result, errors.New("backup_import_document_invalid")
	}
	adapter := portableaccount.New(nil, portableaccount.NewBuiltinStaticCredentialFactory(), nativeaccount.NewDecoder())
	// The entire document's credential shape is validated before opening SQLite.
	for _, entry := range request.Accounts {
		out := Outcome{Provider: entry.Provider, SourceRef: entry.AccountRef, Status: "planned"}
		credential, _, e := adapter.DecodeEntry(entry.Provider, entry)
		_, refErr := accountcore.ParseAccountRef(entry.AccountRef)
		alias, aliasErr := strconv.ParseInt(entry.CLIAccountID, 10, 64)
		if refErr != nil || entry.Provider != strings.ToLower(strings.TrimSpace(entry.Provider)) || (entry.CLIAccountID != "" && (aliasErr != nil || alias <= 0)) || e != nil || credential == nil || (entry.Status != "" && entry.Status != "up" && entry.Status != "down") {
			out.Status = "invalid"
			out.Reason = "credential_shape_unsupported"
			result.Summary["invalid"]++
		}
		result.Accounts = append(result.Accounts, out)
	}
	if result.Summary["invalid"] > 0 {
		result.Error = "backup_import_preflight_failed"
		return result, nil
	}
	if dryRun {
		result.OK = true
		return result, nil
	}
	lease, e := accountwriterlease.Acquire(home)
	if e != nil {
		return result, e
	}
	defer lease.Close()
	store, catalog, e := open(ctx, home)
	if e != nil {
		return result, e
	}
	defer store.Close()
	return importAndProject(ctx, store, catalog, request, result)
}

func ImportInto(ctx context.Context, store Store, catalog *providers.Catalog, request Request, dryRun bool) (Result, error) {
	// Reuse the same side-effect-free credential preflight in HTTP and stdio.
	preflight, e := Import(ctx, "", request, true)
	if e != nil || !preflight.OK || dryRun {
		return preflight, e
	}
	return importAndProject(ctx, store, catalog, request, preflight)
}

type Store interface {
	remotebackup.ExportStore
	RestorePortableAccount(context.Context, string, string, accountapp.Credential, accountapp.PublicProfile, bool, json.RawMessage) (accountcore.Account, bool, error)
}

func importAndProject(ctx context.Context, store Store, catalog *providers.Catalog, request Request, initial Result) (Result, error) {
	result, err := importIntoStore(ctx, store, catalog, request, initial)
	if !request.CompatibilityProjection {
		return result, err
	}
	status := &ProjectionStatus{Protocol: CompatibilityProjectionProtocol, Status: "not_applied", CanonicalStatus: "none"}
	result.CompatibilityProjection = status
	if err != nil {
		result.OK = false
		result.Error = "backup_import_incomplete"
		status.CanonicalStatus = "unknown"
		status.OutcomeUnknown = true
		return result, nil
	}
	successes := result.Summary["created"] + result.Summary["updated"] + result.Summary["unchanged"]
	if result.canonicalCommitted {
		status.CanonicalStatus = "committed"
		if !result.OK {
			status.CanonicalStatus = "partial"
		}
	}
	if result.canonicalUncertain {
		status.CanonicalStatus = "unknown"
		status.OutcomeUnknown = true
	}
	projector, ok := store.(interface {
		ProjectBackupCompatibility(context.Context, []sqliteaccount.BackupCompatibilityRecord) (int, error)
	})
	if !ok {
		result.OK = false
		result.Error = "backup_core_mirror_incomplete"
		return result, nil
	}
	records := make([]sqliteaccount.BackupCompatibilityRecord, 0, successes)
	if result.Document != nil {
		for _, entry := range result.Document.Accounts {
			var outcome *Outcome
			for i := range result.Accounts {
				item := &result.Accounts[i]
				if item.AccountRef == entry.AccountRef && item.Status != "failed" && item.Status != "invalid" {
					outcome = item
					break
				}
			}
			if outcome == nil {
				result.OK = false
				result.Error = "backup_core_mirror_incomplete"
				return result, nil
			}
			env, encodeErr := json.Marshal(entry.Env)
			if encodeErr != nil {
				result.OK = false
				result.Error = "backup_core_mirror_incomplete"
				return result, nil
			}
			records = append(records, sqliteaccount.BackupCompatibilityRecord{AccountRef: entry.AccountRef, Provider: entry.Provider, CLIAccountID: entry.CLIAccountID, CredentialUpdatedAt: outcome.CredentialUpdatedAt, ProfileUpdatedAt: outcome.ProfileUpdatedAt, EnvJSON: env, NativeAuthJSON: entry.NativeAuth})
		}
	}
	// A failed canonical readback must not erase an earlier commit or advertise
	// an empty projection as complete. Preserve the partial/unknown outcome.
	if len(records) == 0 && (result.canonicalCommitted || result.canonicalUncertain) {
		result.OK = false
		result.Error = "backup_core_mirror_incomplete"
		return result, nil
	}
	applied, projectionErr := projector.ProjectBackupCompatibility(ctx, records)
	if projectionErr != nil {
		result.OK = false
		result.Error = "backup_core_mirror_incomplete"
		status.Status = "unknown"
		status.OutcomeUnknown = true
		return result, nil
	}
	status.Status = "applied"
	status.Applied = applied
	return result, nil
}

func importIntoStore(ctx context.Context, store Store, catalog *providers.Catalog, request Request, result Result) (Result, error) {
	adapter := portableaccount.New(nil, portableaccount.NewBuiltinStaticCredentialFactory(), nativeaccount.NewDecoder())
	result.Accounts = nil
	for _, entry := range request.Accounts {
		item := Outcome{Provider: entry.Provider, SourceRef: entry.AccountRef, Status: "failed"}
		credential, profile, decodeErr := adapter.DecodeEntry(entry.Provider, entry)
		if decodeErr != nil || credential == nil {
			item.Reason = "credential_shape_unsupported"
			result.Summary["failed"]++
			result.Accounts = append(result.Accounts, item)
			continue
		}
		var previousVersion int64
		if finder, ok := store.(interface {
			FindCredentialSnapshotByIdentity(context.Context, accountapp.Credential) (accountapp.CredentialSnapshot, bool, error)
		}); ok {
			before, found, readErr := finder.FindCredentialSnapshotByIdentity(ctx, credential)
			if readErr != nil {
				return result, readErr
			}
			if found {
				previousVersion = before.UpdatedAt().UnixMilli()
			}
		}
		supplement, encodeErr := json.Marshal(map[string]any{"env": entry.Env, "nativeAuth": entry.NativeAuth})
		if encodeErr != nil {
			return result, encodeErr
		}
		account, created, importErr := store.RestorePortableAccount(ctx, entry.AccountRef, entry.CLIAccountID, credential, profile, entry.Status == "down", supplement)
		if importErr != nil {
			// Restore can fail during post-COMMIT readback. The result alone
			// does not authorize a claim of no write or an automatic retry.
			if request.CompatibilityProjection {
				result.canonicalUncertain = true
			}
			item.Reason = "canonical_restore_failed"
			result.Summary["failed"]++
		} else {
			if request.CompatibilityProjection {
				result.canonicalCommitted = true
			}
			item.AccountRef = account.Ref().String()
			item.CLIAccountID = strconv.FormatInt(account.CLIAccountID().Int64(), 10)
			item.Status = "unchanged"
			if created {
				item.Status = "created"
			} else if previousVersion > 0 {
				next, readErr := store.GetCredentialSnapshot(ctx, account.Ref())
				if readErr != nil {
					return result, readErr
				}
				if next.UpdatedAt().UnixMilli() != previousVersion {
					item.Status = "updated"
				}
			}
			result.Summary[item.Status]++
		}
		result.Accounts = append(result.Accounts, item)
	}
	result.OK = result.Summary["failed"] == 0 && result.Summary["invalid"] == 0
	if !result.OK {
		result.Error = "backup_import_incomplete"
	}
	stored, e := (remotebackup.SQLiteAccountExporter{Store: store, Catalog: catalog}).ExportAccounts(ctx)
	if e != nil {
		return result, e
	}
	byRef := map[string]remotebackup.AccountRecord{}
	for _, record := range stored.Accounts {
		byRef[record.AccountRef] = record
	}
	result.Document = &Request{Kind: "aih-accounts", Version: 1, Accounts: []portableaccount.AihAccountsImportEntry{}}
	for i := range result.Accounts {
		item := &result.Accounts[i]
		if item.Status == "failed" || item.Status == "invalid" {
			continue
		}
		record, found := byRef[item.AccountRef]
		if !found {
			result.Summary[item.Status]--
			item.Status = "failed"
			item.Reason = "canonical_readback_failed"
			result.OK = false
			result.Error = "backup_import_incomplete"
			result.Summary["failed"]++
			continue
		}
		item.CLIAccountID = record.CLIAccountID
		item.CredentialUpdatedAt = record.CredentialUpdatedAt
		item.ProfileUpdatedAt = record.ProfileUpdatedAt
		raw, e := json.Marshal(record.NativeAuth)
		if e != nil {
			return result, e
		}
		result.Document.Accounts = append(result.Document.Accounts, portableaccount.AihAccountsImportEntry{Provider: record.Provider, AccountRef: record.AccountRef, CLIAccountID: record.CLIAccountID, Status: record.Status, Env: record.Env, NativeAuth: raw})
	}
	return result, nil
}

func Export(ctx context.Context, home string) (Result, error) {
	empty := Result{ProtocolVersion: 1, OK: true, Document: &Request{Kind: "aih-accounts", Version: 1, Accounts: []portableaccount.AihAccountsImportEntry{}}}
	path := filepath.Join(home, sqliteaccount.DatabaseFileName)
	if _, e := os.Stat(path); errors.Is(e, os.ErrNotExist) {
		return empty, nil
	} else if e != nil {
		return empty, e
	}
	// Do not initialize a core schema just because the legacy-only source exists.
	uri := sqlitefile.URL(path)
	q := uri.Query()
	q.Set("mode", "ro")
	uri.RawQuery = q.Encode()
	db, e := sql.Open("sqlite", uri.String())
	if e != nil {
		return empty, e
	}
	var count int
	e = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='accounts'").Scan(&count)
	db.Close()
	if e != nil {
		return empty, e
	}
	if count == 0 {
		return empty, nil
	}
	catalog, e := providers.NewCatalog(providers.BuiltinManifest())
	if e != nil {
		return empty, e
	}
	store, e := sqliteaccount.OpenReadOnly(ctx, home, catalog)
	if e != nil {
		return empty, e
	}
	defer store.Close()
	exported, e := (remotebackup.SQLiteAccountExporter{Store: store, Catalog: catalog}).ExportAccounts(ctx)
	if e != nil {
		return empty, e
	}
	for _, record := range exported.Accounts {
		raw, e := json.Marshal(record.NativeAuth)
		if e != nil {
			return empty, e
		}
		empty.Document.Accounts = append(empty.Document.Accounts, portableaccount.AihAccountsImportEntry{Provider: record.Provider, AccountRef: record.AccountRef, CLIAccountID: record.CLIAccountID, Status: record.Status, Env: record.Env, NativeAuth: raw})
	}
	empty.Skipped = exported.Skipped
	return empty, nil
}
