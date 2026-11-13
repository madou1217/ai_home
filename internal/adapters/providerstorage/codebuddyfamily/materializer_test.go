package codebuddyfamilystorage

import (
	"context"
	"testing"

	"github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestMaterializerSkipsAPIKeyAccounts API Key 账号没有 .info：物化与回写都必须是
// no-op，而不是把启动挡在 "requires native credential"。
func TestMaterializerSkipsAPIKeyAccounts(t *testing.T) {
	credential, err := accountcore.NewStaticAPIKeyAuth(accountcore.StaticAPIKeyInput{
		ProviderID: "codebuddycn",
		APIKey:     "sk-test-family-key",
	})
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("account ref: %v", err)
	}
	materializer, err := NewMaterializer("codebuddycn")
	if err != nil {
		t.Fatalf("materializer: %v", err)
	}
	policy, ok := Policy("codebuddycn")
	if !ok {
		t.Fatal("codebuddycn 缺少投影策略")
	}
	request := accountprojection.Request{
		ProviderID: "codebuddycn",
		AccountRef: accountRef,
		Credential: credential,
	}
	writes, err := materializer.Materialize(context.Background(), request, policy, t.TempDir())
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if len(writes) != 0 {
		t.Fatalf("api-key 不应写 auth 产物: %#v", writes)
	}
	next, changed, err := materializer.Capture(context.Background(), request, policy, t.TempDir())
	if err != nil {
		t.Fatalf("capture: %v", err)
	}
	if changed || next != nil {
		t.Fatalf("api-key 不应回写: %#v %v", next, changed)
	}
}
