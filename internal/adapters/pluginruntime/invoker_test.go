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
		Generation: 1,
		Contributions: []appplugins.Contribution{{ID: "sample.echo.call", Capability: "command", FailurePolicy: "deny", InstanceID: "echo"}},
	}}); err != nil {
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

	if _, err := registry.Replace(appplugins.HostAccess{}, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := invoker.Invoke(context.Background(), 1, "sample.echo.call", nil, time.Second); Code(err) != "plugin_runtime_inactive" {
		t.Fatalf("no host: %v", err)
	}
}
