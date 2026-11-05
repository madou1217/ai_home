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
)

const (
	testCapturedAtMS = int64(1_800_000_000_000)
	testAccessToken  = "access-token"
)

func testCapturedAt() time.Time { return time.UnixMilli(testCapturedAtMS).UTC() }

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

// kimiCredential 构造一份生产形态的原生凭据：canonical credentials + 官方 device_id。
func kimiCredential(t *testing.T, payload string) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("kimi", "user-1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(payload))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

// defaultCredential 是 happy path 用的凭据文档（deviceId 走官方声明，不做策略派生）。
const defaultCredential = `{
	"credentials": {"access_token": "access-token", "refresh_token": "refresh-token"},
	"deviceId": "device-123"
}`

type recordedRequest struct {
	path          string
	authorization string
	headers       http.Header
}

// newTestServer 按路径返回固定响应并记录请求头，便于断言鉴权与设备指纹。
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
			headers:       request.Header.Clone(),
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

type testResponse struct {
	status int
	body   string
}

func newTestStrategy(t *testing.T, server *httptest.Server) *Strategy {
	t.Helper()
	strategy, err := New(server.Client(), Options{BaseURL: server.URL, ClientVersion: "2.2.0"})
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	return strategy
}

func TestFetchUsageMapsWindowsAndIdentity(t *testing.T) {
	t.Parallel()
	server, requests := newTestServer(t, map[string]testResponse{
		"/usages": {body: `{
			"usage": {"used": 25, "remaining": 75, "limit": 100, "resetTime": "2027-01-22T08:00:00Z"},
			"limits": [
				{"name": "5h window",
				 "detail": {"used": 40, "remaining": 60, "limit": 100, "resetTime": "2027-01-15T13:00:00Z"},
				 "window": {"duration": 5, "timeUnit": "TIME_UNIT_HOUR"}},
				{"name": "daily",
				 "detail": {"used": "10", "limit": "100"},
				 "window": {"duration": 1, "time_unit": "TIME_UNIT_DAY"}}
			],
			"user": {"membership": {"level": "LEVEL_INTERMEDIATE"}}
		}`},
		"/me": {body: `{
			"nickname": "kim",
			"phone": {"country_code": "86", "number": "13800000000"},
			"user_level_name": "Allegretto",
			"user_level": 3
		}`},
	})
	strategy := newTestStrategy(t, server)
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kimiCredential(t, defaultCredential), testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}

	records := requests()
	if len(records) != 2 || records[0].path != "/usages" || records[1].path != "/me" {
		t.Fatalf("requests = %#v", records)
	}
	for _, record := range records {
		if record.authorization != "Bearer "+testAccessToken {
			t.Fatalf("%s authorization = %q", record.path, record.authorization)
		}
		if record.headers.Get("X-Msh-Device-Id") != "device-123" ||
			record.headers.Get("X-Msh-Platform") != "kimi_code_cli" ||
			record.headers.Get("X-Msh-Version") != "2.2.0" ||
			record.headers.Get("User-Agent") != "kimi-code-cli/2.2.0" {
			t.Fatalf("%s headers = %#v", record.path, record.headers)
		}
		if record.headers.Get("X-Msh-Device-Name") == "" || record.headers.Get("X-Msh-Os-Version") == "" {
			t.Fatalf("%s device headers = %#v", record.path, record.headers)
		}
	}

	entries := snapshot.Entries()
	if len(entries) != 3 {
		t.Fatalf("entries = %#v", entries)
	}
	byBucket := map[string]usagecore.Entry{}
	for _, entry := range entries {
		byBucket[entry.Bucket()] = entry
		if entry.Scope() != usagecore.ScopeAccount || entry.Kind() != usagecore.KindWindow {
			t.Fatalf("entry scope/kind = %#v", entry)
		}
	}
	weekly, ok := byBucket["weekly"]
	if !ok {
		t.Fatalf("weekly missing: %#v", byBucket)
	}
	if bps, known := weekly.RemainingBasisPoints(); !known || bps != 7500 {
		t.Fatalf("weekly bps = %d / %v", bps, known)
	}
	if weekly.WindowSeconds() != 7*24*3600 {
		t.Fatalf("weekly window = %d", weekly.WindowSeconds())
	}
	if weekly.ResetAt().Format(time.RFC3339) != "2027-01-22T08:00:00Z" {
		t.Fatalf("weekly reset = %s", weekly.ResetAt())
	}
	fiveHour, ok := byBucket["5h-window"]
	if !ok {
		t.Fatalf("5h-window missing: %#v", byBucket)
	}
	if bps, _ := fiveHour.RemainingBasisPoints(); bps != 6000 || fiveHour.WindowSeconds() != 5*3600 {
		t.Fatalf("5h-window = %#v", fiveHour)
	}
	daily, ok := byBucket["daily"]
	if !ok {
		t.Fatalf("daily missing: %#v", byBucket)
	}
	// 只有 used/limit 时按 used 推算剩余（数字串也认）。
	if bps, _ := daily.RemainingBasisPoints(); bps != 9000 || daily.WindowSeconds() != 24*3600 {
		t.Fatalf("daily = %#v", daily)
	}

	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["kind"] != documentKind || payload["source"] != sourceID {
		t.Fatalf("payload identity = %#v", payload)
	}
	if payload["schemaVersion"].(float64) != 2 || payload["capturedAt"].(float64) != float64(testCapturedAtMS) {
		t.Fatalf("payload header = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["planType"] != "intermediate" || account["planName"] != "Allegretto" ||
		account["displayName"] != "kim" || account["phone"] != "+86 13800000000" ||
		account["planLevel"].(float64) != 3 {
		t.Fatalf("account = %#v", account)
	}
	documentEntries := payload["entries"].([]any)
	if len(documentEntries) != 3 {
		t.Fatalf("document entries = %#v", documentEntries)
	}
	// 文档保持解析顺序（summary 在前），归一化快照才按 bucket 排序。
	documentWeekly := documentEntries[0].(map[string]any)
	if documentWeekly["bucket"] != "weekly" || documentWeekly["window"] != "7days" ||
		documentWeekly["windowMinutes"].(float64) != 10080 ||
		documentWeekly["remainingPct"].(float64) != 75 ||
		documentWeekly["resetIn"] != "7d0h0m" {
		t.Fatalf("weekly document entry = %#v", documentWeekly)
	}
	documentFiveHour := documentEntries[1].(map[string]any)
	if documentFiveHour["window"] != "5h" || documentFiveHour["remainingPct"].(float64) != 60 ||
		documentFiveHour["resetIn"] != "5h0m" {
		t.Fatalf("5h document entry = %#v", documentFiveHour)
	}
	if _, found := payload["notApplicable"]; found {
		t.Fatalf("notApplicable must be absent: %#v", payload)
	}
}

func TestFetchUsageFreePlanIsConclusion(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, map[string]testResponse{
		// 付费订阅失效后 /usages 仍返回 200，但正文是 {}：这是上游给出的结论。
		"/usages": {body: `{}`},
		"/me":     {body: `{"nickname": "kim", "user_level_name": "Free"}`},
	})
	strategy := newTestStrategy(t, server)
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kimiCredential(t, defaultCredential), testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 || entries[0].Bucket() != unknownBucket {
		t.Fatalf("entries = %#v", entries)
	}
	if _, known := entries[0].RemainingBasisPoints(); known {
		t.Fatal("remaining must be unknown: 耗尽与否不能由「没有配额池」推出来")
	}
	if entries[0].Availability() != usagecore.AvailabilityUnknown {
		t.Fatalf("availability = %s", entries[0].Availability())
	}

	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if len(payload["entries"].([]any)) != 0 {
		t.Fatalf("document entries = %#v", payload["entries"])
	}
	if payload["notApplicable"] != true || payload["reason"] != noPaidPlanReason {
		t.Fatalf("payload = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["planName"] != "Free" || account["planType"] != "free" {
		t.Fatalf("account = %#v", account)
	}
}

func TestFetchUsageUnauthorizedDoesNotRetry(t *testing.T) {
	t.Parallel()
	server, requests := newTestServer(t, map[string]testResponse{
		"/usages": {status: http.StatusUnauthorized, body: `{"error": "unauthorized"}`},
	})
	strategy := newTestStrategy(t, server)
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kimiCredential(t, defaultCredential), testCapturedAt(),
	)
	if !errors.Is(err, usageapp.ErrRefreshFailed) || !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error = %v", err)
	}
	records := requests()
	// 本包不刷新令牌：401 只上报，不隐式重试，更不能拿旧 token 打第二次。
	if len(records) != 1 || records[0].path != "/usages" {
		t.Fatalf("requests = %#v", records)
	}
}

func TestFetchUsageEmptyPayloadIsInvalidResponse(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, map[string]testResponse{
		"/usages": {body: `{}`},
		"/me":     {status: http.StatusInternalServerError, body: `{"error": "boom"}`},
	})
	strategy := newTestStrategy(t, server)
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kimiCredential(t, defaultCredential), testCapturedAt(),
	)
	if !errors.Is(err, usageapp.ErrRefreshFailed) || !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchUsageKeepsRemainingUnknownWithoutLimit(t *testing.T) {
	t.Parallel()
	server, _ := newTestServer(t, map[string]testResponse{
		"/usages": {body: `{
			"limits": [{"detail": {"remaining": 5}}]
		}`},
	})
	strategy := newTestStrategy(t, server)
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kimiCredential(t, defaultCredential), testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 || entries[0].Bucket() != unknownBucket {
		t.Fatalf("entries = %#v", entries)
	}
	if _, known := entries[0].RemainingBasisPoints(); known {
		t.Fatal("remaining must stay unknown: 没有 limit 不能推算成 100%")
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	entry := payload["entries"].([]any)[0].(map[string]any)
	if entry["remainingPct"] != nil || entry["window"] != "" || entry["windowMinutes"].(float64) != 0 {
		t.Fatalf("entry = %#v", entry)
	}
}

func TestFetchUsageAPIKeyModeIsNotApplicable(t *testing.T) {
	t.Parallel()
	server, requests := newTestServer(t, map[string]testResponse{})
	strategy := newTestStrategy(t, server)
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		kimiCredential(t, `{"env": {"MOONSHOT_API_KEY": "sk-test"}}`),
		testCapturedAt(),
	)
	if !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("error = %v", err)
	}
	if len(requests()) != 0 {
		t.Fatalf("API Key 账号不该发请求: %#v", requests())
	}
}
