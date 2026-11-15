package codexdefault

import (
	"bytes"
	"context"
	"fmt"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/internal/adapters/accounts/sqliteaccount"
	"github.com/madou1217/ai_home/internal/adapters/codex/authfile"
	codexstorage "github.com/madou1217/ai_home/internal/adapters/providerstorage/codex"
	"time"
)

func adoptNewerHostCredential(ctx context.Context, store *sqliteaccount.Store, current accountapp.CredentialSnapshot, host fileSnapshot) (accountapp.CredentialSnapshot, error) {
	stored, ok := current.Credential().(*codex.OAuthAuth)
	if !ok || !host.Existed {
		return current, nil
	}
	nextAuth, err := authfile.Decode(host.Data, authfile.DecodeOptions{})
	if err != nil {
		return current, fmt.Errorf("codex_host_auth_invalid")
	}
	next, ok := nextAuth.(*codex.OAuthAuth)
	if !ok || next.IdentitySeed() != stored.IdentitySeed() {
		return current, nil
	}
	a, _ := authfile.Encode(stored)
	b, _ := authfile.Encode(next)
	if bytes.Equal(a, b) {
		return current, nil
	}
	if next.RefreshedAtMS() == stored.RefreshedAtMS() {
		return current, fmt.Errorf("codex_native_auth_update_in_progress")
	}
	if !(codexstorage.Materializer{}).ShouldAdopt(stored, next) {
		return current, nil
	}
	now := time.Now().UTC().Truncate(time.Millisecond)
	if !now.After(current.UpdatedAt()) {
		now = current.UpdatedAt().Add(time.Millisecond)
	}
	replacement, err := accountapp.NewCredentialReplacement(current, next, now)
	if err != nil {
		return current, err
	}
	if err := store.ReplaceCredential(ctx, replacement); err != nil {
		return current, err
	}
	return store.GetCredentialSnapshot(ctx, current.AccountRef())
}

func adoptOutgoingHostCredential(ctx context.Context, store *sqliteaccount.Store, host fileSnapshot) error {
	if !host.Existed {
		return nil
	}
	auth, err := authfile.Decode(host.Data, authfile.DecodeOptions{})
	if err != nil {
		return fmt.Errorf("codex_host_auth_invalid")
	}
	oauth, ok := auth.(*codex.OAuthAuth)
	if !ok {
		return nil
	}
	current, found, err := store.FindCredentialSnapshotByIdentity(ctx, oauth)
	if err != nil {
		return err
	}
	// An unregistered login cannot be silently destroyed just to change the
	// selection. Import it first, so its refreshed generation remains recoverable.
	if !found {
		return fmt.Errorf("codex_host_oauth_not_registered_import_first")
	}
	_, err = adoptNewerHostCredential(ctx, store, current, host)
	return err
}
