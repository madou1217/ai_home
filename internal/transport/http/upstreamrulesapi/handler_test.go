package upstreamrulesapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	rulesapp "github.com/madou1217/ai_home/application/upstreamrules"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type fakeService struct {
	result  rulesapp.ProjectionResult
	records []rulesapp.Record
	got     []rulesapp.ProjectionAccount
}

func (service *fakeService) ReplaceProjection(
	_ context.Context,
	accounts []rulesapp.ProjectionAccount,
) (rulesapp.ProjectionResult, error) {
	service.got = accounts
	return service.result, nil
}

func (service *fakeService) Snapshot(context.Context) ([]rulesapp.Record, error) {
	return service.records, nil
}

func (service *fakeService) Generation() int64 { return service.result.Generation }

func (service *fakeService) SupportedProviders() []string { return []string{"codex"} }

func TestCompatProjectionReturnsAcceptedDroppedAndMismatched(t *testing.T) {
	service := &fakeService{result: rulesapp.ProjectionResult{
		Generation: 7,
		Accepted:   []string{"acct_0123456789abcdef0123"},
		Dropped:    []rulesapp.Drop{{AccountRef: "acct_ffffffffffffffffffff", Reason: rulesapp.DropProviderNotSupported}},
		Mismatched: []string{"acct_0123456789abcdef0123"},
	}}
	handler, err := NewHandler(Dependencies{Authorizer: allowAll{}, Service: service})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	body := `{"accounts":[{"account_ref":"acct_0123456789abcdef0123","provider":"codex","rules":[{"name":"r","kind":"rate_limited","enabled":true,"statuses":[429],"matchers":[{"source":"body","operator":"contains","value":"x"}]}]}]}`
	request := httptest.NewRequest(http.MethodPut, Path, strings.NewReader(body))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Data rulesView `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if payload.Data.Generation != 7 ||
		len(payload.Data.AcceptedAccountRefs) != 1 ||
		len(payload.Data.Dropped) != 1 ||
		len(payload.Data.MismatchedRefs) != 1 {
		t.Fatalf("响应 = %+v", payload.Data)
	}
	if len(service.got) != 1 || service.got[0].AccountRef != "acct_0123456789abcdef0123" {
		t.Fatalf("透传记录 = %+v", service.got)
	}
}

func TestCompatProjectionGetReturnsAccounts(t *testing.T) {
	var rule rulescore.Rule
	if err := json.Unmarshal([]byte(`{"name":"r","kind":"rate_limited","enabled":true,"statuses":[429],"matchers":[{"source":"body","operator":"contains","value":"x"}]}`), &rule); err != nil {
		t.Fatalf("解析规则失败: %v", err)
	}
	service := &fakeService{records: []rulesapp.Record{{
		AccountRef: "acct_0123456789abcdef0123",
		Provider:   "codex",
		Source:     rulesapp.SourceProjection,
		Rules:      []rulescore.Rule{rule},
	}}}
	handler, err := NewHandler(Dependencies{Authorizer: allowAll{}, Service: service})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	request := httptest.NewRequest(http.MethodGet, Path, nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var payload struct {
		Data rulesView `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if len(payload.Data.Accounts) != 1 || payload.Data.Accounts[0].Provider != "codex" {
		t.Fatalf("accounts = %+v", payload.Data.Accounts)
	}
}
