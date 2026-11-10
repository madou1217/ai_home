package webuiaccountsexportapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/accountrefmap"
)

func mustSyncResolver(t *testing.T, links map[string]string) accountrefmap.Resolver {
	t.Helper()
	payload := struct {
		Links map[string]struct {
			GoRef string `json:"goRef"`
		} `json:"links"`
	}{Links: map[string]struct {
		GoRef string `json:"goRef"`
	}{}}
	for nodeRef, goRef := range links {
		payload.Links[nodeRef] = struct {
			GoRef string `json:"goRef"`
		}{GoRef: goRef}
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	table, err := accountrefmap.Parse(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return accountrefmap.NewResolver(true, table)
}

func newTestHandlerWithResolver(t *testing.T, fixture fixture, resolver accountrefmap.Resolver) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer:  allowAll{},
		Overviews:   fixture.overviews,
		Credentials: fixture.credentials,
		Resolver:    resolver,
	})
	if err != nil {
		t.Fatal(err)
	}
	return handler
}

func TestExportTranslatesNodeAccountRef(t *testing.T) {
	fixture := newFixture(t, 2)
	goRef := fixture.accounts[1].Ref().String()
	handler := newTestHandlerWithResolver(t, fixture, mustSyncResolver(t, map[string]string{
		"node-ref-alpha": goRef,
	}))

	for _, key := range []string{"accountRef", "account_ref"} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(
			recorder,
			httptest.NewRequest(http.MethodGet, Path+"?"+key+"=node-ref-alpha", nil),
		)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, body = %s", key, recorder.Code, recorder.Body.String())
		}
		accounts := exportedDocument(t, recorder.Body.Bytes())["accounts"].([]any)
		if len(accounts) != 1 || accounts[0].(map[string]any)["accountRef"] != goRef {
			t.Fatalf("%s: accounts = %#v", key, accounts)
		}
	}
}

func TestExportRejectsMalformedFilters(t *testing.T) {
	fixture := newFixture(t, 1)
	handler := newTestHandler(t, fixture)
	for _, query := range []string{
		"?provider=co%20dex",
		"?provider=-codex",
		"?accountRef=not-a-ref",
		"?accountRef=" + fixture.accounts[0].Ref().String() + ",bogus",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path+query, nil))
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, body = %s", query, recorder.Code, recorder.Body.String())
		}
		var body errorResponse
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Error.Code != "invalid_export_query" {
			t.Fatalf("%s: body = %#v", query, body)
		}
	}
}

func TestExportCanonicalizesProviderCase(t *testing.T) {
	fixture := newFixture(t, 2)
	recorder := httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path+"?provider=%20CODEX%20", nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if accounts := exportedDocument(t, recorder.Body.Bytes())["accounts"].([]any); len(accounts) != 2 {
		t.Fatalf("accounts = %#v", accounts)
	}
}

func TestExportUnknownAccountRefReturnsNotFound(t *testing.T) {
	fixture := newFixture(t, 1)
	catalog := mustCatalog(t)
	missing, _ := mustCodexAccount(t, catalog, "sk-not-in-fixture", 99)

	recorder := httptest.NewRecorder()
	newTestHandler(t, fixture).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path+"?accountRef="+missing.Ref().String(), nil),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != "account_not_found" {
		t.Fatalf("body = %#v", body)
	}
}

func TestExportNodeRefForMissingGoAccountReturnsNotFound(t *testing.T) {
	fixture := newFixture(t, 1)
	catalog := mustCatalog(t)
	missing, _ := mustCodexAccount(t, catalog, "sk-node-only", 42)
	handler := newTestHandlerWithResolver(t, fixture, mustSyncResolver(t, map[string]string{
		"node-ref-missing": missing.Ref().String(),
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path+"?accountRef=node-ref-missing", nil),
	)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestExportReportsNodeOnlyAccountsFromLinks(t *testing.T) {
	fixture := newFixture(t, 2)
	catalog := mustCatalog(t)
	missing, _ := mustCodexAccount(t, catalog, "sk-node-only", 7)
	resolver := mustSyncResolver(t, map[string]string{
		"node-ref-known":   fixture.accounts[0].Ref().String(),
		"node-ref-unknown": missing.Ref().String(),
	})

	recorder := httptest.NewRecorder()
	newTestHandlerWithResolver(t, fixture, resolver).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if nodeOnly := recorder.Header().Get(NodeOnlyAccountsHeader); nodeOnly != "1" {
		t.Fatalf("%s = %q", NodeOnlyAccountsHeader, nodeOnly)
	}

	// 过滤后的集合不完整，计数不可解释：不发该响应头。
	recorder = httptest.NewRecorder()
	newTestHandlerWithResolver(t, fixture, resolver).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path+"?provider=codex", nil),
	)
	if nodeOnly := recorder.Header().Get(NodeOnlyAccountsHeader); nodeOnly != "" {
		t.Fatalf("过滤导出不应给出 %s，得到 %q", NodeOnlyAccountsHeader, nodeOnly)
	}

	// 未启用同步：两边引用相同，没有可统计的 Node-only。
	recorder = httptest.NewRecorder()
	newTestHandlerWithResolver(t, fixture, accountrefmap.NewResolver(false, accountrefmap.Table{})).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)
	if nodeOnly := recorder.Header().Get(NodeOnlyAccountsHeader); nodeOnly != "" {
		t.Fatalf("未启用同步不应给出 %s，得到 %q", NodeOnlyAccountsHeader, nodeOnly)
	}
}

func TestExportNodeOnlyDeduplicatesSharedGoRef(t *testing.T) {
	fixture := newFixture(t, 1)
	catalog := mustCatalog(t)
	missing, _ := mustCodexAccount(t, catalog, "sk-shared", 8)
	resolver := mustSyncResolver(t, map[string]string{
		"node-ref-a": missing.Ref().String(),
		"node-ref-b": missing.Ref().String(),
	})
	recorder := httptest.NewRecorder()
	newTestHandlerWithResolver(t, fixture, resolver).ServeHTTP(
		recorder,
		httptest.NewRequest(http.MethodGet, Path, nil),
	)
	if nodeOnly := recorder.Header().Get(NodeOnlyAccountsHeader); nodeOnly != "1" {
		t.Fatalf("%s = %q, 同一 Go 引用应只计一次", NodeOnlyAccountsHeader, nodeOnly)
	}
}

func TestTranslateExportQueryKeepsUnknownKeys(t *testing.T) {
	fixture := newFixture(t, 1)
	handler := newTestHandler(t, fixture)
	query, err := handler.translateExportQuery(
		httptest.NewRequest(http.MethodGet, Path+"?ref=acct_x", nil).URL.Query(),
	)
	if err != nil {
		t.Fatalf("err = %v, 未知键应原样保留交给 ParseExportFilters 拒绝", err)
	}
	if values := query.values["ref"]; len(values) != 1 || values[0] != "acct_x" {
		t.Fatalf("ref = %#v", values)
	}
}
