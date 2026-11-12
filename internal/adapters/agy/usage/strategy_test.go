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
	strategy.baseURLs = []string{server.URL + "/v1internal"}
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
	strategy.baseURLs = []string{server.URL + "/v1internal"}
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

// agy 的 models 既可能是对象也可能数组；数组形态按 Node descriptor 规则取 id（先 id 后
// model，去 _vertex），可选字段的类型不合预期只影响该字段，不丢整条模型。
func TestFetchUsageAcceptsArrayModelsAndTolerantFields(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
			_, _ = response.Write([]byte(`{"cloudaicompanionProject":"proj-1"}`))
		case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
			_, _ = response.Write([]byte(`{"models":[
				{"id":"gemini-3-pro","model":"gemini-3-pro-preview","quotaInfo":{"remainingFraction":"0.5","resetTime":"2027-01-15T13:00:00Z"},"maxTokens":"1000","supportsThinking":0,"supportsImages":"yes"},
				{"model":"claude-opus-4-5_vertex","quotaInfo":{"remaining_fraction":0.25,"reset_time":"2027-01-15T13:00:00Z"}},
				{"model":"MODEL_PLACEHOLDER_1","quotaInfo":{"remainingFraction":0.9,"resetTime":"2027-01-15T13:00:00Z"}},
				{"model":"chat_internal","quotaInfo":{"remainingFraction":0.9,"resetTime":"2027-01-15T13:00:00Z"}},
				{"model":"no-quota-info"}
			]}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.baseURLs = []string{server.URL + "/v1internal"}
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), agyCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 2 {
		t.Fatalf("entries = %d", len(entries))
	}
	// 排序按模型 ID 字节序：claude-… 在 gemini-… 之前。
	if entries[0].Bucket() != "claude-opus-4-5" || entries[1].Bucket() != "gemini-3-pro" {
		t.Fatalf("buckets = %q, %q", entries[0].Bucket(), entries[1].Bucket())
	}
	// 字符串分数按 Number("0.5") 参与计算。
	if bps, _ := entries[1].RemainingBasisPoints(); bps != 5000 {
		t.Fatalf("gemini bps = %d", bps)
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	models := payload["models"].([]any)
	gemini := models[1].(map[string]any)
	if gemini["model"] != "gemini-3-pro" {
		t.Fatalf("gemini model = %#v", gemini["model"])
	}
	// maxTokens 字符串按 Number("1000") 取 1000；supportsThinking=0 是假值，
	// supportsImages="yes" 是真值（JS Boolean 语义）。
	if gemini["maxTokens"].(float64) != 1000 || gemini["supportsThinking"] != false || gemini["supportsImages"] != true {
		t.Fatalf("gemini flags = %#v", gemini)
	}
}

// 转发表只保留两端都是真实模型 ID 的规则（Node normalizeForwardingRules）。
func TestForwardingRulesFilterUnrealModelIDs(t *testing.T) {
	t.Parallel()
	payload := []byte(`{
		"deprecatedModelIds": {
			"MODEL_INTERNAL": "gemini-3-pro",
			"gemini-2-5-pro": "MODEL_PLACEHOLDER_2",
			"gemini-3-pro-high": {"newModelId": "gemini-pro-agent"},
			"gemini-3-pro-low": "gemini-3-pro"
		}
	}`)
	rules := forwardingRules(payload)
	if len(rules) != 2 {
		t.Fatalf("rules = %#v", rules)
	}
	if rules["gemini-3-pro-high"] != "gemini-pro-agent" || rules["gemini-3-pro-low"] != "gemini-3-pro" {
		t.Fatalf("rules = %#v", rules)
	}
	if rules := forwardingRules([]byte(`{"deprecatedModelIds": []}`)); len(rules) != 0 {
		t.Fatalf("array form rules = %#v", rules)
	}
}

// 套餐 tier 的优先级与 snake_case 字段（Node extractSubscriptionTier）。
func TestSubscriptionTierExtraction(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name     string
		body     string
		wantTier string
		wantPlan string
	}{
		{
			name:     "paid tier snake case",
			body:     `{"cloudaicompanionProject":"p","paid_tier":{"quota_tier":"Google AI Pro"}}`,
			wantTier: "Google AI Pro",
			wantPlan: "pro",
		},
		{
			name:     "ineligible tiers mark allowed default restricted",
			body:     `{"ineligible_tiers":[{"reason":"x"}],"allowed_tiers":[{"name":"Free","is_default":true},{"name":"Pro"}]}`,
			wantTier: "Free (Restricted)",
			wantPlan: "free",
		},
		{
			name:     "current tier ignored when ineligible",
			body:     `{"current_tier":{"name":"Starter"},"ineligibleTiers":[{"reason":"x"}],"allowedTiers":[{"name":"Free"}]}`,
			wantTier: "Free (Restricted)",
			wantPlan: "free",
		},
		{
			name:     "current tier without ineligible",
			body:     `{"currentTier":{"name":"Starter"}}`,
			wantTier: "Starter",
			wantPlan: "free",
		},
		{
			name:     "malformed tier is ignored",
			body:     `{"paidTier":"not-an-object","currentTier":{"id":"Google AI Ultra"}}`,
			wantTier: "Google AI Ultra",
			wantPlan: "ultra",
		},
	}
	for _, testCase := range cases {
		info := parseLoadResponse([]byte(testCase.body))
		if info.Tier != testCase.wantTier {
			t.Fatalf("%s: tier = %q, want %q", testCase.name, info.Tier, testCase.wantTier)
		}
		if got := normalizePlanType(info.Tier); got != testCase.wantPlan {
			t.Fatalf("%s: plan = %q, want %q", testCase.name, got, testCase.wantPlan)
		}
	}
}

// Node 在 loadCodeAssist / fetchAvailableModels 上按 404/429/5xx 换端点；
// 401 是凭据问题，换端点没有意义。
func TestFetchUsageFallsBackAcrossEndpoints(t *testing.T) {
	t.Parallel()
	firstHits := 0
	first := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		firstHits++
		response.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
			_, _ = response.Write([]byte(`{"cloudaicompanionProject":"proj-1"}`))
		case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
			_, _ = response.Write([]byte(`{"models":{"gemini-3-pro":{"quotaInfo":{"remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"}}}}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer second.Close()
	strategy, _ := New(first.Client())
	strategy.baseURLs = []string{first.URL + "/v1internal", second.URL + "/v1internal"}
	snapshot, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), agyCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	if len(snapshot.Entries()) != 1 {
		t.Fatalf("entries = %d", len(snapshot.Entries()))
	}
	if firstHits < 2 {
		t.Fatalf("first endpoint hits = %d, want load + fetch attempts", firstHits)
	}
}

func TestFetchUsageDoesNotFallBackOnUnauthorized(t *testing.T) {
	t.Parallel()
	secondHits := 0
	first := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	}))
	defer first.Close()
	second := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		secondHits++
		_, _ = response.Write([]byte(`{"models":{"gemini-3-pro":{"quotaInfo":{"remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"}}}}`))
	}))
	defer second.Close()
	strategy, _ := New(first.Client())
	strategy.baseURLs = []string{first.URL + "/v1internal", second.URL + "/v1internal"}
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), agyCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err == nil {
		t.Fatal("FetchUsageWithDocument() = nil error, want 401 failure")
	}
	if secondHits != 0 {
		t.Fatalf("second endpoint hits = %d, want 0", secondHits)
	}
}

// Go 的额度条目键必须满足 core 的标识符字符集：大写归一成小写，奇异字符的单条模型
// 被丢弃，但不拖垮整份快照。
func TestFetchUsageNormalizesEntryKeys(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch {
		case strings.HasSuffix(request.URL.Path, ":loadCodeAssist"):
			_, _ = response.Write([]byte(`{"cloudaicompanionProject":"proj-1"}`))
		case strings.HasSuffix(request.URL.Path, ":fetchAvailableModels"):
			_, _ = response.Write([]byte(`{"models":{
				"Gemini-3-Pro":{"quotaInfo":{"remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"}},
				"gemini+weird":{"quotaInfo":{"remainingFraction":0.9,"resetTime":"2027-01-15T13:00:00Z"}}
			}}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	strategy, _ := New(server.Client())
	strategy.baseURLs = []string{server.URL + "/v1internal"}
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), agyCredential(t), time.UnixMilli(1_800_000_000_000).UTC(),
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	entries := snapshot.Entries()
	if len(entries) != 1 {
		t.Fatalf("entries = %d", len(entries))
	}
	if entries[0].Bucket() != "gemini-3-pro" || entries[0].ScopeKey() != "gemini-3-pro" {
		t.Fatalf("entry keys = %q / %q", entries[0].Bucket(), entries[0].ScopeKey())
	}
	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	models := payload["models"].([]any)
	if models[0].(map[string]any)["model"] != "Gemini-3-Pro" {
		t.Fatalf("document model = %#v", models[0])
	}
}
