package accounts_test

import (
	"fmt"
	"runtime"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func BenchmarkDeriveAccountRef(b *testing.B) {
	source := testIdentitySource{
		providerID:   "codex",
		identitySeed: "oauth:codex:benchmark-user:personal",
	}

	b.ReportAllocs()
	for range b.N {
		accountRef, err := accounts.DeriveAccountRef(source)
		if err != nil {
			b.Fatal(err)
		}
		runtime.KeepAlive(accountRef)
	}
}

func BenchmarkCreateTenThousandAccounts(b *testing.B) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		b.Fatal(err)
	}
	createdAt := time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	sources := make([]testIdentitySource, 10_000)
	aliases := make([]accounts.CLIAccountID, 10_000)
	for index := range sources {
		sources[index] = testIdentitySource{
			providerID:   "codex",
			identitySeed: fmt.Sprintf("oauth:codex:benchmark-user-%d:personal", index),
		}
		aliases[index], err = accounts.NewCLIAccountID(int64(index + 1))
		if err != nil {
			b.Fatal(err)
		}
	}

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		snapshots := make([]accounts.Account, 0, len(sources))
		for index, source := range sources {
			account, createErr := accounts.NewAccount(catalog, accounts.NewAccountInput{
				Identity:     source,
				CLIAccountID: aliases[index],
				CreatedAt:    createdAt,
			})
			if createErr != nil {
				b.Fatal(createErr)
			}
			snapshots = append(snapshots, account)
		}
		runtime.KeepAlive(snapshots)
	}
}

func BenchmarkFilterTenThousandAccountSnapshots(b *testing.B) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		b.Fatal(err)
	}
	createdAt := time.Date(2026, time.July, 27, 0, 0, 0, 0, time.UTC)
	snapshots := make([]accounts.Account, 0, 10_000)
	for index := range 10_000 {
		alias, aliasErr := accounts.NewCLIAccountID(int64(index + 1))
		if aliasErr != nil {
			b.Fatal(aliasErr)
		}
		account, createErr := accounts.NewAccount(catalog, accounts.NewAccountInput{
			Identity: testIdentitySource{
				providerID:   "codex",
				identitySeed: fmt.Sprintf("oauth:codex:filter-user-%d:personal", index),
			},
			CLIAccountID: alias,
			CreatedAt:    createdAt,
		})
		if createErr != nil {
			b.Fatal(createErr)
		}
		snapshots = append(snapshots, account)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		matched := 0
		for _, account := range snapshots {
			if account.Enabled() && account.ProviderID() == "codex" {
				matched++
			}
		}
		if matched != len(snapshots) {
			b.Fatalf("matched = %d, want %d", matched, len(snapshots))
		}
		runtime.KeepAlive(matched)
	}
}
