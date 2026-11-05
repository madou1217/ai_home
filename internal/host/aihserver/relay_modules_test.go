package aihserver

import (
	"context"
	"testing"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	"github.com/madou1217/ai_home/internal/transport/http/codebuddyfamilyrelay"
	"github.com/madou1217/ai_home/internal/transport/http/qoderrelay"
	"github.com/madou1217/ai_home/internal/transport/http/relaycore"
)

// 每条 spec 必须自带 Provider：漏写会让该 Provider 的请求静默交回 Canonical。
// 唯一允许共享变体的是 qodercn（复用 qoder），这里把它写成显式例外。
func TestRelayModuleSpecsDeclareProviders(t *testing.T) {
	shared := map[string]struct{}{qoderrelay.QoderCNProviderID: {}}
	for _, spec := range relayModuleSpecs() {
		if spec.ID == "" || spec.Label == "" || spec.Policy == nil {
			t.Fatalf("spec 不完整: %+v", spec)
		}
		if spec.Provider == nil {
			if _, ok := shared[spec.ID]; !ok {
				t.Fatalf("%s 没有 Provider 构造，也不是已登记的共享变体", spec.ID)
			}
			continue
		}
		if _, ok := shared[spec.ID]; ok {
			t.Fatalf("%s 登记为共享变体，却又提供了 Provider 构造", spec.ID)
		}
	}
}

func TestRelayModuleSpecsAreUnique(t *testing.T) {
	ids := map[string]struct{}{}
	labels := map[string]struct{}{}
	for _, spec := range relayModuleSpecs() {
		if _, duplicate := ids[spec.ID]; duplicate {
			t.Fatalf("重复的 Provider ID: %s", spec.ID)
		}
		ids[spec.ID] = struct{}{}
		if _, duplicate := labels[spec.Label]; duplicate {
			t.Fatalf("重复的 label: %s", spec.Label)
		}
		labels[spec.Label] = struct{}{}
	}
}

// 目录名单必须与注册表一致：多一个会去要不存在的 Factory，少一个会让模型不可路由。
func TestRelayProviderIDsDeriveFromSpecs(t *testing.T) {
	ids := relayProviderIDs()
	seen := map[string]struct{}{}
	for _, id := range ids {
		if _, duplicate := seen[id]; duplicate {
			t.Fatalf("relayProviderIDs 重复: %s", id)
		}
		seen[id] = struct{}{}
	}
	for _, provider := range codebuddyfamilyrelay.FamilyProviders {
		if _, ok := seen[provider]; !ok {
			t.Fatalf("家族 Provider 缺失: %s", provider)
		}
	}
	for _, spec := range relayModuleSpecs() {
		if _, ok := seen[spec.ID]; !ok {
			t.Fatalf("注册表的 Provider 不在目录名单里: %s", spec.ID)
		}
	}
	if len(ids) != len(codebuddyfamilyrelay.FamilyProviders)+len(relayModuleSpecs()) {
		t.Fatalf("目录数量 = %d, want 家族 %d + 注册表 %d", len(ids), len(codebuddyfamilyrelay.FamilyProviders), len(relayModuleSpecs()))
	}
}

// 账号来源与 Provider 链必须同序，且 nil 变体（qodercn）不重复进链。
func TestRelayModuleDerivationsKeepOrderAndSkipNil(t *testing.T) {
	first := &stubRelayAccounts{}
	second := &stubRelayAccounts{}
	firstProvider := &stubRelayProvider{}
	secondProvider := &stubRelayProvider{}
	modules := []relayModule{
		{ID: "a", Accounts: first, Provider: firstProvider},
		{ID: "b", Accounts: second},
		{ID: "c", Provider: secondProvider},
	}
	accounts := relayModuleAccounts(modules)
	if len(accounts) != 2 || accounts[0] != first || accounts[1] != second {
		t.Fatalf("账号来源顺序不对: %v", accounts)
	}
	providers := relayModuleProviders(modules)
	if len(providers) != 2 || providers[0] != firstProvider || providers[1] != secondProvider {
		t.Fatalf("Provider 顺序不对: %v", providers)
	}
}

type stubRelayAccounts struct{}

func (*stubRelayAccounts) Accounts(
	context.Context,
	runtimecore.ModelID,
) (relaycore.AccountCursor, error) {
	return nil, nil
}

type stubRelayProvider struct{ relaycore.BaseProvider }

func (*stubRelayProvider) ID() string { return "stub" }
