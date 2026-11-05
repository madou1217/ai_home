package sqliteaccount

import (
	"context"
	"errors"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/core/providers"
)

func openUsageDocumentStore(t *testing.T) (*Store, accountcore.AccountRef) {
	t.Helper()
	ctx := context.Background()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(ctx, OpenOptions{AIHomeDir: t.TempDir(), Catalog: catalog})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: accountRef, ProviderID: "codex", CLIAccountID: 1, Enabled: true,
		CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	if err := store.Create(ctx, account); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	return store, accountRef
}

func newUsageDocument(t *testing.T, accountRef accountcore.AccountRef, capturedAtMS int64, payload string) usagecore.Document {
	t.Helper()
	document, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: "codex",
		Kind:       "codex_oauth_status",
		Source:     "codex_read_rate_limits",
		CapturedAt: time.UnixMilli(capturedAtMS).UTC(),
		Payload:    []byte(payload),
	})
	if err != nil {
		t.Fatalf("NewDocument() error = %v", err)
	}
	return document
}

func TestUsageDocumentRoundTripKeepsPayloadVerbatim(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	payload := `{"schemaVersion":2,"kind":"codex_oauth_status","capturedAt":1000,"entries":[{"bucket":"primary","remainingPct":42.5}],"account":{"planType":"team"}}`
	if err := store.ReplaceUsageDocument(ctx, newUsageDocument(t, accountRef, 1000, payload)); err != nil {
		t.Fatalf("ReplaceUsageDocument() error = %v", err)
	}
	documents, err := store.ListUsageDocuments(ctx, usageapp.DocumentQuery{})
	if err != nil {
		t.Fatalf("ListUsageDocuments() error = %v", err)
	}
	if len(documents) != 1 {
		t.Fatalf("documents = %d, want 1", len(documents))
	}
	got := documents[0]
	if got.AccountRef() != accountRef || got.ProviderID() != "codex" {
		t.Fatalf("document identity = %s/%s", got.AccountRef(), got.ProviderID())
	}
	if got.Kind() != "codex_oauth_status" || got.Source() != "codex_read_rate_limits" {
		t.Fatalf("document metadata = %s/%s", got.Kind(), got.Source())
	}
	if string(got.Payload()) != payload {
		t.Fatalf("payload changed:\n got %s\nwant %s", got.Payload(), payload)
	}
	if !got.CapturedAt().Equal(time.UnixMilli(1000).UTC()) {
		t.Fatalf("capturedAt = %s", got.CapturedAt())
	}
}

func TestUsageDocumentRejectsOlderCapture(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	if err := store.ReplaceUsageDocument(ctx, newUsageDocument(t, accountRef, 2000, `{"capturedAt":2000,"marker":"new"}`)); err != nil {
		t.Fatalf("ReplaceUsageDocument() error = %v", err)
	}
	if err := store.ReplaceUsageDocument(ctx, newUsageDocument(t, accountRef, 1000, `{"capturedAt":1000,"marker":"old"}`)); err != nil {
		t.Fatalf("stale ReplaceUsageDocument() error = %v", err)
	}
	documents, err := store.ListUsageDocuments(ctx, usageapp.DocumentQuery{})
	if err != nil {
		t.Fatalf("ListUsageDocuments() error = %v", err)
	}
	if len(documents) != 1 || documents[0].CapturedAt().UnixMilli() != 2000 {
		t.Fatalf("documents = %#v", documents)
	}
	if string(documents[0].Payload()) != `{"capturedAt":2000,"marker":"new"}` {
		t.Fatalf("stale document overwrote current: %s", documents[0].Payload())
	}
}

func TestUsageDocumentRejectsProviderMismatchAndMissingAccount(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	mismatched, err := usagecore.NewDocument(usagecore.DocumentInput{
		AccountRef: accountRef,
		ProviderID: "claude",
		CapturedAt: time.UnixMilli(1000).UTC(),
		Payload:    []byte(`{"capturedAt":1000}`),
	})
	if err != nil {
		t.Fatalf("NewDocument() error = %v", err)
	}
	if err := store.ReplaceUsageDocument(ctx, mismatched); !errors.Is(err, usagecore.ErrInvalidDocument) {
		t.Fatalf("provider mismatch error = %v", err)
	}
	missingRef, err := accountcore.ParseAccountRef("acct_ffffffffffffffffffff")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	if err := store.ReplaceUsageDocument(ctx, newUsageDocument(t, missingRef, 1000, `{"capturedAt":1000}`)); !errors.Is(err, accountapp.ErrAccountNotFound) {
		t.Fatalf("missing account error = %v", err)
	}
}

func TestUsageDocumentIsRemovedWithAccount(t *testing.T) {
	store, accountRef := openUsageDocumentStore(t)
	ctx := context.Background()
	if err := store.ReplaceUsageDocument(ctx, newUsageDocument(t, accountRef, 1000, `{"capturedAt":1000}`)); err != nil {
		t.Fatalf("ReplaceUsageDocument() error = %v", err)
	}
	if err := store.DeleteAccount(ctx, accountRef); err != nil {
		t.Fatalf("DeleteAccount() error = %v", err)
	}
	documents, err := store.ListUsageDocuments(ctx, usageapp.DocumentQuery{})
	if err != nil {
		t.Fatalf("ListUsageDocuments() error = %v", err)
	}
	if len(documents) != 0 {
		t.Fatalf("documents after delete = %d, want 0", len(documents))
	}
}

func TestUsageDocumentRejectsNonObjectPayload(t *testing.T) {
	_, accountRef := openUsageDocumentStore(t)
	for _, payload := range []string{`[]`, `"text"`, `null`, `{`, ``} {
		if _, err := usagecore.NewDocument(usagecore.DocumentInput{
			AccountRef: accountRef,
			ProviderID: "codex",
			CapturedAt: time.UnixMilli(1000).UTC(),
			Payload:    []byte(payload),
		}); !errors.Is(err, usagecore.ErrInvalidDocument) {
			t.Fatalf("payload %q error = %v", payload, err)
		}
	}
}
