package providerlaunch_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/claude"
	"github.com/madou1217/ai_home/core/accounts/codex"
)

const gatewayTestClientKey = "aih-gateway-client-key-32-bytes-minimum"

// 编译期确认基础账号 Store 的公开读取签名可由 GatewayAccountResolver 承载。
var _ providerlaunch.GatewayAccountResolver = (*gatewayAccountResolver)(nil)

// TestGatewayPlannerBuildsPoolWithoutAccountRead 验证默认 Gateway 不查询账号、更不读取凭据。
func TestGatewayPlannerBuildsPoolWithoutAccountRead(t *testing.T) {
	resolver := &gatewayAccountResolver{}
	strategy := &gatewayStrategy{
		providerID: codex.ProviderID,
		result:     gatewayTestStrategyResult(t, codex.ProviderID),
	}
	planner := newGatewayTestPlanner(t, resolver, strategy)
	intent, err := providerlaunch.ParseLaunchIntent(mustProviderCatalog(t), codex.ProviderID, nil)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}
	endpoint := gatewayTestEndpoint(t)

	spec, err := planner.Build(context.Background(), intent, endpoint)
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if !spec.IsValid() ||
		spec.Mode() != providerlaunch.LaunchModeGatewayRelay ||
		spec.ClientProviderID() != codex.ProviderID ||
		spec.RelayProviderID() != codex.ProviderID ||
		spec.CLIAccountID().IsValid() ||
		resolver.calls != 0 ||
		strategy.calls != 1 {
		t.Fatalf("spec=%v resolverCalls=%d strategyCalls=%d", spec, resolver.calls, strategy.calls)
	}
	if _, pinned := spec.PinnedAccount(); pinned {
		t.Fatal("账号池模式被错误固定")
	}
	assertGatewayRedacted(t, endpoint, spec)
}

// TestGatewayPlannerBuildsPoolWithoutAccountResolver 验证远端账号池完全不依赖本地账号库。
func TestGatewayPlannerBuildsPoolWithoutAccountResolver(t *testing.T) {
	strategy := &gatewayStrategy{
		providerID: codex.ProviderID,
		result:     gatewayTestStrategyResult(t, codex.ProviderID),
	}
	planner, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Strategies: []providerlaunch.GatewayStrategy{strategy},
	})
	if err != nil {
		t.Fatalf("NewGatewayPlanner() error = %v", err)
	}
	intent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		codex.ProviderID,
		nil,
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}
	if _, err := planner.Build(context.Background(), intent, gatewayTestEndpoint(t)); err != nil {
		t.Fatalf("Build(pool without resolver) error = %v", err)
	}
}

// TestGatewayPlannerRejectsPinnedWithoutAccountResolver 验证固定 Relay 没有目标 Server 解析端口时失败关闭。
func TestGatewayPlannerRejectsPinnedWithoutAccountResolver(t *testing.T) {
	strategy := &gatewayStrategy{
		providerID: codex.ProviderID,
		result:     gatewayTestStrategyResult(t, codex.ProviderID),
	}
	planner, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Strategies: []providerlaunch.GatewayStrategy{strategy},
	})
	if err != nil {
		t.Fatalf("NewGatewayPlanner() error = %v", err)
	}
	intent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		codex.ProviderID,
		[]string{"relay", "9"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}
	if _, err := planner.Build(context.Background(), intent, gatewayTestEndpoint(t)); !errors.Is(
		err,
		providerlaunch.ErrGatewayAccountResolverUnavailable,
	) {
		t.Fatalf("Build(pinned without resolver) error = %v", err)
	}
}

// TestGatewayPlannerSeparatesClientStrategyAndRelayAccount 验证跨 Provider 只用客户端 Strategy，并从 Relay Provider 解析账号。
func TestGatewayPlannerSeparatesClientStrategyAndRelayAccount(t *testing.T) {
	auth, err := claude.NewAPIKeyAuth(claude.APIKeyInput{APIKey: "synthetic-cross-provider-secret"})
	if err != nil {
		t.Fatalf("NewAPIKeyAuth() error = %v", err)
	}
	accountID, err := accountcore.NewCLIAccountID(9)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.NewAccount(mustProviderCatalog(t), accountcore.NewAccountInput{
		Identity:     auth,
		CLIAccountID: accountID,
		CreatedAt:    time.UnixMilli(1_700_000_000_000).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccount() error = %v", err)
	}
	resolver := &gatewayAccountResolver{account: account}
	strategy := &gatewayStrategy{
		providerID: codex.ProviderID,
		result:     gatewayTestStrategyResult(t, codex.ProviderID),
	}
	planner := newGatewayTestPlanner(t, resolver, strategy)
	intent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		codex.ProviderID,
		[]string{"relay", claude.ProviderID, "9", "--model", "claude-opus-5"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}

	spec, err := planner.Build(context.Background(), intent, gatewayTestEndpoint(t))
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	if !spec.IsValid() || spec.ClientProviderID() != codex.ProviderID ||
		spec.RelayProviderID() != claude.ProviderID ||
		resolver.lastProvider != claude.ProviderID || strategy.calls != 1 ||
		spec.Binary() != codex.ProviderID {
		t.Fatalf("spec=%v resolver=%+v strategyCalls=%d", spec, resolver, strategy.calls)
	}
}

// TestGatewayPlannerResolvesPinnedPublicAccount 验证数字别名只读取基础账号并绑定 AccountRef。
func TestGatewayPlannerResolvesPinnedPublicAccount(t *testing.T) {
	account, _ := codexFixture(t, "synthetic-gateway-account-identity", 8)
	resolver := &gatewayAccountResolver{account: account}
	strategy := &gatewayStrategy{
		providerID: codex.ProviderID,
		result:     gatewayTestStrategyResult(t, codex.ProviderID),
	}
	planner := newGatewayTestPlanner(t, resolver, strategy)
	intent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		codex.ProviderID,
		[]string{"relay", "8", "resume", "thread-id"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}

	spec, err := planner.Build(context.Background(), intent, gatewayTestEndpoint(t))
	if err != nil {
		t.Fatalf("Build() error = %v", err)
	}
	accountRef, pinned := spec.PinnedAccount()
	arguments, err := spec.ResolveArguments(intent.Arguments())
	if err != nil {
		t.Fatalf("ResolveArguments() error = %v", err)
	}
	if !pinned || accountRef != account.Ref() ||
		spec.CLIAccountID() != account.CLIAccountID() ||
		resolver.calls != 1 ||
		resolver.lastProvider != codex.ProviderID ||
		resolver.lastCLIAccountID != account.CLIAccountID() ||
		strings.Join(arguments, " ") != "resume thread-id" {
		t.Fatalf(
			"spec=%v pinned=%t arguments=%v resolver=%+v",
			spec,
			pinned,
			arguments,
			resolver,
		)
	}
}

// TestGatewayPlannerRejectsNativeIntentAndAccountMismatch 验证两种模式和账号归属不会混用。
func TestGatewayPlannerRejectsNativeIntentAndAccountMismatch(t *testing.T) {
	account, _ := codexFixture(t, "synthetic-gateway-mismatch", 9)
	resolver := &gatewayAccountResolver{account: account}
	strategy := &gatewayStrategy{
		providerID: codex.ProviderID,
		result:     gatewayTestStrategyResult(t, codex.ProviderID),
	}
	planner := newGatewayTestPlanner(t, resolver, strategy)
	native, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		codex.ProviderID,
		[]string{"9"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent(native) error = %v", err)
	}
	if _, err := planner.Build(
		context.Background(),
		native,
		gatewayTestEndpoint(t),
	); !errors.Is(err, providerlaunch.ErrInvalidGatewayBuildRequest) {
		t.Fatalf("Build(native) error = %v", err)
	}

	relay, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		codex.ProviderID,
		[]string{"relay", "9"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent(relay) error = %v", err)
	}
	resolver.account = accountcore.Account{}
	if _, err := planner.Build(
		context.Background(),
		relay,
		gatewayTestEndpoint(t),
	); !errors.Is(err, providerlaunch.ErrGatewayAccountMismatch) {
		t.Fatalf("Build(mismatch) error = %v", err)
	}
}

// TestGatewayEndpointRejectsUnsafeValuesAndRedactsKey 验证 URL 注入和密钥日志泄漏失败关闭。
func TestGatewayEndpointRejectsUnsafeValuesAndRedactsKey(t *testing.T) {
	for _, input := range []struct {
		baseURL string
		key     string
	}{
		{baseURL: "http://127.0.0.1:9527/path", key: gatewayTestClientKey},
		{baseURL: "http://user@example.test", key: gatewayTestClientKey},
		{baseURL: "http://127.0.0.1:9527", key: "short"},
	} {
		if _, err := providerlaunch.NewGatewayEndpoint(input.baseURL, input.key); !errors.Is(
			err,
			providerlaunch.ErrInvalidGatewayEndpoint,
		) {
			t.Fatalf("NewGatewayEndpoint(%q) error = %v", input.baseURL, err)
		}
	}
	endpoint := gatewayTestEndpoint(t)
	formatted := fmt.Sprintf("%v %+v %#v", endpoint, endpoint, endpoint)
	if strings.Contains(formatted, gatewayTestClientKey) {
		t.Fatalf("GatewayEndpoint 格式化泄漏客户端密钥: %s", formatted)
	}
}

// gatewayAccountResolver 是只返回基础账号的测试端口。
type gatewayAccountResolver struct {
	account          accountcore.Account
	err              error
	calls            int
	lastProvider     string
	lastCLIAccountID accountcore.CLIAccountID
}

// GetByCLIAccountID 记录固定账号公开读取，不包含凭据返回值。
func (resolver *gatewayAccountResolver) GetByCLIAccountID(
	_ context.Context,
	providerID string,
	cliAccountID accountcore.CLIAccountID,
) (accountcore.Account, error) {
	resolver.calls++
	resolver.lastProvider = providerID
	resolver.lastCLIAccountID = cliAccountID
	return resolver.account, resolver.err
}

// gatewayStrategy 返回预设的无凭据 Gateway 进程描述。
type gatewayStrategy struct {
	providerID string
	result     providerlaunch.GatewayStrategyResult
	err        error
	calls      int
}

func (strategy *gatewayStrategy) ProviderID() string {
	return strategy.providerID
}

func (strategy *gatewayStrategy) Build(
	providerlaunch.GatewayTarget,
) (providerlaunch.GatewayStrategyResult, error) {
	strategy.calls++
	return strategy.result, strategy.err
}

// newGatewayTestPlanner 创建当前测试需要的最小 Gateway Planner。
func newGatewayTestPlanner(
	t *testing.T,
	resolver providerlaunch.GatewayAccountResolver,
	strategy providerlaunch.GatewayStrategy,
) *providerlaunch.GatewayPlanner {
	t.Helper()
	planner, err := providerlaunch.NewGatewayPlanner(providerlaunch.GatewayDependencies{
		Accounts:   resolver,
		Strategies: []providerlaunch.GatewayStrategy{strategy},
	})
	if err != nil {
		t.Fatalf("NewGatewayPlanner() error = %v", err)
	}
	return planner
}

// gatewayTestEndpoint 创建不会触网的合成 Server Endpoint。
func gatewayTestEndpoint(t *testing.T) providerlaunch.GatewayEndpoint {
	t.Helper()
	endpoint, err := providerlaunch.NewGatewayEndpoint(
		"http://127.0.0.1:9527/",
		gatewayTestClientKey,
	)
	if err != nil {
		t.Fatalf("NewGatewayEndpoint() error = %v", err)
	}
	return endpoint
}

// gatewayTestStrategyResult 创建不含 Provider 上游凭据的测试进程描述。
func gatewayTestStrategyResult(
	t *testing.T,
	providerID string,
) providerlaunch.GatewayStrategyResult {
	t.Helper()
	patch, err := providerlaunch.NewEnvironmentPatch(
		map[string]string{"AIH_GATEWAY_CLIENT_KEY": gatewayTestClientKey},
		nil,
	)
	if err != nil {
		t.Fatalf("NewEnvironmentPatch() error = %v", err)
	}
	result, err := providerlaunch.NewGatewayStrategyResult(
		providerlaunch.GatewayStrategyResultInput{
			ProviderID:  providerID,
			Binary:      providerID,
			Environment: patch,
		},
	)
	if err != nil {
		t.Fatalf("NewGatewayStrategyResult() error = %v", err)
	}
	return result
}

// assertGatewayRedacted 验证所有公开格式化入口都不泄漏客户端密钥。
func assertGatewayRedacted(
	t *testing.T,
	endpoint providerlaunch.GatewayEndpoint,
	spec providerlaunch.GatewayLaunchSpec,
) {
	t.Helper()
	formatted := fmt.Sprintf("%v\n%+v\n%#v\n%v", endpoint, endpoint, endpoint, spec)
	if strings.Contains(formatted, gatewayTestClientKey) {
		t.Fatalf("Gateway 启动描述泄漏客户端密钥: %s", formatted)
	}
}
