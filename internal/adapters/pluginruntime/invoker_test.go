package pluginruntime

import (
	"context"
	"strings"
	"testing"
	"time"

	appplugins "github.com/madou1217/ai_home/application/pluginruntime"
)

// HostInvoker 按注册表里的接入信息连真实 Plugin Host 调用贡献项；连接断开后下一次调用重新拨号。
func TestHostInvokerCallsThroughTheRegistryAndRedials(t *testing.T) {
	fixture := startHost(t)
	setup := dialReady(t, fixture)
	activateSample(t, fixture, setup)

	registry := appplugins.NewRegistry()
	if _, err := registry.Replace(appplugins.HostAccess{Address: fixture.address, Token: testToken}, []appplugins.Projection{{
		Generation:    1,
		Contributions: []appplugins.Contribution{{ID: "sample.echo.call", Capability: "command", FailurePolicy: "deny", InstanceID: "echo"}},
	}}, nil); err != nil {
		t.Fatal(err)
	}
	invoker := NewHostInvoker(registry)
	t.Cleanup(func() { _ = invoker.Close() })

	value, err := invoker.Invoke(context.Background(), 1, "sample.echo.call", map[string]any{"from": "go-gate"}, 5*time.Second)
	if err != nil || !strings.Contains(string(value), "go-gate") {
		t.Fatalf("invoke: %v %s", err, value)
	}
	invoker.mu.Lock()
	_ = invoker.client.Close()
	invoker.mu.Unlock()
	value, err = invoker.Invoke(context.Background(), 1, "sample.echo.call", map[string]any{"from": "after-redial"}, 5*time.Second)
	if err != nil || !strings.Contains(string(value), "after-redial") {
		t.Fatalf("redial invoke: %v %s", err, value)
	}

	if _, err := registry.Replace(appplugins.HostAccess{}, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := invoker.Invoke(context.Background(), 1, "sample.echo.call", nil, time.Second); Code(err) != "plugin_runtime_inactive" {
		t.Fatalf("no host: %v", err)
	}
}

// Probe 在确认投影前验证宿主可调用：令牌正确时成功，错误令牌或地址时失败。
func TestHostInvokerProbeChecksTheHostIsCallable(t *testing.T) {
	fixture := startHost(t)
	invoker := NewHostInvoker(appplugins.NewRegistry())
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := invoker.Probe(ctx, appplugins.HostAccess{Address: fixture.address, Token: testToken}); err != nil {
		t.Fatalf("probe: %v", err)
	}
	if err := invoker.Probe(ctx, appplugins.HostAccess{Address: fixture.address, Token: strings.Repeat("e", len(testToken))}); err == nil {
		t.Fatal("a wrong token must fail the probe")
	}
	if err := invoker.Probe(ctx, appplugins.HostAccess{Address: fixture.address + "-missing", Token: testToken}); err == nil {
		t.Fatal("a wrong address must fail the probe")
	}
}
