package providerlaunch_test

import (
	"context"
	"testing"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/providerlaunch"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestServiceDispatchesExactlyOneLaunchMode 验证 Gateway 永不读 Native 凭据，反向亦然。
func TestServiceDispatchesExactlyOneLaunchMode(t *testing.T) {
	account, binding := codexFixture(t, "synthetic-service-account", 12)
	nativeSpec := nativeServiceSpec(t, account, binding)
	gatewaySpec := gatewayServiceSpec(t)
	native := &nativeBuilder{spec: nativeSpec}
	gateway := &gatewayBuilder{spec: gatewaySpec}
	service, err := providerlaunch.NewService(providerlaunch.ServiceDependencies{
		Native:  native,
		Gateway: gateway,
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	endpoint := gatewayTestEndpoint(t)

	gatewayIntent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		"codex",
		nil,
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent(gateway) error = %v", err)
	}
	plan, err := service.Plan(context.Background(), gatewayIntent, endpoint)
	if err != nil {
		t.Fatalf("Plan(gateway) error = %v", err)
	}
	if plan.Mode() != providerlaunch.LaunchModeGatewayRelay ||
		!plan.IsValid() || native.calls != 0 || gateway.calls != 1 {
		t.Fatalf("gateway plan=%#v nativeCalls=%d gatewayCalls=%d", plan, native.calls, gateway.calls)
	}
	if _, found := plan.Native(); found {
		t.Fatal("Gateway 计划暴露 Native 描述")
	}

	nativeIntent, err := providerlaunch.ParseLaunchIntent(
		mustProviderCatalog(t),
		"codex",
		[]string{"12"},
	)
	if err != nil {
		t.Fatalf("ParseLaunchIntent(native) error = %v", err)
	}
	plan, err = service.Plan(context.Background(), nativeIntent, providerlaunch.GatewayEndpoint{})
	if err != nil {
		t.Fatalf("Plan(native) error = %v", err)
	}
	if plan.Mode() != providerlaunch.LaunchModeNativeDirect ||
		!plan.IsValid() || native.calls != 1 || gateway.calls != 1 ||
		native.lastRequest.CLIAccountID != account.CLIAccountID() {
		t.Fatalf("native plan=%#v nativeCalls=%d gatewayCalls=%d", plan, native.calls, gateway.calls)
	}
	if _, found := plan.Gateway(); found {
		t.Fatal("Native 计划暴露 Gateway 描述")
	}
}

// nativeBuilder 记录 Native 分支是否被调用。
type nativeBuilder struct {
	spec        providerlaunch.LaunchSpec
	calls       int
	lastRequest accountapp.LaunchSelectionRequest
}

func (builder *nativeBuilder) Build(
	_ context.Context,
	request accountapp.LaunchSelectionRequest,
) (providerlaunch.LaunchSpec, error) {
	builder.calls++
	builder.lastRequest = request
	return builder.spec, nil
}

// gatewayBuilder 记录 Gateway 分支是否被调用。
type gatewayBuilder struct {
	spec  providerlaunch.GatewayLaunchSpec
	calls int
}

func (builder *gatewayBuilder) Build(
	context.Context,
	providerlaunch.LaunchIntent,
	providerlaunch.GatewayEndpoint,
) (providerlaunch.GatewayLaunchSpec, error) {
	builder.calls++
	return builder.spec, nil
}

// nativeServiceSpec 使用真实 Native Planner 构造有效联合值成员。
func nativeServiceSpec(
	t *testing.T,
	account accountcore.Account,
	binding accountapp.CredentialBinding,
) providerlaunch.LaunchSpec {
	t.Helper()
	selection, err := accountapp.NewLaunchSelection(
		account,
		accountapp.LaunchSelectionSourceCLIAccountID,
	)
	if err != nil {
		t.Fatalf("NewLaunchSelection() error = %v", err)
	}
	planner, err := providerlaunch.NewPlanner(providerlaunch.Dependencies{
		Accounts:    &plannerSelector{selection: selection},
		Credentials: &plannerCredentialResolver{binding: binding},
		Strategies: []providerlaunch.Strategy{
			&plannerStrategy{
				providerID: account.ProviderID(),
				result:     testStrategyResult(t, account.ProviderID()),
			},
		},
	})
	if err != nil {
		t.Fatalf("NewPlanner() error = %v", err)
	}
	spec, err := planner.Build(context.Background(), accountapp.LaunchSelectionRequest{
		ProviderID:   account.ProviderID(),
		CLIAccountID: account.CLIAccountID(),
	})
	if err != nil {
		t.Fatalf("Planner.Build() error = %v", err)
	}
	return spec
}

// gatewayServiceSpec 使用真实 Gateway Planner 构造有效联合值成员。
func gatewayServiceSpec(t *testing.T) providerlaunch.GatewayLaunchSpec {
	t.Helper()
	intent, err := providerlaunch.ParseLaunchIntent(mustProviderCatalog(t), "codex", nil)
	if err != nil {
		t.Fatalf("ParseLaunchIntent() error = %v", err)
	}
	planner := newGatewayTestPlanner(
		t,
		&gatewayAccountResolver{},
		&gatewayStrategy{providerID: "codex", result: gatewayTestStrategyResult(t, "codex")},
	)
	spec, err := planner.Build(context.Background(), intent, gatewayTestEndpoint(t))
	if err != nil {
		t.Fatalf("GatewayPlanner.Build() error = %v", err)
	}
	return spec
}
