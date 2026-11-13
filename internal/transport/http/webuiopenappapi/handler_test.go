package webuiopenappapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/core/providers"
)

const (
	// 两个固定账号：一个 codex 身份，一个 gemini 身份（用于 Provider 不匹配）。
	codexAccountRef  = "acct_0123456789abcdef0123"
	geminiAccountRef = "acct_0123456789abcdef0456"
)

type stubAuthorizer bool

func (authorizer stubAuthorizer) Authorized(*http.Request) bool { return bool(authorizer) }

// stubAccounts 只回答「引用是否存在」；资格判定不在这里。
type stubAccounts struct {
	byRef map[string]accountcore.Account
}

func (accounts stubAccounts) GetByRef(
	_ context.Context,
	accountRef accountcore.AccountRef,
) (accountcore.Account, error) {
	account, found := accounts.byRef[accountRef.String()]
	if !found {
		return accountcore.Account{}, accountapp.ErrAccountNotFound
	}
	return account, nil
}

// stubLauncher 记录收到的计划并回放固定结果。
type stubLauncher struct {
	result Result
	err    error
	calls  int
	last   Request
}

func (launcher *stubLauncher) Launch(_ context.Context, request Request) (Result, error) {
	launcher.calls++
	launcher.last = request
	return launcher.result, launcher.err
}

// stubLookPath 只认识显式给出的可执行文件，避免测试依赖真实宿主安装。
func stubLookPath(paths map[string]string) func(string) (string, error) {
	return func(name string) (string, error) {
		if path, found := paths[name]; found {
			return path, nil
		}
		return "", exec.ErrNotFound
	}
}

type decodedPlan struct {
	IdentityProvider string `json:"identityProvider"`
	AccountRef       string `json:"accountRef"`
	HarnessID        string `json:"harnessId"`
	HarnessKind      string `json:"harnessKind"`
	CrossProvider    bool   `json:"crossProvider"`
	ManagedAppID     string `json:"managedAppId"`
	BinaryName       string `json:"binaryName"`
	Kind             string `json:"kind"`
	Action           string `json:"action"`
	Model            string `json:"model"`
	TerminalID       string `json:"terminalId"`
	Workdir          string `json:"workdir"`
	Transport        string `json:"transport"`
	SessionKey       string `json:"sessionKey"`
	Executable       string `json:"executable"`
	Installed        bool   `json:"installed"`
}

type decodedInstallTarget struct {
	Provider string `json:"provider"`
	Kind     string `json:"kind"`
	AppID    string `json:"appId"`
}

type decodedResponse struct {
	OK               bool                  `json:"ok"`
	Error            string                `json:"error"`
	Message          string                `json:"message"`
	Provider         string                `json:"provider"`
	AccountRef       string                `json:"accountRef"`
	Kind             string                `json:"kind"`
	Action           string                `json:"action"`
	Status           string                `json:"status"`
	PID              *int                  `json:"pid"`
	TerminalID       string                `json:"terminalId"`
	SessionKey       string                `json:"sessionKey"`
	LaunchMode       string                `json:"launchMode"`
	Executable       string                `json:"executable"`
	PIDs             []int                 `json:"pids"`
	Plan             *decodedPlan          `json:"plan"`
	InstallRequired  bool                  `json:"installRequired"`
	InstallTarget    *decodedInstallTarget `json:"installTarget"`
	InstallAvailable *bool                 `json:"installAvailable"`
	Partial          bool                  `json:"partial"`
	UnfilledFields   []string              `json:"unfilledFields"`
}

func newTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func newTestAccount(t *testing.T, catalog *providers.Catalog, ref string, providerID string) accountcore.Account {
	t.Helper()
	createdAt := time.Date(2026, time.November, 1, 0, 0, 0, 0, time.UTC)
	account, err := accountcore.RestoreAccount(catalog, accountcore.RestoreAccountInput{
		Ref:          accountcore.AccountRef(ref),
		ProviderID:   providerID,
		CLIAccountID: accountcore.CLIAccountID(1),
		Enabled:      true,
		CreatedAt:    createdAt,
		UpdatedAt:    createdAt,
	})
	if err != nil {
		t.Fatalf("RestoreAccount(%s) error = %v", providerID, err)
	}
	return account
}

func newTestAccounts(t *testing.T, catalog *providers.Catalog) stubAccounts {
	t.Helper()
	return stubAccounts{byRef: map[string]accountcore.Account{
		codexAccountRef:  newTestAccount(t, catalog, codexAccountRef, "codex"),
		geminiAccountRef: newTestAccount(t, catalog, geminiAccountRef, "gemini"),
	}}
}

// newTestHandler 用真实路由模式挂载，让 PathValue 与生产一致。
func newTestHandler(t *testing.T, dependencies Dependencies) http.Handler {
	t.Helper()
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	mux := http.NewServeMux()
	mux.Handle(Path+OpenAppSuffix, handler)
	return mux
}

func newDependencies(t *testing.T, launcher Launcher, desktopHost bool) Dependencies {
	t.Helper()
	catalog := newTestCatalog(t)
	return Dependencies{
		Authorizer:  stubAuthorizer(true),
		Accounts:    newTestAccounts(t, catalog),
		Providers:   catalog,
		AIHomeDir:   t.TempDir(),
		HostHomeDir: t.TempDir(),
		Launcher:    launcher,
		LookPath:    stubLookPath(map[string]string{"codex": "/usr/local/bin/codex"}),
		DesktopHost: func() bool { return desktopHost },
	}
}

func doRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	target string,
	body string,
	remoteAddr string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.RemoteAddr = remoteAddr
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
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

func openAppTarget(provider string, accountRef string) string {
	return Path + "/" + provider + "/" + accountRef + "/open-app"
}

func TestServeHTTPRejectsUnauthorized(t *testing.T) {
	dependencies := newDependencies(t, &stubLauncher{}, true)
	dependencies.Authorizer = stubAuthorizer(false)
	handler := newTestHandler(t, dependencies)

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Fatalf("WWW-Authenticate = %q, want Bearer", got)
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "unauthorized" {
		t.Fatalf("error = %q, want unauthorized", decoded.Error)
	}
}

func TestServeHTTPRejectsNonPost(t *testing.T) {
	handler := newTestHandler(t, newDependencies(t, &stubLauncher{}, true))

	recorder := doRequest(t, handler, http.MethodGet,
		openAppTarget("codex", codexAccountRef), "", "127.0.0.1:5000")

	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodPost {
		t.Fatalf("Allow = %q, want POST", got)
	}
}

func TestServeHTTPRejectsUnknownProvider(t *testing.T) {
	handler := newTestHandler(t, newDependencies(t, &stubLauncher{}, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("not-a-provider", codexAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "unsupported_provider" {
		t.Fatalf("error = %q, want unsupported_provider", decoded.Error)
	}
}

func TestServeHTTPRejectsInvalidAccountRef(t *testing.T) {
	handler := newTestHandler(t, newDependencies(t, &stubLauncher{}, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", "not-a-ref"), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "invalid_account_ref" {
		t.Fatalf("error = %q, want invalid_account_ref", decoded.Error)
	}
}

func TestServeHTTPRejectsUnknownAccount(t *testing.T) {
	handler := newTestHandler(t, newDependencies(t, &stubLauncher{}, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", "acct_ffffffffffffffffffff"), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", decoded.Error)
	}
}

// 账号引用存在但属于别的 Provider：Node 的启动器同样按 account_not_found 处理。
func TestServeHTTPRejectsAccountProviderMismatch(t *testing.T) {
	launcher := &stubLauncher{}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", geminiAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "account_not_found" {
		t.Fatalf("error = %q, want account_not_found", decoded.Error)
	}
	if launcher.calls != 0 {
		t.Fatalf("launcher calls = %d, want 0", launcher.calls)
	}
}

func TestServeHTTPReportsLaunchUnavailableWithoutLauncher(t *testing.T) {
	handler := newTestHandler(t, newDependencies(t, nil, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Error != "launch_unavailable" {
		t.Fatalf("error = %q, want launch_unavailable", decoded.Error)
	}
	if decoded.Plan == nil {
		t.Fatal("501 响应必须带启动计划")
	}
	if decoded.Plan.Kind != kindCLI || decoded.Plan.HarnessID != "codex" {
		t.Fatalf("plan = %+v, want cli/codex", decoded.Plan)
	}
}

func TestServeHTTPLaunchesCLIThroughWebTerminal(t *testing.T) {
	launcher := &stubLauncher{result: Result{
		OK:         true,
		Status:     "launched",
		TerminalID: "system-default",
		LaunchMode: "webui-pty",
	}}
	// 无桌面会话：CLI 一律降级到 Web Terminal，并自动生成会话键。
	handler := newTestHandler(t, newDependencies(t, launcher, false))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef),
		`{"kind":"cli","model":"gpt-5","workdir":"/tmp/project"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Status != "launched" || decoded.LaunchMode != "webui-pty" {
		t.Fatalf("response = %+v, want launched/webui-pty", decoded)
	}
	if !strings.HasPrefix(decoded.SessionKey, "account-cli:") {
		t.Fatalf("sessionKey = %q, want account-cli: 前缀", decoded.SessionKey)
	}
	if decoded.Plan == nil {
		t.Fatal("成功响应必须带启动计划")
	}
	if decoded.Plan.Transport != transportWebUI {
		t.Fatalf("plan.transport = %q, want webui", decoded.Plan.Transport)
	}
	if decoded.Plan.BinaryName != "codex" || decoded.Plan.Executable != "/usr/local/bin/codex" {
		t.Fatalf("plan = %+v, want codex 二进制与解析路径", decoded.Plan)
	}
	if launcher.calls != 1 {
		t.Fatalf("launcher calls = %d, want 1", launcher.calls)
	}
	if launcher.last.Transport != transportWebUI || launcher.last.AccountRef != codexAccountRef {
		t.Fatalf("launcher request = %+v, want webui 传输与账号引用", launcher.last)
	}
}

func TestServeHTTPLaunchesDesktopOnHost(t *testing.T) {
	launcher := &stubLauncher{result: Result{OK: true, Status: "launched", PID: intPointer(4321)}}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"desktop"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Plan == nil || decoded.Plan.Kind != kindDesktop || decoded.Plan.HarnessID != "codex" {
		t.Fatalf("plan = %+v, want desktop/codex", decoded.Plan)
	}
	if decoded.Plan.Transport != "" {
		t.Fatalf("desktop plan.transport = %q, want 空", decoded.Plan.Transport)
	}
	if decoded.PID == nil || *decoded.PID != 4321 {
		t.Fatalf("pid = %v, want 4321", decoded.PID)
	}
}

func TestServeHTTPRejectsDesktopOnHeadlessServer(t *testing.T) {
	launcher := &stubLauncher{}
	handler := newTestHandler(t, newDependencies(t, launcher, false))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"desktop"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "desktop_unavailable_on_server" {
		t.Fatalf("error = %q, want desktop_unavailable_on_server", decoded.Error)
	}
	if launcher.calls != 0 {
		t.Fatalf("launcher calls = %d, want 0", launcher.calls)
	}
}

func TestServeHTTPRejectsDesktopNotSupported(t *testing.T) {
	// gemini 只声明 CLI，没有桌面客户端。
	handler := newTestHandler(t, newDependencies(t, &stubLauncher{}, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("gemini", geminiAccountRef), `{"kind":"desktop"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "desktop_not_supported" {
		t.Fatalf("error = %q, want desktop_not_supported", decoded.Error)
	}
}

func TestServeHTTPRejectsCLINotSupported(t *testing.T) {
	// workbuddy 只声明桌面端，不对外分发 CLI。
	catalog := newTestCatalog(t)
	accounts := stubAccounts{byRef: map[string]accountcore.Account{
		codexAccountRef: newTestAccount(t, catalog, codexAccountRef, "workbuddy"),
	}}
	dependencies := newDependencies(t, &stubLauncher{}, true)
	dependencies.Accounts = accounts
	handler := newTestHandler(t, dependencies)

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("workbuddy", codexAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "cli_not_supported" {
		t.Fatalf("error = %q, want cli_not_supported", decoded.Error)
	}
}

func TestServeHTTPRejectsUnsupportedKindAndAction(t *testing.T) {
	handler := newTestHandler(t, newDependencies(t, &stubLauncher{}, true))

	kindRecorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"terminal"}`, "127.0.0.1:5000")
	if kindRecorder.Code != http.StatusBadRequest {
		t.Fatalf("kind status = %d, want 400", kindRecorder.Code)
	}
	if decoded := decodeResponse(t, kindRecorder); decoded.Error != "unsupported_kind" {
		t.Fatalf("error = %q, want unsupported_kind", decoded.Error)
	}

	actionRecorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli","action":"restart"}`, "127.0.0.1:5000")
	if actionRecorder.Code != http.StatusBadRequest {
		t.Fatalf("action status = %d, want 400", actionRecorder.Code)
	}
	if decoded := decodeResponse(t, actionRecorder); decoded.Error != "unsupported_action" {
		t.Fatalf("error = %q, want unsupported_action", decoded.Error)
	}
}

// 请求没带 kind 时按宿主机与 Provider 能力推导。
func TestServeHTTPInfersKindWhenMissing(t *testing.T) {
	desktopLauncher := &stubLauncher{result: Result{OK: true, Status: "launched"}}
	desktopHandler := newTestHandler(t, newDependencies(t, desktopLauncher, true))
	desktopRecorder := doRequest(t, desktopHandler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{}`, "127.0.0.1:5000")
	if desktopRecorder.Code != http.StatusOK {
		t.Fatalf("desktop status = %d, want 200 (body=%s)", desktopRecorder.Code, desktopRecorder.Body.String())
	}
	if decoded := decodeResponse(t, desktopRecorder); decoded.Kind != kindDesktop {
		t.Fatalf("kind = %q, want desktop", decoded.Kind)
	}

	cliLauncher := &stubLauncher{result: Result{OK: true, Status: "launched"}}
	cliHandler := newTestHandler(t, newDependencies(t, cliLauncher, false))
	cliRecorder := doRequest(t, cliHandler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{}`, "127.0.0.1:5000")
	if cliRecorder.Code != http.StatusOK {
		t.Fatalf("cli status = %d, want 200 (body=%s)", cliRecorder.Code, cliRecorder.Body.String())
	}
	if decoded := decodeResponse(t, cliRecorder); decoded.Kind != kindCLI {
		t.Fatalf("kind = %q, want cli", decoded.Kind)
	}
}

func TestServeHTTPMapsInstallRequired(t *testing.T) {
	launcher := &stubLauncher{result: Result{OK: false, Error: "cli_not_installed"}}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli","transport":"native"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if !decoded.InstallRequired || decoded.Error != "install_required" {
		t.Fatalf("response = %+v, want install_required", decoded)
	}
	if decoded.InstallTarget == nil || decoded.InstallTarget.Provider != "codex" ||
		decoded.InstallTarget.Kind != kindCLI || decoded.InstallTarget.AppID != "codex" {
		t.Fatalf("installTarget = %+v, want codex/cli/codex", decoded.InstallTarget)
	}
	if decoded.InstallAvailable == nil || *decoded.InstallAvailable {
		t.Fatalf("installAvailable = %v, want false", decoded.InstallAvailable)
	}
}

func TestServeHTTPMapsLauncherBusinessFailures(t *testing.T) {
	launcher := &stubLauncher{result: Result{OK: false, Error: "account_auth_invalid"}}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli","transport":"native"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Error != "account_auth_invalid" {
		t.Fatalf("error = %q, want account_auth_invalid", decoded.Error)
	}
	if decoded.Message == "" {
		t.Fatal("业务失败必须带可读 message")
	}
}

func TestServeHTTPMapsLauncherError(t *testing.T) {
	launcher := &stubLauncher{err: context.DeadlineExceeded}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "launch_failed" {
		t.Fatalf("error = %q, want launch_failed", decoded.Error)
	}
}

func TestServeHTTPKeepsNativeTransportForLoopbackDesktop(t *testing.T) {
	launcher := &stubLauncher{result: Result{OK: true, Status: "launched"}}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), `{"kind":"cli"}`, "127.0.0.1:5000")

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Plan == nil || decoded.Plan.Transport != transportNative {
		t.Fatalf("plan.transport = %+v, want native", decoded.Plan)
	}
	// 客户端没带 sessionKey 且走原生窗口时不生成 Web 会话键。
	if decoded.SessionKey != "" {
		t.Fatalf("sessionKey = %q, want 空", decoded.SessionKey)
	}
}

// 经代理或跨机访问时，即使宿主有桌面也只能开 Web Terminal。
func TestServeHTTPDowngradesProxiedRequestToWebTerminal(t *testing.T) {
	launcher := &stubLauncher{result: Result{OK: true, Status: "launched"}}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	request := httptest.NewRequest(http.MethodPost,
		openAppTarget("codex", codexAccountRef), strings.NewReader(`{"kind":"cli"}`))
	request.RemoteAddr = "127.0.0.1:5000"
	request.Header.Set("x-forwarded-for", "10.0.0.8")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Plan == nil || decoded.Plan.Transport != transportWebUI {
		t.Fatalf("plan.transport = %+v, want webui", decoded.Plan)
	}
}

func TestServeHTTPLaunchesExternalHarness(t *testing.T) {
	launcher := &stubLauncher{result: Result{OK: true, Status: "launched", LaunchMode: "webui-pty", SessionKey: "account-cli:pi"}}
	handler := newTestHandler(t, newDependencies(t, launcher, false))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef),
		"{\"kind\":\"cli\",\"harness\":\"pi\",\"model\":\"gpt-5\"}", "127.0.0.1:5000")

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if decoded.Plan == nil {
		t.Fatal("成功响应必须带启动计划")
	}
	if decoded.Plan.HarnessID != "pi" || decoded.Plan.HarnessKind != "external" {
		t.Fatalf("plan = %+v, want external pi", decoded.Plan)
	}
	if decoded.Plan.ManagedAppID != "pi" || decoded.Plan.BinaryName != "pi" {
		t.Fatalf("plan = %+v, want managedAppId/binaryName pi", decoded.Plan)
	}
	if !decoded.Plan.CrossProvider || decoded.Plan.IdentityProvider != "codex" {
		t.Fatalf("plan = %+v, want 跨 Provider 且身份仍是 codex", decoded.Plan)
	}
	if launcher.calls != 1 || launcher.last.Harness != "pi" || launcher.last.HarnessKind != "external" {
		t.Fatalf("launcher request = %+v", launcher.last)
	}
}

func TestServeHTTPRejectsCrossProviderNativeHarnessWithoutRelayProfile(t *testing.T) {
	launcher := &stubLauncher{}
	handler := newTestHandler(t, newDependencies(t, launcher, false))

	// gemini 声明了 CLI，但没有跨 Provider relay profile：以 codex 身份启动必须拒绝。
	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef),
		"{\"kind\":\"cli\",\"harness\":\"gemini\"}", "127.0.0.1:5000")

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (body=%s)", recorder.Code, recorder.Body.String())
	}
	if decoded := decodeResponse(t, recorder); decoded.Error != "cross_provider_relay_unsupported" {
		t.Fatalf("error = %q, want cross_provider_relay_unsupported", decoded.Error)
	}
	if launcher.calls != 0 {
		t.Fatalf("launcher calls = %d, want 0", launcher.calls)
	}
}

func TestServeHTTPPassesInstallAvailabilityFromLauncher(t *testing.T) {
	available := true
	launcher := &stubLauncher{result: Result{
		OK:               false,
		Error:            "cli_not_installed",
		Message:          "未检测到原生 CLI，请确认后开始安装。",
		InstallRequired:  true,
		InstallTarget:    &InstallTarget{Provider: "codex", Kind: kindCLI, AppID: "codex"},
		InstallAvailable: &available,
	}}
	handler := newTestHandler(t, newDependencies(t, launcher, true))

	recorder := doRequest(t, handler, http.MethodPost,
		openAppTarget("codex", codexAccountRef), "{\"kind\":\"cli\"}", "127.0.0.1:5000")

	if recorder.Code != http.StatusPreconditionRequired {
		t.Fatalf("status = %d, want 428 (body=%s)", recorder.Code, recorder.Body.String())
	}
	decoded := decodeResponse(t, recorder)
	if !decoded.InstallRequired || decoded.InstallTarget == nil || decoded.InstallTarget.AppID != "codex" {
		t.Fatalf("install = %+v, want codex", decoded)
	}
	if decoded.InstallAvailable == nil || *decoded.InstallAvailable != true {
		t.Fatalf("installAvailable = %v, want true", decoded.InstallAvailable)
	}
}
func intPointer(value int) *int { return &value }
