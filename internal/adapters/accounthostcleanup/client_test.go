package accounthostcleanup

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

func newTestClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	client, err := New(Options{
		BaseURL:       server.URL,
		ManagementKey: func() string { return "management-key" },
		// Node 与 Go 的引用不是同一个值，默认翻译成一个不同的 Node 引用，
		// 让每个用例都真的走一遍翻译（恒等回落会掩盖漏接）。
		NodeAccountRef: func(context.Context, string) (string, error) {
			return "acct_abcdef0123456789abcd", nil
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return client
}

func newAccount(t *testing.T, providerID string) accountcore.Account {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cliAccountID, err := accountcore.NewCLIAccountID(1)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          ref,
		ProviderID:   providerID,
		CLIAccountID: cliAccountID,
		Enabled:      true,
		CreatedAt:    time.Unix(1, 0).UTC(),
		UpdatedAt:    time.Unix(1, 0).UTC(),
	})
	if err != nil {
		t.Fatalf("RestoreAccount() error = %v", err)
	}
	return account
}

func TestNewRejectsNonLoopback(t *testing.T) {
	resolveRef := func(context.Context, string) (string, error) { return "acct_abcdef0123456789abcd", nil }
	if _, err := New(Options{BaseURL: "http://10.0.0.8:9527", ManagementKey: func() string { return "k" }, NodeAccountRef: resolveRef}); err == nil {
		t.Fatal("非 loopback 地址应被拒绝")
	}
	if _, err := New(Options{BaseURL: "https://127.0.0.1:9527", ManagementKey: func() string { return "k" }, NodeAccountRef: resolveRef}); err == nil {
		t.Fatal("https 地址应被拒绝")
	}
	if _, err := New(Options{BaseURL: "http://127.0.0.1:9527", ManagementKey: nil, NodeAccountRef: resolveRef}); err == nil {
		t.Fatal("缺少管理密钥应被拒绝")
	}
	if _, err := New(Options{BaseURL: "http://127.0.0.1:9527", ManagementKey: func() string { return "k" }}); err == nil {
		t.Fatal("缺少账号引用翻译应被拒绝")
	}
}

func TestNodeAccountRefTranslationFailureFailsClosed(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		calls++
	}))
	defer server.Close()
	client, err := New(Options{
		BaseURL:       server.URL,
		ManagementKey: func() string { return "management-key" },
		NodeAccountRef: func(context.Context, string) (string, error) {
			return "", errors.New("链接表不可读")
		},
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := client.BeforeDelete(context.Background(), newAccount(t, "codebuddy")); !errors.Is(err, accountapp.ErrAccountHostCleanupFailed) {
		t.Fatalf("error = %v", err)
	}
	if err := client.AfterDelete(context.Background(), newAccount(t, "codebuddy")); !errors.Is(err, accountapp.ErrAccountHostCleanupFailed) {
		t.Fatalf("error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("翻译失败时不得向 Node 发请求，实际 %d 次", calls)
	}
}

func TestBeforeDeleteSendsContract(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != cleanupPath || request.Method != http.MethodPost {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer management-key" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		document, _ := io.ReadAll(request.Body)
		var payload map[string]any
		if err := json.Unmarshal(document, &payload); err != nil {
			t.Errorf("body = %s", string(document))
		}
		if payload["phase"] != "verify" || payload["provider"] != "codebuddy" || payload["accountRef"] != "acct_abcdef0123456789abcd" {
			t.Errorf("payload = %+v", payload)
		}
		_, _ = response.Write([]byte(`{"ok":true,"phase":"verify","reaped":1}`))
	})
	if err := client.BeforeDelete(context.Background(), newAccount(t, "codebuddy")); err != nil {
		t.Fatalf("BeforeDelete() error = %v", err)
	}
}

func TestBeforeDeleteSkipsUncoveredProvider(t *testing.T) {
	calls := 0
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = response.Write([]byte(`{"ok":true}`))
	})
	if err := client.BeforeDelete(context.Background(), newAccount(t, "cline")); err != nil {
		t.Fatalf("BeforeDelete() error = %v", err)
	}
	if err := client.AfterDelete(context.Background(), newAccount(t, "kimi")); err != nil {
		t.Fatalf("AfterDelete() error = %v", err)
	}
	if calls != 0 {
		t.Fatalf("未登记的 Provider 不应产生网络调用，实际 %d 次", calls)
	}
}

func TestBeforeDeleteMapsConflictToRuntimeActive(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusConflict)
		_, _ = response.Write([]byte(`{"ok":false,"error":"account_runtime_active","blockers":[{"session":"s-main"}]}`))
	})
	err := client.BeforeDelete(context.Background(), newAccount(t, "codebuddy"))
	if !errors.Is(err, accountapp.ErrAccountRuntimeActive) {
		t.Fatalf("error = %v", err)
	}
}

func TestBeforeDeleteMapsUnknownStateToUnverifiable(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte(`{"ok":false,"error":"account_host_state_unknown","message":"登记不可读"}`))
	})
	err := client.BeforeDelete(context.Background(), newAccount(t, "workbuddycn"))
	if !errors.Is(err, accountapp.ErrAccountRuntimeUnverifiable) {
		t.Fatalf("error = %v", err)
	}
}

func TestBeforeDeleteMapsUnavailableToCleanupFailed(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte(`{"ok":false,"error":"account_host_cleanup_unavailable"}`))
	})
	err := client.BeforeDelete(context.Background(), newAccount(t, "codebuddy"))
	if !errors.Is(err, accountapp.ErrAccountHostCleanupFailed) {
		t.Fatalf("error = %v", err)
	}
	if errors.Is(err, accountapp.ErrAccountRuntimeActive) {
		t.Fatal("通道不可用不能被当成「有会话在跑」")
	}
}

func TestTransportFailureIsCleanupFailed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	baseURL := server.URL
	server.Close()
	client, err := New(Options{
		BaseURL:        baseURL,
		ManagementKey:  func() string { return "management-key" },
		NodeAccountRef: func(context.Context, string) (string, error) { return "acct_abcdef0123456789abcd", nil },
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	err = client.BeforeDelete(context.Background(), newAccount(t, "codebuddy"))
	if !errors.Is(err, accountapp.ErrAccountHostCleanupFailed) {
		t.Fatalf("error = %v", err)
	}
}

func TestTimeoutIsCleanupFailed(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		time.Sleep(200 * time.Millisecond)
		_, _ = response.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()
	client, err := New(Options{
		BaseURL:       server.URL,
		ManagementKey: func() string { return "management-key" },
		NodeAccountRef: func(context.Context, string) (string, error) {
			return "acct_abcdef0123456789abcd", nil
		},
		Timeout: 20 * time.Millisecond,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if err := client.BeforeDelete(context.Background(), newAccount(t, "codebuddy")); !errors.Is(err, accountapp.ErrAccountHostCleanupFailed) {
		t.Fatalf("超时必须失败关闭，error = %v", err)
	}
}

func TestAfterDeleteDegradedIsDiagnostic(t *testing.T) {
	client := newTestClient(t, func(response http.ResponseWriter, request *http.Request) {
		document, _ := io.ReadAll(request.Body)
		var payload map[string]any
		_ = json.Unmarshal(document, &payload)
		if payload["phase"] != "cleanup" {
			t.Errorf("phase = %+v", payload["phase"])
		}
		_, _ = response.Write([]byte(`{"ok":true,"degraded":true,"results":[{"socket":"aih-codebuddy-acct_0123456789abcdef0123","action":"kill_failed"}]}`))
	})
	err := client.AfterDelete(context.Background(), newAccount(t, "codebuddy"))
	if !errors.Is(err, accountapp.ErrAccountHostCleanupFailed) {
		t.Fatalf("error = %v", err)
	}
}

func TestAfterDeleteIsRetryable(t *testing.T) {
	calls := 0
	client := newTestClient(t, func(response http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = response.Write([]byte(`{"ok":true,"degraded":false,"results":[]}`))
	})
	account := newAccount(t, "workbuddy")
	if err := client.AfterDelete(context.Background(), account); err != nil {
		t.Fatalf("第一次 AfterDelete() error = %v", err)
	}
	if err := client.AfterDelete(context.Background(), account); err != nil {
		t.Fatalf("重试 AfterDelete() error = %v", err)
	}
	if calls != 2 {
		t.Fatalf("每次重试都必须真的发请求，实际 %d 次", calls)
	}
}
