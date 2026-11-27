package accountprojection

import (
	"context"
	"path/filepath"
	"testing"

	appprojection "github.com/madou1217/ai_home/application/accountprojection"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/providerstorage"
)

// TestCredentialPathsFollowPolicy 验证 watcher 的监听路径来自 Provider 策略，
// 而不是按 Provider 名字硬编码。
func TestCredentialPathsFollowPolicy(t *testing.T) {
	registry := providerstorage.New()
	provisioner, err := New(Options{
		Policies:      registry,
		Materializers: registry.Materializers(),
		Linker:        NewLinker(),
	})
	if err != nil {
		t.Fatal(err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	request := func(providerID string) appprojection.Request {
		return appprojection.Request{
			ProviderID:         providerID,
			AccountRef:         accountRef,
			ProjectionRequired: true,
		}
	}

	codebuddyPaths := provisioner.CredentialPaths(context.Background(), request("codebuddycn"), appprojection.Result{Root: root})
	wantCodeBuddy := filepath.Join(
		root,
		"Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth",
		"Tencent-Cloud.coding-copilot.info",
	)
	if len(codebuddyPaths) != 1 || codebuddyPaths[0] != wantCodeBuddy {
		t.Fatalf("codebuddycn paths = %v, want [%s]", codebuddyPaths, wantCodeBuddy)
	}

	codexPaths := provisioner.CredentialPaths(context.Background(), request("codex"), appprojection.Result{Root: root})
	wantCodex := filepath.Join(root, ".codex", "auth.json")
	if len(codexPaths) != 1 || codexPaths[0] != wantCodex {
		t.Fatalf("codex paths = %v, want [%s]", codexPaths, wantCodex)
	}

	geminiPaths := provisioner.CredentialPaths(context.Background(), request("gemini"), appprojection.Result{Root: root})
	if len(geminiPaths) != 2 {
		t.Fatalf("gemini paths = %v, want 2 artifacts", geminiPaths)
	}
	if geminiPaths[0] != filepath.Join(root, ".gemini", "oauth_creds.json") {
		t.Fatalf("gemini first path = %s", geminiPaths[0])
	}
	if geminiPaths[1] != filepath.Join(root, ".gemini", "google_accounts.json") {
		t.Fatalf("gemini second path = %s", geminiPaths[1])
	}

	// claude 没有文件投影策略；运行时由内存 OAuth Proxy 处理 401，watcher 应为空。
	if paths := provisioner.CredentialPaths(context.Background(), request("claude"), appprojection.Result{Root: root}); len(paths) != 0 {
		t.Fatalf("claude paths = %v, want none", paths)
	}
}
