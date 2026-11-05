package usage

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/kiro"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

const testRegion = "us-east-1"
const testEndpoint = "https://codewhisperer.us-east-1.amazonaws.com"

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func kiroCredential(t *testing.T, profileARN string) accountapp.Credential {
	t.Helper()
	auth := map[string]any{
		"access_token":  "aoa-test",
		"refresh_token": "aor-test",
		"expires_at":    "2099-01-01T00:00:00.000Z",
		"region":        testRegion,
	}
	if profileARN != "" {
		auth["profile_arn"] = profileARN
	}
	document := map[string]any{
		"auth": auth,
		"identityEvidence": map[string]any{
			"version":      1,
			"source":       "aws-codewhisperer:GetUsageLimits",
			"endpoint":     testEndpoint,
			"subject":      "d-1",
			"tokenBinding": "placeholder",
			"observedAtMs": 1_700_000_000_000,
		},
		"flavor": "oidc",
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var parsed map[string]json.RawMessage
	_ = json.Unmarshal(encoded, &parsed)
	var parsedAuth map[string]json.RawMessage
	_ = json.Unmarshal(parsed["auth"], &parsedAuth)
	if !kiro.RebindIdentityEvidence(parsed, parsedAuth) {
		t.Fatal("rebind failed")
	}
	payload, _ := json.Marshal(parsed)
	credential, err := nativeaccount.NewDecoder().DecodeNativeAuth("kiro", payload)
	if err != nil {
		t.Fatalf("DecodeNativeAuth() error = %v", err)
	}
	return credential
}

func TestFetchUsageBuildsSnapshotAndDocument(t *testing.T) {
	t.Parallel()
	var seen *http.Request
	var seenBody map[string]string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seen = request
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &seenBody)
		_, _ = response.Write([]byte(`{
			"usageBreakdownList":[{
				"resourceType":"CREDIT",
				"currentUsage":10,
				"currentUsageWithPrecision":12.5,
				"usageLimit":100,
				"usageLimitWithPrecision":100,
				"nextDateReset":1794000000
			}],
			"subscriptionInfo":{"subscriptionTitle":"Kiro Pro","type":"Q_DEVELOPER_STANDALONE_PRO"},
			"userInfo":{"email":"demo@example.com"}
		}`))
	}))
	defer server.Close()
	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	// 打桩端点：把生产 URL 重写到测试服务器。
	strategy.endpoint = func(string) (string, error) { return server.URL + "/", nil }

	capturedAt := time.UnixMilli(1_800_000_000_000).UTC()
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(),
		testAccountRef(t),
		kiroCredential(t, "arn:aws:codewhisperer:us-east-1:123:profile/X"),
		capturedAt,
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	bps, has := entries[0].RemainingBasisPoints()
	if !has || bps != 8750 {
		t.Fatalf("remaining = %d / %v", bps, has)
	}
	if seen.Header.Get("x-amz-target") != usageTarget ||
		seen.Header.Get("Authorization") != "Bearer aoa-test" ||
		seen.Header.Get("Content-Type") != "application/x-amz-json-1.0" {
		t.Fatalf("headers = %#v", seen.Header)
	}
	if seen.URL.Query().Get("origin") != "CLI" ||
		seen.URL.Query().Get("resourceType") != "AGENTIC_REQUEST" ||
		seen.URL.Query().Get("profileArn") == "" {
		t.Fatalf("query = %s", seen.URL.RawQuery)
	}
	if seenBody["isEmailRequired"] != "true" {
		t.Fatalf("body = %#v", seenBody)
	}

	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["schemaVersion"].(float64) != 2 || payload["kind"] != documentKind {
		t.Fatalf("payload = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["email"] != "demo@example.com" || account["planType"] != "pro" || account["planName"] != "Kiro Pro" {
		t.Fatalf("account = %#v", account)
	}
	entry := payload["entries"].([]any)[0].(map[string]any)
	if entry["remainingUnits"].(float64) != 87.5 || entry["remainingPct"].(float64) != 87.5 {
		t.Fatalf("entry = %#v", entry)
	}
	if entry["resetAtMs"].(float64) != 1794000000000 {
		t.Fatalf("resetAtMs = %#v", entry["resetAtMs"])
	}
}

func TestFetchUsageRejectsMissingCreditResource(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"usageBreakdownList":[{"resourceType":"TOKENS","usageLimit":1}]}`))
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.endpoint = func(string) (string, error) { return server.URL + "/", nil }
	if _, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kiroCredential(t, ""), time.Now().UTC(),
	); err == nil {
		t.Fatal("expected an error")
	}
}

func TestFetchUsageMapsHTTPFailures(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.endpoint = func(string) (string, error) { return server.URL + "/", nil }
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), kiroCredential(t, ""), time.Now().UTC(),
	)
	if err == nil || !strings.Contains(err.Error(), "HTTP 401") {
		t.Fatalf("error = %v", err)
	}
}
