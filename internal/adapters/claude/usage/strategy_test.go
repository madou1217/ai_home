package usage

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	claudeauth "github.com/madou1217/ai_home/core/accounts/claude"
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

func testCredential(t *testing.T, baseURL string) *claudeauth.OAuthTokenAuth {
	t.Helper()
	credential, err := claudeauth.NewOAuthTokenAuth(claudeauth.OAuthTokenInput{
		AccessToken: "test-token",
		BaseURL:     baseURL,
	})
	if err != nil {
		t.Fatalf("NewOAuthTokenAuth() error = %v", err)
	}
	return credential
}

func testCapturedAt() time.Time {
	return time.Date(2026, 11, 5, 0, 0, 0, 0, time.UTC)
}

// 模型族不写死：上游返回任何 seven_day_<family> 都要成为一条 model_family 条目。
func TestFetchUsageReadsEveryModelFamily(t *testing.T) {
	t.Parallel()
	usageBody := `{
		"five_hour": {"utilization": 10, "resets_at": "2026-11-05T05:00:00Z"},
		"seven_day": {"utilization": 20, "resets_at": "2026-11-12T00:00:00Z"},
		"seven_day_oauth_apps": {"utilization": 30, "resets_at": "2026-11-12T00:00:00Z"},
		"seven_day_opus": {"utilization": 40, "resets_at": "2026-11-12T00:00:00Z"},
		"seven_day_fable": {"utilization": 60, "resets_at": "2026-11-12T00:00:00Z"},
		"extra_usage": {"is_enabled": false}
	}`
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case usagePath:
			_, _ = response.Write([]byte(usageBody))
		case profilePath:
			_, _ = response.Write([]byte(`{"account":{"has_claude_pro":true}}`))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	snapshot, err := strategy.FetchUsage(
		context.Background(), testAccountRef(t), testCredential(t, server.URL), testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	byBucket := make(map[string]usagecore.Entry, len(snapshot.Entries()))
	for _, entry := range snapshot.Entries() {
		byBucket[entry.Bucket()] = entry
	}
	if len(byBucket) != 6 {
		t.Fatalf("entries = %#v", byBucket)
	}
	for bucket, family := range map[string]string{
		"seven_day_opus":  "opus",
		"seven_day_fable": "fable",
	} {
		entry, exists := byBucket[bucket]
		if !exists {
			t.Fatalf("缺少 %s 条目: %#v", bucket, byBucket)
		}
		if entry.Scope() != usagecore.ScopeModelFamily || entry.ScopeKey() != family {
			t.Fatalf("%s scope = %s/%q", bucket, entry.Scope(), entry.ScopeKey())
		}
	}
	if remaining, has := byBucket["seven_day_fable"].RemainingBasisPoints(); !has || remaining != 4000 {
		t.Fatalf("fable remaining = %d/%v, want 4000", remaining, has)
	}
	if byBucket["seven_day_oauth_apps"].Scope() != usagecore.ScopeAccount {
		t.Fatalf("oauth apps scope = %s", byBucket["seven_day_oauth_apps"].Scope())
	}
}

// 模型族条目顺序必须稳定，否则同一份响应每次落库顺序都不同。
func TestFetchUsageSortsModelFamilies(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == profilePath {
			response.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = response.Write([]byte(`{
			"seven_day": {"utilization": 20},
			"seven_day_opus": {"utilization": 40},
			"seven_day_fable": {"utilization": 60},
			"seven_day_haiku": {"utilization": 80}
		}`))
	}))
	defer server.Close()

	strategy, _ := New(server.Client())
	snapshot, err := strategy.FetchUsage(
		context.Background(), testAccountRef(t), testCredential(t, server.URL), testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	var buckets []string
	for _, entry := range snapshot.Entries() {
		buckets = append(buckets, entry.Bucket())
	}
	want := "seven_day,seven_day_fable,seven_day_haiku,seven_day_opus"
	if strings.Join(buckets, ",") != want {
		t.Fatalf("buckets = %v, want %s", buckets, want)
	}
}

// profile 失败只影响套餐，不能影响额度采集。
func TestFetchUsageKeepsSnapshotWhenProfileFails(t *testing.T) {
	t.Parallel()
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path == profilePath {
			response.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = response.Write([]byte(`{"five_hour":{"utilization":10}}`))
	}))
	defer server.Close()

	strategy, _ := New(server.Client())
	snapshot, err := strategy.FetchUsage(
		context.Background(), testAccountRef(t), testCredential(t, server.URL), testCapturedAt(),
	)
	if err != nil {
		t.Fatalf("FetchUsage() error = %v", err)
	}
	if snapshot.PlanType() != "" {
		t.Fatalf("plan type = %q, want empty", snapshot.PlanType())
	}
}

// 套餐不维护清单：organization_type 去掉 claude_ 前缀就是档位名。
func TestProfilePlanType(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{name: "max 布尔优先", body: `{"account":{"has_claude_max":true,"has_claude_pro":true},"organization":{"organization_type":"claude_team"}}`, want: "max"},
		{name: "pro 布尔", body: `{"account":{"has_claude_pro":true}}`, want: "pro"},
		{name: "组织类型 team", body: `{"organization":{"organization_type":"claude_team"}}`, want: "team"},
		{name: "组织类型 enterprise", body: `{"organization":{"organization_type":"claude_enterprise"}}`, want: "enterprise"},
		{name: "新档位 fable", body: `{"organization":{"organization_type":"claude_fable"}}`, want: "fable"},
		{name: "未知组织类型原样归一", body: `{"organization":{"organization_type":"Fable Max"}}`, want: "fable_max"},
		{name: "空 profile", body: `{}`, want: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				if request.URL.Path == profilePath {
					_, _ = response.Write([]byte(testCase.body))
					return
				}
				_, _ = response.Write([]byte(`{"five_hour":{"utilization":10}}`))
			}))
			defer server.Close()
			strategy, _ := New(server.Client())
			snapshot, err := strategy.FetchUsage(
				context.Background(), testAccountRef(t), testCredential(t, server.URL), testCapturedAt(),
			)
			if err != nil {
				t.Fatalf("FetchUsage() error = %v", err)
			}
			if snapshot.PlanType() != testCase.want {
				t.Fatalf("plan type = %q, want %q", snapshot.PlanType(), testCase.want)
			}
		})
	}
}

// 模型族匹配按 scope_key 包含匹配，不维护族名清单。
func TestMatchesModelFamily(t *testing.T) {
	strategy, _ := New(http.DefaultClient)
	cases := []struct {
		scopeKey string
		model    string
		want     bool
	}{
		{scopeKey: "opus", model: "claude-opus-5-5", want: true},
		{scopeKey: "sonnet", model: "claude-sonnet-4-5", want: true},
		{scopeKey: "fable", model: "claude-fable-5-1", want: true},
		{scopeKey: "fable", model: "claude-opus-5-5", want: false},
		{scopeKey: "haiku", model: "claude-haiku-4-5", want: true},
		{scopeKey: "", model: "claude-opus-5-5", want: false},
	}
	for _, testCase := range cases {
		modelID, err := runtimecore.NewModelID(testCase.model)
		if err != nil {
			t.Fatalf("NewModelID(%q) error = %v", testCase.model, err)
		}
		if got := strategy.MatchesModelFamily(testCase.scopeKey, modelID); got != testCase.want {
			t.Fatalf("MatchesModelFamily(%q, %q) = %v, want %v",
				testCase.scopeKey, testCase.model, got, testCase.want)
		}
	}
}

// 上游新增的怪键不能拖垮整次采集。
func TestFamilyFromBucketIgnoresNonFamilyKeys(t *testing.T) {
	cases := []struct {
		bucket string
		want   string
		ok     bool
	}{
		{bucket: "seven_day", ok: false},
		{bucket: "seven_day_oauth_apps", ok: false},
		{bucket: "five_hour", ok: false},
		{bucket: "seven_day_opus", want: "opus", ok: true},
		{bucket: "seven_day_fable", want: "fable", ok: true},
		{bucket: "seven_day_opus-5", want: "opus-5", ok: true},
		{bucket: "seven_day_Opus", ok: false},
		{bucket: "seven_day_", ok: false},
		{bucket: "seven_day_" + strings.Repeat("a", 129), ok: false},
	}
	for _, testCase := range cases {
		got, ok := familyFromBucket(testCase.bucket)
		if ok != testCase.ok || got != testCase.want {
			t.Fatalf("familyFromBucket(%q) = %q/%v, want %q/%v",
				testCase.bucket, got, ok, testCase.want, testCase.ok)
		}
	}
}
