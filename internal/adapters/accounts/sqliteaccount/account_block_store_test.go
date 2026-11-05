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

func TestAccountBlockRoundTripAndDelete(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	now := time.UnixMilli(1_000_000).UTC()
	block, err := runtimecore.NewAccountBlock(runtimecore.AccountBlockInput{
		AccountRef: accountRef,
		Kind:       runtimecore.FailureRateLimited,
		Scope:      runtimecore.BlockScopeAccount,
		Reason:     "rate_limited",
		ObservedAt: now,
		Until:      now.Add(5 * time.Hour),
	})
	if err != nil {
		t.Fatalf("NewAccountBlock() error = %v", err)
	}
	if err := store.ReplaceAccountBlock(ctx, block); err != nil {
		t.Fatalf("ReplaceAccountBlock() error = %v", err)
	}
	blocks, err := store.ListAccountBlocks(ctx)
	if err != nil || len(blocks) != 1 {
		t.Fatalf("ListAccountBlocks() = %v, %v", blocks, err)
	}
	if blocks[0].Kind() != runtimecore.FailureRateLimited || blocks[0].Reason() != "rate_limited" {
		t.Fatalf("block = %#v", blocks[0])
	}
	if err := store.DeleteAccountBlock(ctx, accountRef, runtimecore.FailureRateLimited); err != nil {
		t.Fatalf("DeleteAccountBlock() error = %v", err)
	}
	blocks, _ = store.ListAccountBlocks(ctx)
	if len(blocks) != 0 {
		t.Fatalf("blocks after delete = %d", len(blocks))
	}
}

func TestAccountBlockRejectsMissingAccount(t *testing.T) {
	store, _ := openUsageDocumentStore(t)
	ctx := context.Background()
	missingRef, _ := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	now := time.UnixMilli(1_000_000).UTC()
	block, err := runtimecore.NewAccountBlock(runtimecore.AccountBlockInput{
		AccountRef: missingRef,
		Kind:       runtimecore.FailureCredentialRejected,
		Scope:      runtimecore.BlockScopeAccount,
		ObservedAt: now,
		Until:      now.Add(time.Minute),
	})
	if err != nil {
		t.Fatalf("NewAccountBlock() error = %v", err)
	}
	if err := store.ReplaceAccountBlock(ctx, block); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("missing account error = %v", err)
	}
}

func TestAccountBlockCascadesWithAccountDelete(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	now := time.UnixMilli(1_000_000).UTC()
	block, _ := runtimecore.NewAccountBlock(runtimecore.AccountBlockInput{
		AccountRef: accountRef,
		Kind:       runtimecore.FailureCredentialRejected,
		Scope:      runtimecore.BlockScopeAccount,
		ObservedAt: now,
		Until:      now.Add(time.Minute),
	})
	if err := store.ReplaceAccountBlock(ctx, block); err != nil {
		t.Fatalf("ReplaceAccountBlock() error = %v", err)
	}
	if err := store.DeleteAccount(ctx, accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	blocks, _ := store.ListAccountBlocks(ctx)
	if len(blocks) != 0 {
		t.Fatalf("blocks after account delete = %d", len(blocks))
	}
}
