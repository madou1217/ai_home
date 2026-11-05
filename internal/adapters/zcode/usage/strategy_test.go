package usage

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func zcodeCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeSubjectIdentity("zcode", "user-1")
	if err != nil {
		t.Fatalf("identity: %v", err)
	}
	credential, err := accountcore.NewNativeCredential(identity, []byte(`{"credentials":{"zcodejwttoken":"jwt-token"}}`))
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	return credential
}

func TestFetchUsageMapsBalances(t *testing.T) {
	t.Parallel()
	var seen *http.Request
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		seen = request
		_, _ = response.Write([]byte(`{"code":0,"data":{
			"plans":[{"plan_id":"zcode-v3-start-plan","user_plan_id":"up-1","name":"ZCode Start Plan","status":"active","ends_at":1796083200}],
			"balances":[{
				"show_name":"GLM-5.3","capabilities":["model:glm-5.3"],"unit_type":"token",
				"total_units":1000,"used_units":250,"remaining_units":750,
				"period":"weekly","period_start":1793500000,"period_end":1794100000,
				"plan_id":"zcode-v3-start-plan","user_plan_id":"up-1"
			}]
		}}`))
	}))
	defer server.Close()
	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.balanceURL = server.URL + "/balance"
	capturedAt := time.UnixMilli(1_800_000_000_000).UTC()
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), zcodeCredential(t), capturedAt,
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if seen.Header.Get("Authorization") != "Bearer jwt-token" || seen.Header.Get("X-Device-Mid") == "" {
		t.Fatalf("headers = %#v", seen.Header)
	}
	if seen.URL.Query().Get("app_version") == "" {
		t.Fatalf("query = %s", seen.URL.RawQuery)
	}
	// plans[0].name = "ZCode Start Plan" → zcode_start_plan（Node 词表内的档位）。
	if snapshot.PlanType() != "zcode_start_plan" {
		t.Fatalf("plan type = %q, want zcode_start_plan", snapshot.PlanType())
	}
	entries := snapshot.Entries()
	if len(entries) != 1 || entries[0].Bucket() != "glm-5.3" {
		t.Fatalf("entries = %#v", entries)
	}
	if bps, has := entries[0].RemainingBasisPoints(); !has || bps != 7500 {
		t.Fatalf("bps = %d / %v", bps, has)
	}
	if entries[0].WindowSeconds() != 7*24*3600 {
		t.Fatalf("window = %d", entries[0].WindowSeconds())
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["kind"] != documentKind || payload["schemaVersion"].(float64) != 2 {
		t.Fatalf("payload = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["planType"] != "ZCode Start Plan" || len(account["planNames"].([]any)) != 1 {
		t.Fatalf("account = %#v", account)
	}
	docEntry := payload["entries"].([]any)[0].(map[string]any)
	if docEntry["bucket"] != "glm-5.3" || docEntry["remainingUnits"].(float64) != 750 || docEntry["planGroupId"] != "up-1" {
		t.Fatalf("entry = %#v", docEntry)
	}
}

func TestFetchUsageTreatsEmptyPlansAndBalancesAsConclusion(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"code":0,"data":{"plans":[],"balances":[]}}`))
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.balanceURL = server.URL + "/balance"
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), zcodeCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	if _, has := entries[0].RemainingBasisPoints(); has {
		t.Fatal("remaining must be unknown")
	}
	var payload map[string]any
	_ = json.Unmarshal(document.Payload(), &payload)
	if len(payload["entries"].([]any)) != 0 {
		t.Fatalf("document entries = %#v", payload["entries"])
	}
}

func TestFetchUsageMarksPendingPlan(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"code":0,"data":{
			"plans":[{"plan_id":"p1","user_plan_id":"u1","name":"Start","status":"pending",
				"entitlements":[{"effective_at":1794000000}]}],
			"balances":[]
		}}`))
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.balanceURL = server.URL + "/balance"
	_, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), zcodeCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	var payload map[string]any
	_ = json.Unmarshal(document.Payload(), &payload)
	if payload["pendingEffectiveAtMs"].(float64) != 1794000000000 {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestFetchUsageRejectsBusinessError(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		_, _ = response.Write([]byte(`{"code":3001,"msg":"parameter error"}`))
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.balanceURL = server.URL + "/balance"
	if _, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), zcodeCredential(t), time.Now().UTC(),
	); err == nil || !strings.Contains(err.Error(), "zcode") {
		t.Fatalf("error = %v", err)
	}
}
