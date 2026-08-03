package clauderelayleaseapi

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	"github.com/madou1217/ai_home/application/clauderelay"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
)

const testClientKey = "client-key-for-claude-relay-tests"

// TestHandlerIssuesAccountBoundLeaseOverRealHTTP 验证推理客户端鉴权、OAuth
// 预检和短期 Token 签发形成完整 HTTP 合同。
func TestHandlerIssuesAccountBoundLeaseOverRealHTTP(t *testing.T) {
	t.Parallel()

	accountRef, credential := newLeaseOAuthCredential(t)
	registry, err := clauderelay.NewLeaseRegistry(clauderelay.Dependencies{
		Random: rand.Reader,
		Clock: func() time.Time {
			return time.Date(2026, 7, 30, 16, 0, 0, 0, time.UTC)
		},
		TTL: time.Hour,
	})
	if err != nil {
		t.Fatalf("clauderelay.NewLeaseRegistry() error = %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: leaseAuthorizer{},
		Credentials: leaseCredentialResolver{
			accountRef: accountRef,
			credential: credential,
		},
		Leases: registry,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	payload := []byte(`{"account_ref":"` + accountRef.String() + `"}`)
	request, err := http.NewRequest(
		http.MethodPost,
		server.URL+Path,
		bytes.NewReader(payload),
	)
	if err != nil {
		t.Fatalf("http.NewRequest() error = %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+testClientKey)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("http.Client.Do() error = %v", err)
	}
	defer response.Body.Close()

	var document createLeaseResponse
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatalf("json.Decode() error = %v", err)
	}
	resolved, found := registry.ResolveRelayToken(document.Data.Token)
	if response.StatusCode != http.StatusCreated ||
		response.Header.Get("Cache-Control") != "no-store" ||
		document.Data.AccountRef != accountRef.String() ||
		document.Data.ExpiresAt != "2026-07-30T17:00:00Z" ||
		!found ||
		resolved != accountRef {
		t.Fatalf(
			"status=%d data=%#v resolved=%s found=%t",
			response.StatusCode,
			document.Data,
			resolved,
			found,
		)
	}
	t.Logf(
		"POST %s payload=%s response_status=%d response={account_ref:%s,expires_at:%s,token:<redacted>}",
		Path,
		payload,
		response.StatusCode,
		document.Data.AccountRef,
		document.Data.ExpiresAt,
	)
}

// TestHandlerRejectsUnauthorizedAndNonOAuthAccountsBeforeIssue 验证客户端
// 鉴权与凭据类型两层失败关闭。
func TestHandlerRejectsUnauthorizedAndNonOAuthAccountsBeforeIssue(
	t *testing.T,
) {
	t.Parallel()

	apiKey, err := claudeauth.NewAPIKeyAuth(claudeauth.APIKeyInput{
		APIKey: "sk-ant-api03-lease-test",
	})
	if err != nil {
		t.Fatalf("claude.NewAPIKeyAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(apiKey)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	issuer := &leaseIssuerStub{}
	handler, err := NewHandler(Dependencies{
		Authorizer: leaseAuthorizer{},
		Credentials: leaseCredentialResolver{
			accountRef: accountRef,
			credential: apiKey,
		},
		Leases: issuer,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	payload := `{"account_ref":"` + accountRef.String() + `"}`

	unauthorized := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(payload),
	)
	unauthorized.Header.Set("Content-Type", "application/json")
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	if unauthorizedResponse.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status=%d", unauthorizedResponse.Code)
	}

	unsupported := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(payload),
	)
	unsupported.Header.Set("Authorization", "Bearer "+testClientKey)
	unsupported.Header.Set("Content-Type", "application/json")
	unsupportedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unsupportedResponse, unsupported)
	if unsupportedResponse.Code != http.StatusUnprocessableEntity ||
		issuer.calls != 0 {
		t.Fatalf(
			"unsupported status=%d issuer_calls=%d body=%s",
			unsupportedResponse.Code,
			issuer.calls,
			unsupportedResponse.Body,
		)
	}
}

// leaseAuthorizer 只接受固定测试 Server Client Key。
type leaseAuthorizer struct{}

// Authorized 验证推理客户端 Bearer Header。
func (leaseAuthorizer) Authorized(request *http.Request) bool {
	return request != nil &&
		request.Header.Get("Authorization") ==
			"Bearer "+testClientKey
}

// leaseCredentialResolver 返回唯一测试账号的凭据。
type leaseCredentialResolver struct {
	accountRef accountcore.AccountRef
	credential accountapp.Credential
}

// ResolveCredential 拒绝其他 AccountRef。
func (resolver leaseCredentialResolver) ResolveCredential(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountapp.Credential, error) {
	if accountRef != resolver.accountRef {
		return nil, accountapp.ErrCredentialNotFound
	}
	return resolver.credential, nil
}

// leaseIssuerStub 记录非 OAuth 是否越过签发边界。
type leaseIssuerStub struct {
	calls int
}

// Issue 返回零值，测试不应调用该路径。
func (issuer *leaseIssuerStub) Issue(
	accountcore.AccountRef,
) (clauderelay.Lease, error) {
	issuer.calls++
	return clauderelay.Lease{}, nil
}

// newLeaseOAuthCredential 创建不含真实 Token 的官方 OAuth 凭据。
func newLeaseOAuthCredential(
	t *testing.T,
) (accountcore.AccountRef, *claudeauth.OAuthAuth) {
	t.Helper()

	credential, err := claudeauth.NewOAuthAuth(claudeauth.OAuthInput{
		AccessToken:  "sk-ant-oat01-lease-test",
		RefreshToken: "sk-ant-ort01-lease-test",
		ExpiresAtMS: time.Date(2100, 1, 1, 0, 0, 0, 0, time.UTC).
			UnixMilli(),
		Scopes: []string{claudeauth.InferenceScope},
		Identity: claudeauth.OAuthIdentity{
			AccountUUID: "123e4567-e89b-12d3-a456-426614174000",
		},
	})
	if err != nil {
		t.Fatalf("claude.NewOAuthAuth() error = %v", err)
	}
	accountRef, err := accountcore.DeriveAccountRef(credential)
	if err != nil {
		t.Fatalf("accounts.DeriveAccountRef() error = %v", err)
	}
	return accountRef, credential
}
