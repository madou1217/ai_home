package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/accounts/managementapi"
)

const gatewayResolverTestKey = "gateway-management-key-32-characters-min"

// TestManagementGatewayAccountResolverUsesRemoteAlias 验证固定 Relay 只读取目标 Server 的公开别名。
func TestManagementGatewayAccountResolverUsesRemoteAlias(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(
		response http.ResponseWriter,
		request *http.Request,
	) {
		if request.URL.Path != "/v1/management/account-aliases/claude/9" {
			t.Fatalf("request path = %q", request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer "+gatewayResolverTestKey {
			t.Fatalf("authorization header missing or incorrect")
		}
		response.Header().Set("Content-Type", "application/json")
		_, _ = response.Write([]byte(`{"data":{"account_ref":"acct_11111111111111111111","provider_id":"claude","cli_account_id":9,"enabled":true,"created_at":"2026-08-01T00:00:00Z","updated_at":"2026-08-10T00:00:00Z"}}`))
	}))
	defer server.Close()

	resolver, err := newManagementGatewayAccountResolver(
		http.DefaultClient,
		server.URL,
		gatewayResolverTestKey,
	)
	if err != nil {
		t.Fatalf("newManagementGatewayAccountResolver() error = %v", err)
	}
	alias, err := accountcore.NewCLIAccountID(9)
	if err != nil {
		t.Fatalf("NewCLIAccountID() error = %v", err)
	}
	account, err := resolver.GetByCLIAccountID(context.Background(), "claude", alias)
	if err != nil {
		t.Fatalf("GetByCLIAccountID() error = %v", err)
	}
	if account.ProviderID() != "claude" || account.CLIAccountID() != alias ||
		account.Ref().String() != "acct_11111111111111111111" || !account.Enabled() {
		t.Fatalf("remote account = %#v", account)
	}
}

// TestManagementGatewayAccountResolverAllowsPoolWithoutManagementKey 验证账号池不强制远端管理面。
func TestManagementGatewayAccountResolverAllowsPoolWithoutManagementKey(t *testing.T) {
	resolver, err := newManagementGatewayAccountResolver(
		http.DefaultClient,
		"http://127.0.0.1:1",
		"",
	)
	if err != nil {
		t.Fatalf("newManagementGatewayAccountResolver(empty) error = %v", err)
	}
	if resolver != nil {
		t.Fatal("empty management key must leave resolver nil")
	}
}

var _ managementapi.HTTPClient = http.DefaultClient
