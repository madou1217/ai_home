// Package upstreamrulesadmin composes explicit, offline recovery of the Go
// upstream-rule authority. It never starts a server or initializes a database.
package upstreamrulesadmin

import (
	"context"
	"encoding/hex"
	"errors"
	"path/filepath"
	"strings"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/businessdb"
	"github.com/madou1217/ai_home/internal/runtime/accountwriterlease"
)

var ErrInvalidConfirmation = errors.New("upstream_rule_confirmation_invalid")

// Result deliberately omits account references, rules and credential content.
type Result struct {
	Source            string `json:"source"`
	SelectorVersion   int    `json:"selector_version"`
	AuthorityRevision int64  `json:"authority_revision"`
	Digest            string `json:"digest"`
	Accepted          int    `json:"accepted"`
	Skipped           int    `json:"skipped"`
}

func explicitHome(ctx context.Context, home string) (string, error) {
	// DatabasePath trims HOME while accountwriterlease deliberately does not.
	// Reject edge whitespace rather than lock a different directory.
	if ctx == nil || strings.TrimSpace(home) == "" || home != strings.TrimSpace(home) || !filepath.IsAbs(home) {
		return "", errors.New("upstream_rule_explicit_home_required")
	}
	cleaned := filepath.Clean(home)
	if cleaned != strings.TrimSpace(cleaned) {
		return "", errors.New("upstream_rule_explicit_home_required")
	}
	return cleaned, nil
}

// Plan opens only an existing canonical DB in mode=ro/query_only and takes a
// read-only snapshot. It does not call the marker-writing AuthoritySnapshot.
func Plan(ctx context.Context, home string) (plan rulesapp.LegacyPlan, err error) {
	home, err = explicitHome(ctx, home)
	if err != nil {
		return plan, err
	}
	store, err := sqliteaccount.OpenUpstreamRuleAdmin(ctx, home, false)
	if err != nil {
		return plan, publicError(err)
	}
	defer func() {
		if closeErr := store.Close(); closeErr != nil && err == nil {
			err = publicError(closeErr)
		}
	}()
	plan, err = sqliteaccount.NewUpstreamErrorRuleRepository(store).PlanLegacyRules(ctx)
	if err != nil {
		return rulesapp.LegacyPlan{}, publicError(err)
	}
	return plan, nil
}

// ConfirmLegacy requires the exact prior plan and excludes the daemon/offline
// writers with their existing lease. The repository re-reads the source, links,
// marker and canonical rows under BEGIN IMMEDIATE before staging the batch.
func ConfirmLegacy(ctx context.Context, home string, confirmation rulesapp.LegacyConfirmation) (result Result, err error) {
	home, err = explicitHome(ctx, home)
	if err != nil {
		return result, err
	}
	decoded, decodeErr := hex.DecodeString(confirmation.Digest)
	if confirmation.Source != rulesapp.LegacyRulesSource ||
		confirmation.SelectorVersion != rulesapp.LegacyRulesSelectorVersion ||
		confirmation.AuthorityRevision < 0 || decodeErr != nil || len(decoded) != 32 ||
		confirmation.Digest != strings.ToLower(confirmation.Digest) {
		return result, ErrInvalidConfirmation
	}
	// Check the existing DB before Acquire may create the standard lease file.
	// This handle is read-only; no ordinary Store.Open/migration path is used.
	preflight, err := sqliteaccount.OpenUpstreamRuleAdmin(ctx, home, false)
	if err != nil {
		return result, publicError(err)
	}
	if err := preflight.Close(); err != nil {
		return result, publicError(err)
	}
	lease, err := accountwriterlease.Acquire(home)
	if err != nil {
		return result, publicError(err)
	}
	defer func() {
		if closeErr := lease.Close(); closeErr != nil && err == nil {
			err = publicError(closeErr)
		}
	}()
	store, err := sqliteaccount.OpenUpstreamRuleAdmin(ctx, home, true)
	if err != nil {
		return result, publicError(err)
	}
	defer func() {
		if closeErr := store.Close(); closeErr != nil && err == nil {
			err = publicError(closeErr)
		}
	}()
	service, err := rulesapp.NewService(rulesapp.Options{Repository: sqliteaccount.NewUpstreamErrorRuleRepository(store)})
	if err != nil {
		return result, publicError(err)
	}
	imported, err := service.ImportAccounts(ctx, rulesapp.ImportRequest{Legacy: &confirmation})
	if err != nil {
		return result, publicError(err)
	}
	return Result{Source: confirmation.Source, SelectorVersion: confirmation.SelectorVersion,
		AuthorityRevision: imported.Revision, Digest: confirmation.Digest,
		Accepted: len(imported.AcceptedRefs), Skipped: len(imported.SkippedRefs)}, nil
}

// Keep SQL/parser errors (which can contain identifiers or source bytes) off
// the CLI. The recovery gates remain distinguishable by stable error codes.
func publicError(err error) error {
	for _, known := range []error{rulesapp.ErrSourcePlanChanged, rulesapp.ErrLegacySourceConfirmationRequired,
		rulesapp.ErrInvalidImport, accountwriterlease.ErrBusy, businessdb.ErrMigrationRequired,
		context.Canceled, context.DeadlineExceeded} {
		if errors.Is(err, known) {
			return known
		}
	}
	return errors.New("upstream_rule_admin_failed")
}
