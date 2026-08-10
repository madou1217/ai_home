package managementapi_test

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
	accountcontract "github.com/madou1217/ai_home/internal/contracts/accountmanagement"
)

// TestClientGetsAndRefreshesUsage 验证额度读与刷新共享认证合同，且保留显式 null 语义。
func TestClientGetsAndRefreshesUsage(t *testing.T) {
	t.Parallel()

	transport := &usageHTTPClient{t: t}
	client, err := managementapi.New(transport, managementapi.Config{
		BaseURL:       "http://127.0.0.1:9527",
		ManagementKey: testManagementKey,
	})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	cached, err := client.GetUsage(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("GetUsage() error = %v", err)
	}
	refreshed, err := client.RefreshUsage(context.Background(), accountRef)
	if err != nil {
		t.Fatalf("RefreshUsage() error = %v", err)
	}
	if transport.calls != 2 || !cached.Stale() || refreshed.Stale() {
		t.Fatalf(
			"calls=%d cached.stale=%t refreshed.stale=%t",
			transport.calls,
			cached.Stale(),
			refreshed.Stale(),
		)
	}
	snapshot := refreshed.Snapshot()
	entries := snapshot.Entries()
	if snapshot.AccountRef() != accountRef ||
		snapshot.ProviderID() != "codex" ||
		snapshot.Source() != "codex_wham_usage" ||
		len(entries) != 2 {
		t.Fatalf("RefreshUsage() snapshot = %#v entries=%#v", snapshot, entries)
	}
	entriesByBucket := make(map[string]usagecore.Entry, len(entries))
	for _, entry := range entries {
		entriesByBucket[entry.Bucket()] = entry
	}
	remaining, known := entriesByBucket["five_hour"].RemainingBasisPoints()
	if !known || remaining != 7234 ||
		!entriesByBucket["credits"].ResetAt().IsZero() {
		t.Fatalf("usage entries = %#v", entriesByBucket)
	}
}

// TestClientRejectsMismatchedOrInvalidUsage 验证错账号和非法领域字段失败关闭。
func TestClientRejectsMismatchedOrInvalidUsage(t *testing.T) {
	t.Parallel()

	accountRef, err := accountcore.ParseAccountRef("acct_11111111111111111111")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	for _, document := range []string{
		usageDocument("acct_22222222222222222222", false),
		strings.Replace(
			usageDocument(accountRef.String(), false),
			`"remaining_basis_points":7234`,
			`"remaining_basis_points":10001`,
			1,
		),
		`{"data":{"account_ref":"` + accountRef.String() + `"}}`,
	} {
		client, newErr := managementapi.New(&staticHTTPClient{
			status: http.StatusOK,
			body:   document,
		}, managementapi.Config{
			BaseURL:       "http://127.0.0.1:9527",
			ManagementKey: testManagementKey,
		})
		if newErr != nil {
			t.Fatalf("New() error = %v", newErr)
		}
		if _, getErr := client.GetUsage(
			context.Background(),
			accountRef,
		); !errors.Is(getErr, managementapi.ErrInvalidResponse) {
			t.Fatalf("GetUsage(invalid) error = %v document=%s", getErr, document)
		}
	}
}

// usageHTTPClient 断言离线 GET 和显式 POST 刷新的线级合同。
type usageHTTPClient struct {
	t     *testing.T
	calls int
}

// Do 返回同一账号的缓存和刷新结果，拒绝请求正文及凭据泄漏。
func (client *usageHTTPClient) Do(request *http.Request) (*http.Response, error) {
	client.t.Helper()
	body, err := io.ReadAll(request.Body)
	if err != nil {
		client.t.Fatalf("ReadAll(request body) error = %v", err)
	}
	if request.Header.Get("Authorization") != "Bearer "+testManagementKey ||
		request.Header.Get("Content-Type") != "" ||
		len(body) != 0 ||
		strings.Contains(request.URL.String(), testManagementKey) {
		client.t.Fatalf("usage request leaked or malformed: %s %s", request.Method, request.URL)
	}
	client.calls++
	wantPath := accountcontract.AccountsPath +
		"/acct_11111111111111111111" + accountcontract.AccountUsageSuffix
	switch client.calls {
	case 1:
		if request.Method != http.MethodGet || request.URL.Path != wantPath {
			client.t.Fatalf("GetUsage request = %s %s", request.Method, request.URL)
		}
		return jsonResponse(http.StatusOK, usageDocument(
			"acct_11111111111111111111",
			true,
		)), nil
	case 2:
		if request.Method != http.MethodPost ||
			request.URL.Path != wantPath+"/refresh" {
			client.t.Fatalf("RefreshUsage request = %s %s", request.Method, request.URL)
		}
		return jsonResponse(http.StatusOK, usageDocument(
			"acct_11111111111111111111",
			false,
		)), nil
	default:
		client.t.Fatalf("unexpected request count %d", client.calls)
		return nil, nil
	}
}

// usageDocument 创建同时覆盖已知比例、可空窗口和 Credits 的公开响应。
func usageDocument(accountRef string, stale bool) string {
	staleJSON := "false"
	if stale {
		staleJSON = "true"
	}
	return `{"data":{` +
		`"account_ref":"` + accountRef + `",` +
		`"provider_id":"codex",` +
		`"source":"codex_wham_usage",` +
		`"captured_at":"2026-08-10T08:00:00Z",` +
		`"stale":` + staleJSON + `,` +
		`"entries":[` +
		`{"limit_id":"primary","limit_name":"Primary",` +
		`"bucket":"five_hour","kind":"window","scope":"account",` +
		`"scope_key":"","remaining_basis_points":7234,` +
		`"availability":"available","window_seconds":18000,` +
		`"reset_at":"2026-08-10T10:00:00Z"},` +
		`{"limit_id":"credits","limit_name":"Credits",` +
		`"bucket":"credits","kind":"credits","scope":"account",` +
		`"scope_key":"","remaining_basis_points":null,` +
		`"availability":"disabled","window_seconds":null,"reset_at":null}` +
		`]}}`
}
