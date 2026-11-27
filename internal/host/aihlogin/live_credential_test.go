package aihlogin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

// TestCredentialWatcherRegistersLiveUpdates 验证 CLI 还停留在交互会话时，
// 新出现和后续刷新的 .info 都会立即注册，不需要等进程退出。
func TestCredentialWatcherRegistersLiveUpdates(t *testing.T) {
	root := t.TempDir()
	directory := authDirectory(root)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	baseline := snapshotCredentialArtifacts(root)

	var mu sync.Mutex
	registered := make([]string, 0, 2)
	done := make(chan struct{}, 2)
	register := func(_ context.Context, credential accountapp.Credential, _ accountapp.PublicProfile) (accountcore.Account, error) {
		mu.Lock()
		registered = append(registered, credential.IdentitySeed())
		mu.Unlock()
		done <- struct{}{}
		return accountcore.Account{}, nil
	}
	stop := startCredentialWatcher(context.Background(), "codebuddycn", root, baseline, register, nil)
	defer stop()

	path := filepath.Join(directory, "Tencent-Cloud.coding-copilot.info")
	writeFakeCredential(t, path, "uid-live", 1000)
	waitForRegistrations(t, done, 1)

	// 同一文件里的 token 刷新要再次导入，账号库才能拿到最新 token。
	writeFakeCredential(t, path, "uid-live", 2000)
	waitForRegistrations(t, done, 1)

	mu.Lock()
	defer mu.Unlock()
	if len(registered) != 2 {
		t.Fatalf("registered = %d, want 2", len(registered))
	}
	for _, seed := range registered {
		if seed == "" {
			t.Fatalf("identity seed should not be empty")
		}
	}
}

// TestCredentialWatcherIgnoresPreLoginArtifacts 验证登录开始前已有的文件不会被
// 当成这次授权结果；只有文件变化才导入。
func TestCredentialWatcherIgnoresPreLoginArtifacts(t *testing.T) {
	root := t.TempDir()
	directory := authDirectory(root)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(directory, "Tencent-Cloud.coding-copilot.info")
	writeFakeCredential(t, path, "uid-old", 1000)
	baseline := snapshotCredentialArtifacts(root)

	called := make(chan struct{}, 1)
	register := func(_ context.Context, _ accountapp.Credential, _ accountapp.PublicProfile) (accountcore.Account, error) {
		called <- struct{}{}
		return accountcore.Account{}, nil
	}
	stop := startCredentialWatcher(context.Background(), "codebuddycn", root, baseline, register, nil)
	defer stop()

	select {
	case <-called:
		t.Fatal("pre-login artifact must not be registered")
	case <-time.After(1500 * time.Millisecond):
	}
}

func writeFakeCredential(t *testing.T, path string, uid string, issuedAt int64) {
	t.Helper()
	claims := fmt.Sprintf(
		`{"iss":"https://www.codebuddy.cn/auth/realms/copilot","sub":%q,"iat":%d,"exp":%d}`,
		uid, issuedAt, issuedAt+3600,
	)
	token := "e30." + base64.RawURLEncoding.EncodeToString([]byte(claims)) + ".signature"
	document, err := json.Marshal(map[string]any{
		"auth": map[string]any{
			"accessToken":  token,
			"refreshToken": token,
			"domain":       "www.codebuddy.cn",
		},
		"account": map[string]any{"uid": uid, "nickname": "tester"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, document, 0o600); err != nil {
		t.Fatal(err)
	}
}

func waitForRegistrations(t *testing.T, done <-chan struct{}, want int) {
	t.Helper()
	for index := 0; index < want; index++ {
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatalf("timed out waiting for registration %d", index+1)
		}
	}
}
