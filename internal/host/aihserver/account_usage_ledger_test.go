package aihserver

import (
	"context"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/inferencegateway"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/inference"
	"github.com/madou1217/ai_home/core/providers"
)

type testUsageLedgerAccountReader struct {
	account accountcore.Account
}

func (reader testUsageLedgerAccountReader) GetByRef(context.Context, accountcore.AccountRef) (accountcore.Account, error) {
	return reader.account, nil
}

func TestBuildUsageLedgerRecordResolvesProviderFromAccount(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	accountRef, _ := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref: accountRef, ProviderID: "codex", CLIAccountID: 1, Enabled: true,
		CreatedAt: time.UnixMilli(100).UTC(), UpdatedAt: time.UnixMilli(100).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	route, err := runtimecore.NewModelRoute(accountRef, "gpt-6.1-sol")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	usage, err := inference.NewUsage(inference.UsageInput{InputTokens: 10, OutputTokens: 5})
	if err != nil {
		t.Fatalf("NewUsage() error = %v", err)
	}
	success, err := inferencegateway.NewAttemptSuccess(time.UnixMilli(1000).UTC())
	if err != nil {
		t.Fatalf("NewAttemptSuccess() error = %v", err)
	}
	record, err := buildUsageLedgerRecord(context.Background(), testUsageLedgerAccountReader{account: account}, route, success.WithUsage(usage))
	if err != nil {
		t.Fatalf("buildUsageLedgerRecord() error = %v", err)
	}
	if record.Provider() != "codex" || record.Model() != "gpt-6.1-sol" || record.Usage().TotalTokens() != 15 {
		t.Fatalf("record = %#v", record)
	}
}
