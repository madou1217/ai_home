package kirooauth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/madou1217/ai_home/application/accountauth"
	"github.com/madou1217/ai_home/internal/adapters/accounts/kirodb"
	"github.com/madou1217/ai_home/internal/adapters/accounts/nativeaccount"
)

// fakeAWS 模拟 OIDC 的三个端点与 codewhisperer 的 GetUsageLimits。
type fakeAWS struct {
	server *httptest.Server

	mu       sync.Mutex
	requests []string
	bodies   map[string]map[string]any

	registerStatus  int
	registerPayload string
	deviceStatus    int
	devicePayload   string
	tokenStatus     int
	tokenPayload    string
	usageStatus     int
	usagePayload    string
}

func newFakeAWS(t *testing.T) *fakeAWS {
	t.Helper()
	fake := &fakeAWS{
		bodies:          map[string]map[string]any{},
		registerStatus:  http.StatusOK,
		deviceStatus:    http.StatusOK,
		tokenStatus:     http.StatusOK,
		usageStatus:     http.StatusOK,
		registerPayload: `{"clientId":"client-1","clientSecret":"secret-1","clientSecretExpiresAt":1800000000}`,
		devicePayload: `{"deviceCode":"device-1","userCode":"ABCD-1234",
			"verificationUri":"https://view.awsapps.com/start/#/device","verificationUriComplete":"https://view.awsapps.com/start/#/device?user_code=ABCD-1234",
			"interval":5,"expiresIn":600}`,
		tokenPayload: `{"accessToken":"access-1","refreshToken":"refresh-1","expiresIn":3600}`,
		usagePayload: `{"userInfo":{"userId":"user-1","email":"user@example.test"}}`,
	}
	fake.server = httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(io.LimitReader(request.Body, 64*1024))
		body := map[string]any{}
		_ = json.Unmarshal(raw, &body)
		fake.mu.Lock()
		fake.requests = append(fake.requests, request.Method+" "+request.URL.Path)
		fake.bodies[request.URL.Path] = body
		fake.mu.Unlock()
		switch request.URL.Path {
		case registerPath:
			response.WriteHeader(fake.registerStatus)
			_, _ = response.Write([]byte(fake.registerPayload))
		case deviceAuthorizationPath:
			response.WriteHeader(fake.deviceStatus)
			_, _ = response.Write([]byte(fake.devicePayload))
		case deviceTokenPath:
			response.WriteHeader(fake.tokenStatus)
			_, _ = response.Write([]byte(fake.tokenPayload))
		case "/":
			response.WriteHeader(fake.usageStatus)
			_, _ = response.Write([]byte(fake.usagePayload))
		default:
			response.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(fake.server.Close)
	return fake
}

func (fake *fakeAWS) count(path string) int {
	fake.mu.Lock()
	defer fake.mu.Unlock()
	total := 0
	for _, entry := range fake.requests {
		if entry == "POST "+path {
			total++
		}
	}
	return total
}

// newLoginFlow 用假端点与固定时钟创建一次待轮询的流程。
func newLoginFlow(t *testing.T, fake *fakeAWS) (*loginFlow, *time.Time) {
	t.Helper()
	now := time.Date(2026, time.November, 9, 10, 0, 0, 0, time.UTC)
	provider, err := newLogin(loginOptions{
		client:    fake.server.Client(),
		clock:     func() time.Time { return now },
		oidcBase:  func(string) string { return fake.server.URL },
		usageBase: func(string) string { return fake.server.URL },
	})
	if err != nil {
		t.Fatalf("newLogin() error = %v", err)
	}
	flowValue, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	typed, ok := flowValue.(*loginFlow)
	if !ok {
		t.Fatalf("Begin() flow type = %T", flowValue)
	}
	return typed, &now
}

func TestLoginProviderImplementsDevicePorts(t *testing.T) {
	provider, err := NewLogin(&http.Client{}, time.Now)
	if err != nil {
		t.Fatalf("NewLogin() error = %v", err)
	}
	var oauth accountauth.OAuthProvider = provider
	if oauth.ProviderID() != "kiro" {
		t.Fatalf("ProviderID() = %q", oauth.ProviderID())
	}
}

func TestBeginRegistersPublicClientAndRequestsDeviceCode(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, _ := newLoginFlow(t, fake)

	if flowValue.AuthorizationURL() != "https://view.awsapps.com/start/#/device?user_code=ABCD-1234" {
		t.Fatalf("AuthorizationURL() = %q", flowValue.AuthorizationURL())
	}
	if flowValue.UserCode() != "ABCD-1234" {
		t.Fatalf("UserCode() = %q", flowValue.UserCode())
	}
	if flowValue.PollInterval() != 5*time.Second {
		t.Fatalf("PollInterval() = %v", flowValue.PollInterval())
	}

	register := fake.bodies[registerPath]
	if register["clientName"] != "aih" || register["clientType"] != "public" {
		t.Fatalf("client/register body = %v", register)
	}
	if len(register) != 4 {
		t.Fatalf("client/register 字段 = %v, want 4 个", register)
	}
	grantTypes, _ := register["grantTypes"].([]any)
	if len(grantTypes) != 2 ||
		grantTypes[0] != "urn:ietf:params:oauth:grant-type:device_code" ||
		grantTypes[1] != "refresh_token" {
		t.Fatalf("grantTypes = %v", register["grantTypes"])
	}
	scopes, _ := register["scopes"].([]any)
	if len(scopes) != 3 || scopes[0] != "codewhisperer:completions" {
		t.Fatalf("scopes = %v", register["scopes"])
	}

	device := fake.bodies[deviceAuthorizationPath]
	if device["clientId"] != "client-1" ||
		device["clientSecret"] != "secret-1" ||
		device["startUrl"] != "https://view.awsapps.com/start" {
		t.Fatalf("device_authorization body = %v", device)
	}
	if len(device) != 3 {
		t.Fatalf("device_authorization 字段 = %v, want 3 个", device)
	}
}

func TestBeginRejectsInvalidDeviceCode(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload string
		want    error
	}{
		{name: "register 4xx", status: http.StatusBadRequest, payload: `{}`, want: accountauth.ErrProviderRejected},
		{name: "register 5xx", status: http.StatusBadGateway, payload: `oops`, want: accountauth.ErrProviderUnavailable},
		{name: "register missing client", status: http.StatusOK, payload: `{"clientId":"c"}`, want: accountauth.ErrProviderRejected},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeAWS(t)
			fake.registerStatus = testCase.status
			fake.registerPayload = testCase.payload
			provider, err := newLogin(loginOptions{
				client:    fake.server.Client(),
				clock:     time.Now,
				oidcBase:  func(string) string { return fake.server.URL },
				usageBase: func(string) string { return fake.server.URL },
			})
			if err != nil {
				t.Fatalf("newLogin() error = %v", err)
			}
			if _, err := provider.Begin(context.Background()); !errors.Is(err, testCase.want) {
				t.Fatalf("Begin() error = %v, want %v", err, testCase.want)
			}
		})
	}
}

func TestBeginRejectsUnusableDeviceAuthorization(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		payload string
		want    error
	}{
		{name: "4xx", status: http.StatusBadRequest, payload: `{"error":"invalid_client"}`, want: accountauth.ErrProviderRejected},
		{name: "5xx", status: http.StatusBadGateway, payload: `oops`, want: accountauth.ErrProviderUnavailable},
		{name: "invalid json", status: http.StatusOK, payload: `no`, want: accountauth.ErrProviderUnavailable},
		{name: "missing user code", status: http.StatusOK, payload: `{"deviceCode":"d","verificationUri":"https://x.test/v","expiresIn":600}`, want: accountauth.ErrProviderRejected},
		{name: "unusable verification url", status: http.StatusOK, payload: `{"deviceCode":"d","userCode":"u","verificationUri":"ftp://x","expiresIn":600}`, want: accountauth.ErrProviderRejected},
		{name: "expired hint", status: http.StatusOK, payload: `{"deviceCode":"d","userCode":"u","verificationUri":"https://x.test/v","expiresIn":0}`, want: accountauth.ErrProviderRejected},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeAWS(t)
			fake.deviceStatus = testCase.status
			fake.devicePayload = testCase.payload
			provider, err := newLogin(loginOptions{
				client:    fake.server.Client(),
				clock:     time.Now,
				oidcBase:  func(string) string { return fake.server.URL },
				usageBase: func(string) string { return fake.server.URL },
			})
			if err != nil {
				t.Fatalf("newLogin() error = %v", err)
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
		{name: "invalid client", status: http.StatusUnauthorized, payload: `{"error":"invalid_client"}`, wantStatus: PollFailed},
		{name: "unparsable 4xx", status: http.StatusBadRequest, payload: `plain`, wantStatus: PollFailed},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			fake := newFakeAWS(t)
			flowValue, _ := newLoginFlow(t, fake)
			fake.tokenStatus = testCase.status
			fake.tokenPayload = testCase.payload
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
		})
	}
}

func TestPollReturnsUnavailableOnUpstreamFailure(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, _ := newLoginFlow(t, fake)
	fake.tokenStatus = http.StatusBadGateway
	fake.tokenPayload = `oops`
	if _, err := flowValue.Poll(context.Background()); !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("Poll() error = %v, want provider_unavailable", err)
	}
}

func TestPollExpiresLocallyWithoutRequest(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, now := newLoginFlow(t, fake)
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

// 成功路径的 artifact 必须能过生产 decoder：身份来自 GetUsageLimits 的 userId，
// tokenBinding 绑定 access/refresh，缺一都会被 decoder 拒绝。
func TestPollSuccessBuildsDecodableArtifacts(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, now := newLoginFlow(t, fake)
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
	if _, _, err := nativeaccount.NewDecoder().Decode("kiro", result.Artifacts); err != nil {
		t.Fatalf("native decoder 拒绝 artifact: %v", err)
	}

	var envelope struct {
		NativeAuth struct {
			Auth         map[string]any `json:"auth"`
			Registration map[string]any `json:"registration"`
			Evidence     map[string]any `json:"identityEvidence"`
			Flavor       string         `json:"flavor"`
			Database     string         `json:"database"`
		} `json:"native_auth_json"`
	}
	if err := json.Unmarshal(result.Artifacts, &envelope); err != nil {
		t.Fatalf("artifact 不是合法 JSON: %v", err)
	}
	auth := envelope.NativeAuth.Auth
	if auth["access_token"] != "access-1" || auth["refresh_token"] != "refresh-1" {
		t.Fatalf("auth = %v", auth)
	}
	if auth["region"] != "us-east-1" {
		t.Fatalf("region = %v", auth["region"])
	}
	if auth["expires_at"] != now.Add(time.Hour).Format("2006-01-02T15:04:05.000Z") {
		t.Fatalf("expires_at = %v", auth["expires_at"])
	}
	registration := envelope.NativeAuth.Registration
	if registration["client_id"] != "client-1" ||
		registration["client_secret"] != "secret-1" ||
		registration["oauth_flow"] != "DeviceCode" {
		t.Fatalf("registration = %v", registration)
	}
	evidence := envelope.NativeAuth.Evidence
	if evidence["subject"] != "user-1" ||
		evidence["endpoint"] != "https://codewhisperer.us-east-1.amazonaws.com" ||
		evidence["source"] != "aws-codewhisperer:GetUsageLimits" {
		t.Fatalf("identityEvidence = %v", evidence)
	}
	if evidence["observedAtMs"] != float64(now.UnixMilli()) {
		t.Fatalf("observedAtMs = %v", evidence["observedAtMs"])
	}
	if evidence["tokenBinding"] != tokenBinding("https://codewhisperer.us-east-1.amazonaws.com", "access-1", "refresh-1") {
		t.Fatalf("tokenBinding 与 access/refresh 不匹配")
	}
	if count := fake.count("/"); count != 1 {
		t.Fatalf("GetUsageLimits 被请求 %d 次，want 1", count)
	}
	if envelope.NativeAuth.Flavor != "oidc" {
		t.Fatalf("flavor = %q, want oidc", envelope.NativeAuth.Flavor)
	}
	// database 是 Node 启动链路与 kiro-cli 唯一能读的凭据载体：必须能用生产读取器解出同一个 token。
	databaseBytes, err := base64.StdEncoding.DecodeString(envelope.NativeAuth.Database)
	if err != nil || len(databaseBytes) == 0 {
		t.Fatalf("database 不是合法 base64: %v", err)
	}
	databasePath := filepath.Join(t.TempDir(), "data.sqlite3")
	if err := os.WriteFile(databasePath, databaseBytes, 0o600); err != nil {
		t.Fatalf("写入 database 失败: %v", err)
	}
	storedAuth, found, err := kirodb.ReadAuth(context.Background(), databasePath)
	if err != nil || !found {
		t.Fatalf("kirodb 读取失败: found=%v err=%v", found, err)
	}
	if storedAuth.Slot != "kirocli:odic:token" {
		t.Fatalf("auth slot = %q", storedAuth.Slot)
	}
	var stored map[string]any
	if err := json.Unmarshal(storedAuth.Raw, &stored); err != nil {
		t.Fatalf("auth 行不是合法 JSON: %v", err)
	}
	if stored["access_token"] != "access-1" || stored["refresh_token"] != "refresh-1" {
		t.Fatalf("database 里的 token = %v", stored)
	}
}

// token 已签发后身份探测失败是终态：device code 已经被消费，重试只会拿到 expired_token。
func TestPollIdentityRejectionIsTerminal(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, _ := newLoginFlow(t, fake)
	fake.usageStatus = http.StatusUnauthorized
	first, err := flowValue.Poll(context.Background())
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if first.Status != PollFailed {
		t.Fatalf("Status = %q, want failed", first.Status)
	}
	second, secondErr := flowValue.Poll(context.Background())
	if secondErr != nil {
		t.Fatalf("第二次 Poll() error = %v", secondErr)
	}
	if second.Status != PollFailed {
		t.Fatalf("第二次 Status = %q, want failed", second.Status)
	}
	if count := fake.count(deviceTokenPath); count != 1 {
		t.Fatalf("device/token 被请求 %d 次，want 1", count)
	}
	if count := fake.count("/"); count != 1 {
		t.Fatalf("GetUsageLimits 被请求 %d 次，want 1", count)
	}
}

// 身份探测的瞬时 5xx 不应让 Job 变成「设备码过期」：grant 缓存后只重试探测。
func TestPollRetriesIdentityProbeWithoutRedeemingDeviceCode(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, _ := newLoginFlow(t, fake)
	fake.usageStatus = http.StatusInternalServerError
	if _, err := flowValue.Poll(context.Background()); !errors.Is(err, accountauth.ErrProviderUnavailable) {
		t.Fatalf("Poll() error = %v, want provider_unavailable", err)
	}
	fake.usageStatus = http.StatusOK
	result, err := flowValue.Poll(context.Background())
	if err != nil {
		t.Fatalf("第二次 Poll() error = %v", err)
	}
	if result.Status != PollReady {
		t.Fatalf("Status = %q, want ready", result.Status)
	}
	if count := fake.count(deviceTokenPath); count != 1 {
		t.Fatalf("device/token 被请求 %d 次，want 1", count)
	}
}

func TestPollIsIdempotentAfterReady(t *testing.T) {
	fake := newFakeAWS(t)
	flowValue, _ := newLoginFlow(t, fake)
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
			fake := newFakeAWS(t)
			flowValue, _ := newLoginFlow(t, fake)
			fake.tokenStatus = testCase.status
			fake.tokenPayload = testCase.payload
			if _, err := flowValue.Exchange(context.Background(), ""); !errors.Is(err, testCase.want) {
				t.Fatalf("Exchange() error = %v, want %v", err, testCase.want)
			}
		})
	}
	fake := newFakeAWS(t)
	flowValue, _ := newLoginFlow(t, fake)
	artifacts, err := flowValue.Exchange(context.Background(), "")
	if err != nil || len(artifacts) == 0 {
		t.Fatalf("Exchange() = %v, %v", string(artifacts), err)
	}
}

// 上游若返回相对验证地址，必须补成绝对地址，否则界面上打不开。
func TestBeginResolvesRelativeVerificationURL(t *testing.T) {
	fake := newFakeAWS(t)
	fake.devicePayload = `{"deviceCode":"d","userCode":"ABCD-1234","verificationUri":"/device","verificationUriComplete":"/device?user_code=ABCD-1234","expiresIn":600,"interval":5}`
	provider, err := newLogin(loginOptions{
		client:    fake.server.Client(),
		clock:     time.Now,
		oidcBase:  func(string) string { return fake.server.URL },
		usageBase: func(string) string { return fake.server.URL },
	})
	if err != nil {
		t.Fatalf("newLogin() error = %v", err)
	}
	flowValue, err := provider.Begin(context.Background())
	if err != nil {
		t.Fatalf("Begin() error = %v", err)
	}
	want := fake.server.URL + "/device?user_code=ABCD-1234"
	if flowValue.AuthorizationURL() != want {
		t.Fatalf("AuthorizationURL() = %q, want %q", flowValue.AuthorizationURL(), want)
	}
}
