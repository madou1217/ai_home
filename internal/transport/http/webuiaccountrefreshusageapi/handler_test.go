package webuiaccountrefreshusageapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testProvider   = "codex"
	testAccountRef = "acct_0123456789abcdef0123"
)

var testCapturedAt = time.UnixMilli(1_700_000_000_000).UTC()

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

type fakeAccounts struct {
	owner string
	found bool
	err   error
}

func (fake fakeAccounts) LookupProvider(
	context.Context,
	string,
) (string, bool, error) {
	return fake.owner, fake.found, fake.err
}

type fakeProbe struct {
	snapshot Snapshot
	err      error
	// waitForContext 为 true 时阻塞到 ctx 结束，用来模拟超时。
	waitForContext bool
	// observedDeadline 记录 handler 传下来的截止时间，用于验证默认超时。
	observedDeadline time.Time
	receivedProvider string
	receivedRef      string
}

func (fake *fakeProbe) ProbeQuota(
	ctx context.Context,
	provider string,
	accountRef string,
) (Snapshot, error) {
	fake.receivedProvider = provider
	fake.receivedRef = accountRef
	if deadline, ok := ctx.Deadline(); ok {
		fake.observedDeadline = deadline
	}
	if fake.waitForContext {
		<-ctx.Done()
		return Snapshot{}, ctx.Err()
	}
	if fake.err != nil {
		return Snapshot{}, fake.err
	}
	return fake.snapshot, nil
}

func validSnapshot() Snapshot {
	remaining := 73.5
	return Snapshot{
		Provider:   testProvider,
		AccountRef: testAccountRef,
		PlanType:   "plus",
		Source:     "go_quota_probe",
		CapturedAt: testCapturedAt,
		Windows: []Window{
			{
				LimitID:       "",
				Bucket:        "primary",
				Kind:          kindWindow,
				Scope:         scopeAccount,
				RemainingPct:  &remaining,
				WindowSeconds: 18_000,
				ResetAt:       testCapturedAt.Add(time.Hour),
				Availability:  availabilityAvailable,
			},
			{
				Bucket:        "seven_day",
				Kind:          kindWindow,
				Scope:         scopeModelFamily,
				ScopeKey:      "opus",
				WindowSeconds: 604_800,
				Availability:  availabilityUnknown,
			},
		},
	}
}

func newRawHandler(
	t *testing.T,
	accounts AccountLookup,
	probe QuotaProbe,
	timeout time.Duration,
) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Accounts:   accounts,
		QuotaProbe: probe,
		AIHomeDir:  t.TempDir(),
		Timeout:    timeout,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func newHandler(
	t *testing.T,
	accounts AccountLookup,
	probe QuotaProbe,
	timeout time.Duration,
) http.Handler {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("POST "+Path+RefreshUsageSuffix, newRawHandler(t, accounts, probe, timeout))
	return mux
}

func knownAccounts() fakeAccounts {
	return fakeAccounts{owner: testProvider, found: true}
}

func postRefreshUsage(
	t *testing.T,
	handler http.Handler,
	provider string,
	accountRef string,
) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(
		http.MethodPost,
		Path+"/"+provider+"/"+accountRef+"/refresh-usage",
		nil,
	)
	handler.ServeHTTP(recorder, request)
	var decoded map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, decoded
}

func TestRefreshUsageReturnsRefreshedWindows(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	handler := newHandler(t, knownAccounts(), probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, "CODEX", testAccountRef)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if decoded["ok"] != true || decoded["provider"] != testProvider ||
		decoded["accountRef"] != testAccountRef || decoded["planType"] != "plus" {
		t.Fatalf("body = %v", decoded)
	}
	if capturedAtMS, _ := decoded["capturedAtMs"].(float64); int64(capturedAtMS) != testCapturedAt.UnixMilli() {
		t.Fatalf("capturedAtMs = %v, want %d", decoded["capturedAtMs"], testCapturedAt.UnixMilli())
	}
	windows, ok := decoded["windows"].([]any)
	if !ok || len(windows) != 2 {
		t.Fatalf("windows = %v", decoded["windows"])
	}
	primary, _ := windows[0].(map[string]any)
	if primary["bucket"] != "primary" || primary["kind"] != kindWindow ||
		primary["scope"] != scopeAccount || primary["availability"] != availabilityAvailable {
		t.Fatalf("primary window = %v", primary)
	}
	if remaining, _ := primary["remainingPct"].(float64); remaining != 73.5 {
		t.Fatalf("remainingPct = %v", primary["remainingPct"])
	}
	if seconds, _ := primary["windowSeconds"].(float64); int64(seconds) != 18_000 {
		t.Fatalf("windowSeconds = %v", primary["windowSeconds"])
	}
	if minutes, _ := primary["windowMinutes"].(float64); int64(minutes) != 300 {
		t.Fatalf("windowMinutes = %v", primary["windowMinutes"])
	}
	if resetAtMS, _ := primary["resetAtMs"].(float64); int64(resetAtMS) != testCapturedAt.Add(time.Hour).UnixMilli() {
		t.Fatalf("resetAtMs = %v", primary["resetAtMs"])
	}
	family, _ := windows[1].(map[string]any)
	// 未知剩余额度必须是 null，不能伪造成 0（0 在展示层等于「已耗尽」）。
	if value, present := family["remainingPct"]; !present || value != nil {
		t.Fatalf("unknown remainingPct = %v (present=%v)", value, present)
	}
	if family["scopeKey"] != "opus" || family["windowMinutes"].(float64) != 10_080 {
		t.Fatalf("family window = %v", family)
	}
	if probe.receivedProvider != testProvider || probe.receivedRef != testAccountRef {
		t.Fatalf("probe received %q/%q", probe.receivedProvider, probe.receivedRef)
	}
}

func TestRefreshUsageUsesDefaultTimeout(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	handler := newHandler(t, knownAccounts(), probe, 0)

	before := time.Now()
	if recorder, _ := postRefreshUsage(t, handler, testProvider, testAccountRef); recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	if probe.observedDeadline.IsZero() {
		t.Fatal("probe 必须收到带截止时间的 ctx")
	}
	remaining := probe.observedDeadline.Sub(before)
	if remaining <= 0 || remaining > DefaultTimeout+time.Second {
		t.Fatalf("deadline = %v, want ≈%v", remaining, DefaultTimeout)
	}
}

func TestRefreshUsageRejectsUnauthorized(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Accounts:   knownAccounts(),
		QuotaProbe: probe,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusUnauthorized || decoded["error"] != "unauthorized" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if probe.receivedRef != "" {
		t.Fatal("未鉴权的请求不得触发探测")
	}
}

func TestRefreshUsageRejectsNonPost(t *testing.T) {
	handler := newRawHandler(t, knownAccounts(), &fakeProbe{snapshot: validSnapshot()}, 0)

	request := httptest.NewRequest(http.MethodGet, "/irrelevant", nil)
	request.SetPathValue("provider", testProvider)
	request.SetPathValue("accountRef", testAccountRef)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d", recorder.Code)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q", allow)
	}
}

func TestRefreshUsageRejectsUnknownAccountAndProviderMismatch(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	unknown := newHandler(t, fakeAccounts{}, probe, 0)
	recorder, decoded := postRefreshUsage(t, unknown, testProvider, testAccountRef)
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("unknown: status = %d, error = %v", recorder.Code, decoded["error"])
	}

	mismatch := newHandler(t, knownAccounts(), probe, 0)
	recorder, decoded = postRefreshUsage(t, mismatch, "claude", testAccountRef)
	if recorder.Code != http.StatusNotFound || decoded["error"] != "account_not_found" {
		t.Fatalf("mismatch: status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if probe.receivedRef != "" {
		t.Fatal("账号不存在或 Provider 不匹配时不得触发探测")
	}
}

func TestRefreshUsageRejectsEmptyPath(t *testing.T) {
	probe := &fakeProbe{snapshot: validSnapshot()}
	handler := newRawHandler(t, knownAccounts(), probe, 0)

	request := httptest.NewRequest(http.MethodPost, "/irrelevant", nil)
	request.SetPathValue("provider", testProvider)
	request.SetPathValue("accountRef", "   ")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if probe.receivedRef != "" {
		t.Fatal("空账号路径不得触发探测")
	}
}

func TestRefreshUsageWithoutProbeReturnsNotImplemented(t *testing.T) {
	handler := newHandler(t, knownAccounts(), nil, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusNotImplemented || decoded["error"] != "quota_probe_unavailable" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	// 必须显式说明「没刷新」，而不是返回空窗口列表冒充「没有额度」。
	if _, present := decoded["windows"]; present {
		t.Fatalf("body = %v", decoded)
	}
}

func TestRefreshUsageMapsProbeFailure(t *testing.T) {
	handler := newHandler(t, knownAccounts(), &fakeProbe{err: errors.New("upstream 500")}, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusBadGateway || decoded["error"] != "quota_probe_failed" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
}

func TestRefreshUsageReturnsGatewayTimeout(t *testing.T) {
	probe := &fakeProbe{waitForContext: true}
	handler := newHandler(t, knownAccounts(), probe, 20*time.Millisecond)

	started := time.Now()
	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusGatewayTimeout || decoded["error"] != "quota_probe_timeout" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("超时应在 20ms 左右返回，实际 %v", elapsed)
	}
}

func TestRefreshUsageRejectsMismatchedSnapshot(t *testing.T) {
	for name, mutate := range map[string]func(*Snapshot){
		"other_account": func(snapshot *Snapshot) { snapshot.AccountRef = "acct_fedcba98765432100123" },
		"other_provider": func(snapshot *Snapshot) {
			snapshot.Provider = "claude"
		},
		"no_captured_at": func(snapshot *Snapshot) { snapshot.CapturedAt = time.Time{} },
		"no_windows":     func(snapshot *Snapshot) { snapshot.Windows = nil },
		"bad_window": func(snapshot *Snapshot) {
			snapshot.Windows[0].Bucket = ""
		},
	} {
		t.Run(name, func(t *testing.T) {
			snapshot := validSnapshot()
			mutate(&snapshot)
			handler := newHandler(t, knownAccounts(), &fakeProbe{snapshot: snapshot}, 0)

			recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
			if recorder.Code != http.StatusBadGateway || decoded["error"] != "quota_probe_invalid_snapshot" {
				t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
			}
		})
	}
}

func TestRefreshUsageMapsLookupFailure(t *testing.T) {
	handler := newHandler(t, fakeAccounts{err: errors.New("db locked")}, &fakeProbe{}, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusInternalServerError || decoded["error"] != "account_lookup_failed" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v", err)
	}
}

func TestWindowViewOmitsNonWholeMinuteWindows(t *testing.T) {
	views := newWindowViews([]Window{{
		Bucket:        "custom",
		Kind:          kindWindow,
		Scope:         scopeAccount,
		WindowSeconds: 90,
		Availability:  availabilityUnknown,
	}})
	if len(views) != 1 || views[0].WindowMinutes != nil {
		t.Fatalf("views = %+v", views)
	}
	if views[0].WindowSeconds == nil || *views[0].WindowSeconds != 90 {
		t.Fatalf("windowSeconds = %v", views[0].WindowSeconds)
	}
}

func TestPathConstantsComposeTheManagementRoute(t *testing.T) {
	if got := Path + RefreshUsageSuffix; got !=
		"/v1/management/webui/accounts/{provider}/{accountRef}/refresh-usage" {
		t.Fatalf("route = %q", got)
	}
	if !strings.HasPrefix(RefreshUsageSuffix, "/{provider}/{accountRef}/") {
		t.Fatalf("suffix = %q", RefreshUsageSuffix)
	}
}
