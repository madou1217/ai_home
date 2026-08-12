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

	"github.com/madou1217/ai_home/application/claudegateway"
	"github.com/madou1217/ai_home/application/clauderelay"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
	gatewaycontract "github.com/madou1217/ai_home/internal/contracts/claudegateway"
)

const testClientKey = "client-key-for-claude-relay-tests"

// TestHandlerIssuesAccountBoundLeaseOverRealHTTP 验证推理客户端鉴权、账号选择
// 和 Native OAuth 短期 Token 签发形成完整 HTTP 合同。
func TestHandlerIssuesAccountBoundLeaseOverRealHTTP(t *testing.T) {
	t.Parallel()

	accountRef, _ := newLeaseOAuthCredential(t)
	modelID, err := runtimecore.NewModelID("claude-opus-5")
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
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
	lease, err := registry.Issue(accountRef, modelID)
	if err != nil {
		t.Fatalf("Issue() error = %v", err)
	}
	decision, err := claudegateway.NewDecision(
		claudegateway.TransportNativeOAuth,
		accountRef,
		lease,
	)
	if err != nil {
		t.Fatalf("claudegateway.NewDecision() error = %v", err)
	}
	selector := &leaseSelectorStub{decision: decision}
	handler, err := NewHandler(Dependencies{
		Authorizer: leaseAuthorizer{},
		Selector:   selector,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()

	payload := []byte(`{"provider_id":"claude","model":"claude-opus-5","account_ref":"` + accountRef.String() + `"}`)
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

	var document gatewaycontract.SelectionResponse
	if err := json.NewDecoder(response.Body).Decode(&document); err != nil {
		t.Fatalf("json.Decode() error = %v", err)
	}
	resolved, resolvedModel, found := registry.ConsumeRelayToken(
		document.Data.Token,
	)
	if response.StatusCode != http.StatusCreated ||
		response.Header.Get("Cache-Control") != "no-store" ||
		document.Data.AccountRef != accountRef.String() ||
		document.Data.Transport != gatewaycontract.TransportNativeOAuth ||
		document.Data.ExpiresAt != "2026-07-30T17:00:00Z" ||
		!found ||
		resolved != accountRef ||
		resolvedModel != modelID ||
		selector.calls != 1 ||
		selector.request.ProviderID != claudeauth.ProviderID ||
		selector.request.ModelID != modelID.String() ||
		selector.request.AccountRef != accountRef {
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

// TestHandlerRejectsUnauthorizedAndReturnsCanonicalDecision 验证客户端
// 鉴权失败不会征召，Canonical 选择不签发 OAuth Token。
func TestHandlerRejectsUnauthorizedAndReturnsCanonicalDecision(
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
	decision, err := claudegateway.NewDecision(
		claudegateway.TransportCanonical,
		accountRef,
		clauderelay.Lease{},
	)
	if err != nil {
		t.Fatalf("claudegateway.NewDecision() error = %v", err)
	}
	selector := &leaseSelectorStub{decision: decision}
	handler, err := NewHandler(Dependencies{
		Authorizer: leaseAuthorizer{},
		Selector:   selector,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	payload := `{"provider_id":"claude","model":"claude-opus-5","account_ref":"` + accountRef.String() + `"}`

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

	canonical := httptest.NewRequest(
		http.MethodPost,
		Path,
		strings.NewReader(payload),
	)
	canonical.Header.Set("Authorization", "Bearer "+testClientKey)
	canonical.Header.Set("Content-Type", "application/json")
	canonicalResponse := httptest.NewRecorder()
	handler.ServeHTTP(canonicalResponse, canonical)
	var document gatewaycontract.SelectionResponse
	if err := json.Unmarshal(canonicalResponse.Body.Bytes(), &document); err != nil {
		t.Fatalf("json.Unmarshal() error = %v", err)
	}
	if canonicalResponse.Code != http.StatusCreated ||
		selector.calls != 1 ||
		document.Data.Transport != gatewaycontract.TransportCanonical ||
		document.Data.AccountRef != accountRef.String() ||
		document.Data.Token != "" ||
		document.Data.ExpiresAt != "" {
		t.Fatalf(
			"canonical status=%d selector_calls=%d body=%s",
			canonicalResponse.Code,
			selector.calls,
			canonicalResponse.Body,
		)
	}

	emptyQuery := httptest.NewRequest(
		http.MethodPost,
		Path+"?",
		strings.NewReader(payload),
	)
	emptyQuery.Header.Set("Authorization", "Bearer "+testClientKey)
	emptyQuery.Header.Set("Content-Type", "application/json")
	emptyQueryResponse := httptest.NewRecorder()
	handler.ServeHTTP(emptyQueryResponse, emptyQuery)
	if emptyQueryResponse.Code != http.StatusBadRequest || selector.calls != 1 {
		t.Fatalf(
			"empty query status=%d selector_calls=%d",
			emptyQueryResponse.Code,
			selector.calls,
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

// leaseSelectorStub 记录 HTTP 层投影到应用用例的真实模型和固定账号。
type leaseSelectorStub struct {
	decision claudegateway.Decision
	err      error
	request  claudegateway.Request
	calls    int
}

// Select 返回预设的稳定传输决策。
func (selector *leaseSelectorStub) Select(
	_ context.Context,
	request claudegateway.Request,
) (claudegateway.Decision, error) {
	selector.calls++
	selector.request = request
	return selector.decision, selector.err
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
