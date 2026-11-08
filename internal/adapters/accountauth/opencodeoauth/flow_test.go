package opencodeoauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// fakeConsole 模拟 opencode.ai/console 的四个端点。
type fakeConsole struct {
	server *httptest.Server

	mu       sync.Mutex
	requests []string
	bodies   map[string]map[string]any

	deviceCodeStatus   int
	deviceCodePayload  string
	deviceTokenStatus  int
	deviceTokenPayload string
	userPayload        string
	orgsPayload        string
}

func newFakeConsole(t *testing.T) *fakeConsole {
	t.Helper()
	fake := &fakeConsole{
		bodies:            map[string]map[string]any{},
		deviceCodeStatus:  http.StatusOK,
		deviceTokenStatus: http.StatusOK,
		userPayload:       `{"id":"acc_1","email":"user@example.test"}`,
		orgsPayload:       `[]`,
	}
	fake.deviceCodePayload = `{"device_code":"dev-1","user_code":"ABCD-1234",
		"verification_uri_complete":"https://opencode.ai/console/device?code=dev-1",
		"expires_in":600,"interval":5}`
	fake.deviceTokenPayload = `{"access_token":"access-1","refresh_token":"refresh-1","expires_in":3600}`
	fake.server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 64*1024))
		body := map[string]any{}
		_ = json.Unmarshal(raw, &body)
		fake.mu.Lock()
		fake.requests = append(fake.requests, request.Method+" "+request.URL.Path)
		fake.bodies[request.URL.Path] = body
		fake.mu.Unlock()
		switch request.URL.Path {
		case deviceCodePath:
			response.WriteHeader(fake.deviceCodeStatus)
			_, _ = response.Write([]byte(fake.deviceCodePayload))
		case deviceTokenPath:
			response.WriteHeader(fake.deviceTokenStatus)
			_, _ = response.Write([]byte(fake.deviceTokenPayload))
		case userPath:
			_, _ = response.Write([]byte(fake.userPayload))
		case orgsPath:
			_, _ = response.Write([]byte(fake.orgsPayload))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

// count 返回某个路径被请求的次数。
func (fake *fakeConsole) count(path string) int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	total := 0
	for _, entry := range fake.requests {
		if entry == "POST "+path || entry == "GET "+path {
			total++
		}
	}
	return total
}

// newFlow 用 fake console 与固定时钟创建一次待轮询的流程。
func newFlow(t *testing.T, fake *fakeConsole) (*flow, *time.Time) {
	t.Helper()
	now := time.Date(2026, time.November, 8, 10, 0, 0, 0, time.UTC)
	provider, err := newProvider(providerOptions{
		client: fake.server.Client(),
		clock:  func() time.Time { return now },
		server: fake.server.URL,
	})
	if err != nil {
		t.Fatalf("newProvider() error = %v", err)
	}
	flowValue, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	typed, ok := flowValue.(*flow)
	if !ok {
		t.Fatalf("Begin() flow type = %T", flowValue)
	}
	return typed, &now
}

func TestProviderImplementsOAuthProvider(t *testing.T) {
	provider, err := New(&http.Client{}, time.Now)
	if err != nil {
		t.Fatalf("New() error = %v", err)
	}
	var oauth accountauth.OAuthProvider = provider
	if oauth.ProviderID() != "opencode" {
		t.Fatalf("ProviderID() = %q", oauth.ProviderID())
	}
}

func TestBeginRequestsDeviceCode(t *testing.T) {
	fake := newFakeConsole(t)
	flowValue, _ := newFlow(t, fake)
	if flowValue.AuthorizationURL() != "https://opencode.ai/console/device?code=dev-1" {
		t.Fatalf("AuthorizationURL() = %q", flowValue.AuthorizationURL())
	}
	if flowValue.UserCode() != "ABCD-1234" {
		t.Fatalf("UserCode() = %q", flowValue.UserCode())
	}
	if flowValue.PollInterval() != 5*time.Second {
		t.Fatalf("PollInterval() = %v", flowValue.PollInterval())
	}
	body := fake.bodies[deviceCodePath]
	if body["client_id"] != "opencode-cli" || body["supports_org_scope"] != true {
		t.Fatalf("device/code body = %v", body)
	}
	if len(body) != 2 {
		t.Fatalf("device/code 字段 = %v, want 2 个", body)
	}
}

func TestBeginRejectsInvalidDeviceCode(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload string
		want    error
	}{
		{name: "4xx", status: http.StatusBadRequest, payload: `{"error":"invalid_client"}`, want: accountauth.ErrProviderRejected},
		{name: "5xx", status: http.StatusBadGateway, payload: `oops`, want: accountauth.ErrProviderUnavailable},
		{name: "invalid json", status: http.StatusOK, payload: `no`, want: accountauth.ErrProviderUnavailable},
		{name: "missing user code", status: http.StatusOK, payload: `{"device_code":"d","expires_in":600}`, want: accountauth.ErrProviderRejected},
		{name: "unusable verification url", status: http.StatusOK, payload: `{"device_code":"d","user_code":"u","verification_uri_complete":"ftp://x","expires_in":600}`, want: accountauth.ErrProviderRejected},
		{name: "expired hint", status: http.StatusOK, payload: `{"device_code":"d","user_code":"u","verification_uri_complete":"https://x.test/v","expires_in":0}`, want: accountauth.ErrProviderRejected},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeConsole(t)
			fake.deviceCodeStatus = testCase.status
			fake.deviceCodePayload = testCase.payload
			now := time.Now
			provider, err := newProvider(providerOptions{client: fake.server.Client(), clock: now, server: fake.server.URL})
			if err != nil {
				t.Fatalf("newProvider() error = %v", err)
			}
			if _, err := provider.Begin(context.Background()); !errors.Is(err, testCase.want) {
				t.Fatalf("Begin() error = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestPollStateMachine(t *testing.T) {
	cases := []struct {
		name         string
		status       int
		payload      string
		wantStatus   PollStatus
		wantInterval time.Duration
	}{
		{name: "pending", status: http.StatusBadRequest, payload: `{"error":"authorization_pending"}`, wantStatus: PollPending, wantInterval: 5 * time.Second},
		{name: "slow down", status: http.StatusBadRequest, payload: `{"error":"slow_down"}`, wantStatus: PollSlowDown, wantInterval: 10 * time.Second},
		{name: "rate limited", status: http.StatusTooManyRequests, payload: ``, wantStatus: PollSlowDown, wantInterval: 10 * time.Second},
		{name: "timeout status", status: http.StatusRequestTimeout, payload: ``, wantStatus: PollSlowDown, wantInterval: 10 * time.Second},
		{name: "expired token", status: http.StatusBadRequest, payload: `{"error":"expired_token"}`, wantStatus: PollExpired},
		{name: "access denied", status: http.StatusBadRequest, payload: `{"error":"access_denied"}`, wantStatus: PollFailed},
		{name: "unparsable 4xx", status: http.StatusBadRequest, payload: `plain`, wantStatus: PollFailed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeConsole(t)
			flowValue, _ := newFlow(t, fake)
			fake.deviceTokenStatus = testCase.status
			fake.deviceTokenPayload = testCase.payload
			result, err := flowValue.Poll(context.Background())
			if err != nil {
				t.Fatalf("Poll() error = %v", err)
			}
			if result.Status != testCase.wantStatus {
				t.Fatalf("Status = %q, want %q", result.Status, testCase.wantStatus)
			}
			if testCase.wantInterval != 0 && result.Interval != testCase.wantInterval {
				t.Fatalf("Interval = %v, want %v", result.Interval, testCase.wantInterval)
			}
			if testCase.wantStatus == PollReady && len(result.Artifacts) == 0 {
				t.Fatal("ready 必须带 artifact")
			}
		})
	}
}

func TestPollReturnsUnavailableOnUpstreamFailure(t *testing.T) {
	fake := newFakeConsole(t)
	flowValue, _ := newFlow(t, fake)
	fake.deviceTokenStatus = http.StatusBadGateway
	fake.deviceTokenPayload = `oops`
	if _, err := flowValue.Poll(context.Background()); !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("Poll() error = %v, want provider_unavailable", err)
	}
}

func TestPollExpiresLocallyWithoutRequest(t *testing.T) {
	fake := newFakeConsole(t)
	flowValue, now := newFlow(t, fake)
	*now = now.Add(11 * time.Minute)
	result, err := flowValue.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if result.Status != PollExpired {
		t.Fatalf("Status = %q, want expired", result.Status)
	}
	if count := fake.count(deviceTokenPath); count != 0 {
		t.Fatalf("过期后不应请求上游，实际 %d 次", count)
	}
}

func TestPollSuccessBuildsDecodableArtifacts(t *testing.T) {
	fake := newFakeConsole(t)
	fake.orgsPayload = `[{"id":"wrk_b","name":"Zeta"},{"id":"wrk_a","name":"Alpha"}]`
	flowValue, _ := newFlow(t, fake)
	result, err := flowValue.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if result.Status != PollReady {
		t.Fatalf("Status = %q", result.Status)
	}
	if result.Account.Email != "user@example.test" || result.Account.DisplayName != "user@example.test" {
		t.Fatalf("Account = %+v", result.Account)
	}
	// artifact 必须能被真实解码器注册（身份来自 metadata.accountID）。
	if _, _, err := nativeaccount.NewDecoder().Decode("opencode", result.Artifacts); err != nil {
		t.Fatalf("native decoder 拒绝 artifact: %v", err)
	}
	var envelope struct {
		NativeAuth struct {
			Auth map[string]struct {
				Type     string         `json:"type"`
				MethodID string         `json:"methodID"`
				Access   string         `json:"access"`
				Refresh  string         `json:"refresh"`
				Expires  int64          `json:"expires"`
				Metadata map[string]any `json:"metadata"`
			} `json:"auth"`
		} `json:"native_auth_json"`
	}
	if err := json.Unmarshal(result.Artifacts, &envelope); err != nil {
		t.Fatalf("artifact 不是合法 JSON: %v", err)
	}
	record := envelope.NativeAuth.Auth["opencode"]
	if record.Type != "oauth" || record.MethodID != "device" {
		t.Fatalf("record = %+v", record)
	}
	if record.Access != "access-1" || record.Refresh != "refresh-1" {
		t.Fatalf("record 凭据 = %+v", record)
	}
	if record.Metadata["accountID"] != "acc_1" || record.Metadata["server"] != fake.server.URL {
		t.Fatalf("metadata = %v", record.Metadata)
	}
	// 未指定 org_id 时取排序后的第一个（Alpha）。
	if record.Metadata["orgID"] != "wrk_a" || record.Metadata["orgName"] != "Alpha" {
		t.Fatalf("org metadata = %v", record.Metadata)
	}
	if record.Expires <= 0 {
		t.Fatalf("expires = %d", record.Expires)
	}
}

func TestPollIsIdempotentAfterReady(t *testing.T) {
	fake := newFakeConsole(t)
	flowValue, _ := newFlow(t, fake)
	first, err := flowValue.Poll(context.Background())
	if err != nil || first.Status != PollReady {
		t.Fatalf("Poll() = %v, %v", first.Status, err)
	}
	second, err := flowValue.Poll(context.Background())
	if err != nil {
		t.Fatalf("第二次 Poll() error = %v", err)
	}
	if second.Status != PollReady || string(second.Artifacts) != string(first.Artifacts) {
		t.Fatal("终态必须原样回放，不应重新换取")
	}
	if count := fake.count(deviceTokenPath); count != 1 {
		t.Fatalf("device/token 被请求 %d 次，want 1", count)
	}
}

func TestExchangeMapsPollStates(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload string
		want    error
	}{
		{name: "pending", status: http.StatusBadRequest, payload: `{"error":"authorization_pending"}`, want: ErrAuthorizationPending},
		{name: "slow down", status: http.StatusBadRequest, payload: `{"error":"slow_down"}`, want: ErrSlowDown},
		{name: "expired", status: http.StatusBadRequest, payload: `{"error":"expired_token"}`, want: accountauth.ErrProviderRejected},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeConsole(t)
			flowValue, _ := newFlow(t, fake)
			fake.deviceTokenStatus = testCase.status
			fake.deviceTokenPayload = testCase.payload
			if _, err := flowValue.Exchange(context.Background(), ""); !errors.Is(err, testCase.want) {
				t.Fatalf("Exchange() error = %v, want %v", err, testCase.want)
			}
		})
	}
	// ready 时 Exchange 直接交付 artifact。
	fake := newFakeConsole(t)
	flowValue, _ := newFlow(t, fake)
	artifacts, err := flowValue.Exchange(context.Background(), "")
	if err != nil || len(artifacts) == 0 {
		t.Fatalf("Exchange() = %v, %v", string(artifacts), err)
	}
}

func TestSelectOrganization(t *testing.T) {
	orgs := []consoleOrg{{ID: "b", Name: "Zeta"}, {ID: "a", Name: "Alpha"}}
	if selected := selectOrganization(orgs, ""); selected == nil || selected.ID != "a" {
		t.Fatalf("默认排序选择 = %+v", selected)
	}
	if selected := selectOrganization(orgs, "b"); selected == nil || selected.Name != "Zeta" {
		t.Fatalf("org_id 选择 = %+v", selected)
	}
	if selected := selectOrganization(orgs, "missing"); selected != nil {
		t.Fatalf("未知 org_id 必须返回 nil，得到 %+v", selected)
	}
	if selected := selectOrganization(nil, ""); selected != nil {
		t.Fatalf("空列表必须返回 nil")
	}
}
