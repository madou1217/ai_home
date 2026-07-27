package sqliteaccount

import (
	"context"
	"fmt"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

// BenchmarkAccountReadModels 测量公开资料点查和账号管理 keyset 分页成本。
func BenchmarkAccountReadModels(benchmark *testing.B) {
	for _, accountCount := range []int{10_000, 100_000} {
		benchmark.Run(fmt.Sprintf("accounts_%d", accountCount), func(benchmark *testing.B) {
			store := openBenchmarkStore(benchmark)
			targetRef := seedBenchmarkAccountProfiles(benchmark, store, accountCount)
			firstPageQuery, err := accountapp.NewOverviewQuery(
				"",
				accountapp.DefaultOverviewLimit,
			)
			if err != nil {
				benchmark.Fatalf("NewOverviewQuery() error = %v", err)
			}

			benchmark.Run("profile_by_ref", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					if _, err := store.GetProfile(
						context.Background(),
						targetRef,
					); err != nil {
						benchmark.Fatalf("GetProfile() error = %v", err)
					}
				}
			})
			benchmark.Run("overview_limit_50", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					overviews, err := store.ListAccountOverviews(
						context.Background(),
						firstPageQuery,
					)
					if err != nil {
						benchmark.Fatalf("ListAccountOverviews() error = %v", err)
					}
					if len(overviews) != accountapp.DefaultOverviewLimit {
						benchmark.Fatalf(
							"overview count = %d, want %d",
							len(overviews),
							accountapp.DefaultOverviewLimit,
						)
					}
				}
			})
			benchmark.Run("overview_by_ref", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					if _, err := store.GetAccountOverview(
						context.Background(),
						targetRef,
					); err != nil {
						benchmark.Fatalf("GetAccountOverview() error = %v", err)
					}
				}
			})
			benchmark.Run("overview_load_all", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					overviews := loadAllBenchmarkOverviews(benchmark, store)
					if len(overviews) != accountCount {
						benchmark.Fatalf(
							"overview count = %d, want %d",
							len(overviews),
							accountCount,
						)
					}
				}
			})
		})
	}
}

// seedBenchmarkAccountProfiles 写入身份一致的 Codex 合成账号和公开资料。
func seedBenchmarkAccountProfiles(
	benchmark *testing.B,
	store *Store,
	accountCount int,
) accountcore.AccountRef {
	benchmark.Helper()

	transaction, err := store.db.Begin()
	if err != nil {
		benchmark.Fatalf("Begin() error = %v", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()

	accountStatement, err := transaction.Prepare(`
		INSERT INTO accounts (
			account_ref, provider_id, cli_account_id, enabled,
			created_at_ms, updated_at_ms
		) VALUES (?, 'codex', ?, 1, 1785110400000, 1785110400000)`)
	if err != nil {
		benchmark.Fatalf("prepare account insert error = %v", err)
	}
	defer func() {
		_ = accountStatement.Close()
	}()
	profileStatement, err := transaction.Prepare(`
		INSERT INTO account_profiles (
			account_ref, display_name, email, subscription_kind,
			subscription_raw, format_version, profile_json, updated_at_ms
		) VALUES (?, ?, ?, ?, ?, 1, ?, 1785110400000)`)
	if err != nil {
		benchmark.Fatalf("prepare profile insert error = %v", err)
	}
	defer func() {
		_ = profileStatement.Close()
	}()

	var targetRef accountcore.AccountRef
	for index := 0; index < accountCount; index++ {
		profile, err := codex.NewAccountProfile(codex.Profile{
			UserID:    fmt.Sprintf("benchmark-user-%06d", index+1),
			AccountID: codex.PersonalAccountID,
			Email:     "benchmark@example.invalid",
			Plan:      codex.ParsePlan("plus"),
		})
		if err != nil {
			benchmark.Fatalf("NewAccountProfile(%d) error = %v", index, err)
		}
		accountRef, err := accountcore.DeriveAccountRef(profile)
		if err != nil {
			benchmark.Fatalf("DeriveAccountRef(%d) error = %v", index, err)
		}
		document, err := store.profiles.Encode(profile)
		if err != nil {
			benchmark.Fatalf("Encode(%d) error = %v", index, err)
		}
		if _, err := accountStatement.Exec(accountRef.String(), index+1); err != nil {
			benchmark.Fatalf("insert account %d error = %v", index, err)
		}
		if _, err := profileStatement.Exec(
			accountRef.String(),
			document.displayName,
			document.email,
			document.subscriptionKind,
			document.subscriptionRaw,
			string(document.json),
		); err != nil {
			benchmark.Fatalf("insert profile %d error = %v", index, err)
		}
		if index == accountCount/2 {
			targetRef = accountRef
		}
	}
	if err := transaction.Commit(); err != nil {
		benchmark.Fatalf("Commit() error = %v", err)
	}
	if _, err := store.db.Exec("ANALYZE"); err != nil {
		benchmark.Fatalf("ANALYZE error = %v", err)
	}
	return targetRef
}

// loadAllBenchmarkOverviews 使用生产 keyset 查询加载全部账号管理投影。
func loadAllBenchmarkOverviews(
	benchmark *testing.B,
	store *Store,
) []accountapp.AccountOverview {
	benchmark.Helper()

	var afterRef accountcore.AccountRef
	var overviews []accountapp.AccountOverview
	for {
		query, err := accountapp.NewOverviewQuery(
			afterRef,
			accountapp.MaxOverviewLimit,
		)
		if err != nil {
			benchmark.Fatalf("NewOverviewQuery() error = %v", err)
		}
		page, err := store.ListAccountOverviews(context.Background(), query)
		if err != nil {
			benchmark.Fatalf("ListAccountOverviews() error = %v", err)
		}
		overviews = append(overviews, page...)
		if len(page) < accountapp.MaxOverviewLimit {
			return overviews
		}
		afterRef = page[len(page)-1].Account().Ref()
	}
}
