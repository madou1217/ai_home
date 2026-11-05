package usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func testFamilyCredential(t *testing.T, providerID string) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity(providerID, "u1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	payload := []byte(`{"credentials":{"auth":{"accessToken":"access-token","domain":"www.codebuddy.ai"},"account":{"uid":"u1"}}}`)
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestFetchUsageAggregatesPackagesAndKeepsDetails(t *testing.T) {
	t.Parallel()
	var seen *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seen = request
		_, _ = response.Write([]byte(`{"code":0,"data":{
			"Packages":[
				{"PackageCode":"TCACA_code_002_x","CycleTotalCapacity":"100","CycleRemainCapacity":"80","CycleUsedCapacity":"20","CapacityUnit":"credit"},
				{"PackageCode":"TCACA_code_006_y","CycleTotalCapacity":"50","CycleRemainCapacity":"0","CycleUsedCapacity":"50","CapacityUnit":"credit"}
			],
			"TotalCredits":"50","SubscriptionPackageCode":"TCACA_code_002_z","IsPaidUser":true
		}}`))
	}))
	defer server.Close()
	strategy, err := New(server.Client(), "codebuddy")
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.endpoint = server.URL
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), testFamilyCredential(t, "codebuddy"), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if seen.Header.Get("Authorization") != "Bearer access-token" || seen.Header.Get("X-User-Id") != "u1" ||
		seen.Header.Get("X-Domain") != "www.codebuddy.ai" || seen.Header.Get("User-Agent") != probeUserAgent {
		t.Fatalf("headers = %#v", seen.Header)
	}
	// 付费包 TCACA_code_002_ → "Pro" → pro。
	if snapshot.PlanType() != "pro" {
		t.Fatalf("plan type = %q, want pro", snapshot.PlanType())
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("snapshot entries = %d (details must not enter the snapshot)", len(entries))
	}
	if bps, has := entries[0].RemainingBasisPoints(); !has || bps != 5333 {
		t.Fatalf("aggregate = %d / %v", bps, has)
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["kind"] != documentKind || payload["schemaVersion"].(float64) != 2 {
		t.Fatalf("payload = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["planType"] != "Pro" {
		t.Fatalf("account = %#v", account)
	}
	docEntries := payload["entries"].([]any)
	if len(docEntries) != 3 {
		t.Fatalf("document entries = %d", len(docEntries))
	}
	if docEntries[0].(map[string]any)["bucket"] != "credits" {
		t.Fatalf("aggregate entry = %#v", docEntries[0])
	}
	gift := docEntries[2].(map[string]any)
	if gift["bucket"] != "gift" || gift["category"] != "detail" || gift["remainingPct"].(float64) != 0 {
		t.Fatalf("gift entry = %#v", gift)
	}
}

func TestFetchUsageTreatsZeroCreditsAsConclusion(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"code":0,"data":{"Packages":[],"TotalCredits":"0","IsPaidUser":false}}`))
	}))
	defer server.Close()
	strategy, _ := New(server.Client(), "workbuddycn")
	strategy.endpoint = server.URL
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), testFamilyCredential(t, "workbuddycn"), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	if bps, has := entries[0].RemainingBasisPoints(); !has || bps != 0 {
		t.Fatalf("bps = %d / %v", bps, has)
	}
	var payload map[string]any
	_ = json.Unmarshal(document.Payload(), &payload)
	if _, exists := payload["account"]; exists {
		t.Fatalf("free account must not have a paid plan label: %#v", payload["account"])
	}
}

func TestFetchUsageMapsHTTPFailures(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer server.Close()
	strategy, _ := New(server.Client(), "codebuddycn")
	strategy.endpoint = server.URL
	if _, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), testFamilyCredential(t, "codebuddycn"), time.Now().UTC(),
	); err == nil {
		t.Fatal("expected an error")
	}
}

// 家族在 Node 侧仍走默认配额策略（只小写、不折叠分隔符），
// 所以多词套餐必须落成 "pro plus"，不能是 "pro_plus"。
func TestPaidPlanLabelKeepsNodeDefaultPlanSpelling(t *testing.T) {
	t.Parallel()
	cases := []struct {
		code string
		want string
	}{
		{code: "TCACA_code_002_20260101", want: "pro"},
		{code: "TCACA_code_005_20260101", want: "pro plus"},
		{code: "TCACA_code_039_20260101", want: ""}, // 体验包不算付费档位
		{code: "", want: ""},
	}
	for _, testCase := range cases {
		got := usagecore.NormalizePlanName(paidPlanLabel(testCase.code))
		if got != testCase.want {
			t.Fatalf("paidPlanLabel(%q) = %q, want %q", testCase.code, got, testCase.want)
		}
	}
}
