// Package distributiondata prepares offline upgrade data without opening a live
// database with SQLite. The caller must stop all writers before Prepare, keep
// them stopped through VerifySource and publication, and own publication and
// rollback. A successful report is not a deployment or an account import.
package distributiondata

import (
	"github.com/madou1217/ai_home/core/providers"
)

// Options identifies the read-only source and an installer-owned transaction
// directory OUTSIDE Home. Prepare only creates a unique child of BackupDir.
// Catalog defaults to the built-in provider catalog. Config/key bootstrap is
// deliberately left to the installer, after preparation and before publication.
type Options struct {
	Home      string
	BackupDir string
	Catalog   *providers.Catalog
}

// SourceFingerprint covers aih.db and its WAL/SHM/rollback sidecars, including
// absent files. It must be checked again immediately before publish.
type SourceFingerprint struct {
	Home       string            `json:"home"`
	HomeExists bool              `json:"home_exists"`
	Files      []FileFingerprint `json:"files"`
}

type FileFingerprint struct {
	Name       string `json:"name"`
	Exists     bool   `json:"exists"`
	Size       int64  `json:"size"`
	Mode       uint32 `json:"mode"`
	ModifiedNS int64  `json:"modified_ns"`
	SHA256     string `json:"sha256,omitempty"`
}

// TableCheck contains counts, never database values or credentials. Equality is
// checked with EXCEPT in both directions (and grouped multiplicities), not just
// row counts. Legacy target checks allow the conflict-free union of split data.
type TableCheck struct {
	Source string `json:"source"`
	Target string `json:"target"`
	Rows   int64  `json:"rows"`
	Check  string `json:"check"`
}

type AccountReport struct {
	SchemaInitialized        bool     `json:"schema_initialized"`
	InitializedDuringPrepare bool     `json:"initialized_during_prepare"`
	BeforeAccounts           int64    `json:"before_accounts"`
	BeforeCredentials        int64    `json:"before_credentials"`
	CanonicalAccounts        int64    `json:"canonical_accounts"`
	CanonicalCredentials     int64    `json:"canonical_credentials"`
	CompatibilityAccounts    int64    `json:"compatibility_accounts"`
	CompatibilityCredentials int64    `json:"compatibility_credentials"`
	NodeImportPerformed      bool     `json:"node_import_performed"`
	NodeImportDeferred       bool     `json:"node_import_deferred"`
	ImportGuidance           []string `json:"import_guidance"`
}

// Report describes private artifacts. PreparedHome contains only standalone
// SQLite files, ready for the installer's config bootstrap and atomic publish.
// BackupHome contains consistent, PRE-MIGRATION databases under original names;
// OriginalBackup also preserves the exact source DB/sidecar bytes. Missing
// original files are recorded in SourceFingerprint (rollback must not invent
// them). Neither backup directory may be passed to a normal application writer.
// AlreadyReady describes the input's required schema capabilities; it
// does NOT authorize skipping publication of the prepared result.
// Fresh only means neither source database existed; Home may still contain
// existing keys/configuration or native artifacts owned by the installer.
type Report struct {
	State             string            `json:"state"`
	SourceState       string            `json:"source_state"`
	Home              string            `json:"home"`
	PreparedHome      string            `json:"prepared_home"`
	BackupHome        string            `json:"backup_home"`
	OriginalBackup    string            `json:"original_backup"`
	ReportPath        string            `json:"report_path"`
	FingerprintPath   string            `json:"fingerprint_path"`
	SourceFingerprint SourceFingerprint `json:"source_fingerprint"`
	AlreadyReady      bool              `json:"already_ready"`
	Fresh             bool              `json:"fresh"`
	ApplicationID     int               `json:"application_id"`
	Checks            []TableCheck      `json:"checks"`
	Accounts          AccountReport     `json:"accounts"`
	Error             string            `json:"error,omitempty"`
}
