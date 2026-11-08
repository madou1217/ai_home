package accountauth_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// scriptedDeviceProvider 是只实现设备码端口的假 Provider。
//
// 每次 Begin 返回同一个 scriptedDeviceFlow：测试按顺序编排 pending/ready/failed，
// 不依赖真实上游，也不引入额外开关。
type scriptedDeviceProvider struct {
	flow *scriptedDeviceFlow
}

func (provider *scriptedDeviceProvider) ProviderID() string { return "opencode" }

func (provider *scriptedDeviceProvider) Begin(context.Context) (accountauth.OAuthFlow, error) {
	return provider.flow, nil
}

// stubCodexProvider 满足 Service 对 codex 基线 Provider 的要求，流程不被调用。
type stubCodexProvider struct{}

func (stubCodexProvider) ProviderID() string { return "codex" }

func (stubCodexProvider) Begin(context.Context) (accountauth.OAuthFlow, error) {
	return stubDevicelessFlow{}, nil
}

// stubDevicelessFlow 是普通回调型 Flow：没有轮询能力。
type stubDevicelessFlow struct{}

func (stubDevicelessFlow) AuthorizationURL() string { return "https://example.test/authorize" }

func (stubDevicelessFlow) Exchange(context.Context, string) ([]byte, error) {
	return nil, accountauth.ErrProviderUnavailable
}

// scriptedDeviceFlow 按脚本返回轮询结果，并记录被调用的次数。
type scriptedDeviceFlow struct {
	mu      sync.Mutex
	results []accountauth.DevicePoll
	calls   int
}

func (flow *scriptedDeviceFlow) AuthorizationURL() string {
	return "https://opencode.ai/console/device?user_code=ABCD-1234"
}

func (flow *scriptedDeviceFlow) UserCode() string { return "ABCD-1234" }

func (flow *scriptedDeviceFlow) AccountClaims() accountauth.Account {
	return accountauth.Account{Email: "device@example.test", DisplayName: "device@example.test"}
}

func (flow *scriptedDeviceFlow) PollInterval() time.Duration { return time.Millisecond }

func (flow *scriptedDeviceFlow) Exchange(context.Context, string) ([]byte, error) {
	return nil, accountauth.ErrProviderUnavailable
}

func (flow *scriptedDeviceFlow) Poll(context.Context) (accountauth.DevicePoll, error) {
	flow.mu.Lock()
	defer flow.mu.Unlock()
	index := flow.calls
	flow.calls++
	if index < len(flow.results) {
		return flow.results[index], nil
	}
	return accountauth.DevicePoll{Status: accountauth.DevicePending}, nil
}

func (flow *scriptedDeviceFlow) callCount() int {
	flow.mu.Lock()
	defer flow.mu.Unlock()
	return flow.calls
}

// opencodeArtifacts 生成 opencode 的 native_auth_json，形状与设备码适配器一致。
func opencodeArtifacts(t *testing.T, accountID string) []byte {
	t.Helper()
	native, err := json.Marshal(map[string]any{
		"auth": map[string]any{
			"opencode": map[string]any{
				"type":    "oauth",
				"access":  "access-token",
				"refresh": "refresh-token",
				"metadata": map[string]any{
					"accountID": accountID,
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal native auth: %v", err)
	}
	artifacts, err := json.Marshal(map[string]any{"native_auth_json": json.RawMessage(native)})
	if err != nil {
		t.Fatalf("marshal artifacts: %v", err)
	}
	return artifacts
}

// newDeviceService 用真实解码器与记录型注册器组装设备码服务。
func newDeviceService(t *testing.T, flow *scriptedDeviceFlow) (*accountauth.Service, *recordingRegistrar) {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	registrar := &recordingRegistrar{catalog: catalog, now: serviceNow()}
	service, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			stubCodexProvider{},
			stubClaudeProvider{},
			&scriptedDeviceProvider{flow: flow},
		},
		Decoder:    nativeaccount.NewDecoder(),
		Registrar:  registrar,
		Reauth:     stubReauth{},
		Clock:      func() time.Time { return serviceNow() },
		GenerateID: func() (string, error) { return serviceJobID, nil },
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	return service, registrar
}

// waitDeviceJobTerminal 等待后台轮询把 Job 推进到终态。
func waitDeviceJobTerminal(t *testing.T, service *accountauth.Service, jobID string) accountauth.Job {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		job, err := service.Get(jobID)
		if err == nil && job.IsTerminal() {
			return job
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("设备码 Job 未在超时内进入终态")
	return accountauth.Job{}
}

// TestDeviceFlowRegistersAccount 验证 pending → ready 后走统一注册链并保留 user_code。
func TestDeviceFlowRegistersAccount(t *testing.T) {
	flow := &scriptedDeviceFlow{results: []accountauth.DevicePoll{
		{Status: accountauth.DevicePending},
		{Status: accountauth.DeviceSlowDown, Interval: 2 * time.Millisecond},
		{Status: accountauth.DeviceReady, Artifacts: opencodeArtifacts(t, "acc_device_test")},
	}}
	service, registrar := newDeviceService(t, flow)
	start, err := service.Start(context.Background(), accountauth.StartRequest{ProviderID: "opencode"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if start.UserCode() != "ABCD-1234" {
		t.Fatalf("UserCode() = %q, want ABCD-1234", start.UserCode())
	}
	job := waitDeviceJobTerminal(t, service, start.Job().ID())
	if job.Status() != accountauth.StatusCompleted {
		t.Fatalf("Job status = %s, want completed（failure=%s）", job.Status(), job.FailureCode())
	}
	if job.AccountRef().String() == "" {
		t.Fatal("completed Job 缺少 account_ref")
	}
	if registrar.calls != 1 {
		t.Fatalf("registrar.calls = %d, want 1", registrar.calls)
	}
	if job.Account().Email == "" || job.Account().DisplayName == "" {
		t.Fatalf("Job 展示字段 = %+v", job.Account())
	}
	// ready 之后必须停止轮询：再等一小段，调用次数不能增长。
	calls := flow.callCount()
	time.Sleep(20 * time.Millisecond)
	if got := flow.callCount(); got != calls {
		t.Fatalf("终态后仍在轮询: %d → %d", calls, got)
	}
}

// TestDeviceFlowRejected 验证上游明确拒绝时立即收敛为 failed。
func TestDeviceFlowRejected(t *testing.T) {
	flow := &scriptedDeviceFlow{results: []accountauth.DevicePoll{{Status: accountauth.DeviceFailed}}}
	service, registrar := newDeviceService(t, flow)
	start, err := service.Start(context.Background(), accountauth.StartRequest{ProviderID: "opencode"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	job := waitDeviceJobTerminal(t, service, start.Job().ID())
	if job.Status() != accountauth.StatusFailed || job.FailureCode() != "provider_rejected" {
		t.Fatalf("Job = %s/%s, want failed/provider_rejected", job.Status(), job.FailureCode())
	}
	if registrar.calls != 0 {
		t.Fatalf("失败 Job 不得注册账号: calls = %d", registrar.calls)
	}
}

// TestDeviceFlowExpired 验证 expired_token 收敛为 expired，而不是无限轮询。
func TestDeviceFlowExpired(t *testing.T) {
	flow := &scriptedDeviceFlow{results: []accountauth.DevicePoll{{Status: accountauth.DeviceExpired}}}
	service, _ := newDeviceService(t, flow)
	start, err := service.Start(context.Background(), accountauth.StartRequest{ProviderID: "opencode"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	job := waitDeviceJobTerminal(t, service, start.Job().ID())
	if job.Status() != accountauth.StatusExpired {
		t.Fatalf("Job status = %s, want expired", job.Status())
	}
}

// TestDeviceFlowCancelStopsPolling 验证取消后轮询停止且不写账号。
func TestDeviceFlowCancelStopsPolling(t *testing.T) {
	flow := &scriptedDeviceFlow{}
	service, registrar := newDeviceService(t, flow)
	start, err := service.Start(context.Background(), accountauth.StartRequest{ProviderID: "opencode"})
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	deadline := time.Now().Add(time.Second)
	for flow.callCount() < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	job, err := service.Cancel(start.Job().ID())
	if err != nil {
		t.Fatalf("Cancel() error = %v", err)
	}
	if job.Status() != accountauth.StatusCancelled {
		t.Fatalf("Cancel() status = %s, want cancelled", job.Status())
	}
	calls := flow.callCount()
	time.Sleep(20 * time.Millisecond)
	if got := flow.callCount(); got > calls+1 {
		t.Fatalf("取消后仍在轮询: %d → %d", calls, got)
	}
	if registrar.calls != 0 {
		t.Fatalf("取消的 Job 不得注册账号: calls = %d", registrar.calls)
	}
}
