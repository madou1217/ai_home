package usage

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const testCapturedAtMS = int64(1_800_000_000_000)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func fakeJWT(t *testing.T, claims map[string]any) string {
	t.Helper()
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"none","typ":"JWT"}`))
	body, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	return header + "." + base64.RawURLEncoding.EncodeToString(body) + ".c2ln"
}

// clineCredential 构造与 providers.json 收窄后同形的原生凭据。
//
// slots 只描述 settings 里的内容（auth / apiKey），外层结构由这里补齐。
func clineCredential(t *testing.T, slots map[string]map[string]any) accountapp.Credential {
	t.Helper()
	providers := make(map[string]any, len(slots))
	for slotID, settings := range slots {
		providers[slotID] = map[string]any{"settings": settings}
	}
	payload, err := json.Marshal(map[string]any{
		"auth": map[string]any{"providers": providers},
	})
	if err != nil {
		t.Fatal(err)
	}
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("cline", payload)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	return credential
}

// oauthSlot 是一个带 OAuth 记录的槽位。
func oauthSlot(t *testing.T, accessToken string, expiresAt any) map[string]any {
	t.Helper()
	return map[string]any{
		"auth": map[string]any{
			"accessToken":  accessToken,
			"refreshToken": "refresh-" + accessToken,
			"expiresAt":    expiresAt,
		},
	}
}

// apiKeyCredential 构造 API Key 形态的 cline 原生凭据（解码器不接受它，直接建值）。
func apiKeyCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	payload, err := json.Marshal(map[string]any{
		"auth": map[string]any{"providers": map[string]any{
			"cline": map[string]any{"settings": map[string]any{"apiKey": "sk-live-test"}},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	identity, err := accountcore.NewNativeSubjectIdentity("cline", "user_01TEST")
	if err != nil {
		t.Fatalf("NewNativeSubjectIdentity() error = %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("NewNativeCredential() error = %v", err)
	}
	return credential
}

// limitsBody 是 /users/me/plan/usage-limits 的响应；percentUsed 为 nil 时输出 null。
func limitsBody(t *testing.T, rows map[string]map[string]any) string {
	t.Helper()
	limits := make([]map[string]any, 0, len(rows))
	for kind, row := range rows {
		entry := map[string]any{"type": kind}
		for key, value := range row {
			entry[key] = value
		}
		limits = append(limits, entry)
	}
	encoded, err := json.Marshal(map[string]any{"data": map[string]any{"limits": limits}})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

// planBody 是 /users/me/plan 的响应；caps 为 nil 表示没有 inferenceCapThreshold。
func planBody(t *testing.T, enabled bool, caps map[string]any) string {
	t.Helper()
	pass := map[string]any{"enabled": enabled}
	if caps != nil {
		pass["inferenceCapThreshold"] = caps
	}
	encoded, err := json.Marshal(map[string]any{"data": map[string]any{
		"userId":             "usr-0abc",
		"currentPeriodStart": "2026-10-01T00:00:00.000Z",
		"currentPeriodEnd":   "2026-11-01T00:00:00.000Z",
		"plan": map[string]any{
			"displayName": "Cline Pass",
			"entitlements": map[string]any{
				"cline_pass": pass,
			},
		},
	}})
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func fullCaps() map[string]any {
	return map[string]any{
		"last5HoursUsageCostUSDPerUser": 5 * costUnitPerUSD,
		"last7daysUsageCostUSDPerUser":  20 * costUnitPerUSD,
		"last30daysUsageCostUSDPerUser": 40 * costUnitPerUSD,
	}
}

// quotaServer 用同一份 handler 服务两个账号面端点。
func quotaServer(t *testing.T, limits, plan string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/users/me/plan/usage-limits":
			if request.Header.Get("Accept") != "application/json" {
				t.Errorf("limits Accept = %q", request.Header.Get("Accept"))
			}
			_, _ = response.Write([]byte(limits))
		case "/users/me/plan":
			_, _ = response.Write([]byte(plan))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func newTestStrategy(t *testing.T, server *httptest.Server) *Strategy {
	t.Helper()
	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.apiBase = server.URL
	return strategy
}

func TestNewRequiresHTTPClient(t *testing.T) {
	t.Parallel()
	if _, err := New(nil); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("New(nil) error = %v", err)
	}
	strategy, err := New(http.DefaultClient)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if strategy.ProviderID() != clineProviderID {
		t.Fatalf("ProviderID() = %q", strategy.ProviderID())
	}
	if strategy.MatchesModelFamily("scope", "cline/sonnet") {
		t.Fatal("cline 额度是账号级，不该匹配模型族")
	}
}

func TestFetchUsageBuildsSnapshotAndDocument(t *testing.T) {
	t.Parallel()
	server := quotaServer(t,
		limitsBody(t, map[string]map[string]any{
			"five_hour": {"percentUsed": 40, "resetsAt": "2027-01-15T09:00:00.000Z"},
			"weekly":    {"percentUsed": 12.5, "resetsAt": "2027-01-17T08:00:00.000Z"},
			"monthly":   {"percentUsed": 100},
		}),
		planBody(t, true, fullCaps()),
	)
	strategy := newTestStrategy(t, server)

	var seenPaths []string
	var authHeaders []string
	recording := strategy.client
	strategy.client = httpClientFunc(func(request *http.Request) (*http.Response, error) {
		seenPaths = append(seenPaths, request.URL.Path)
		authHeaders = append(authHeaders, request.Header.Get("Authorization"))
		return recording.Do(request)
	})

	primary := fakeJWT(t, map[string]any{"sub": "user_01TEST"})
	pass := fakeJWT(t, map[string]any{"sub": "user_01TEST"})
	credential := clineCredential(t, map[string]map[string]any{
		// 主槽位有效但更早过期；Cline Pass 槽位更晚过期 → 必须选 cline-pass。
		"cline":      oauthSlot(t, "workos:"+primary, 1_900_000_000_000),
		"cline-pass": oauthSlot(t, pass, 1_950_000_000_000),
	})

	capturedAt := time.UnixMilli(testCapturedAtMS).UTC()
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), credential, capturedAt,
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if !snapshot.IsValid() || !snapshot.CapturedAt().Equal(capturedAt) {
		t.Fatalf("snapshot invalid = %v at %v", snapshot.IsValid(), snapshot.CapturedAt())
	}
	if snapshot.Source() != sourceID || snapshot.ProviderID() != clineProviderID {
		t.Fatalf("snapshot source = %q provider = %q", snapshot.Source(), snapshot.ProviderID())
	}
	// plan.displayName = "Cline Pass" → cline_pass。
	if snapshot.PlanType() != "cline_pass" {
		t.Fatalf("plan type = %q, want cline_pass", snapshot.PlanType())
	}

	// 快照按 bucket 排序：30days / 5h / 7days。
	entries := snapshot.Entries()
	if len(entries) != 3 {
		t.Fatalf("entries = %d", len(entries))
	}
	expected := []struct {
		bucket       string
		basisPoints  uint16
		windowSecond int64
		availability usagecore.Availability
	}{
		{"30days", 0, 43_200 * 60, usagecore.AvailabilityExhausted},
		{"5h", 6000, 300 * 60, usagecore.AvailabilityAvailable},
		{"7days", 8750, 10_080 * 60, usagecore.AvailabilityAvailable},
	}
	for index, want := range expected {
		entry := entries[index]
		basisPoints, known := entry.RemainingBasisPoints()
		if entry.Bucket() != want.bucket ||
			!known ||
			basisPoints != want.basisPoints ||
			entry.WindowSeconds() != want.windowSecond ||
			entry.Kind() != usagecore.KindWindow ||
			entry.Scope() != usagecore.ScopeAccount ||
			entry.Availability() != want.availability {
			t.Fatalf("entry[%d] = %#v", index, entry)
		}
	}
	if resetAt := entries[1].ResetAt(); !resetAt.Equal(time.Date(2027, 1, 15, 9, 0, 0, 0, time.UTC)) {
		t.Fatalf("5h resetAt = %v", resetAt)
	}
	if !entries[0].ResetAt().IsZero() {
		t.Fatalf("missing resetsAt must stay zero, got %v", entries[0].ResetAt())
	}

	if len(seenPaths) != 2 ||
		seenPaths[0] != usageLimitsPath ||
		seenPaths[1] != planPath {
		t.Fatalf("paths = %#v", seenPaths)
	}
	for _, header := range authHeaders {
		// 裸 JWT 会被上游 401，cline-pass 槽位缺前缀时必须补 workos:。
		if header != "Bearer workos:"+pass {
			t.Fatalf("Authorization = %q", header)
		}
	}

	payload := decodePayload(t, document)
	if payload["schemaVersion"].(float64) != 2 ||
		payload["kind"] != documentKind ||
		payload["source"] != sourceID ||
		int64(payload["capturedAt"].(float64)) != testCapturedAtMS {
		t.Fatalf("payload header = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["userId"] != "usr-0abc" ||
		account["planName"] != "Cline Pass" ||
		int64(account["periodStartMs"].(float64)) != time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC).UnixMilli() ||
		int64(account["periodEndMs"].(float64)) != time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("account = %#v", account)
	}
	coverage := payload["coverage"].(map[string]any)
	if coverage["source"] != coverageSource || len(coverage["missingWindows"].([]any)) != 0 {
		t.Fatalf("coverage = %#v", coverage)
	}
	documentEntries := payload["entries"].([]any)
	if len(documentEntries) != 3 {
		t.Fatalf("document entries = %d", len(documentEntries))
	}
	fiveHour := documentEntries[0].(map[string]any)
	if fiveHour["bucket"] != "5h" ||
		fiveHour["window"] != "5h" ||
		fiveHour["windowMinutes"].(float64) != 300 ||
		fiveHour["remainingPct"].(float64) != 60 ||
		fiveHour["totalUnits"].(float64) != 5 ||
		fiveHour["usedUnits"].(float64) != 2 ||
		fiveHour["remainingUnits"].(float64) != 3 ||
		fiveHour["unitType"] != "usd" ||
		int64(fiveHour["resetAtMs"].(float64)) != time.Date(2027, 1, 15, 9, 0, 0, 0, time.UTC).UnixMilli() ||
		fiveHour["resetIn"] != "1h0m" {
		t.Fatalf("5h document entry = %#v", fiveHour)
	}
	weekly := documentEntries[1].(map[string]any)
	if weekly["window"] != "7days" || weekly["windowMinutes"].(float64) != 10_080 ||
		weekly["resetIn"] != "2d0h0m" {
		t.Fatalf("weekly document entry = %#v", weekly)
	}
	monthly := documentEntries[2].(map[string]any)
	if monthly["bucket"] != "30days" || monthly["window"] != "30days" ||
		monthly["remainingPct"].(float64) != 0 ||
		monthly["resetAtMs"].(float64) != 0 ||
		monthly["resetIn"] != "" {
		t.Fatalf("monthly document entry = %#v", monthly)
	}
}

func TestFetchUsageSkipsWindowsWithoutServerUsage(t *testing.T) {
	t.Parallel()
	server := quotaServer(t,
		limitsBody(t, map[string]map[string]any{
			"five_hour": {"percentUsed": 10, "resetsAt": "2026-10-15T11:00:00.000Z"},
			"weekly":    {"percentUsed": 20},
			// monthly 没有 percentUsed：宁可缺窗口，也不臆造用量。
			"monthly": {"percentUsed": nil},
		}),
		planBody(t, true, fullCaps()),
	)
	strategy := newTestStrategy(t, server)
	credential := clineCredential(t, map[string]map[string]any{
		"cline": oauthSlot(t, "workos:"+fakeJWT(t, map[string]any{"sub": "user_01TEST"}), 1_900_000_000_000),
	})

	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), credential, time.UnixMilli(testCapturedAtMS).UTC(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if len(snapshot.Entries()) != 2 {
		t.Fatalf("entries = %d", len(snapshot.Entries()))
	}
	payload := decodePayload(t, document)
	missing := payload["coverage"].(map[string]any)["missingWindows"].([]any)
	if len(missing) != 1 || missing[0] != "30days" {
		t.Fatalf("missingWindows = %#v", missing)
	}
}

func TestFetchUsageErrors(t *testing.T) {
	t.Parallel()
	validLimits := limitsBody(t, map[string]map[string]any{
		"five_hour": {"percentUsed": 10},
	})
	cases := []struct {
		name       string
		limits     func(t *testing.T) (int, string)
		plan       func(t *testing.T) (int, string)
		want       []error
		wantInText string
	}{
		{
			name:   "entitlement missing",
			limits: func(t *testing.T) (int, string) { return http.StatusOK, validLimits },
			plan: func(t *testing.T) (int, string) {
				return http.StatusOK, planBody(t, false, nil)
			},
			want: []error{usageapp.ErrRefreshFailed, ErrEntitlementMissing},
		},
		{
			name: "no windows with usage",
			limits: func(t *testing.T) (int, string) {
				return http.StatusOK, limitsBody(t, map[string]map[string]any{
					"five_hour": {"percentUsed": nil},
					"weekly":    {"percentUsed": nil},
				})
			},
			plan: func(t *testing.T) (int, string) {
				return http.StatusOK, planBody(t, true, fullCaps())
			},
			want:       []error{usageapp.ErrRefreshFailed, ErrWindowsMissing},
			wantInText: "5h,7days,30days",
		},
		{
			name:   "unauthorized",
			limits: func(t *testing.T) (int, string) { return http.StatusUnauthorized, "" },
			plan: func(t *testing.T) (int, string) {
				return http.StatusOK, planBody(t, true, fullCaps())
			},
			want:       []error{usageapp.ErrRefreshFailed, ErrUnauthorized, ErrInvalidResponse},
			wantInText: "HTTP 401",
		},
		{
			name:   "plan server error",
			limits: func(t *testing.T) (int, string) { return http.StatusOK, validLimits },
			plan: func(t *testing.T) (int, string) {
				return http.StatusInternalServerError, ""
			},
			want:       []error{usageapp.ErrRefreshFailed, ErrInvalidResponse},
			wantInText: "HTTP 500",
		},
		{
			name:   "invalid json",
			limits: func(t *testing.T) (int, string) { return http.StatusOK, "not-json" },
			plan: func(t *testing.T) (int, string) {
				return http.StatusOK, planBody(t, true, fullCaps())
			},
			want: []error{usageapp.ErrRefreshFailed, ErrInvalidResponse},
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()
			limitsStatus, limitsText := testCase.limits(t)
			planStatus, planText := testCase.plan(t)
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case usageLimitsPath:
					response.WriteHeader(limitsStatus)
					_, _ = response.Write([]byte(limitsText))
				case planPath:
					response.WriteHeader(planStatus)
					_, _ = response.Write([]byte(planText))
				default:
					response.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			strategy := newTestStrategy(t, server)
			token := "workos:" + fakeJWT(t, map[string]any{"sub": "user_01TEST"})
			credential := clineCredential(t, map[string]map[string]any{
				"cline": oauthSlot(t, token, 1_900_000_000_000),
			})

			_, document, err := strategy.FetchUsageWithDocument(
				context.Background(), testAccountRef(t), credential, time.UnixMilli(testCapturedAtMS).UTC(),
			)
			if document != nil {
				t.Fatal("failed probe must not return a document")
			}
			if err == nil {
				t.Fatal("expected an error")
			}
			for _, want := range testCase.want {
				if !errors.Is(err, want) {
					t.Fatalf("error = %v, want %v", err, want)
				}
			}
			if testCase.wantInText != "" && !strings.Contains(err.Error(), testCase.wantInText) {
				t.Fatalf("error = %v, want substring %q", err, testCase.wantInText)
			}
			if strings.Contains(err.Error(), token) || strings.Contains(err.Error(), "workos:") {
				t.Fatalf("error leaks credential: %v", err)
			}
		})
	}
}

func TestFetchUsageRejectsApiKeyCredential(t *testing.T) {
	t.Parallel()
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		_, _ = response.Write([]byte("{}"))
	}))
	defer server.Close()
	strategy := newTestStrategy(t, server)

	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), apiKeyCredential(t), time.UnixMilli(testCapturedAtMS).UTC(),
	)
	if err == nil || !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("error = %v", err)
	}
	if errors.Is(err, usageapp.ErrRefreshFailed) {
		t.Fatalf("API Key 账号是「不适用」，不该记成刷新失败: %v", err)
	}
	if snapshot.IsValid() || document != nil {
		t.Fatal("rejected credential must not produce output")
	}
	if calls.Load() != 0 {
		t.Fatalf("API Key 账号不该发出请求，实际 %d 次", calls.Load())
	}
}

func TestFetchUsageRejectsUnsupportedInputs(t *testing.T) {
	t.Parallel()
	server := quotaServer(t, "{}", "{}")
	strategy := newTestStrategy(t, server)
	capturedAt := time.UnixMilli(testCapturedAtMS).UTC()

	if _, _, err := strategy.FetchUsageWithDocument(context.Background(), testAccountRef(t), nil, capturedAt); !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("nil credential error = %v", err)
	}
	credential := clineCredential(t, map[string]map[string]any{
		"cline": oauthSlot(t, "workos:"+fakeJWT(t, map[string]any{"sub": "user_01TEST"}), 1_900_000_000_000),
	})
	var zero accountcore.AccountRef
	if _, _, err := strategy.FetchUsageWithDocument(context.Background(), zero, credential, capturedAt); !errors.Is(err, usageapp.ErrInvalidRequest) {
		t.Fatalf("invalid account error = %v", err)
	}
	// FetchUsage（不带文档的端口）与带文档路径同源。
	if _, err := strategy.FetchUsage(context.Background(), testAccountRef(t), credential, capturedAt); err == nil {
		t.Fatal("empty payloads must fail")
	}
}

type httpClientFunc func(*http.Request) (*http.Response, error)

func (function httpClientFunc) Do(request *http.Request) (*http.Response, error) {
	return function(request)
}

func decodePayload(t *testing.T, document *usagecore.Document) map[string]any {
	t.Helper()
	if document == nil || !document.IsValid() {
		t.Fatal("document is invalid")
	}
	if document.Kind() != documentKind || document.Source() != sourceID {
		t.Fatalf("document kind = %q source = %q", document.Kind(), document.Source())
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	return payload
}
