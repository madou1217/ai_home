package usage

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const testToken = "oauth-token"

// callLog 记录各端点调用次数，用来证明兜底分支没有多发请求。
type callLog struct {
	mu      sync.Mutex
	billing int
	legacy  int
	user    int
	grpc    int
}

func (log *callLog) record(kind string) {
	log.mu.Lock()
	defer log.mu.Unlock()
	switch kind {
	case "billing":
		log.billing++
	case "legacy":
		log.legacy++
	case "user":
		log.user++
	case "grpc":
		log.grpc++
	}
}

func (log *callLog) counts() (billing int, legacy int, user int, grpc int) {
	log.mu.Lock()
	defer log.mu.Unlock()
	return log.billing, log.legacy, log.user, log.grpc
}

// newTestStrategy 把所有端点指向同一个 httptest 服务，并固定 gRPC 账期判断时钟。
func newTestStrategy(
	t *testing.T,
	handle func(response http.ResponseWriter, request *http.Request),
) (*Strategy, *callLog) {
	t.Helper()
	log := &callLog{}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/v1/billing" && request.URL.Query().Get("format") == "credits":
			log.record("billing")
		case request.URL.Path == "/v1/billing":
			log.record("legacy")
		case request.URL.Path == "/v1/user":
			log.record("user")
		case strings.Contains(request.URL.Path, "GetGrokCreditsConfig"):
			log.record("grpc")
		}
		handle(response, request)
	}))
	t.Cleanup(server.Close)
	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.billingURL = server.URL + "/v1/billing?format=credits"
	strategy.legacyBillingURL = server.URL + "/v1/billing"
	strategy.userURL = server.URL + "/v1/user?include=subscription"
	strategy.grpcBillingURL = server.URL + "/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig"
	strategy.now = func() time.Time { return testCapturedAt(t) }
	return strategy, log
}

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func grokCredential(t *testing.T, payload string) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeGrokIdentity([]string{"user-1"})
	if err != nil {
		t.Fatalf("NewNativeGrokIdentity() error = %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(payload))
	if err != nil {
		t.Fatalf("NewNativeCredential() error = %v", err)
	}
	return credential
}

// testCapturedAt 是固定采集时刻，所有测试的账期都围绕它构造。
func testCapturedAt(t *testing.T) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, "2026-11-05T00:00:00Z")
	if err != nil {
		t.Fatalf("time.Parse() error = %v", err)
	}
	return parsed
}

func mustParseTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("time.Parse(%q) error = %v", value, err)
	}
	return parsed
}

const (
	periodStartJSON = "2026-11-01T00:00:00Z"
	periodEndJSON   = "2026-11-08T00:00:00Z"
)

// primaryBillingJSON 是带权威百分比的账单响应。
const primaryBillingJSON = "{\"config\":{\"creditUsagePercent\":25," +
	"\"currentPeriod\":{\"start\":\"" + periodStartJSON + "\",\"end\":\"" + periodEndJSON + "\"}}}"

func TestFetchUsageMapsCreditsFromPrimaryBilling(t *testing.T) {
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/billing":
			if request.Method != http.MethodGet {
				t.Errorf("billing method = %s", request.Method)
			}
			if request.URL.Query().Get("format") != "credits" {
				t.Errorf("billing query = %s", request.URL.RawQuery)
			}
			if got := request.Header.Get("Authorization"); got != "Bearer "+testToken {
				t.Errorf("Authorization = %q", got)
			}
			if got := request.Header.Get("x-xai-token-auth"); got != "xai-grok-cli" {
				t.Errorf("x-xai-token-auth = %q", got)
			}
			_, _ = response.Write([]byte(primaryBillingJSON))
		case "/v1/user":
			_, _ = response.Write([]byte("{\"email\":\"user@example.com\",\"subscriptionTier\":\"SuperGrok\"}"))
		default:
			t.Errorf("unexpected path %s", request.URL.Path)
		}
	})
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"https://accounts.x.ai::uuid\":{\"key\":\""+testToken+"\"}}"),
		testCapturedAt(t),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	entry := entries[0]
	if entry.Bucket() != "credits" || entry.Kind() != usagecore.KindCredits ||
		entry.Scope() != usagecore.ScopeAccount {
		t.Fatalf("entry = %#v", entry)
	}
	if bps, has := entry.RemainingBasisPoints(); !has || bps != 7500 {
		t.Fatalf("remaining = %d / %v", bps, has)
	}
	if entry.WindowSeconds() != 7*24*3600 {
		t.Fatalf("window = %d", entry.WindowSeconds())
	}
	if !entry.ResetAt().Equal(mustParseTime(t, periodEndJSON)) {
		t.Fatalf("resetAt = %s", entry.ResetAt())
	}
	if snapshot.Source() != sourceID || snapshot.ProviderID() != providerID {
		t.Fatalf("snapshot = %s / %s", snapshot.ProviderID(), snapshot.Source())
	}
	if snapshot.MinRemaining().BasisPoints != 7500 {
		t.Fatalf("min remaining = %#v", snapshot.MinRemaining())
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["schemaVersion"].(float64) != 2 || payload["kind"] != documentKind ||
		payload["source"] != sourceID {
		t.Fatalf("payload = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["planType"] != "supergrok" || account["planName"] != "SuperGrok" ||
		account["email"] != "user@example.com" {
		t.Fatalf("account = %#v", account)
	}
	docEntry := payload["entries"].([]any)[0].(map[string]any)
	if docEntry["bucket"] != "credits" || docEntry["windowMinutes"].(float64) != 10080 ||
		docEntry["window"] != "10080m" || docEntry["remainingPct"].(float64) != 75 {
		t.Fatalf("entry = %#v", docEntry)
	}
	if _, _, _, grpcCalls := log.counts(); grpcCalls != 0 {
		t.Fatalf("grpc calls = %d", grpcCalls)
	}
}

func TestFetchUsageKeepsWindowWhenPercentMissing(t *testing.T) {
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/billing":
			_, _ = response.Write([]byte("{\"config\":{\"currentPeriod\":{\"start\":\"" +
				periodStartJSON + "\",\"end\":\"" + periodEndJSON + "\"}}}"))
		default:
			_, _ = response.Write([]byte("{}"))
		}
	})
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"key\":\""+testToken+"\"}"),
		testCapturedAt(t),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	entry := snapshot.Entries()[0]
	if _, has := entry.RemainingBasisPoints(); has {
		t.Fatal("remaining must stay unknown")
	}
	if entry.Availability() != usagecore.AvailabilityUnknown {
		t.Fatalf("availability = %s", entry.Availability())
	}
	if entry.WindowSeconds() != 7*24*3600 {
		t.Fatalf("window = %d", entry.WindowSeconds())
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["entries"].([]any)[0].(map[string]any)["remainingPct"] != nil {
		t.Fatalf("payload = %#v", payload)
	}
	// 剩余未知时会按 Node 语义尝试补充接口，失败后仍保留 REST 的账期。
	if _, legacyCalls, _, grpcCalls := log.counts(); grpcCalls != 1 || legacyCalls != 1 {
		t.Fatalf("grpc = %d, legacy = %d", grpcCalls, legacyCalls)
	}
}

func TestFetchUsageComputesPercentFromIncludedUnits(t *testing.T) {
	strategy, _ := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/billing":
			_, _ = response.Write([]byte("{\"config\":{\"monthlyLimit\":{\"val\":1000},\"used\":\"250\"," +
				"\"currentPeriod\":{\"start\":\"" + periodStartJSON + "\",\"end\":\"" + periodEndJSON + "\"}}}"))
		default:
			_, _ = response.Write([]byte("{}"))
		}
	})
	snapshot, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"key\":\""+testToken+"\"}"),
		testCapturedAt(t),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	if bps, has := snapshot.Entries()[0].RemainingBasisPoints(); !has || bps != 7500 {
		t.Fatalf("remaining = %d / %v", bps, has)
	}
}

func TestFetchUsageFallsBackToGRPCWeb(t *testing.T) {
	now := testCapturedAt(t)
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/v1/billing":
			response.WriteHeader(http.StatusInternalServerError)
		case "/v1/user":
			_, _ = response.Write([]byte("{}"))
		case "/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig":
			if request.Method != http.MethodPost {
				t.Errorf("grpc method = %s", request.Method)
			}
			for header, want := range map[string]string{
				"Content-Type":  "application/grpc-web+proto",
				"x-grpc-web":    "1",
				"x-user-agent":  "connect-es/2.1.1",
				"Origin":        "https://grok.com",
				"Referer":       "https://grok.com/?_s=usage",
				"Authorization": "Bearer " + testToken,
			} {
				if got := request.Header.Get(header); got != want {
					t.Errorf("%s = %q", header, got)
				}
			}
			body, _ := io.ReadAll(request.Body)
			if string(body) != string(grpcCreditsRequest) {
				t.Errorf("grpc body = %v", body)
			}
			percent := float32(40)
			_, _ = response.Write(grpcBillingResponse(&percent, 2, now.Add(-30*time.Minute), now.Add(30*time.Minute)))
		default:
			t.Errorf("unexpected path %s", request.URL.Path)
		}
	})
	snapshot, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"key\":\""+testToken+"\"}"),
		testCapturedAt(t),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	entry := snapshot.Entries()[0]
	if bps, has := entry.RemainingBasisPoints(); !has || bps != 6000 {
		t.Fatalf("remaining = %d / %v", bps, has)
	}
	if entry.WindowSeconds() != 3600 {
		t.Fatalf("window = %d", entry.WindowSeconds())
	}
	if _, legacyCalls, _, _ := log.counts(); legacyCalls != 0 {
		t.Fatalf("legacy calls = %d", legacyCalls)
	}
}

func TestFetchUsageFallsBackToLegacyBilling(t *testing.T) {
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		switch {
		case request.URL.Path == "/v1/billing" && request.URL.Query().Get("format") == "credits":
			// 没有 config：主账单给不出任何事实，继续兜底。
			_, _ = response.Write([]byte("{}"))
		case request.URL.Path == "/v1/billing":
			_, _ = response.Write([]byte("{\"config\":{\"creditUsagePercent\":10," +
				"\"currentPeriod\":{\"start\":\"" + periodStartJSON + "\",\"end\":\"" + periodEndJSON + "\"}}}"))
		case request.URL.Path == "/v1/user":
			_, _ = response.Write([]byte("{}"))
		default:
			// gRPC 返回不可解码的字节：解析失败后必须落到旧账单。
			_, _ = response.Write([]byte("x"))
		}
	})
	snapshot, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"key\":\""+testToken+"\"}"),
		testCapturedAt(t),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	if bps, has := snapshot.Entries()[0].RemainingBasisPoints(); !has || bps != 9000 {
		t.Fatalf("remaining = %d / %v", bps, has)
	}
	if _, legacyCalls, _, grpcCalls := log.counts(); legacyCalls != 1 || grpcCalls != 1 {
		t.Fatalf("legacy = %d, grpc = %d", legacyCalls, grpcCalls)
	}
}

func TestFetchUsageStopsOnRateLimit(t *testing.T) {
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusTooManyRequests)
	})
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"key\":\""+testToken+"\"}"),
		testCapturedAt(t),
	)
	if err == nil || !errors.Is(err, usageapp.ErrRefreshFailed) || errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error = %v", err)
	}
	billingCalls, legacyCalls, userCalls, grpcCalls := log.counts()
	if billingCalls != 1 || legacyCalls != 0 || userCalls != 0 || grpcCalls != 0 {
		t.Fatalf("calls = %d/%d/%d/%d", billingCalls, legacyCalls, userCalls, grpcCalls)
	}
}

func TestFetchUsageReportsUnauthorized(t *testing.T) {
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	})
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"key\":\""+testToken+"\"}"),
		testCapturedAt(t),
	)
	if err == nil || !errors.Is(err, ErrUnauthorized) || !errors.Is(err, usageapp.ErrRefreshFailed) {
		t.Fatalf("error = %v", err)
	}
	if _, _, userCalls, grpcCalls := log.counts(); userCalls != 0 || grpcCalls != 0 {
		t.Fatalf("user = %d, grpc = %d", userCalls, grpcCalls)
	}
}

func TestFetchUsageRejectsAPIKeyCredential(t *testing.T) {
	strategy, log := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		t.Error("no request expected")
	})
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		grokCredential(t, "{\"api_key\":\"sk-test\"}"),
		testCapturedAt(t),
	)
	if err == nil || !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("error = %v", err)
	}
	if billingCalls, _, _, _ := log.counts(); billingCalls != 0 {
		t.Fatalf("billing calls = %d", billingCalls)
	}
}

func TestParseGRPCWebBillingImpliesZeroOnlyForActivePeriod(t *testing.T) {
	now := testCapturedAt(t)
	active := grpcBillingResponse(nil, 2, now.Add(-30*time.Minute), now.Add(30*time.Minute))
	entry, ok := parseGRPCWebBilling(active, now.UnixMilli())
	if !ok || entry.remainingPct == nil || *entry.remainingPct != 100 ||
		entry.windowMinutes != 60 || entry.resetAtMS != now.Add(30*time.Minute).UnixMilli() {
		t.Fatalf("entry = %#v / %v", entry, ok)
	}
	expired := grpcBillingResponse(nil, 2, now.Add(-2*time.Hour), now.Add(-time.Hour))
	if _, ok := parseGRPCWebBilling(expired, now.UnixMilli()); ok {
		t.Fatal("expired period without percentage must stay unknown")
	}
	pending := grpcBillingResponse(nil, 1, now.Add(time.Hour), now.Add(2*time.Hour))
	if _, ok := parseGRPCWebBilling(pending, now.UnixMilli()); ok {
		t.Fatal("future period without percentage must stay unknown")
	}
}

func TestParseGRPCWebBillingClampsAndValidates(t *testing.T) {
	now := testCapturedAt(t)
	over := float32(140)
	entry, ok := parseGRPCWebBilling(
		grpcBillingResponse(&over, 2, now.Add(-time.Hour), now.Add(time.Hour)),
		now.UnixMilli(),
	)
	if !ok || entry.remainingPct == nil || *entry.remainingPct != 0 {
		t.Fatalf("entry = %#v / %v", entry, ok)
	}
	zero := float32(0)
	entry, ok = parseGRPCWebBilling(
		grpcBillingResponse(&zero, 2, now.Add(-time.Hour), now.Add(time.Hour)),
		now.UnixMilli(),
	)
	if !ok || entry.remainingPct == nil || *entry.remainingPct != 100 {
		t.Fatalf("entry = %#v / %v", entry, ok)
	}
}

func TestParseGRPCWebBillingRejectsBadFrames(t *testing.T) {
	now := testCapturedAt(t)
	percent := float32(10)
	message := grpcMessage(&percent, 2, now.Add(-time.Hour), now.Add(time.Hour))
	cases := map[string][]byte{
		"trailer_error":   append(grpcFrame(0, message), grpcFrame(0x80, []byte("grpc-status: 2\r\n"))...),
		"two_payloads":    append(grpcFrame(0, message), grpcFrame(0, message)...),
		"truncated_frame": {0x00, 0x00, 0x00, 0x00, 0x10, 0x08},
		"unknown_flag":    grpcFrame(0x01, message),
		"empty":           {},
		"garbage":         []byte("not-protobuf"),
	}
	for name, data := range cases {
		if _, ok := parseGRPCWebBilling(data, now.UnixMilli()); ok {
			t.Fatalf("%s must be rejected", name)
		}
	}
	// 没有帧头的裸消息按未分包处理（Node 的同一条兜底）。
	if _, ok := parseGRPCWebBilling(message, now.UnixMilli()); !ok {
		t.Fatal("unframed message must parse")
	}
}

func TestParseBillingBodyRequiresConfigObject(t *testing.T) {
	cases := map[string]string{
		"array_config":  "{\"config\":[]}",
		"null_config":   "{\"config\":null}",
		"empty_object":  "{}",
		"zero_limit":    "{\"config\":{\"monthlyLimit\":{\"val\":0},\"used\":10}}",
		"percent_range": "{\"config\":{\"creditUsagePercent\":150}}",
	}
	for name, payload := range cases {
		if entry := parseBillingBody([]byte(payload)); entry != nil {
			t.Fatalf("%s parsed = %#v", name, entry)
		}
	}
	entry := parseBillingBody([]byte("{\"config\":{\"creditUsagePercent\":0," +
		"\"currentPeriod\":{\"start\":\"" + periodStartJSON + "\",\"end\":\"" + periodEndJSON + "\"}}}"))
	if entry == nil || entry.remainingPct == nil || *entry.remainingPct != 100 {
		t.Fatalf("entry = %#v", entry)
	}
}

func TestParseGrokAuthShapes(t *testing.T) {
	cases := []struct {
		name      string
		payload   string
		token     string
		wantMatch bool
	}{
		{
			name:      "grok_cli_map",
			payload:   "{\"https://accounts.x.ai::uuid\":{\"key\":\"token-a\",\"refresh_token\":\"refresh-a\",\"email\":\"a@example.com\"}}",
			token:     "token-a",
			wantMatch: true,
		},
		{
			name:      "direct_profile",
			payload:   "{\"access_token\":\"token-b\",\"email\":\"b@example.com\"}",
			token:     "token-b",
			wantMatch: true,
		},
		{
			name:      "auth_wrapper",
			payload:   "{\"auth\":{\"default\":{\"access_token\":\"token-c\"}}}",
			token:     "token-c",
			wantMatch: true,
		},
		{
			name:      "api_key_account",
			payload:   "{\"api_key\":\"sk-test\"}",
			wantMatch: false,
		},
		{
			name:      "empty",
			payload:   "{}",
			wantMatch: false,
		},
		{
			name:      "not_json",
			payload:   "token",
			wantMatch: false,
		},
	}
	for _, testCase := range cases {
		auth, ok := parseGrokAuth([]byte(testCase.payload))
		if ok != testCase.wantMatch {
			t.Fatalf("%s ok = %v", testCase.name, ok)
		}
		if ok && auth.accessToken != testCase.token {
			t.Fatalf("%s token = %q", testCase.name, auth.accessToken)
		}
	}
}

// grpcMessage 构造 GetGrokCreditsConfig 的 protobuf 响应消息。
func grpcMessage(percent *float32, periodType uint64, start time.Time, end time.Time) []byte {
	period := protoVarintField(1, periodType)
	period = append(period, protoBytesField(2, protoTimestamp(start))...)
	period = append(period, protoBytesField(3, protoTimestamp(end))...)
	config := make([]byte, 0, 16)
	if percent != nil {
		config = append(config, protoFixed32Field(1, *percent)...)
	}
	config = append(config, protoBytesField(8, period)...)
	return protoBytesField(1, config)
}

// grpcBillingResponse 构造带 grpc-status: 0 trailer 的完整 gRPC-Web 响应。
func grpcBillingResponse(percent *float32, periodType uint64, start time.Time, end time.Time) []byte {
	message := grpcMessage(percent, periodType, start, end)
	return append(grpcFrame(0, message), grpcFrame(0x80, []byte("grpc-status: 0\r\n"))...)
}

func grpcFrame(flag byte, payload []byte) []byte {
	frame := make([]byte, 5+len(payload))
	frame[0] = flag
	binary.BigEndian.PutUint32(frame[1:5], uint32(len(payload)))
	copy(frame[5:], payload)
	return frame
}

func protoVarint(value uint64) []byte {
	buffer := make([]byte, binary.MaxVarintLen64)
	length := binary.PutUvarint(buffer, value)
	return buffer[:length]
}

func protoVarintField(number int, value uint64) []byte {
	return append(protoVarint(uint64(number)<<3), protoVarint(value)...)
}

func protoBytesField(number int, payload []byte) []byte {
	field := append(protoVarint(uint64(number)<<3|2), protoVarint(uint64(len(payload)))...)
	return append(field, payload...)
}

func protoFixed32Field(number int, value float32) []byte {
	field := protoVarint(uint64(number)<<3 | 5)
	var raw [4]byte
	binary.LittleEndian.PutUint32(raw[:], math.Float32bits(value))
	return append(field, raw[:]...)
}

func protoTimestamp(at time.Time) []byte {
	payload := protoVarintField(1, uint64(at.Unix()))
	if nanos := at.Nanosecond(); nanos > 0 {
		payload = append(payload, protoVarintField(2, uint64(nanos))...)
	}
	return payload
}
