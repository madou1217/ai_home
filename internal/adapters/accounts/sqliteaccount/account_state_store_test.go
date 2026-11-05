package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func TestAccountStateRoundTripOverwriteAndDelete(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	state := newTestAccountState(t, accountRef, `{"rateLimitUntil":30000,"lastFailureKind":"rate_limited","lastFailureAt":10000,"lastFailureReason":"429"}`, 1_700_000_000_000)
	if err := replaceTestAccountState(ctx, store, state); err != nil {
		t.Fatalf("ReplaceAccountState() error = %v", err)
	}
	loaded, err := store.GetAccountState(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetAccountState() error = %v", err)
	}
	status := loaded.DeriveStatus(time.UnixMilli(20_000).UTC())
	if status.Status() != "rate_limited" || status.Until().UnixMilli() != 30_000 {
		t.Fatalf("status = %q until = %d", status.Status(), status.Until().UnixMilli())
	}
	states, err := store.ListAccountStates(ctx)
	if err != nil || len(states) != 1 || states[0].AccountRef() != accountRef {
		t.Fatalf("ListAccountStates() = %v, %v", states, err)
	}
	blocks, err := store.ListAccountBlocks(ctx)
	if err != nil || len(blocks) != 1 {
		t.Fatalf("ListAccountBlocks() = %v, %v", blocks, err)
	}
	if blocks[0].Kind() != runtimecore.FailureRateLimited || blocks[0].Until().UnixMilli() != 30_000 {
		t.Fatalf("block = %#v", blocks[0])
	}

	replaced := newTestAccountState(t, accountRef, `{"authInvalidUntil":60000}`, 1_700_000_001_000)
	if err := replaceTestAccountState(ctx, store, replaced); err != nil {
		t.Fatalf("ReplaceAccountState() overwrite error = %v", err)
	}
	loaded, err = store.GetAccountState(ctx, accountRef)
	if err != nil {
		t.Fatalf("GetAccountState() after overwrite error = %v", err)
	}
	if status := loaded.DeriveStatus(time.UnixMilli(20_000).UTC()); status.Status() != "auth_invalid" {
		t.Fatalf("status after overwrite = %q", status.Status())
	}
	blocks, _ = store.ListAccountBlocks(ctx)
	if len(blocks) != 0 {
		t.Fatalf("blocks after overwrite = %d, want 0", len(blocks))
	}

	if err := store.DeleteAccountState(ctx, accountRef); err != nil {
		t.Fatalf("DeleteAccountState() error = %v", err)
	}
	if _, err := store.GetAccountState(ctx, accountRef); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("GetAccountState() after delete error = %v", err)
	}
	if err := store.DeleteAccountState(ctx, accountRef); err != nil {
		t.Fatalf("DeleteAccountState() second call error = %v", err)
	}
}

func TestAccountStateRejectsMissingAccount(t *testing.T) {
	store, _ := openUsageDocumentStore(t)
	missingRef, _ := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	state := newTestAccountState(t, missingRef, `{}`, 1_700_000_000_000)
	if err := replaceTestAccountState(context.Background(), store, state); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("missing account error = %v", err)
	}
}

func TestAccountStateCascadesWithAccountDelete(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	state := newTestAccountState(t, accountRef, `{"cooldownUntil":90000,"lastFailureKind":"rate_limited","lastFailureAt":10000}`, 1_700_000_000_000)
	if err := replaceTestAccountState(ctx, store, state); err != nil {
		t.Fatalf("ReplaceAccountState() error = %v", err)
	}
	if err := store.DeleteAccount(ctx, accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	states, err := store.ListAccountStates(ctx)
	if err != nil || len(states) != 0 {
		t.Fatalf("states after account delete = %d, %v", len(states), err)
	}
	blocks, _ := store.ListAccountBlocks(ctx)
	if len(blocks) != 0 {
		t.Fatalf("blocks after account delete = %d", len(blocks))
	}
}

func replaceTestAccountState(
	ctx context.Context,
	store *Store,
	state runtimecore.AccountState,
) error {
	block, hasBlock := state.DeriveBlock()
	if !hasBlock {
		return store.ReplaceAccountState(ctx, state, nil)
	}
	return store.ReplaceAccountState(ctx, state, &block)
}

func newTestAccountState(
	t *testing.T,
	accountRef accountcore.AccountRef,
	document string,
	updatedAtMS int64,
) runtimecore.AccountState {
	t.Helper()
	state, err := runtimecore.NewAccountState(runtimecore.AccountStateInput{
		AccountRef: accountRef,
		Document:   []byte(document),
		UpdatedAt:  time.UnixMilli(updatedAtMS).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountState() error = %v", err)
	}
	return state
}
