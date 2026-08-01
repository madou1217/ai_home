package inferenceapi_test

import (
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/application/inferencegateway"
	"github.com/madou1217/ai_home/internal/transport/http/inferenceapi"
)

// TestContextWithPinnedAccountParsesOptionalCanonicalHeader 验证无头和规范 AccountRef 的两条路径。
func TestContextWithPinnedAccountParsesOptionalCanonicalHeader(t *testing.T) {
	request := httptest.NewRequest("POST", "/v1/responses", nil)
	ctx, err := inferenceapi.ContextWithPinnedAccount(request)
	if err != nil {
		t.Fatalf("ContextWithPinnedAccount(empty) error = %v", err)
	}
	if _, found := inferencegateway.PinnedAccount(ctx); found {
		t.Fatal("无请求头不应固定账号")
	}

	request.Header.Set(inferenceapi.AccountRefHeader, "acct_0123456789abcdef0123")
	ctx, err = inferenceapi.ContextWithPinnedAccount(request)
	if err != nil {
		t.Fatalf("ContextWithPinnedAccount(valid) error = %v", err)
	}
	accountRef, found := inferencegateway.PinnedAccount(ctx)
	if !found || accountRef.String() != "acct_0123456789abcdef0123" {
		t.Fatalf("PinnedAccount() = %s, %t", accountRef, found)
	}
}

// TestContextWithPinnedAccountRejectsAmbiguousHeaders 验证重复、空白和非规范值失败关闭。
func TestContextWithPinnedAccountRejectsAmbiguousHeaders(t *testing.T) {
	for _, values := range [][]string{
		{""},
		{" acct_0123456789abcdef0123"},
		{"invalid"},
		{"acct_0123456789abcdef0123,acct_1234567890abcdef1234"},
		{"acct_0123456789abcdef0123", "acct_1234567890abcdef1234"},
	} {
		request := httptest.NewRequest("POST", "/v1/messages", nil)
		for _, value := range values {
			request.Header.Add(inferenceapi.AccountRefHeader, value)
		}
		if _, err := inferenceapi.ContextWithPinnedAccount(request); !errors.Is(
			err,
			inferenceapi.ErrInvalidAccountRefHeader,
		) {
			t.Fatalf("ContextWithPinnedAccount(%q) error = %v", values, err)
		}
	}
}
