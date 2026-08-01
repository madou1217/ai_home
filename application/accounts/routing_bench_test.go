package accounts_test

import (
	"fmt"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// BenchmarkRoutingCandidatesFindByRef10K 测量一万账号有序快照的固定账号定位成本。
func BenchmarkRoutingCandidatesFindByRef10K(benchmark *testing.B) {
	const accountCount = 10_000
	catalog := testCatalog(benchmark)
	accounts := make([]accountapp.RoutingAccount, 0, accountCount)
	for index := 1; index <= accountCount; index++ {
		accountRef, err := accountcore.ParseAccountRef(fmt.Sprintf("acct_%020x", index))
		if err != nil {
			benchmark.Fatalf("ParseAccountRef() error = %v", err)
		}
		cliAccountID, err := accountcore.NewCLIAccountID(int64(index))
		if err != nil {
			benchmark.Fatalf("NewCLIAccountID() error = %v", err)
		}
		account, err := accountapp.NewRoutingAccount(
			catalog,
			accountapp.RoutingAccountInput{
				Ref:          accountRef,
				ProviderID:   "codex",
				CLIAccountID: cliAccountID,
			},
		)
		if err != nil {
			benchmark.Fatalf("NewRoutingAccount() error = %v", err)
		}
		accounts = append(accounts, account)
	}
	snapshot := accountapp.NewRoutingCandidates(accounts)
	target := accounts[len(accounts)-1].Ref()

	benchmark.ReportAllocs()
	benchmark.ResetTimer()
	for range benchmark.N {
		account, found := snapshot.FindByRef(target)
		if !found || account.Ref() != target {
			benchmark.Fatal("FindByRef() 未找到目标账号")
		}
	}
}
