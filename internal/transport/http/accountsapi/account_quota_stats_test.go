package accountsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

type fakeQuotaStats struct {
	result usageapp.QuotaStatsResult
	err    error
	query  usageapp.QuotaStatsQuery
}

func (fake *fakeQuotaStats) BuildQuotaStats(
	_ context.Context,
	query usageapp.QuotaStatsQuery,
) (usageapp.QuotaStatsResult, error) {
	fake.query = query
	return fake.result, fake.err
}

func quotaStatsAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func TestParseMemberResourceRecognizesQuotaStats(t *testing.T) {
	resource, err := parseMemberResource(
		CollectionPath + "/acct_0123456789abcdef0123/quota-stats",
	)
	if err != nil {
		t.Fatalf("parseMemberResource() error = %v", err)
	}
	if resource.kind != memberResourceQuotaStats {
		t.Fatalf("kind = %v, want memberResourceQuotaStats", resource.kind)
	}
}

func TestParseQuotaStatsQueryAcceptsValidParams(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/quota-stats?window=10080&scope=rate_limit:secondary&range_days=7",
		nil,
	)
	recorder := httptest.NewRecorder()
	query, ok := parseQuotaStatsQuery(recorder, request, quotaStatsAccountRef(t))
	if !ok {
		t.Fatalf("parseQuotaStatsQuery() ok = false, status = %d", recorder.Code)
	}
	if query.WindowMinutes != 10080 || query.QuotaKey != "rate_limit:secondary" || query.RangeDays != 7 {
		t.Fatalf("query = %+v", query)
	}
}

func TestParseQuotaStatsQueryRejectsInvalidParams(t *testing.T) {
	cases := []string{
		"window=0",
		"window=-5",
		"window=abc",
		"window=999999999",
		"range_days=0",
		"range_days=91",
		"unknown=1",
	}
	for _, rawQuery := range cases {
		t.Run(rawQuery, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodGet,
				CollectionPath+"/acct_0123456789abcdef0123/quota-stats?"+rawQuery,
				nil,
			)
			recorder := httptest.NewRecorder()
			if _, ok := parseQuotaStatsQuery(recorder, request, quotaStatsAccountRef(t)); ok {
				t.Fatalf("parseQuotaStatsQuery() ok = true, want false")
			}
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", recorder.Code)
			}
		})
	}
}

func TestHandleAccountQuotaStatsReturnsData(t *testing.T) {
	fake := &fakeQuotaStats{result: usageapp.QuotaStatsResult{
		WindowMinutes: 300,
		Windows: []usageapp.QuotaStatsWindow{{
			QuotaWindow: usagecore.QuotaWindow{Index: 0, AnchorAtMS: 1, CloseAtMS: 2},
			Tokens:      120,
		}},
	}}
	handler := &Handler{quotaStats: fake}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/quota-stats?window=300",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.handleAccountQuotaStats(recorder, request, quotaStatsAccountRef(t))

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data usageapp.QuotaStatsResult `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	if len(payload.Data.Windows) != 1 || payload.Data.Windows[0].Tokens != 120 {
		t.Fatalf("payload = %+v", payload.Data)
	}
	if fake.query.WindowMinutes != 300 {
		t.Fatalf("service 收到的 window = %d", fake.query.WindowMinutes)
	}
}

func TestHandleAccountQuotaStatsRejectsNonGET(t *testing.T) {
	handler := &Handler{quotaStats: &fakeQuotaStats{}}
	request := httptest.NewRequest(
		http.MethodPost,
		CollectionPath+"/acct_0123456789abcdef0123/quota-stats",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.handleAccountQuotaStats(recorder, request, quotaStatsAccountRef(t))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
	if recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("Allow = %q", recorder.Header().Get("Allow"))
	}
}

func TestHandleAccountQuotaStatsMapsInvalidQueryTo400(t *testing.T) {
	handler := &Handler{quotaStats: &fakeQuotaStats{err: usageapp.ErrInvalidQuotaStatsQuery}}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/quota-stats",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.handleAccountQuotaStats(recorder, request, quotaStatsAccountRef(t))
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

type allowAllQuotaStatsAuthorizer struct{}

func (allowAllQuotaStatsAuthorizer) Authorized(*http.Request) bool { return true }

func TestServeHTTPDispatchesQuotaStatsMember(t *testing.T) {
	handler := &Handler{
		quotaStats: &fakeQuotaStats{result: usageapp.QuotaStatsResult{WindowMinutes: 300}},
		authorizer: allowAllQuotaStatsAuthorizer{},
	}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/quota-stats?window=300",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
}

func TestHandleAccountQuotaStatsMapsUnknownErrorTo500(t *testing.T) {
	handler := &Handler{quotaStats: &fakeQuotaStats{err: errors.New("boom")}}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/quota-stats",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.handleAccountQuotaStats(recorder, request, quotaStatsAccountRef(t))
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
}
