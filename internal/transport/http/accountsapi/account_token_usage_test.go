package accountsapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/usageledger"
)

type fakeTokenUsage struct {
	usage           usageledger.AccountTokenUsage
	err             error
	query           usageledger.Query
	tzOffsetMinutes int
}

func (fake *fakeTokenUsage) QueryAccountTokenUsage(
	_ context.Context,
	query usageledger.Query,
	tzOffsetMinutes int,
) (usageledger.AccountTokenUsage, error) {
	fake.query = query
	fake.tzOffsetMinutes = tzOffsetMinutes
	return fake.usage, fake.err
}

type denyAllTokenUsageAuthorizer struct{}

func (denyAllTokenUsageAuthorizer) Authorized(*http.Request) bool { return false }

func tokenUsageAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return accountRef
}

func TestParseMemberResourceRecognizesTokenUsage(t *testing.T) {
	resource, err := parseMemberResource(
		CollectionPath + "/acct_0123456789abcdef0123/token-usage",
	)
	if err != nil {
		t.Fatalf("parseMemberResource() error = %v", err)
	}
	if resource.kind != memberResourceTokenUsage {
		t.Fatalf("kind = %v, want memberResourceTokenUsage", resource.kind)
	}
}

func TestParseAccountTokenUsageQueryUsesUTCBounds(t *testing.T) {
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/token-usage?from=2026-11-01&to=2026-11-06",
		nil,
	)
	recorder := httptest.NewRecorder()
	query, tzOffsetMinutes, ok := parseAccountTokenUsageQuery(recorder, request, tokenUsageAccountRef(t))
	if !ok {
		t.Fatalf("parseAccountTokenUsageQuery() ok = false, status = %d", recorder.Code)
	}
	if tzOffsetMinutes != 0 {
		t.Fatalf("tzOffsetMinutes = %d, want 0（缺省按 UTC）", tzOffsetMinutes)
	}
	if want := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC); !query.From.Equal(want) {
		t.Fatalf("from = %v, want %v", query.From, want)
	}
	// 只写日期时 to 取当天最后一纳秒，与 usagestatsapi.parseQuery 一致。
	if want := time.Date(2026, 11, 6, 23, 59, 59, 999999999, time.UTC); !query.To.Equal(want) {
		t.Fatalf("to = %v, want %v", query.To, want)
	}
	if query.AccountRef != tokenUsageAccountRef(t) {
		t.Fatalf("AccountRef = %v", query.AccountRef)
	}

	// RFC3339Nano 带偏移时归一到 UTC。
	request = httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/token-usage?from=2026-11-01T08%3A30%3A00%2B08%3A00",
		nil,
	)
	recorder = httptest.NewRecorder()
	query, _, ok = parseAccountTokenUsageQuery(recorder, request, tokenUsageAccountRef(t))
	if !ok {
		t.Fatalf("parseAccountTokenUsageQuery(rfc3339) ok = false, status = %d", recorder.Code)
	}
	if want := time.Date(2026, 11, 1, 0, 30, 0, 0, time.UTC); !query.From.Equal(want) {
		t.Fatalf("from = %v, want %v", query.From, want)
	}
}

func TestParseAccountTokenUsageQueryRejectsInvalidParams(t *testing.T) {
	for _, rawQuery := range []string{
		"from=abc",
		"to=2026-11-06T12:00:00",
		"from=2026-11-06&to=2026-11-01",
		"unknown=1",
		"from=2026-11-01&from=2026-11-02",
		"tz_offset_minutes=abc",
		"tz_offset_minutes=",
		"tz_offset_minutes=841",
		"tz_offset_minutes=-721",
		"tz_offset_minutes=480&tz_offset_minutes=480",
	} {
		t.Run(rawQuery, func(t *testing.T) {
			request := httptest.NewRequest(
				http.MethodGet,
				CollectionPath+"/acct_0123456789abcdef0123/token-usage?"+rawQuery,
				nil,
			)
			recorder := httptest.NewRecorder()
			if _, _, ok := parseAccountTokenUsageQuery(recorder, request, tokenUsageAccountRef(t)); ok {
				t.Fatalf("parseAccountTokenUsageQuery() ok = true, want false")
			}
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", recorder.Code)
			}
		})
	}
}

func TestParseAccountTokenUsageQueryParsesTZOffset(t *testing.T) {
	// 缺省（不带参数）按 UTC；-720（UTC-12）与 840（UTC+14）是合法闭区间端点。
	cases := map[string]int{
		"":          0, // 空串表示不传该参数
		"0":         0,
		"480":       480,
		"-300":      -300,
		"-720":      -720,
		"840":       840,
		"%20480%20": 480, // URL 解码后首尾带空格，TrimSpace 后仍可解析
	}
	for raw, want := range cases {
		target := CollectionPath + "/acct_0123456789abcdef0123/token-usage?to=2026-11-06"
		if raw != "" {
			target += "&tz_offset_minutes=" + raw
		}
		request := httptest.NewRequest(http.MethodGet, target, nil)
		recorder := httptest.NewRecorder()
		_, offset, ok := parseAccountTokenUsageQuery(recorder, request, tokenUsageAccountRef(t))
		if !ok {
			t.Fatalf("tz_offset_minutes=%q ok = false, status = %d", raw, recorder.Code)
		}
		if offset != want {
			t.Fatalf("tz_offset_minutes=%q offset = %d, want %d", raw, offset, want)
		}
	}
}

func TestServeHTTPRejectsUnauthorizedTokenUsage(t *testing.T) {
	handler := &Handler{
		tokenUsage: &fakeTokenUsage{},
		authorizer: denyAllTokenUsageAuthorizer{},
	}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/token-usage",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q", recorder.Header().Get("WWW-Authenticate"))
	}
}

func TestHandleAccountTokenUsageReturnsNodeShape(t *testing.T) {
	fake := &fakeTokenUsage{usage: usageledger.AccountTokenUsage{
		Day: 7, Week: 9, Month: 11, Total: 13,
		Models: []usageledger.AccountTokenUsageModel{{
			Model: "gpt-6.1-sol", Day: 7, Week: 9, Month: 11, Total: 13,
		}},
	}}
	handler := &Handler{tokenUsage: fake, authorizer: allowAllQuotaStatsAuthorizer{}}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/token-usage?to=2026-11-06&tz_offset_minutes=480",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if fake.query.AccountRef != tokenUsageAccountRef(t) {
		t.Fatalf("服务收到的 AccountRef = %v", fake.query.AccountRef)
	}
	// 偏移必须原样传到存储层，否则窗口会退回 UTC 切分。
	if fake.tzOffsetMinutes != 480 {
		t.Fatalf("服务收到的 tzOffsetMinutes = %d, want 480", fake.tzOffsetMinutes)
	}
	var payload struct {
		Data struct {
			Day       uint64           `json:"day"`
			Week      uint64           `json:"week"`
			Month     uint64           `json:"month"`
			Total     uint64           `json:"total"`
			Models    []map[string]any `json:"models"`
			FromMS    int64            `json:"from_ms"`
			ToMS      int64            `json:"to_ms"`
			CostKnown bool             `json:"cost_known"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	data := payload.Data
	if data.Day != 7 || data.Week != 9 || data.Month != 11 || data.Total != 13 {
		t.Fatalf("data = %+v", data)
	}
	if len(data.Models) != 1 || data.Models[0]["model"] != "gpt-6.1-sol" {
		t.Fatalf("models = %#v", data.Models)
	}
	// Node 的成本字段必须存在且为 null：未知成本不能伪装成 0 元。
	for _, key := range []string{"dayCostUsd", "weekCostUsd", "monthCostUsd", "totalCostUsd"} {
		value, exists := data.Models[0][key]
		if !exists || value != nil {
			t.Fatalf("models[0][%q] = %#v (exists = %v), want null", key, value, exists)
		}
	}
	if data.CostKnown {
		t.Fatalf("cost_known = true, want false")
	}
	if data.FromMS != 0 {
		t.Fatalf("from_ms = %d, want 0", data.FromMS)
	}
	if want := time.Date(2026, 11, 6, 23, 59, 59, 999999999, time.UTC).UnixMilli(); data.ToMS != want {
		t.Fatalf("to_ms = %d, want %d", data.ToMS, want)
	}
}

func TestHandleAccountTokenUsageReturnsZeroesForEmptyData(t *testing.T) {
	handler := &Handler{tokenUsage: &fakeTokenUsage{}, authorizer: allowAllQuotaStatsAuthorizer{}}
	request := httptest.NewRequest(
		http.MethodGet,
		CollectionPath+"/acct_0123456789abcdef0123/token-usage?to=2026-11-06",
		nil,
	)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var payload struct {
		Data struct {
			Day    uint64 `json:"day"`
			Week   uint64 `json:"week"`
			Month  uint64 `json:"month"`
			Total  uint64 `json:"total"`
			Models []any  `json:"models"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("Unmarshal() error = %v", err)
	}
	data := payload.Data
	if data.Day != 0 || data.Week != 0 || data.Month != 0 || data.Total != 0 {
		t.Fatalf("data = %+v, want all zero", data)
	}
	// 空账号也要给 []，不能把 null 丢给 Node 的数组遍历。
	if data.Models == nil || len(data.Models) != 0 {
		t.Fatalf("models = %#v, want []", data.Models)
	}
}
