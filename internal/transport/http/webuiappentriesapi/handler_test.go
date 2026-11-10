package webuiappentriesapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/madou1217/ai_home/core/providers"
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

type stubCatalog []providers.Definition

func (catalog stubCatalog) List() []providers.Definition { return []providers.Definition(catalog) }

type decodedEntry struct {
	Desktop bool `json:"desktop"`
	CLI     bool `json:"cli"`
}

type decodedCapability struct {
	Desktop         bool   `json:"desktop"`
	CLI             bool   `json:"cli"`
	Label           string `json:"label"`
	ExternalHarness bool   `json:"externalHarness"`
}

type decodedResponse struct {
	OK                      bool                         `json:"ok"`
	Entries                 map[string]decodedEntry      `json:"entries"`
	Capabilities            map[string]decodedCapability `json:"capabilities"`
	ServerRuntime           bool                         `json:"serverRuntime"`
	ProbedAtMS              int64                        `json:"probedAtMs"`
	ExpiresAtMS             int64                        `json:"expiresAtMs"`
	Cached                  bool                         `json:"cached"`
	BudgetExceededProviders []string                     `json:"budgetExceededProviders"`
	UnfilledFields          []string                     `json:"unfilledFields"`
}

// testProvider 构造带桌面 / CLI 声明的最小 Provider 合同。
func testProvider(id string, label string, binaryName string, installPaths []string) providers.Definition {
	return providers.Definition{
		ID:           id,
		Presentation: providers.Presentation{ID: id, Label: label},
		Clients:      providers.ClientSupport{CLI: true, Desktop: true},
		CLI: &providers.CLIConfig{
			BinaryName: binaryName,
			DesktopClient: &providers.DesktopClient{
				MacOS: &providers.DesktopPlatform{
					ClientName:   label,
					ExecNames:    []string{label},
					InstallPaths: installPaths,
				},
			},
		},
	}
}

func missingLookPath(string) (string, error) { return "", exec.ErrNotFound }

func newTestHandler(t *testing.T, dependencies Dependencies) http.Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func doRequest(t *testing.T, handler http.Handler, method string, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

func decodeResponse(t *testing.T, recorder *httptest.ResponseRecorder) decodedResponse {
	t.Helper()
	var decoded decodedResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (body=%s)", err, recorder.Body.String())
	}
	return decoded
}

func writeExecutable(t *testing.T, path string, mode os.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("创建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"), mode); err != nil {
		t.Fatalf("写入文件失败: %v", err)
	}
}

func TestNewHandlerRejectsMissingAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{Providers: stubCatalog{}}); err != ErrInvalidDependencies {
		t.Fatalf("NewHandler() error = %v, want %v", err, ErrInvalidDependencies)
	}
}

func TestServeHTTPRequiresAuthorization(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(false),
		HostHomeDir: t.TempDir(),
		LookPath:    missingLookPath,
		Providers:   stubCatalog{testProvider("alpha", "Alpha", "aih-test-alpha-cli", nil)},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, want Bearer", recorder.Header().Get("WWW-Authenticate"))
	}
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误响应不是合法 JSON: %v", err)
	}
	if body.OK || body.Error.Code != "unauthorized" {
		t.Fatalf("错误响应 = %+v, want ok=false code=unauthorized", body)
	}
}

func TestServeHTTPRejectsNonGET(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: t.TempDir(),
		LookPath:    missingLookPath,
		Providers:   stubCatalog{testProvider("alpha", "Alpha", "aih-test-alpha-cli", nil)},
	})
	recorder := doRequest(t, handler, http.MethodPost, Path)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
	if recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("Allow = %q, want GET", recorder.Header().Get("Allow"))
	}
	var body errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("错误响应不是合法 JSON: %v", err)
	}
	if body.Error.Code != "method_not_allowed" {
		t.Fatalf("code = %q, want method_not_allowed", body.Error.Code)
	}
}

func TestEntriesAllMissing(t *testing.T) {
	home := t.TempDir()
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: home,
		LookPath:    missingLookPath,
		Providers: stubCatalog{
			testProvider("alpha", "Alpha", "aih-test-alpha-cli", []string{filepath.Join(home, "Applications", "Alpha.app")}),
			// 没有 CLI 合同的 Provider 与 Node 一致：不产生条目。
			{ID: "beta", Presentation: providers.Presentation{ID: "beta", Label: "Beta"}},
		},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if !decoded.OK {
		t.Fatal("ok = false, want true")
	}
	if len(decoded.Entries) != 1 {
		t.Fatalf("entries = %+v, want 只有 alpha", decoded.Entries)
	}
	if entry, found := decoded.Entries["alpha"]; !found || entry.Desktop || entry.CLI {
		t.Fatalf("alpha 条目 = %+v (found=%v), want {desktop:false cli:false}", entry, found)
	}
	if _, found := decoded.Entries["beta"]; found {
		t.Fatal("没有 CLI 合同的 Provider 不应产生条目")
	}
	if capability := decoded.Capabilities["alpha"]; !capability.Desktop || !capability.CLI || capability.ExternalHarness {
		t.Fatalf("alpha 能力 = %+v, want 声明 desktop/cli 且非外部 harness", capability)
	}
	if decoded.Capabilities["alpha"].Label != "Alpha" {
		t.Fatalf("label = %q, want Alpha", decoded.Capabilities["alpha"].Label)
	}
	if decoded.Cached {
		t.Fatal("首次探测不应命中缓存")
	}
	if decoded.ProbedAtMS <= 0 || decoded.ExpiresAtMS != decoded.ProbedAtMS+int64(entriesCacheTTL/time.Millisecond) {
		t.Fatalf("缓存字段异常: probedAtMs=%d expiresAtMs=%d", decoded.ProbedAtMS, decoded.ExpiresAtMS)
	}
	if !contains(decoded.UnfilledFields, "runningAccounts") {
		t.Fatalf("unfilledFields = %v, want 含 runningAccounts", decoded.UnfilledFields)
	}
}

func TestEntriesPartialAvailability(t *testing.T) {
	home := t.TempDir()
	binDir := filepath.Join(home, ".local", "bin")
	writeExecutable(t, filepath.Join(binDir, "aih-test-alpha-cli"), 0o755)
	bundlePath := filepath.Join(home, "Applications", "Alpha.app")
	if err := os.MkdirAll(bundlePath, 0o755); err != nil {
		t.Fatalf("创建 bundle 目录失败: %v", err)
	}
	lookPath := func(name string) (string, error) {
		switch name {
		case "Alpha", "aih-test-alpha-cli":
			return filepath.Join(binDir, name), nil
		}
		return "", exec.ErrNotFound
	}
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: home,
		LookPath:    lookPath,
		Providers: stubCatalog{
			testProvider("alpha", "Alpha", "aih-test-alpha-cli", []string{bundlePath}),
			testProvider("beta", "Beta", "aih-test-beta-cli", []string{filepath.Join(home, "Applications", "Beta.app")}),
		},
	})
	decoded := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if entry := decoded.Entries["alpha"]; !entry.Desktop || !entry.CLI {
		t.Fatalf("alpha 条目 = %+v, want {desktop:true cli:true}", entry)
	}
	if entry := decoded.Entries["beta"]; entry.Desktop || entry.CLI {
		t.Fatalf("beta 条目 = %+v, want {desktop:false cli:false}", entry)
	}
}

func TestInstallerBinDirIsSearched(t *testing.T) {
	home := t.TempDir()
	writeExecutable(t, filepath.Join(home, ".local", "bin", "aih-test-gamma-cli"), 0o755)
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: home,
		LookPath:    missingLookPath,
		Providers:   stubCatalog{testProvider("gamma", "Gamma", "aih-test-gamma-cli", nil)},
	})
	decoded := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if !decoded.Entries["gamma"].CLI {
		t.Fatalf("gamma 条目 = %+v, want cli:true（应命中 $HOME/.local/bin）", decoded.Entries["gamma"])
	}
}

func TestCLIExistsButNotExecutable(t *testing.T) {
	home := t.TempDir()
	writeExecutable(t, filepath.Join(home, ".local", "bin", "aih-test-delta-cli"), 0o644)
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: home,
		LookPath:    missingLookPath,
		Providers:   stubCatalog{testProvider("delta", "Delta", "aih-test-delta-cli", nil)},
	})
	decoded := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if decoded.Entries["delta"].CLI {
		t.Fatalf("delta 条目 = %+v, want cli:false（存在但不可执行）", decoded.Entries["delta"])
	}
}

func TestDetectCachesUntilTTLAndRefresh(t *testing.T) {
	clock := &manualClock{current: time.Unix(1700000000, 0)}
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: t.TempDir(),
		LookPath:    missingLookPath,
		Now:         clock.Now,
		Providers:   stubCatalog{testProvider("alpha", "Alpha", "aih-test-alpha-cli", nil)},
	})

	first := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if first.Cached {
		t.Fatal("首次请求不应命中缓存")
	}
	if first.ProbedAtMS != clock.current.UnixMilli() {
		t.Fatalf("probedAtMs = %d, want %d", first.ProbedAtMS, clock.current.UnixMilli())
	}

	second := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if !second.Cached {
		t.Fatal("TTL 内的第二次请求应命中缓存")
	}
	if second.ProbedAtMS != first.ProbedAtMS {
		t.Fatalf("命中缓存时 probedAtMs 不应变化: %d != %d", second.ProbedAtMS, first.ProbedAtMS)
	}

	clock.Advance(31 * time.Second)
	third := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if third.Cached {
		t.Fatal("超过 TTL 后应重新探测")
	}
	if third.ProbedAtMS != clock.current.UnixMilli() {
		t.Fatalf("重新探测的 probedAtMs = %d, want %d", third.ProbedAtMS, clock.current.UnixMilli())
	}

	clock.Advance(time.Second)
	refreshed := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path+"?refresh=1"))
	if refreshed.Cached {
		t.Fatal("refresh=1 应强制重新探测")
	}
	if refreshed.ProbedAtMS != clock.current.UnixMilli() {
		t.Fatalf("refresh 后的 probedAtMs = %d, want %d", refreshed.ProbedAtMS, clock.current.UnixMilli())
	}
}

func TestProbeBudgetIsEnforced(t *testing.T) {
	// 每次读时钟前进 1s，必然越过 150ms 的单 Provider 预算。
	clock := &stepClock{current: time.Unix(1700000000, 0), step: time.Second}
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: t.TempDir(),
		LookPath:    missingLookPath,
		Now:         clock.Now,
		Providers: stubCatalog{
			testProvider("alpha", "Alpha", "aih-test-alpha-cli", []string{"/nonexistent/Alpha.app"}),
			testProvider("beta", "Beta", "aih-test-beta-cli", []string{"/nonexistent/Beta.app"}),
		},
	})
	decoded := decodeResponse(t, doRequest(t, handler, http.MethodGet, Path))
	if len(decoded.BudgetExceededProviders) == 0 {
		t.Fatalf("budgetExceededProviders = %v, want 非空", decoded.BudgetExceededProviders)
	}
	if entry := decoded.Entries["alpha"]; entry.Desktop || entry.CLI {
		t.Fatalf("预算耗尽时不应报告可用入口: %+v", entry)
	}
}

func TestEntryJSONKeysMatchNodeContract(t *testing.T) {
	handler := newTestHandler(t, Dependencies{
		Authorizer:  stubAuthorizer(true),
		HostHomeDir: t.TempDir(),
		LookPath:    missingLookPath,
		Providers:   stubCatalog{testProvider("alpha", "Alpha", "aih-test-alpha-cli", nil)},
	})
	recorder := doRequest(t, handler, http.MethodGet, Path)
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON: %v", err)
	}
	entries, ok := payload["entries"].(map[string]any)
	if !ok {
		t.Fatalf("entries 类型 = %T, want object", payload["entries"])
	}
	entry, ok := entries["alpha"].(map[string]any)
	if !ok {
		t.Fatalf("entries.alpha 类型 = %T, want object", entries["alpha"])
	}
	if len(entry) != 2 {
		t.Fatalf("entry 字段 = %v, want 只有 desktop/cli", entry)
	}
	for _, key := range []string{"desktop", "cli"} {
		if _, found := entry[key]; !found {
			t.Fatalf("entry 缺少字段 %q: %v", key, entry)
		}
	}
	for _, key := range []string{"ok", "entries", "capabilities", "serverRuntime", "probedAtMs"} {
		if _, found := payload[key]; !found {
			t.Fatalf("响应缺少 Node 兼容键 %q", key)
		}
	}
}

type manualClock struct {
	current time.Time
}

func (clock *manualClock) Now() time.Time { return clock.current }

func (clock *manualClock) Advance(duration time.Duration) {
	clock.current = clock.current.Add(duration)
}

type stepClock struct {
	current time.Time
	step    time.Duration
}

func (clock *stepClock) Now() time.Time {
	value := clock.current
	clock.current = clock.current.Add(clock.step)
	return value
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}
