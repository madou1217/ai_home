package webuiaccountrefreshusageapi

import (
	"context"
	"encoding/json"
	"errors"
	"math"
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
		// 故意连快照一起返回：真实适配器可能在探测失败时仍持有上一份快照，
		// 调用方必须只看 error，不能把它当成本次刷新结果。
		return fake.snapshot, fake.err
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
	if challenge := recorder.Header().Get("WWW-Authenticate"); challenge != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, want Bearer", challenge)
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
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q", allow)
	}
	var decoded map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if decoded["error"] != "method_not_allowed" {
		t.Fatalf("error = %v", decoded["error"])
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
	var decoded map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	if decoded["error"] != "invalid_account_path" {
		t.Fatalf("error = %v", decoded["error"])
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
	//
	// 注：任务书写的错误码是 quota_refresh_unavailable，handler 实际用的是
	// quota_probe_unavailable（quota_refresh_unavailable 只出现在 503 分支）；
	// 本切片不改实现，按现状断言并在报告里登记这处命名偏差。
	assertNoSnapshotPayload(t, decoded)
}

func TestRefreshUsageMapsProbeFailureWithoutLeakingSnapshot(t *testing.T) {
	// 探测失败时适配器手里可能还留着上一份快照；响应必须只说失败。
	probe := &fakeProbe{snapshot: validSnapshot(), err: errors.New("upstream 500")}
	handler := newHandler(t, knownAccounts(), probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusBadGateway || decoded["error"] != "quota_probe_failed" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	assertNoSnapshotPayload(t, decoded)
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
			assertNoSnapshotPayload(t, decoded)
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

// assertCapturedAt 校验 capturedAt 是可解析的 RFC3339 时间戳，且 capturedAtMs 与它
// 指向同一时刻：展示层用前者格式化、用后者算剩余时间，两者漂移会显示错时间。
func assertCapturedAt(t *testing.T, decoded map[string]any, want time.Time) {
	t.Helper()
	raw, _ := decoded["capturedAt"].(string)
	if raw == "" {
		t.Fatalf("capturedAt = %v", decoded["capturedAt"])
	}
	parsed, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		t.Fatalf("capturedAt = %q 不是 RFC3339: %v", raw, err)
	}
	if !parsed.Equal(want) {
		t.Fatalf("capturedAt = %q, want %v", raw, want.UTC())
	}
	if milliseconds, _ := decoded["capturedAtMs"].(float64); int64(milliseconds) != parsed.UnixMilli() {
		t.Fatalf("capturedAtMs = %v 与 capturedAt %q 不是同一时刻", decoded["capturedAtMs"], raw)
	}
}

// assertNoSnapshotPayload 校验失败响应没有夹带任何快照字段。
//
// 刷新失败时旧快照可能仍在库里，把它当成本次结果返回等于伪造刷新成功。
func assertNoSnapshotPayload(t *testing.T, decoded map[string]any) {
	t.Helper()
	if decoded["ok"] != false {
		t.Fatalf("ok = %v, want false", decoded["ok"])
	}
	for _, key := range []string{"windows", "capturedAt", "capturedAtMs", "planType", "source"} {
		if value, present := decoded[key]; present {
			t.Fatalf("失败响应不得携带 %s（%v）", key, value)
		}
	}
}

// assertNoStore 校验响应禁止缓存。
func assertNoStore(t *testing.T, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if got := recorder.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("status = %d, Cache-Control = %q, want no-store；"+
			"handler.go 的 writeJSON 没有设置该头，需在 ServeHTTP 入口统一补一次", recorder.Code, got)
	}
}

// TestRefreshUsageProjectsCapturedAtAndOptionalWindowFields 覆盖时间戳一致性与
// 三个「零值不等于缺失」的字段：剩余 0%、未提供窗口长度、未提供恢复时间。
func TestRefreshUsageProjectsCapturedAtAndOptionalWindowFields(t *testing.T) {
	capturedAt := time.UnixMilli(1_700_000_000_123).UTC()
	exhausted := 0.0
	full := 100.0
	probe := &fakeProbe{snapshot: Snapshot{
		Provider:   testProvider,
		AccountRef: testAccountRef,
		CapturedAt: capturedAt,
		Windows: []Window{
			{
				Bucket:       "primary",
				Kind:         kindWindow,
				Scope:        scopeAccount,
				RemainingPct: &exhausted,
				Availability: availabilityExhausted,
			},
			{
				Bucket:        "seven_day",
				Kind:          kindWindow,
				Scope:         scopeAccount,
				RemainingPct:  &full,
				WindowSeconds: 60,
				ResetAt:       capturedAt.Add(2 * time.Hour),
				Availability:  availabilityAvailable,
			},
		},
	}}
	handler := newHandler(t, knownAccounts(), probe, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	assertCapturedAt(t, decoded, capturedAt)

	windows, ok := decoded["windows"].([]any)
	if !ok || len(windows) != 2 {
		t.Fatalf("windows = %v", decoded["windows"])
	}
	for index, raw := range windows {
		window, _ := raw.(map[string]any)
		// 契约要求 remainingPct 落在 0–100；null 表示未知，不在越界判定内。
		if remaining, ok := window["remainingPct"].(float64); ok && (remaining < 0 || remaining > 100) {
			t.Fatalf("windows[%d].remainingPct = %v 越界", index, remaining)
		}
	}

	first, _ := windows[0].(map[string]any)
	// 0% 是「已耗尽」，必须原样保留成数字 0，不能因为零值被省略成 null。
	if remaining, ok := first["remainingPct"].(float64); !ok || remaining != 0 {
		t.Fatalf("remainingPct = %v, want 0", first["remainingPct"])
	}
	// Provider 没给窗口长度和恢复时间：两个字段分别是「省略」和「null」。
	if value, present := first["windowSeconds"]; present {
		t.Fatalf("windowSeconds = %v，未提供时应省略", value)
	}
	if value, present := first["windowMinutes"]; present {
		t.Fatalf("windowMinutes = %v，未提供时应省略", value)
	}
	if resetAtMS, present := first["resetAtMs"]; !present || resetAtMS != nil {
		t.Fatalf("resetAtMs = %v (present=%v)，未提供时必须是 null", resetAtMS, present)
	}

	second, _ := windows[1].(map[string]any)
	if remaining, _ := second["remainingPct"].(float64); remaining != 100 {
		t.Fatalf("remainingPct = %v, want 100", second["remainingPct"])
	}
	if minutes, _ := second["windowMinutes"].(float64); int64(minutes) != 1 {
		t.Fatalf("windowMinutes = %v, want 1", second["windowMinutes"])
	}
	if resetAtMS, _ := second["resetAtMs"].(float64); int64(resetAtMS) != capturedAt.Add(2*time.Hour).UnixMilli() {
		t.Fatalf("resetAtMs = %v, want %d", second["resetAtMs"], capturedAt.Add(2*time.Hour).UnixMilli())
	}
}

func TestRefreshUsageRejectsOutOfRangeRemainingPct(t *testing.T) {
	for name, remaining := range map[string]float64{
		"below_zero":    -0.1,
		"above_hundred": 100.1,
		"nan":           math.NaN(),
	} {
		t.Run(name, func(t *testing.T) {
			snapshot := validSnapshot()
			snapshot.Windows[0].RemainingPct = &remaining
			handler := newHandler(t, knownAccounts(), &fakeProbe{snapshot: snapshot}, 0)

			recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
			if recorder.Code != http.StatusBadGateway || decoded["error"] != "quota_probe_invalid_snapshot" {
				t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
			}
			assertNoSnapshotPayload(t, decoded)
		})
	}
}

func TestRefreshUsageRejectsEmptyWindows(t *testing.T) {
	// 空窗口列表必须当失败处理：200 + windows: [] 会被展示层读成「这个账号没有额度」。
	snapshot := validSnapshot()
	snapshot.Windows = []Window{}
	handler := newHandler(t, knownAccounts(), &fakeProbe{snapshot: snapshot}, 0)

	recorder, decoded := postRefreshUsage(t, handler, testProvider, testAccountRef)
	if recorder.Code != http.StatusBadGateway || decoded["error"] != "quota_probe_invalid_snapshot" {
		t.Fatalf("status = %d, error = %v", recorder.Code, decoded["error"])
	}
	assertNoSnapshotPayload(t, decoded)
}

func TestRefreshUsageFailsClosedWithoutHandler(t *testing.T) {
	for name, handler := range map[string]*Handler{
		"nil_handler":  nil,
		"zero_handler": {},
	} {
		t.Run(name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, "/", nil))
			if recorder.Code != http.StatusServiceUnavailable {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			var decoded map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
				t.Fatalf("decode %q: %v", recorder.Body.String(), err)
			}
			if decoded["error"] != "quota_refresh_unavailable" {
				t.Fatalf("error = %v", decoded["error"])
			}
		})
	}
}

// TestRefreshUsageWritesNoStoreCacheControl 覆盖成功与失败响应的禁缓存头。
//
// 额度数据属于账号隐私，任何状态码都不能让中间层缓存；其它 /v1/management
// 写入口（如 webuiquotaresetapi）都在入口统一设置。
func TestRefreshUsageWritesNoStoreCacheControl(t *testing.T) {
	t.Run("success", func(t *testing.T) {
		handler := newHandler(t, knownAccounts(), &fakeProbe{snapshot: validSnapshot()}, 0)
		recorder, _ := postRefreshUsage(t, handler, testProvider, testAccountRef)
		assertNoStore(t, recorder)
	})
	t.Run("account_not_found", func(t *testing.T) {
		handler := newHandler(t, fakeAccounts{}, &fakeProbe{snapshot: validSnapshot()}, 0)
		recorder, _ := postRefreshUsage(t, handler, testProvider, testAccountRef)
		assertNoStore(t, recorder)
	})
	t.Run("probe_failed", func(t *testing.T) {
		handler := newHandler(t, knownAccounts(), &fakeProbe{err: errors.New("upstream 500")}, 0)
		recorder, _ := postRefreshUsage(t, handler, testProvider, testAccountRef)
		assertNoStore(t, recorder)
	})
}
