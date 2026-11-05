package usage

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
	"github.com/madou1217/ai_home/internal/adapters/accounts/qodercred"
)

const testCapturedAtMS = int64(1_800_000_000_000)

func testCapturedAt() time.Time { return time.UnixMilli(testCapturedAtMS).UTC() }

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

// testResponse 是一条固定上游响应；status 为 0 时按 200 处理。
type testResponse struct {
	status int
	body   string
}

type recordedRequest struct {
	path          string
	authorization string
	accept        string
}

// newTestServer 按路径返回固定响应，并记录每次请求的头，便于断言鉴权与路径。
func newTestServer(t *testing.T, responses map[string]testResponse) (*httptest.Server, func() []recordedRequest) {
	t.Helper()
	var (
		mutex   sync.Mutex
		records []recordedRequest
	)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		records = append(records, recordedRequest{
			path:          request.URL.Path,
			authorization: request.Header.Get("Authorization"),
			accept:        request.Header.Get("Accept"),
		})
		mutex.Unlock()
		response, found := responses[request.URL.Path]
		if !found {
			writer.WriteHeader(http.StatusNotFound)
			return
		}
		status := response.status
		if status == 0 {
			status = http.StatusOK
		}
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(status)
		_, _ = writer.Write([]byte(response.body))
	}))
	t.Cleanup(server.Close)
	return server, func() []recordedRequest {
		mutex.Lock()
		defer mutex.Unlock()
		return append([]recordedRequest(nil), records...)
	}
}

func jsonBody(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return string(encoded)
}

func newTestStrategy(t *testing.T, server *httptest.Server, providerID string) *Strategy {
	t.Helper()
	strategy, err := New(server.Client(), providerID)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.apiBase = server.URL
	return strategy
}

func qoderCredential(t *testing.T, providerID string, native map[string]any) accountapp.Credential {
	t.Helper()
	payload, err := json.Marshal(native)
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth(providerID, payload)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	return credential
}

// readableCredential 是最常见的形态：登录态明文落在 userInfo 里。
func readableCredential(t *testing.T, providerID, token string) accountapp.Credential {
	t.Helper()
	return qoderCredential(t, providerID, map[string]any{
		"userInfo": map[string]any{
			"uid":                  "u-1",
			"security_oauth_token": token,
			"email":                "user@example.com",
		},
	})
}

func decodePayload(t *testing.T, document *usagecore.Document) map[string]any {
	t.Helper()
	if document == nil {
		t.Fatal("document = nil")
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("document payload is not JSON: %v", err)
	}
	return payload
}

func payloadEntries(t *testing.T, payload map[string]any) []any {
	t.Helper()
	entries, ok := payload["entries"].([]any)
	if !ok {
		t.Fatalf("payload entries = %#v", payload["entries"])
	}
	return entries
}

func TestNewRejectsUnknownProvider(t *testing.T) {
	if _, err := New(http.DefaultClient, "codex"); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("New(unknown) error = %v", err)
	}
	if _, err := New(nil, "qoder"); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("New(nil client) error = %v", err)
	}
	strategy, err := New(http.DefaultClient, "QoderCN")
	if err != nil {
		t.Fatalf("New(QoderCN) error = %v", err)
	}
	if strategy.ProviderID() != "QoderCN" {
		t.Fatalf("ProviderID() = %q", strategy.ProviderID())
	}
	if strategy.apiBase != "https://openapi.qoder.com.cn" {
		t.Fatalf("apiBase = %q", strategy.apiBase)
	}
}

func TestFetchUsageMapsCreditsPool(t *testing.T) {
	resetAtMS := testCapturedAtMS + 3*24*60*60*1000
	server, requests := newTestServer(t, map[string]testResponse{
		quotaPath: {body: jsonBody(t, map[string]any{
			"userId":               "u-1",
			"userType":             "personal",
			"totalUsagePercentage": 25,
			"isQuotaExceeded":      false,
			"expiresAt":            resetAtMS,
			"userQuota": map[string]any{
				"total":      2000,
				"used":       500,
				"remaining":  1500,
				"percentage": 25.0,
				"unit":       "credits",
			},
		})},
		planPath: {body: jsonBody(t, map[string]any{
			"plan_tier_name": "Pro Trial",
			"is_paid_plan":   true,
			"start_date":     testCapturedAtMS - 30*24*60*60*1000,
			"end_date":       resetAtMS,
		})},
		statusPath: {body: jsonBody(t, map[string]any{
			"id":              "u-1",
			"name":            "Qoder User",
			"email":           "user@example.com",
			"userType":        "personal",
			"plan":            "PLAN_TIER_PRO",
			"userTag":         "Pro",
			"nextResetAt":     0,
			"isQuotaExceeded": false,
		})},
	})
	strategy := newTestStrategy(t, server, "qoder")
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		readableCredential(t, "qoder", "oauth-token"),
		testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	seen := requests()
	if len(seen) != 3 {
		t.Fatalf("requests = %#v", seen)
	}
	for _, request := range seen {
		if request.authorization != "Bearer oauth-token" || request.accept != "application/json" {
			t.Fatalf("request headers = %#v", request)
		}
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	entry := entries[0]
	if entry.Bucket() != "credits" || entry.Kind() != usagecore.KindCredits || entry.Scope() != usagecore.ScopeAccount {
		t.Fatalf("entry = %#v", entry)
	}
	if basisPoints, has := entry.RemainingBasisPoints(); !has || basisPoints != 7500 {
		t.Fatalf("remaining = %d / %v", basisPoints, has)
	}
	if entry.Availability() != usagecore.AvailabilityAvailable {
		t.Fatalf("availability = %q", entry.Availability())
	}
	if entry.WindowSeconds() != 3*24*60*60 {
		t.Fatalf("window seconds = %d", entry.WindowSeconds())
	}
	if !entry.ResetAt().Equal(time.UnixMilli(resetAtMS).UTC()) {
		t.Fatalf("resetAt = %v", entry.ResetAt())
	}
	if document.Kind() != documentKind || document.Source() != sourceID {
		t.Fatalf("document = %q / %q", document.Kind(), document.Source())
	}
	payload := decodePayload(t, document)
	if payload["schemaVersion"] != float64(schemaVersion) || payload["kind"] != documentKind || payload["source"] != sourceID {
		t.Fatalf("payload header = %#v", payload)
	}
	if _, found := payload["notApplicable"]; found {
		t.Fatalf("notApplicable must be absent: %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["userId"] != "u-1" || account["email"] != "user@example.com" ||
		account["name"] != "Qoder User" || account["userType"] != "personal" ||
		account["planName"] != "Pro Trial" || account["planTier"] != "PLAN_TIER_PRO" ||
		account["isPaidPlan"] != true {
		t.Fatalf("account = %#v", account)
	}
	if account["periodStartMs"] != float64(testCapturedAtMS-30*24*60*60*1000) ||
		account["periodEndMs"] != float64(resetAtMS) {
		t.Fatalf("period = %#v", account)
	}
	coverage := payload["coverage"].(map[string]any)
	if coverage["source"] != coverageSource || coverage["tokenSource"] != "native_auth" {
		t.Fatalf("coverage = %#v", coverage)
	}
	documentEntries := payloadEntries(t, payload)
	if len(documentEntries) != 1 {
		t.Fatalf("document entries = %#v", documentEntries)
	}
	view := documentEntries[0].(map[string]any)
	if view["bucket"] != "credits" || view["window"] != "Credits" ||
		view["windowMinutes"] != float64(4320) || view["remainingPct"] != 75.0 ||
		view["totalUnits"] != 2000.0 || view["usedUnits"] != 500.0 ||
		view["remainingUnits"] != 1500.0 || view["unitType"] != "credits" ||
		view["quotaExceeded"] != false || view["resetAtMs"] != float64(resetAtMS) ||
		view["resetIn"] != "3 天后" {
		t.Fatalf("entry view = %#v", view)
	}
}

// Free 档没有可消耗的 credits：必须是「未知」而不是「零剩余」，否则账号会被摘出路由。
func TestFetchUsageFreePlanHasNoConsumableCredits(t *testing.T) {
	server, _ := newTestServer(t, map[string]testResponse{
		quotaPath: {body: jsonBody(t, map[string]any{
			"userId":          "u-free",
			"isQuotaExceeded": true,
			"expiresAt":       0,
			"userQuota": map[string]any{
				"total":      0,
				"used":       0,
				"remaining":  0,
				"percentage": 0,
				"unit":       "credits",
			},
		})},
		planPath: {body: jsonBody(t, map[string]any{"plan_tier_name": "Free", "is_paid_plan": false})},
		statusPath: {body: jsonBody(t, map[string]any{
			"id": "u-free", "plan": "PLAN_TIER_FREE", "isQuotaExceeded": true,
		})},
	})
	strategy := newTestStrategy(t, server, "qoder")
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		readableCredential(t, "qoder", "oauth-token"),
		testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %#v", entries)
	}
	if _, has := entries[0].RemainingBasisPoints(); has {
		t.Fatalf("remaining must be unknown, got %#v", entries[0])
	}
	if entries[0].Availability() != usagecore.AvailabilityUnknown {
		t.Fatalf("availability = %q", entries[0].Availability())
	}
	remaining := snapshot.MinRemaining()
	if remaining.Known {
		t.Fatalf("snapshot remaining = %#v", remaining)
	}
	state := usagecore.DeriveQuotaState(usagecore.QuotaStateInput{Kind: documentKind, Remaining: remaining})
	if state.Status != usagecore.QuotaStatePending {
		t.Fatalf("quota state = %#v", state)
	}
	payload := decodePayload(t, document)
	if payload["notApplicable"] != true || payload["reason"] != noConsumableCreditsReason {
		t.Fatalf("payload = %#v", payload)
	}
	if len(payloadEntries(t, payload)) != 0 {
		t.Fatalf("document entries = %#v", payload["entries"])
	}
}

func TestFetchUsageUnauthorized(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden} {
		server, _ := newTestServer(t, map[string]testResponse{
			quotaPath: {status: status, body: `{"error":"denied"}`},
		})
		strategy := newTestStrategy(t, server, "qoder")
		_, _, err := strategy.FetchUsageWithDocument(
			context.Background(),
			testAccountRef(t),
			readableCredential(t, "qoder", "oauth-token"),
			testCapturedAt(),
		)
		if !errors.Is(err, usageapp.ErrRefreshFailed) || !errors.Is(err, ErrUnauthorized) {
			t.Fatalf("status %d error = %v", status, err)
		}
	}
}

func TestFetchUsageRejectsMissingFields(t *testing.T) {
	cases := map[string]map[string]any{
		"no userQuota":    {"userId": "u-1"},
		"no percentage":   {"userId": "u-1", "userQuota": map[string]any{"total": 100}},
		"empty userQuota": {"userQuota": map[string]any{}},
	}
	for name, body := range cases {
		server, _ := newTestServer(t, map[string]testResponse{
			quotaPath: {body: jsonBody(t, body)},
		})
		strategy := newTestStrategy(t, server, "qoder")
		_, _, err := strategy.FetchUsageWithDocument(
			context.Background(),
			testAccountRef(t),
			readableCredential(t, "qoder", "oauth-token"),
			testCapturedAt(),
		)
		if !errors.Is(err, usageapp.ErrRefreshFailed) || !errors.Is(err, ErrInvalidResponse) {
			t.Fatalf("%s error = %v", name, err)
		}
	}
}

func TestFetchUsageRejectsInvalidJSON(t *testing.T) {
	server, _ := newTestServer(t, map[string]testResponse{
		quotaPath: {body: `null`},
	})
	strategy := newTestStrategy(t, server, "qoder")
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		readableCredential(t, "qoder", "oauth-token"),
		testCapturedAt(),
	)
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchUsageTokenFromPAT(t *testing.T) {
	server, requests := newTestServer(t, map[string]testResponse{
		quotaPath: {body: jsonBody(t, map[string]any{
			"userId": "u-1",
			"userQuota": map[string]any{
				"total": 1000, "used": 100, "remaining": 900, "percentage": 10,
			},
		})},
		planPath:   {body: jsonBody(t, map[string]any{"plan_tier_name": "Pro"})},
		statusPath: {body: jsonBody(t, map[string]any{"id": "u-1"})},
	})
	strategy := newTestStrategy(t, server, "qoder")
	credential := qoderCredential(t, "qoder", map[string]any{
		"userInfo": map[string]any{"personal_access_token": "pat-token"},
	})
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), credential, testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	for _, request := range requests() {
		if request.authorization != "Bearer pat-token" {
			t.Fatalf("authorization = %q", request.authorization)
		}
	}
	if basisPoints, has := snapshot.Entries()[0].RemainingBasisPoints(); !has || basisPoints != 9000 {
		t.Fatalf("remaining = %d / %v", basisPoints, has)
	}
	coverage := decodePayload(t, document)["coverage"].(map[string]any)
	if coverage["tokenSource"] != "native_pat" {
		t.Fatalf("coverage = %#v", coverage)
	}
}

// opaque CLI 凭据只能靠 WASM 解；这里替换解密入口，验证接线（真机解密另有 live 测试）。
func TestFetchUsageTokenFromDecryptedCredential(t *testing.T) {
	original := decryptNative
	t.Cleanup(func() { decryptNative = original })
	decryptNative = func(provider string, native map[string]any) (qodercred.Identity, bool) {
		if provider != "qoder" {
			t.Errorf("decrypt provider = %q", provider)
		}
		if native["credentials"] != "opaque-blob" || native["machineId"] != "abcdefghijklmnop" {
			t.Errorf("decrypt native = %#v", native)
		}
		return qodercred.Identity{Token: "wasm-token", UID: "u-9"}, true
	}
	server, requests := newTestServer(t, map[string]testResponse{
		quotaPath: {body: jsonBody(t, map[string]any{
			"userQuota": map[string]any{
				"total": 500, "used": 0, "remaining": 500, "percentage": 0,
			},
		})},
		planPath:   {body: jsonBody(t, map[string]any{"plan_tier_name": "Free"})},
		statusPath: {body: jsonBody(t, map[string]any{"id": "u-9"})},
	})
	strategy := newTestStrategy(t, server, "qoder")
	credential := qoderCredential(t, "qoder", map[string]any{
		"userInfo":    map[string]any{"uid": "u-9"},
		"credentials": "opaque-blob",
		"machineId":   "abcdefghijklmnop",
	})
	_, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), credential, testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	for _, request := range requests() {
		if request.authorization != "Bearer wasm-token" {
			t.Fatalf("authorization = %q", request.authorization)
		}
	}
	coverage := decodePayload(t, document)["coverage"].(map[string]any)
	if coverage["tokenSource"] != "cli_wasm" {
		t.Fatalf("coverage = %#v", coverage)
	}
}

func TestFetchUsageRejectsCredentialWithoutToken(t *testing.T) {
	strategy, err := New(http.DefaultClient, "qoder")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	identity, err := accountcore.NewNativeQoderIdentity("qoder", "u-1")
	if err != nil {
		t.Fatalf("NewNativeQoderIdentity() error = %v", err)
	}
	payload := jsonBody(t, map[string]any{"userInfo": map[string]any{"uid": "u-1"}})
	credential, err := accountcore.NewNativeCredential(identity, []byte(payload))
	if err != nil {
		t.Fatalf("NewNativeCredential() error = %v", err)
	}
	_, _, err = strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), credential, testCapturedAt(),
	)
	if !errors.Is(err, ErrUnsupportedCredential) {
		t.Fatalf("error = %v", err)
	}
}

// 无限期档位的 9999-12-31 哨兵不能被当成重置时间；plan/status 失败也不该拖垮额度结论。
func TestFetchUsageIgnoresSentinelAndAuxiliaryFailures(t *testing.T) {
	server, _ := newTestServer(t, map[string]testResponse{
		quotaPath: {body: jsonBody(t, map[string]any{
			"userId":               "u-1",
			"totalUsagePercentage": 40,
			"expiresAt":            int64(253402214400000),
			"userQuota": map[string]any{
				"total": 100, "used": 40, "remaining": 60, "unit": "credits",
			},
		})},
		planPath:   {status: http.StatusInternalServerError, body: `{}`},
		statusPath: {status: http.StatusInternalServerError, body: `{}`},
	})
	strategy := newTestStrategy(t, server, "qoder")
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		readableCredential(t, "qoder", "oauth-token"),
		testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entry := snapshot.Entries()[0]
	if !entry.ResetAt().IsZero() || entry.WindowSeconds() != 0 {
		t.Fatalf("resetAt = %v / window = %d", entry.ResetAt(), entry.WindowSeconds())
	}
	payload := decodePayload(t, document)
	view := payloadEntries(t, payload)[0].(map[string]any)
	if view["resetAtMs"] != float64(0) || view["resetIn"] != "" || view["windowMinutes"] != float64(0) {
		t.Fatalf("entry view = %#v", view)
	}
	if view["remainingPct"] != 60.0 {
		t.Fatalf("remainingPct = %#v", view["remainingPct"])
	}
	account := payload["account"].(map[string]any)
	if account["userId"] != "u-1" || account["planName"] != "" {
		t.Fatalf("account = %#v", account)
	}
}

// usage.expiresAt 缺失时重置时间取 status.nextResetAt（Node 的 || 回落链）。
func TestFetchUsageFallsBackToStatusReset(t *testing.T) {
	nextResetAtMS := testCapturedAtMS + 2*60*60*1000
	server, _ := newTestServer(t, map[string]testResponse{
		quotaPath: {body: jsonBody(t, map[string]any{
			"userQuota": map[string]any{
				"total": 1000, "used": 500, "remaining": 500, "percentage": 50,
			},
		})},
		planPath: {body: jsonBody(t, map[string]any{"plan_tier_name": "Pro"})},
		statusPath: {body: jsonBody(t, map[string]any{
			"id": "u-1", "nextResetAt": nextResetAtMS,
		})},
	})
	strategy := newTestStrategy(t, server, "qoder")
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		readableCredential(t, "qoder", "oauth-token"),
		testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if !snapshot.Entries()[0].ResetAt().Equal(time.UnixMilli(nextResetAtMS).UTC()) {
		t.Fatalf("resetAt = %v", snapshot.Entries()[0].ResetAt())
	}
	view := payloadEntries(t, decodePayload(t, document))[0].(map[string]any)
	if view["windowMinutes"] != float64(120) || view["resetIn"] != "2 小时后" || view["resetAtMs"] != float64(nextResetAtMS) {
		t.Fatalf("entry view = %#v", view)
	}
}
