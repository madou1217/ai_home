package accountruntime

import (
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestNewModelRoutePreservesCanonicalModel 验证模型键不改写 Provider 的真实模型 ID。
func TestNewModelRoutePreservesCanonicalModel(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_00000000000000000001")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	route, err := NewModelRoute(accountRef, "claude-opus-4-1")
	if err != nil {
		t.Fatalf("NewModelRoute() error = %v", err)
	}
	if route.AccountRef() != accountRef ||
		route.ModelID().String() != "claude-opus-4-1" {
		t.Fatalf("NewModelRoute() route = %#v", route)
	}
}

// TestNewModelRouteRejectsAmbiguousModel 验证空白和控制字符不能形成 cooldown 键。
func TestNewModelRouteRejectsAmbiguousModel(t *testing.T) {
	t.Parallel()

	accountRef, _ := accountcore.ParseAccountRef("acct_00000000000000000001")
	for _, modelID := range []string{"", " gpt-5.6-sol", "gpt-5.6-sol ", "bad\nmodel"} {
		if _, err := NewModelRoute(accountRef, modelID); err == nil {
			t.Fatalf("NewModelRoute(%q) error = nil", modelID)
		}
	}
}
