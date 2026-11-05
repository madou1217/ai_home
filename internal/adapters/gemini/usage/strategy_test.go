package usage

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	usageapp "github.com/madou1217/ai_home/application/accountusage"
	runtimecore "github.com/madou1217/ai_home/core/accountruntime"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/accounts/gemini"
	usagecore "github.com/madou1217/ai_home/core/accountusage"
)

const testCapturedAtMS int64 = 1_800_000_000_000 // 2027-01-15T08:00:00Z

func testAccountRef(t *testing.T) accountcore.AccountRef {
	t.Helper()
	ref, err := accountcore.ParseAccountRef("acct_0123456789abcdef0123")
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	return ref
}

// geminiCredential 复刻 gemini 登录态原生 artifact 的最小形状。
func geminiCredential(t *testing.T) accountapp.Credential {
	t.Helper()
	identity, err := accountcore.NewNativeEmailIdentity("gemini", "demo@example.com")
	if err != nil {
		t.Fatalf("NewNativeEmailIdentity() error = %v", err)
	}
	payload := []byte(`{"googleAccounts":{"active":"demo@example.com"},
		"oauthCreds":{"access_token":"access-token","refresh_token":"refresh-token"}}`)
	credential, err := accountcore.NewNativeCredential(identity, payload)
	if err != nil {
		t.Fatalf("NewNativeCredential() error = %v", err)
	}
	return credential
}

func newTestStrategy(t *testing.T, handler http.HandlerFunc) (*Strategy, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(handler)
	t.Cleanup(server.Close)
	strategy, err := New(server.Client())
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	strategy.baseURL = server.URL + "/v1internal"
	return strategy, server
}

func TestFetchUsageBuildsModelSnapshotAndDocument(t *testing.T) {
	t.Parallel()
	var requestBody map[string]any
	strategy, _ := newTestStrategy(t, func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1internal:retrieveUserQuota" {
			t.Errorf("request = %s %s", request.Method, request.URL.Path)
		}
		if request.Header.Get("Authorization") != "Bearer access-token" {
			t.Errorf("authorization = %q", request.Header.Get("Authorization"))
		}
		if request.Header.Get("Content-Type") != "application/json" {
			t.Errorf("content-type = %q", request.Header.Get("Content-Type"))
		}
		raw, _ := io.ReadAll(request.Body)
		_ = json.Unmarshal(raw, &requestBody)
		_, _ = response.Write([]byte(`{"buckets":[
			{"modelId":"gemini-2.5-pro","remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"},
			{"modelId":"gemini-2.5-pro_vertex","remainingFraction":0.25,"resetTime":"2027-01-15T14:00:00Z"},
			{"modelId":"gemini-2.5-flash","remainingFraction":0,"resetTime":"2027-01-16T00:00:00Z"},
			{"modelId":"claude-sonnet-4-5","remainingFraction":0.9,"resetTime":"2027-01-15T13:00:00Z"}
		]}`))
	})
	capturedAt := time.UnixMilli(testCapturedAtMS).UTC()
	snapshot, document, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), geminiCredential(t), capturedAt,
	)
	if err != nil {
		t.Fatalf("FetchUsageWithDocument() error = %v", err)
	}
	// 登录态个人账号固定用占位项目；Node 逐字发送同一个值。
	if requestBody["project"] != "{{projectId}}" {
		t.Fatalf("request body = %#v", requestBody)
	}
	if snapshot.ProviderID() != providerID || snapshot.Source() != sourceID {
		t.Fatalf("snapshot = %s/%s", snapshot.ProviderID(), snapshot.Source())
	}
	entries := snapshot.Entries()
	if len(entries) != 2 {
		t.Fatalf("entries = %d", len(entries))
	}
	// 按模型名排序；_vertex 桶归并进 gemini-2.5-pro 并取更低余量（25%）。
	flash := entries[0]
	if flash.Bucket() != "gemini-2.5-flash" || flash.ScopeKey() != "gemini-2.5-flash" ||
		flash.Scope() != usagecore.ScopeModelFamily {
		t.Fatalf("flash entry = %#v", flash)
	}
	if basisPoints, known := flash.RemainingBasisPoints(); !known || basisPoints != 0 {
		t.Fatalf("flash remaining = %d / %v", basisPoints, known)
	}
	if flash.Availability() != usagecore.AvailabilityExhausted {
		t.Fatalf("flash availability = %v", flash.Availability())
	}
	pro := entries[1]
	if pro.Bucket() != "gemini-2.5-pro" {
		t.Fatalf("pro bucket = %q", pro.Bucket())
	}
	if basisPoints, known := pro.RemainingBasisPoints(); !known || basisPoints != 2500 {
		t.Fatalf("pro remaining = %d / %v", basisPoints, known)
	}
	if pro.ResetAt().UnixMilli() != time.Date(2027, 1, 15, 14, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("pro reset = %v", pro.ResetAt())
	}
	// 上游没有给窗口长度：不能凭空按 5h/7d 归类，否则窗口统计会被污染。
	if pro.WindowSeconds() != 0 {
		t.Fatalf("pro window seconds = %d", pro.WindowSeconds())
	}

	var payload map[string]any
	if err := json.Unmarshal(document.Payload(), &payload); err != nil {
		t.Fatalf("payload: %v", err)
	}
	if payload["kind"] != documentKind || payload["source"] != sourceID ||
		payload["schemaVersion"].(float64) != 2 ||
		int64(payload["capturedAt"].(float64)) != testCapturedAtMS {
		t.Fatalf("payload = %#v", payload)
	}
	models := payload["models"].([]any)
	if len(models) != 2 {
		t.Fatalf("document models = %d", len(models))
	}
	first := models[0].(map[string]any)
	if first["model"] != "gemini-2.5-flash" || first["remainingPct"].(float64) != 0 ||
		first["resetIn"] != "16h" || int64(first["resetAtMs"].(float64)) != time.Date(2027, 1, 16, 0, 0, 0, 0, time.UTC).UnixMilli() {
		t.Fatalf("flash document = %#v", first)
	}
	second := models[1].(map[string]any)
	if second["model"] != "gemini-2.5-pro" || second["remainingPct"].(float64) != 25 || second["resetIn"] != "6h" {
		t.Fatalf("pro document = %#v", second)
	}
}

func TestFetchUsageWithoutBucketsFails(t *testing.T) {
	t.Parallel()
	cases := map[string]string{
		"显式空数组": `{"buckets":[]}`,
		"字段缺失":  `{}`,
	}
	for name, body := range cases {
		name, body := name, body
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			strategy, _ := newTestStrategy(t, func(response http.ResponseWriter, _ *http.Request) {
				_, _ = response.Write([]byte(body))
			})
			_, document, err := strategy.FetchUsageWithDocument(
				context.Background(), testAccountRef(t), geminiCredential(t), time.UnixMilli(testCapturedAtMS).UTC(),
			)
			if !errors.Is(err, usageapp.ErrRefreshFailed) || !errors.Is(err, ErrNoQuotaBuckets) {
				t.Fatalf("error = %v", err)
			}
			if document != nil {
				t.Fatalf("document = %#v", document)
			}
		})
	}
}

func TestFetchUsageUnauthorized(t *testing.T) {
	t.Parallel()
	strategy, _ := newTestStrategy(t, func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusUnauthorized)
	})
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), geminiCredential(t), time.UnixMilli(testCapturedAtMS).UTC(),
	)
	if !errors.Is(err, usageapp.ErrRefreshFailed) || !errors.Is(err, ErrUnauthorized) {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchUsageDropsBucketsMissingFields(t *testing.T) {
	t.Parallel()
	strategy, _ := newTestStrategy(t, func(response http.ResponseWriter, _ *http.Request) {
		// 每条都缺一个必需字段：Node 会逐条丢弃，最终没有可用模型。
		_, _ = response.Write([]byte(`{"buckets":[
			{"remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"},
			{"modelId":"gemini-2.5-pro","resetTime":"2027-01-15T13:00:00Z"},
			{"modelId":"gemini-2.5-flash","remainingFraction":0.5},
			{"modelId":42,"remainingFraction":0.5,"resetTime":"2027-01-15T13:00:00Z"}
		]}`))
	})
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), geminiCredential(t), time.UnixMilli(testCapturedAtMS).UTC(),
	)
	if !errors.Is(err, ErrNoQuotaBuckets) {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchUsageRejectsMalformedResponse(t *testing.T) {
	t.Parallel()
	strategy, _ := newTestStrategy(t, func(response http.ResponseWriter, _ *http.Request) {
		_, _ = response.Write([]byte("not-json"))
	})
	_, _, err := strategy.FetchUsageWithDocument(
		context.Background(), testAccountRef(t), geminiCredential(t), time.UnixMilli(testCapturedAtMS).UTC(),
	)
	if !errors.Is(err, ErrInvalidResponse) {
		t.Fatalf("error = %v", err)
	}
}

func TestFetchUsageRejectsVertexPlaceholderCredential(t *testing.T) {
	t.Parallel()
	vertex, err := gemini.NewVertexAuth(gemini.VertexInput{
		ProjectID:   "vertex-placeholder-project",
		Location:    "global",
		APIKey:      "aih_client_test",
		BaseURL:     "http://127.0.0.1:9527",
		Placeholder: true,
	})
	if err != nil {
		t.Fatalf("NewVertexAuth() error = %v", err)
	}
	strategy, err := New(http.DefaultClient)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	if _, err := strategy.FetchUsage(context.Background(), testAccountRef(t), vertex, time.UnixMilli(testCapturedAtMS).UTC()); !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("vertex error = %v", err)
	}
	if _, err := strategy.FetchUsage(context.Background(), testAccountRef(t), nil, time.UnixMilli(testCapturedAtMS).UTC()); !errors.Is(err, usageapp.ErrUsageUnsupported) {
		t.Fatalf("nil credential error = %v", err)
	}
}

func TestMatchesModelFamilyIsExact(t *testing.T) {
	t.Parallel()
	strategy, err := New(http.DefaultClient)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	model, err := runtimecore.NewModelID("gemini-2.5-pro")
	if err != nil {
		t.Fatalf("NewModelID() error = %v", err)
	}
	if strategy.ProviderID() != "gemini" {
		t.Fatalf("provider = %q", strategy.ProviderID())
	}
	if !strategy.MatchesModelFamily("gemini-2.5-pro", model) {
		t.Fatal("exact match failed")
	}
	if strategy.MatchesModelFamily("gemini-2.5", model) {
		t.Fatal("unexpected prefix match")
	}
}

func TestNewRejectsMissingClient(t *testing.T) {
	t.Parallel()
	if _, err := New(nil); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("error = %v", err)
	}
}
