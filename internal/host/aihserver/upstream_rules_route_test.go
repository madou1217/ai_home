package aihserver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/upstreamrules"
	"github.com/madou1217/ai_home/internal/transport/http/upstreamrulesapi"
)

// bearerAuthorizer 只接受携带指定 Bearer 的请求，模拟管理面鉴权器。
type bearerAuthorizer struct{ key string }

func (authorizer bearerAuthorizer) Authorized(request *http.Request) bool {
	return strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ") == authorizer.key
}

// newUpstreamRulesRouter 装配只挂载规则投影管理接口的路由。
func newUpstreamRulesRouter(t *testing.T, supportedProviders []string) http.Handler {
	t.Helper()

	store, err := upstreamrules.NewStore(upstreamrules.Options{SupportedProviders: supportedProviders})
	if err != nil {
		t.Fatalf("NewStore() error = %v", err)
	}
	handler, err := upstreamrulesapi.NewHandler(upstreamrulesapi.Dependencies{
		Authorizer: bearerAuthorizer{key: "management-key"},
		Store:      store,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	fallback := http.NotFoundHandler()
	return newRouter(serverHandlers{
		accounts:           fallback,
		accountAuth:        fallback,
		models:             fallback,
		blobs:              fallback,
		tokenCount:         fallback,
		images:             fallback,
		inference:          fallback,
		gemini:             fallback,
		claudeRelayLeases:  fallback,
		claudeNativeRelay:  fallback,
		codexResponsesHTTP: fallback,
		codexResponsesWS:   fallback,
		upstreamRules:      handler,
		catalogStatus:      func() catalogReadiness { return catalogReadiness{} },
	})
}

// upstreamRulesPushBody 是一条账号规则投影推送体（与 Node 投影字段一致）。
func upstreamRulesPushBody(accounts ...string) string {
	return `{"accounts":[` + strings.Join(accounts, ",") + `]}`
}

// codexRuleAccount 生成一条带生效规则的账号投影记录。
func codexRuleAccount(accountRef string, provider string) string {
	return `{"account_ref":"` + accountRef + `","provider":"` + provider + `","rules":[` +
		`{"name":"额度耗尽","kind":"quota_exhausted","enabled":true,"statuses":[429],` +
		`"matchers":[{"source":"body","operator":"contains","value":"INSUFFICIENT_BALANCE"}]}]}`
}

// upstreamRulesResponse 是管理接口推送响应的最小解码结构。
type upstreamRulesResponse struct {
	Data struct {
		Generation          int64    `json:"generation"`
		AcceptedAccountRefs []string `json:"accepted_account_refs"`
		Dropped             []struct {
			AccountRef string `json:"account_ref"`
			Reason     string `json:"reason"`
		} `json:"dropped"`
		SupportedProviders []string `json:"supported_providers"`
	} `json:"data"`
}

// pushUpstreamRules 以管理密钥推送一次投影并解码响应。
func pushUpstreamRules(t *testing.T, router http.Handler, body string) (int, upstreamRulesResponse, string) {
	t.Helper()

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPut, upstreamrulesapi.Path, strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer management-key")
	router.ServeHTTP(response, request)
	var decoded upstreamRulesResponse
	_ = json.Unmarshal(response.Body.Bytes(), &decoded)
	return response.Code, decoded, response.Body.String()
}

// TestUpstreamRulesRouteIsGatedAndFailsClosedWithoutCapability 验证管理路由存在、需要管理密钥，
// 且能力关闭（缺省）时一个账号都不承接——Node 因此继续自己执行规则。
func TestUpstreamRulesRouteIsGatedAndFailsClosedWithoutCapability(t *testing.T) {
	t.Parallel()

	router := newUpstreamRulesRouter(t, nil)
	body := upstreamRulesPushBody(codexRuleAccount("codex:acct-1", "codex"))

	unauthorized := httptest.NewRecorder()
	router.ServeHTTP(
		unauthorized,
		httptest.NewRequest(http.MethodPut, upstreamrulesapi.Path, strings.NewReader(body)),
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("未鉴权推送 status = %d, want 401", unauthorized.Code)
	}

	status, decoded, raw := pushUpstreamRules(t, router, body)
	if status != http.StatusOK {
		t.Fatalf("推送 status = %d, want 200; body=%s", status, raw)
	}
	if len(decoded.Data.AcceptedAccountRefs) != 0 {
		t.Fatalf("能力关闭时不得承接账号: %#v", decoded.Data.AcceptedAccountRefs)
	}
	if len(decoded.Data.Dropped) != 1 || decoded.Data.Dropped[0].Reason != upstreamrules.DropProviderNotSupported {
		t.Fatalf("dropped = %#v", decoded.Data.Dropped)
	}
	if len(decoded.Data.SupportedProviders) != 0 {
		t.Fatalf("supported_providers = %#v", decoded.Data.SupportedProviders)
	}

	diagnostic := httptest.NewRecorder()
	getRequest := httptest.NewRequest(http.MethodGet, upstreamrulesapi.Path, nil)
	getRequest.Header.Set("Authorization", "Bearer management-key")
	router.ServeHTTP(diagnostic, getRequest)
	if diagnostic.Code != http.StatusOK || !bytes.Contains(diagnostic.Body.Bytes(), []byte(`"accepted_account_refs":[]`)) {
		t.Fatalf("诊断响应 status=%d body=%s", diagnostic.Code, diagnostic.Body.String())
	}
}

// TestUpstreamRulesRouteAcceptsDeclaredProviderAccounts 验证声明能力后该 Provider 的账号被承接，
// 其余 Provider 的账号继续留在 Node（逐账号判定，不整体拒绝）。
func TestUpstreamRulesRouteAcceptsDeclaredProviderAccounts(t *testing.T) {
	t.Parallel()

	router := newUpstreamRulesRouter(t, []string{"codex"})
	status, decoded, raw := pushUpstreamRules(t, router, upstreamRulesPushBody(
		codexRuleAccount("codex:acct-1", "codex"),
		codexRuleAccount("claude:acct-2", "claude"),
	))
	if status != http.StatusOK {
		t.Fatalf("推送 status = %d, want 200; body=%s", status, raw)
	}
	if len(decoded.Data.AcceptedAccountRefs) != 1 || decoded.Data.AcceptedAccountRefs[0] != "codex:acct-1" {
		t.Fatalf("accepted = %#v", decoded.Data.AcceptedAccountRefs)
	}
	if len(decoded.Data.Dropped) != 1 || decoded.Data.Dropped[0].AccountRef != "claude:acct-2" ||
		decoded.Data.Dropped[0].Reason != upstreamrules.DropProviderNotSupported {
		t.Fatalf("dropped = %#v", decoded.Data.Dropped)
	}
	if len(decoded.Data.SupportedProviders) != 1 || decoded.Data.SupportedProviders[0] != "codex" {
		t.Fatalf("supported_providers = %#v", decoded.Data.SupportedProviders)
	}
}
