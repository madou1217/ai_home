package accountauth_test

import (
	"context"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// kiroDeviceProvider 复用设备码脚本，只把 ProviderID 换成 kiro。
type kiroDeviceProvider struct {
	flow *scriptedDeviceFlow
}

func (provider *kiroDeviceProvider) ProviderID() string { return "kiro" }

func (provider *kiroDeviceProvider) Begin(context.Context) (accountauth.OAuthFlow, error) {
	return provider.flow, nil
}

// Service 的 Provider 白名单是显式集合：漏加 kiro 会让 Go 在启动时拒绝注册，
// 这条测试直接锁住「kiro 能进 Job 框架并被轮询推进」。
func TestServiceAcceptsKiroDeviceProvider(t *testing.T) {
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	flow := &scriptedDeviceFlow{results: []accountauth.DevicePoll{
		{Status: accountauth.DeviceFailed},
	}}
	service, err := accountauth.NewService(accountauth.Dependencies{
		Providers: []accountauth.OAuthProvider{
			stubCodexProvider{},
			stubClaudeProvider{},
			&kiroDeviceProvider{flow: flow},
		},
		Decoder:    nativeaccount.NewDecoder(),
		Registrar:  &recordingRegistrar{catalog: catalog, now: serviceNow()},
		Reauth:     stubReauth{},
		Clock:      func() time.Time { return serviceNow() },
		GenerateID: func() (string, error) { return serviceJobID, nil },
	})
	if err != nil {
		t.Fatalf("NewService() error = %v", err)
	}
	start, err := service.Start(context.Background(), accountauth.StartRequest{ProviderID: "kiro"})
	if err != nil {
		t.Fatalf("Start(kiro) error = %v", err)
	}
	if start.UserCode() != "ABCD-1234" {
		t.Fatalf("UserCode() = %q", start.UserCode())
	}
	job := waitDeviceJobTerminal(t, service, start.Job().ID())
	if job.Status() != accountauth.StatusFailed || job.FailureCode() != "provider_rejected" {
		t.Fatalf("Job = %s/%s, want failed/provider_rejected", job.Status(), job.FailureCode())
	}
}
