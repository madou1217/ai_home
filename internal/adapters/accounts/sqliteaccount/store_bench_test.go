package sqliteaccount

import (
	"context"
	"fmt"
	"math/big"
	"net/http"
	"testing"

	"github.com/madou1217/ai_home/application/accountcredentials"
	"github.com/madou1217/ai_home/application/accountrouting"
	runtimeapp "github.com/madou1217/ai_home/application/accountruntime"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accountauth/codexoauth"
)

func BenchmarkStoreQueries(benchmark *testing.B) {
	for _, accountCount := range []int{10_000, 100_000} {
		benchmark.Run(fmt.Sprintf("accounts_%d", accountCount), func(benchmark *testing.B) {
			store := openBenchmarkStore(benchmark)
			seedBenchmarkAccounts(benchmark, store, accountCount)
			middleAccountRef := benchmarkAccountRef(benchmark, accountCount/2)
			middleAlias, err := accountcore.NewCLIAccountID(int64(accountCount/2 + 1))
			if err != nil {
				benchmark.Fatalf("NewCLIAccountID() error = %v", err)
			}
			firstPageQuery, err := accountapp.NewRoutingQuery(
				store.catalog,
				"codex",
				"",
				accountapp.DefaultRoutingLimit,
			)
			if err != nil {
				benchmark.Fatalf("NewRoutingQuery() error = %v", err)
			}
			recruiter, recruitRequest := prepareRecruitmentBenchmark(
				benchmark,
				store,
				accountCount,
			)

			benchmark.Run("account_ref", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					if _, err := store.GetByRef(context.Background(), middleAccountRef); err != nil {
						benchmark.Fatalf("GetByRef() error = %v", err)
					}
				}
			})
			benchmark.Run("cli_alias", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					if _, err := store.GetByCLIAccountID(
						context.Background(),
						"codex",
						middleAlias,
					); err != nil {
						benchmark.Fatalf("GetByCLIAccountID() error = %v", err)
					}
				}
			})
			benchmark.Run("routing_limit_32", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					candidates, err := store.ListRoutingCandidates(
						context.Background(),
						firstPageQuery,
					)
					if err != nil {
						benchmark.Fatalf("ListRoutingCandidates() error = %v", err)
					}
					if len(candidates) != accountapp.DefaultRoutingLimit {
						benchmark.Fatalf(
							"candidate count = %d, want %d",
							len(candidates),
							accountapp.DefaultRoutingLimit,
						)
					}
				}
			})
			benchmark.Run("load_all_compact", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					candidates := loadAllBenchmarkCandidates(benchmark, store)
					if len(candidates) != accountCount {
						benchmark.Fatalf(
							"candidate count = %d, want %d",
							len(candidates),
							accountCount,
						)
					}
				}
			})
			benchmark.Run("recruit_ready_account", func(benchmark *testing.B) {
				benchmark.ReportAllocs()
				for range benchmark.N {
					result, recruitErr := recruiter.Recruit(
						context.Background(),
						recruitRequest,
					)
					if recruitErr != nil {
						benchmark.Fatalf("Recruit() error = %v", recruitErr)
					}
					if result.Examined() != 1 || result.Credential() == nil {
						benchmark.Fatalf("Recruit() result = %#v", result)
					}
				}
			})
		})
	}
}

// prepareRecruitmentBenchmark 在普通账号之外注册一个可稳定点查的真实凭据账号。
func prepareRecruitmentBenchmark(
	benchmark *testing.B,
	store *Store,
	accountCount int,
) (*accountrouting.Recruiter, accountrouting.Request) {
	benchmark.Helper()

	maxSeededRef := fmt.Sprintf("acct_%020x", accountCount)
	var credential *codex.APIKeyAuth
	for suffix := 0; suffix < 100; suffix++ {
		candidate, err := codex.NewAPIKeyAuth(codex.APIKeyInput{
			APIKey: fmt.Sprintf(
				"synthetic-recruitment-benchmark-%d",
				suffix,
			),
		})
		if err != nil {
			benchmark.Fatalf("codex.NewAPIKeyAuth() error = %v", err)
		}
		accountRef, err := accountcore.DeriveAccountRef(candidate)
		if err != nil {
			benchmark.Fatalf("DeriveAccountRef() error = %v", err)
		}
		if accountRef.String() > maxSeededRef {
			credential = candidate
			break
		}
	}
	if credential == nil {
		benchmark.Fatal("未找到可隔离点查的征召基准账号")
	}
	cliAccountID, err := accountcore.NewCLIAccountID(int64(accountCount + 1))
	if err != nil {
		benchmark.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(
		store.catalog,
		accountcore.NewAccountInput{
			Identity:     credential,
			CLIAccountID: cliAccountID,
			CreatedAt:    testAccountTime(),
		},
	)
	if err != nil {
		benchmark.Fatalf("NewAccount() error = %v", err)
	}
	registration, err := accountapp.NewRegistration(
		account,
		credential,
		testAccountTime(),
	)
	if err != nil {
		benchmark.Fatalf("NewRegistration() error = %v", err)
	}
	if err := store.Register(context.Background(), registration); err != nil {
		benchmark.Fatalf("Register() error = %v", err)
	}
	provider, err := codexoauth.New(&http.Client{}, testAccountTime)
	if err != nil {
		benchmark.Fatalf("codexoauth.New() error = %v", err)
	}
	resolver, err := accountcredentials.NewResolver(
		accountcredentials.Dependencies{
			Store: store,
			Strategies: []accountcredentials.RefreshStrategy{
				provider,
			},
			Clock: testAccountTime,
		},
	)
	if err != nil {
		benchmark.Fatalf("NewResolver() error = %v", err)
	}
	runtimeRegistry, err := runtimeapp.NewRegistry(testAccountTime)
	if err != nil {
		benchmark.Fatalf("accountruntime.NewRegistry() error = %v", err)
	}
	recruiter, err := accountrouting.NewRecruiter(
		accountrouting.Dependencies{
			Candidates:  store,
			Runtime:     runtimeRegistry,
			Credentials: resolver,
		},
	)
	if err != nil {
		benchmark.Fatalf("NewRecruiter() error = %v", err)
	}
	afterRef := previousAccountRef(benchmark, account.Ref())
	request, err := accountrouting.NewRequest(
		store.catalog,
		"codex",
		"gpt-5.6-sol",
		afterRef,
		accountapp.DefaultRoutingLimit,
	)
	if err != nil {
		benchmark.Fatalf("NewRequest() error = %v", err)
	}
	return recruiter, request
}

// previousAccountRef 返回字典序紧邻目标之前的合法 AccountRef。
func previousAccountRef(
	benchmark *testing.B,
	target accountcore.AccountRef,
) accountcore.AccountRef {
	benchmark.Helper()

	value, valid := new(big.Int).SetString(target.String()[5:], 16)
	if !valid || value.Sign() <= 0 {
		benchmark.Fatalf("target AccountRef = %q", target)
	}
	value.Sub(value, big.NewInt(1))
	accountRef, err := accountcore.ParseAccountRef(
		fmt.Sprintf("acct_%020x", value),
	)
	if err != nil {
		benchmark.Fatalf("ParseAccountRef(previous) error = %v", err)
	}
	return accountRef
}

// openBenchmarkStore 为每个账号规模创建相互隔离的真实 SQLite 文件。
func openBenchmarkStore(benchmark *testing.B) *Store {
	benchmark.Helper()

	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		benchmark.Fatalf("NewCatalog() error = %v", err)
	}
	store, err := Open(context.Background(), OpenOptions{
		AIHomeDir: benchmark.TempDir(),
		Catalog:   catalog,
	})
	if err != nil {
		benchmark.Fatalf("Open() error = %v", err)
	}
	benchmark.Cleanup(func() {
		_ = store.Close()
	})
	return store
}

// seedBenchmarkAccounts 在计时前批量写入满足 v1 约束的紧凑账号行。
func seedBenchmarkAccounts(
	benchmark *testing.B,
	store *Store,
	accountCount int,
) {
	benchmark.Helper()

	transaction, err := store.db.Begin()
	if err != nil {
		benchmark.Fatalf("Begin() error = %v", err)
	}
	defer func() {
		_ = transaction.Rollback()
	}()

	statement, err := transaction.Prepare(`
		INSERT INTO accounts (
			account_ref, provider_id, cli_account_id, enabled,
			created_at_ms, updated_at_ms
		) VALUES (?, 'codex', ?, 1, 1785110400000, 1785110400000)`)
	if err != nil {
		benchmark.Fatalf("Prepare() error = %v", err)
	}
	defer func() {
		_ = statement.Close()
	}()

	for index := 0; index < accountCount; index++ {
		accountRef := fmt.Sprintf("acct_%020x", index+1)
		if _, err := statement.Exec(accountRef, index+1); err != nil {
			benchmark.Fatalf("insert account %d error = %v", index, err)
		}
	}
	if err := transaction.Commit(); err != nil {
		benchmark.Fatalf("Commit() error = %v", err)
	}
	if _, err := store.db.Exec("ANALYZE accounts"); err != nil {
		benchmark.Fatalf("ANALYZE accounts error = %v", err)
	}
}

// benchmarkAccountRef 返回基准数据中已经存在的稳定账号身份。
func benchmarkAccountRef(
	benchmark *testing.B,
	index int,
) accountcore.AccountRef {
	benchmark.Helper()

	accountRef, err := accountcore.ParseAccountRef(fmt.Sprintf("acct_%020x", index+1))
	if err != nil {
		benchmark.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

// loadAllBenchmarkCandidates 使用生产 keyset 查询加载全部紧凑征召投影。
func loadAllBenchmarkCandidates(
	benchmark *testing.B,
	store *Store,
) []accountapp.RoutingAccount {
	benchmark.Helper()

	var afterRef accountcore.AccountRef
	var candidates []accountapp.RoutingAccount
	for {
		query, err := accountapp.NewRoutingQuery(
			store.catalog,
			"codex",
			afterRef,
			accountapp.MaxRoutingLimit,
		)
		if err != nil {
			benchmark.Fatalf("NewRoutingQuery() error = %v", err)
		}
		page, err := store.ListRoutingCandidates(context.Background(), query)
		if err != nil {
			benchmark.Fatalf("ListRoutingCandidates() error = %v", err)
		}
		candidates = append(candidates, page...)
		if len(page) < accountapp.MaxRoutingLimit {
			return candidates
		}
		afterRef = page[len(page)-1].Ref()
	}
}
