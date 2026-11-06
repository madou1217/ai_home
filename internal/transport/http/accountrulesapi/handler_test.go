package accountrulesapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

type fakeService struct {
	views   map[string]rulesapp.AccountView
	input   rulesapp.AccountInput
	deleted map[string]bool
}

func (service *fakeService) Effective(_ context.Context, accountRef string) (rulesapp.AccountView, error) {
	view, ok := service.views[accountRef]
	if !ok {
		return rulesapp.AccountView{}, rulesapp.ErrAccountNotFound
	}
	return view, nil
}

func (service *fakeService) ReplaceAccount(
	_ context.Context,
	accountRef string,
	input rulesapp.AccountInput,
) (rulesapp.AccountView, error) {
	if _, ok := service.views[accountRef]; !ok {
		return rulesapp.AccountView{}, rulesapp.ErrAccountNotFound
	}
	service.input = input
	view := rulesapp.AccountView{
		AccountRef:     accountRef,
		Provider:       "codex",
		Source:         rulesapp.SourceAccount,
		GroupIDs:       input.GroupIDs,
		Rules:          input.Rules,
		EffectiveRules: input.Rules,
		Supported:      true,
	}
	service.views[accountRef] = view
	return view, nil
}

func (service *fakeService) DeleteAccount(_ context.Context, accountRef string) (bool, error) {
	if _, ok := service.views[accountRef]; !ok {
		return false, nil
	}
	delete(service.views, accountRef)
	service.deleted[accountRef] = true
	return true, nil
}

func (service *fakeService) ListAccounts(context.Context) ([]rulesapp.AccountView, error) {
	views := make([]rulesapp.AccountView, 0, len(service.views))
	for _, view := range service.views {
		views = append(views, view)
	}
	return views, nil
}

func (service *fakeService) SupportedProviders() []string { return []string{"codex"} }

func (service *fakeService) Generation() int64 { return 1 }

const testRuleJSON = `{"name":"rate_limit","kind":"rate_limited","enabled":true,"statuses":[429],"matchers":[{"source":"body","operator":"contains","value":"rate limit"}]}`

func newHandler() (*Handler, *fakeService) {
	service := &fakeService{
		views: map[string]rulesapp.AccountView{
			"acct_0123456789abcdef0123": {
				AccountRef: "acct_0123456789abcdef0123",
				Provider:   "codex",
				Source:     rulesapp.SourceAccount,
				Supported:  true,
			},
		},
		deleted: map[string]bool{},
	}
	handler, err := NewHandler(Dependencies{Authorizer: allowAll{}, Service: service})
	if err != nil {
		panic(err)
	}
	return handler, service
}

func memberRequest(method, body string) *http.Request {
	request := httptest.NewRequest(method, "/v1/management/accounts/acct_0123456789abcdef0123/upstream-error-rules", strings.NewReader(body))
	request.SetPathValue("ref", "acct_0123456789abcdef0123")
	return request
}

func TestPutStoresGroupIDsAndRules(t *testing.T) {
	handler, service := newHandler()
	request := memberRequest(http.MethodPut, `{"group_ids":["uem_group"],"rules":[`+testRuleJSON+`]}`)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	if len(service.input.GroupIDs) != 1 || service.input.GroupIDs[0] != "uem_group" {
		t.Fatalf("GroupIDs = %+v", service.input.GroupIDs)
	}
	if len(service.input.Rules) != 1 || service.input.Rules[0].Name() != "rate_limit" {
		t.Fatalf("Rules = %+v", service.input.Rules)
	}
	var payload struct {
		Data accountRulesView `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if payload.Data.AccountRef != "acct_0123456789abcdef0123" || !payload.Data.Supported {
		t.Fatalf("响应 = %+v", payload.Data)
	}
}

func TestGetAndDeleteAccountRules(t *testing.T) {
	handler, service := newHandler()
	get := memberRequest(http.MethodGet, "")
	getResponse := httptest.NewRecorder()
	handler.ServeHTTP(getResponse, get)
	if getResponse.Code != http.StatusOK {
		t.Fatalf("GET status = %d", getResponse.Code)
	}

	remove := memberRequest(http.MethodDelete, "")
	removeResponse := httptest.NewRecorder()
	handler.ServeHTTP(removeResponse, remove)
	if removeResponse.Code != http.StatusOK {
		t.Fatalf("DELETE status = %d body=%s", removeResponse.Code, removeResponse.Body.String())
	}
	if !service.deleted["acct_0123456789abcdef0123"] {
		t.Fatalf("DELETE 未调用服务")
	}
}

func TestUnknownAccountReturnsNotFound(t *testing.T) {
	handler, _ := newHandler()
	request := httptest.NewRequest(http.MethodGet, "/v1/management/accounts/acct_ffffffffffffffffffff/upstream-error-rules", nil)
	request.SetPathValue("ref", "acct_ffffffffffffffffffff")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusNotFound {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
}

func TestCollectionReturnsAllAccounts(t *testing.T) {
	handler, _ := newHandler()
	request := httptest.NewRequest(http.MethodGet, CollectionPath, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var payload struct {
		Data struct {
			Accounts []accountRulesView `json:"accounts"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if len(payload.Data.Accounts) != 1 {
		t.Fatalf("accounts = %+v", payload.Data.Accounts)
	}
}

func TestUnauthorizedIsRejected(t *testing.T) {
	service := &fakeService{views: map[string]rulesapp.AccountView{}, deleted: map[string]bool{}}
	handler, err := NewHandler(Dependencies{Authorizer: denyAll{}, Service: service})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, memberRequest(http.MethodGet, ""))
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d", response.Code)
	}
}
