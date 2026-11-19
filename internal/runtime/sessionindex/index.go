// Package sessionindex defines the single-database session index used by the
// WebUI session list. Scanners materialize host session metadata here; readers
// never need a second database or a per-request full directory walk.
package sessionindex

import "context"

// Session is one indexed session row.
type Session struct {
	ID             string
	Title          string
	UpdatedAtMS    int64
	Provider       string
	ProjectDirName string
}

// Project groups indexed sessions by the same project identity the scanner
// already returns to the WebUI.
type Project struct {
	ID       string
	Name     string
	Path     string
	Provider string
	Sessions []Session
}

// Snapshot is one provider/account scan result.
//
// ScannedAtMS is the time the underlying host scan completed; Truncated means
// the scan hit its entry/time budget and the next refresh must run again.
type Snapshot struct {
	Projects    []Project
	ScannedAtMS int64
	Truncated   bool
}

// Store persists session snapshots in aih.db.
//
// The provider/accountRef pair is the read scope. Session history is shared
// across accounts for the current providers, but keeping the scope explicit
// preserves the route contract if a provider later becomes account-scoped.
type Store interface {
	LoadSessionIndex(ctx context.Context, provider, accountRef string) (Snapshot, bool, error)
	ReplaceSessionIndex(ctx context.Context, provider, accountRef string, snapshot Snapshot) error
}
