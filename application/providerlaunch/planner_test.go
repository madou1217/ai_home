package providerlaunch_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountcredentials"
	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/codex"
	"github.com/madou1217/ai_home/core/providers"
)

// 编译期确认现有账号选择与凭据解析用例可以直接接入 Planner。
var (
	_ providerlaunch.AccountSelector    = (*accountapp.LaunchAccountSelector)(nil)
	_ providerlaunch.CredentialResolver = (*accountcredentials.Resolver)(nil)
)

// TestPlannerBuildsFromSelectionCredentialAndStrategy 验证固定三段主链及最终账号元数据。
func TestPlannerBuildsFromSelectionCredentialAndStrategy(t *testing.T) {
	account, binding := codexFixture(t, "sk-planner-success", 7)
	selection, err := accountapp.NewLaunchSelection(
		account,
		accountapp.LaunchSelectionSourceCLIAccountID,
	)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	result := testStrategyResult(t, codex.ProviderID)
	selector := &plannerSelector{selection: selection}
	resolver := &plannerCredentialResolver{binding: binding}
	strategy := &plannerStrategy{providerID: codex.ProviderID, result: result}
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
		Accounts:    selector,
		Credentials: resolver,
		Strategies:  []providerlaunch.Strategy{strategy},
	})
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}

	spec, err := planner.Build(context.Background(), accountapp.LaunchSelectionRequest{
		ProviderID:   codex.ProviderID,
		CLIAccountID: account.CLIAccountID(),
	})
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if !spec.IsValid() ||
		spec.Mode() != providerlaunch.LaunchModeNativeDirect ||
		spec.ProviderID() != codex.ProviderID ||
		spec.AccountRef() != account.Ref() ||
		spec.CLIAccountID() != account.CLIAccountID() ||
		spec.SelectionSource() != accountapp.LaunchSelectionSourceCLIAccountID ||
		spec.Binary() != "codex" {
		t.Fatalf("LaunchSpec = %v", spec)
	}
	if selector.calls != 1 || resolver.calls != 1 || strategy.calls != 1 ||
		resolver.lastAccountRef != account.Ref() {
		t.Fatalf(
			"调用链错误: selector=%d resolver=%d strategy=%d ref=%s",
			selector.calls,
			resolver.calls,
			strategy.calls,
			resolver.lastAccountRef,
		)
	}
	assertRedacted(t, spec, "sk-planner-success", specSecret)
}

// TestPlannerRejectsInvalidDependencies 验证缺失依赖、空策略和重复 Provider 均不能启动。
func TestPlannerRejectsInvalidDependencies(t *testing.T) {
	account, binding := codexFixture(t, "sk-planner-dependencies", 1)
	selection, err := accountapp.NewLaunchSelection(account, accountapp.LaunchSelectionSourceAccountRef)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	selector := &plannerSelector{selection: selection}
	resolver := &plannerCredentialResolver{binding: binding}
	strategy := &plannerStrategy{providerID: codex.ProviderID, result: testStrategyResult(t, codex.ProviderID)}
	tests := []struct {
		name         string
		dependencies providerlaunch.Dependencies
	}{
		{name: "缺少账号选择", dependencies: providerlaunch.Dependencies{Credentials: resolver, Strategies: []providerlaunch.Strategy{strategy}}},
		{name: "缺少凭据解析", dependencies: providerlaunch.Dependencies{Accounts: selector, Strategies: []providerlaunch.Strategy{strategy}}},
		{name: "缺少策略", dependencies: providerlaunch.Dependencies{Accounts: selector, Credentials: resolver}},
		{name: "重复策略", dependencies: providerlaunch.Dependencies{Accounts: selector, Credentials: resolver, Strategies: []providerlaunch.Strategy{strategy, strategy}}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := providerlaunch.NewPlanner(test.dependencies); !errors.Is(
				err,
				providerlaunch.ErrInvalidDependencies,
			) {
				t.Fatalf("NewPlanner() error = %v", err)
			}
		})
	}
}

// TestPlannerRejectsImplicitDefaultAccount 验证 Native 规划器不会读取 Provider 默认账号。
func TestPlannerRejectsImplicitDefaultAccount(t *testing.T) {
	account, binding := codexFixture(t, "sk-planner-default-rejected", 11)
	selection, err := accountapp.NewLaunchSelection(
		account,
		accountapp.LaunchSelectionSourceProviderDefault,
	)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	selector := &plannerSelector{selection: selection}
	resolver := &plannerCredentialResolver{binding: binding}
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
		Accounts:    selector,
		Credentials: resolver,
		Strategies: []providerlaunch.Strategy{
			&plannerStrategy{providerID: codex.ProviderID, result: testStrategyResult(t, codex.ProviderID)},
		},
	})
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	if _, err := planner.Build(context.Background(), accountapp.LaunchSelectionRequest{
		ProviderID: codex.ProviderID,
	}); !errors.Is(err, providerlaunch.ErrInvalidBuildRequest) {
		t.Fatalf("Build(default) error = %v", err)
	}
	if selector.calls != 0 || resolver.calls != 0 {
		t.Fatalf("隐式默认账号越过模式边界: selector=%d resolver=%d", selector.calls, resolver.calls)
	}
}

// TestPlannerFailsClosedOnBoundaryMismatch 验证无效选择、缺失策略、错绑凭据和错误结果均失败关闭。
func TestPlannerFailsClosedOnBoundaryMismatch(t *testing.T) {
	account, binding := codexFixture(t, "sk-planner-boundary", 2)
	selection, err := accountapp.NewLaunchSelection(account, accountapp.LaunchSelectionSourceAccountRef)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	_, otherBinding := codexFixture(t, "sk-planner-other", 3)
	disabledAccount, err := account.WithEnabled(
		false,
		time.UnixMilli(1_700_000_001_000).UTC(),
	)
	if err != nil {
		t.Fatalf("WithEnabled() error = %v", err)
	}
	disabledSelection, err := accountapp.NewLaunchSelection(
		disabledAccount,
		accountapp.LaunchSelectionSourceAccountRef,
	)
	if err != nil {
		t.Fatalf("NewLaunchSelection(disabled) error = %v", err)
	}
	validResult := testStrategyResult(t, codex.ProviderID)
	claudeResult := testStrategyResult(t, "claude")
	tests := []struct {
		name       string
		selector   *plannerSelector
		resolver   *plannerCredentialResolver
		strategies []providerlaunch.Strategy
		wantError  error
	}{
		{
			name:       "选择无效",
			selector:   &plannerSelector{},
			resolver:   &plannerCredentialResolver{binding: binding},
			strategies: []providerlaunch.Strategy{&plannerStrategy{providerID: codex.ProviderID, result: validResult}},
			wantError:  providerlaunch.ErrInvalidLaunchSpec,
		},
		{
			name:       "账号已停用",
			selector:   &plannerSelector{selection: disabledSelection},
			resolver:   &plannerCredentialResolver{binding: binding},
			strategies: []providerlaunch.Strategy{&plannerStrategy{providerID: codex.ProviderID, result: validResult}},
			wantError:  providerlaunch.ErrInvalidLaunchSpec,
		},
		{
			name:       "策略缺失",
			selector:   &plannerSelector{selection: selection},
			resolver:   &plannerCredentialResolver{binding: binding},
			strategies: []providerlaunch.Strategy{&plannerStrategy{providerID: "claude", result: claudeResult}},
			wantError:  providerlaunch.ErrStrategyNotFound,
		},
		{
			name:       "凭据错绑",
			selector:   &plannerSelector{selection: selection},
			resolver:   &plannerCredentialResolver{binding: otherBinding},
			strategies: []providerlaunch.Strategy{&plannerStrategy{providerID: codex.ProviderID, result: validResult}},
			wantError:  providerlaunch.ErrCredentialBindingMismatch,
		},
		{
			name:       "策略结果 Provider 错误",
			selector:   &plannerSelector{selection: selection},
			resolver:   &plannerCredentialResolver{binding: binding},
			strategies: []providerlaunch.Strategy{&plannerStrategy{providerID: codex.ProviderID, result: claudeResult}},
			wantError:  providerlaunch.ErrInvalidStrategyResult,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
				Accounts:    test.selector,
				Credentials: test.resolver,
				Strategies:  test.strategies,
			})
			if err != nil {
				t.Fatalf("NewPlanner() error = %v", err)
			}
			if _, err := planner.Build(context.Background(), accountapp.LaunchSelectionRequest{
				ProviderID:   codex.ProviderID,
				CLIAccountID: account.CLIAccountID(),
			}); !errors.Is(err, test.wantError) {
				t.Fatalf("Build() error = %v, want %v", err, test.wantError)
			}
		})
	}
}

// TestPlannerPropagatesCancellationAndPortErrors 验证取消和下层稳定错误不会被静默降级。
func TestPlannerPropagatesCancellationAndPortErrors(t *testing.T) {
	account, binding := codexFixture(t, "sk-planner-errors", 4)
	selection, err := accountapp.NewLaunchSelection(account, accountapp.LaunchSelectionSourceAccountRef)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	portError := errors.New("selection store unavailable")
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
		Accounts:    &plannerSelector{selection: selection, err: portError},
		Credentials: &plannerCredentialResolver{binding: binding},
		Strategies: []providerlaunch.Strategy{
			&plannerStrategy{providerID: codex.ProviderID, result: testStrategyResult(t, codex.ProviderID)},
		},
	})
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	if _, err := planner.Build(context.Background(), accountapp.LaunchSelectionRequest{
		ProviderID:   codex.ProviderID,
		CLIAccountID: account.CLIAccountID(),
	}); !errors.Is(err, portError) {
		t.Fatalf("Build() error = %v", err)
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := planner.Build(canceled, accountapp.LaunchSelectionRequest{
		ProviderID:   codex.ProviderID,
		CLIAccountID: account.CLIAccountID(),
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("Build(canceled) error = %v", err)
	}
}

// BenchmarkPlannerBuild 测量纯编排层在已解析端口上的固定成本。
func BenchmarkPlannerBuild(benchmark *testing.B) {
	account, binding := codexFixture(benchmark, "sk-planner-benchmark", 10)
	selection, err := accountapp.NewLaunchSelection(account, accountapp.LaunchSelectionSourceCLIAccountID)
	if err != nil {
		benchmark.Fatalf("NewLaunchSelection() error = %v", err)
	}
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
		Accounts:    &plannerSelector{selection: selection},
		Credentials: &plannerCredentialResolver{binding: binding},
		Strategies: []providerlaunch.Strategy{
			&plannerStrategy{providerID: codex.ProviderID, result: testStrategyResult(benchmark, codex.ProviderID)},
		},
	})
	if err != nil {
		benchmark.Fatalf("NewPlanner() error = %v", err)
	}
	request := accountapp.LaunchSelectionRequest{
		ProviderID:   codex.ProviderID,
		CLIAccountID: account.CLIAccountID(),
	}
	ctx := context.Background()
	benchmark.ReportAllocs()
	benchmark.ResetTimer()
	for range benchmark.N {
		if _, err := planner.Build(ctx, request); err != nil {
			benchmark.Fatalf("Build() error = %v", err)
		}
	}
}

// plannerSelector 是测试使用的确定性启动账号端口。
type plannerSelector struct {
	selection accountapp.LaunchSelection
	err       error
	calls     int
}

// Resolve 返回预设账号选择并记录调用次数。
func (selector *plannerSelector) Resolve(
	_ context.Context,
	_ accountapp.LaunchSelectionRequest,
) (accountapp.LaunchSelection, error) {
	selector.calls++
	return selector.selection, selector.err
}

// plannerCredentialResolver 是测试使用的确定性凭据解析端口。
type plannerCredentialResolver struct {
	binding        accountapp.CredentialBinding
	err            error
	calls          int
	lastAccountRef accountcore.AccountRef
}

// ResolveCredentialBinding 返回预设绑定并记录目标账号。
func (resolver *plannerCredentialResolver) ResolveCredentialBinding(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.CredentialBinding, error) {
	resolver.calls++
	resolver.lastAccountRef = accountRef
	return resolver.binding, resolver.err
}

// plannerStrategy 是测试使用的确定性 Provider Strategy。
type plannerStrategy struct {
	providerID string
	result     providerlaunch.StrategyResult
	err        error
	calls      int
}

// ProviderID 返回测试策略声明的 Provider。
func (strategy *plannerStrategy) ProviderID() string {
	return strategy.providerID
}

// Build 返回预设启动差异并记录调用次数。
func (strategy *plannerStrategy) Build(
	_ accountapp.CredentialBinding,
) (providerlaunch.StrategyResult, error) {
	strategy.calls++
	return strategy.result, strategy.err
}

// codexFixture 创建身份、基础账号和凭据绑定一致的测试数据。
func codexFixture(
	testingHandle interface {
		Helper()
		Fatalf(string, ...any)
	},
	secret string,
	cliID int64,
) (accountcore.Account, accountapp.CredentialBinding) {
	testingHandle.Helper()
	auth, err := codex.NewAPIKeyAuth(codex.APIKeyInput{APIKey: secret})
	if err != nil {
		testingHandle.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		testingHandle.Fatalf("NewCatalog() error = %v", err)
	}
	accountID, err := accountcore.NewCLIAccountID(cliID)
	if err != nil {
		testingHandle.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(catalog, accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: accountID,
		CreatedAt:    time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		testingHandle.Fatalf("NewAccount() error = %v", err)
	}
	binding, err := accountapp.NewCredentialBinding(account.Ref(), codex.ProviderID, auth)
	if err != nil {
		testingHandle.Fatalf("NewCredentialBinding() error = %v", err)
	}
	return account, binding
}

// testStrategyResult 创建包含敏感环境的有效测试 Strategy 结果。
func testStrategyResult(
	testingHandle interface {
		Helper()
		Fatalf(string, ...any)
	},
	providerID string,
) providerlaunch.StrategyResult {
	testingHandle.Helper()
	environment, err := providerlaunch.NewEnvironmentPatch(map[string]string{"TEST_TOKEN": specSecret}, nil)
	if err != nil {
		testingHandle.Fatalf("NewEnvironmentPatch() error = %v", err)
	}
	descriptor, err := providerlaunch.NewCredentialDescriptor("api_key", "")
	if err != nil {
		testingHandle.Fatalf("NewCredentialDescriptor() error = %v", err)
	}
	binary := providerID
	result, err := providerlaunch.NewStrategyResult(providerlaunch.StrategyResultInput{
		ProviderID:  providerID,
		Binary:      binary,
		Environment: environment,
		Runtime:     providerlaunch.NewDirectProcessRuntime(),
		Credential:  descriptor,
	})
	if err != nil {
		testingHandle.Fatalf("NewStrategyResult() error = %v", err)
	}
	return result
}
