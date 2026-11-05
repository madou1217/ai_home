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
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/agy"
)

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

func agyCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	now := time.Now().UTC()
	auth, err := agy.NewOAuthAuth(agy.OAuthInput{
		Email:         "demo@example.com",
		AccessToken:   "access-token",
		RefreshToken:  "refresh-token",
		ExpiresAtMS:   now.Add(time.Hour).UnixMilli(),
		RefreshedAtMS: now.Add(-time.Minute).UnixMilli(),
		TokenType:     "Bearer",
		AuthMethod:    agy.AuthMethodConsumer,
	})
	if err != nil {
		t.Fatalf("NewOAuthAuth() error = %v", err)
	}
	return auth
}

func TestFetchUsageBuildsModelSnapshotAndDocument(t *testing.T) {
	t.Parallel()
	var fetchBody map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
			if request.Header.Get("Authorization") != "Bearer access-token" || request.Header.Get("x-client-name") != "antigravity" {
				t.Errorf("headers = %#v", request.Header)
			}
			_, _ = response.Write([]byte(`{"cloudaicompanionProject":"proj-1","paidTier":{"name":"Pro"}}`))
		case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
			raw, _ := io.ReadAll(request.Body)
			_ = json.Unmarshal(raw, &fetchBody)
			_, _ = response.Write([]byte(`{"models":{
				"claude-sonnet-4-5":{"quotaInfo":{"remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"},"displayName":"Sonnet","supportsThinking":true},
				"chat_internal":{"quotaInfo":{"remainingFraction":0.1,"resetTime":"2027-01-15T13:00:00Z"}},
				"gemini-3-pro":{"quotaInfo":{"remainingFraction":0.0,"resetTime":"2027-01-22T08:00:00Z"}}
			}}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.baseURL = server.URL + "/v1internal"
	capturedAt := time.UnixMilli(1_800_000_000_000).UTC()
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), agyCredential(t), capturedAt,
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if fetchBody["project"] != "proj-1" {
		t.Fatalf("fetch body = %#v", fetchBody)
	}
	// paidTier.name = "Pro" → 归一为 pro（与 Node agy reset strategy 同词表）。
	if snapshot.PlanType() != "pro" {
		t.Fatalf("plan type = %q, want pro", snapshot.PlanType())
	}
	entries := snapshot.Entries()
	if len(entries) != 2 {
		t.Fatalf("entries = %d", len(entries))
	}
	if entries[0].Bucket() != "claude-sonnet-4-5" || entries[0].ScopeKey() != "claude-sonnet-4-5" {
		t.Fatalf("entry = %#v", entries[0])
	}
	if bps, has := entries[0].RemainingBasisPoints(); !has || bps != 5000 {
		t.Fatalf("bps = %d / %v", bps, has)
	}
	if string(entries[1].Availability()) != "exhausted" {
		t.Fatalf("gemini availability = %v", entries[1].Availability())
	}
	// 窗口长度由 reset 距离推断：5h → 18000s，7 天 → 604800s。
	// 缺这个字段时采样会被跳过，agy 的窗口统计永远为空。
	if entries[0].WindowSeconds() != 5*60*60 {
		t.Fatalf("claude window seconds = %d, want 18000", entries[0].WindowSeconds())
	}
	if entries[1].WindowSeconds() != 7*24*60*60 {
		t.Fatalf("gemini window seconds = %d, want 604800", entries[1].WindowSeconds())
	}

	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["kind"] != documentKind || payload["schemaVersion"].(float64) != 2 {
		t.Fatalf("payload = %#v", payload)
	}
	account := payload["account"].(map[string]any)
	if account["email"] != "demo@example.com" || account["planType"] != "pro" ||
		account["subscriptionTier"] != "Pro" || account["project"] != "proj-1" {
		t.Fatalf("account = %#v", account)
	}
	models := payload["models"].([]any)
	if len(models) != 2 {
		t.Fatalf("document models = %d", len(models))
	}
	first := models[0].(map[string]any)
	if first["model"] != "claude-sonnet-4-5" || first["remainingPct"].(float64) != 50 ||
		first["displayName"] != "Sonnet" || first["supportsThinking"] != true {
		t.Fatalf("model = %#v", first)
	}
}

func TestFetchUsageRetriesWithoutProjectOn403(t *testing.T) {
	t.Parallel()
	fetches := 0
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
			_, _ = response.Write([]byte(`{"cloudaicompanionProject":"proj-1"}`))
		case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
			fetches++
			raw, _ := io.ReadAll(request.Body)
			if strings.Contains(string(raw), "proj-1") {
				response.WriteHeader(http.StatusForbidden)
				return
			}
			_, _ = response.Write([]byte(`{"models":{"claude-sonnet-4-5":{"quotaInfo":{"remainingFraction":0.25,"resetTime":"2026-11-06T00:00:00Z"}}}}`))
		}
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.baseURL = server.URL + "/v1internal"
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), agyCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("error = %v", err)
	}
	if fetches != 2 {
		t.Fatalf("fetches = %d", fetches)
	}
}

func TestMatchesModelFamilyIsExact(t *testing.T) {
	t.Parallel()
	strategy, _ := New(http.DefaultClient)
	model, err := runtimecore.NewModelID("claude-sonnet-4-5")
	if err != nil {
		t.Fatalf("model: %v", err)
	}
	if !strategy.MatchesModelFamily("claude-sonnet-4-5", model) {
		t.Fatal("exact match failed")
	}
	if strategy.MatchesModelFamily("opus", model) {
		t.Fatal("unexpected prefix match")
	}
}

// 套餐不维护档位清单：已知档位按关键字归类，新档位原样通过。
func TestSnapshotPlanType(t *testing.T) {
	t.Parallel()
	cases := []struct {
		raw  string
		want string
	}{
		{raw: "Google AI Ultra", want: "ultra"},
		{raw: "Pro", want: "pro"},
		{raw: "Starter", want: "free"},
		{raw: "Free", want: "free"},
		{raw: "Gemini Fable", want: "gemini_fable"},
		{raw: "oauth", want: ""},
		{raw: "unknown", want: ""},
		{raw: "", want: ""},
	}
	for _, testCase := range cases {
		if got := snapshotPlanType(testCase.raw); got != testCase.want {
			t.Fatalf("snapshotPlanType(%q) = %q, want %q", testCase.raw, got, testCase.want)
		}
	}
}
