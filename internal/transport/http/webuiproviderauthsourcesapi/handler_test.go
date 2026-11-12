package webuiproviderauthsourcesapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

// stubAuthorizer 是鉴权策略替身。
type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

// newTestHandler 构造一个只依赖测试注入的 Handler：
// lookPath 默认恒失败、固定落点目录清空，避免测试受真实宿主安装影响。
func newTestHandler(t *testing.T, hostHomeDir string, lookPath func(string) (string, error)) *Handler {
	t.Helper()
	return newTestHandlerWithDependencies(t, Dependencies{
		HostHomeDir: hostHomeDir, LookPath: lookPath,
	})
}

// newTestHandlerWithDependencies 在默认替身之上叠加调用方声明的端口。
func newTestHandlerWithDependencies(t *testing.T, dependencies Dependencies) *Handler {
	t.Helper()
	if dependencies.Authorizer == nil {
		dependencies.Authorizer = stubAuthorizer{allowed: true}
	}
	if dependencies.LookPath == nil {
		dependencies.LookPath = func(string) (string, error) { return "", errors.New("not found") }
	}
	built, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	handler, ok := built.(*Handler)
	if !ok {
		t.Fatalf("NewHandler 返回 %T，期望 *Handler", built)
	}
	handler.searchDirs = nil
	return handler
}

// request 发起一次请求并返回响应。
func request(t *testing.T, handler http.Handler, method, target string) *httptest.ResponseRecorder {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(method, target, nil))
	return recorder
}

// decode 解出响应体。
func decode(t *testing.T, recorder *httptest.ResponseRecorder) responseView {
	t.Helper()
	var payload responseView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v，body=%s", err, recorder.Body.String())
	}
	return payload
}

// writeFile 在宿主 HOME 下写一个文件（内容无关，测试只关心存在性）。
func writeFile(t *testing.T, root string, segments ...string) string {
	t.Helper()
	path := filepath.Join(append([]string{root}, segments...)...)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatalf("建目录失败: %v", err)
	}
	if err := os.WriteFile(path, []byte("{}\n"), 0o600); err != nil {
		t.Fatalf("写文件失败: %v", err)
	}
	return path
}

// methodByAuthMode 取某个认证方式的视图。
func methodByAuthMode(t *testing.T, payload responseView, authMode string) methodView {
	t.Helper()
	for _, method := range payload.Methods {
		if method.AuthMode == authMode {
			return method
		}
	}
	t.Fatalf("响应里没有认证方式 %q：%+v", authMode, payload.Methods)
	return methodView{}
}

// sourceByID 取某个来源的视图。
func sourceByID(t *testing.T, method methodView, id string) sourceView {
	t.Helper()
	for _, source := range method.Sources {
		if source.ID == id {
			return source
		}
	}
	t.Fatalf("认证方式 %q 里没有来源 %q：%+v", method.AuthMode, id, method.Sources)
	return sourceView{}
}

func TestNewHandlerRejectsMissingAuthorizer(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("err = %v，期望 ErrInvalidDependencies", err)
	}
}

func TestRequiresManagementKey(t *testing.T) {
	built, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: false}})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := request(t, built, http.MethodGet, Path+"?provider=claude")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，期望 401", recorder.Code)
	}
	if got := recorder.Header().Get("WWW-Authenticate"); got != "Bearer" {
		t.Errorf("WWW-Authenticate = %q，期望 Bearer", got)
	}
	var payload errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if payload.OK || payload.Error != "unauthorized" {
		t.Errorf("error = %+v，期望 ok=false/unauthorized", payload)
	}
}

func TestRejectsNonGet(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	recorder := request(t, handler, http.MethodPost, Path+"?provider=claude")
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d，期望 405", recorder.Code)
	}
	if got := recorder.Header().Get("Allow"); got != http.MethodGet {
		t.Errorf("Allow = %q，期望 GET", got)
	}
	var payload errorView
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if payload.Error != "method_not_allowed" {
		t.Errorf("error = %q，期望 method_not_allowed", payload.Error)
	}
}

func TestMissingProvider(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	for _, target := range []string{Path, Path + "?provider=", Path + "?provider=%20%20"} {
		recorder := request(t, handler, http.MethodGet, target)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d，期望 400", target, recorder.Code)
		}
		var payload errorView
		if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
			t.Fatalf("解析响应失败: %v", err)
		}
		if payload.Error != "missing_provider" {
			t.Errorf("%s: error = %q，期望 missing_provider", target, payload.Error)
		}
	}
}

func TestUnknownProviderIsUnsupported(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	recorder := request(t, handler, http.MethodGet, Path+"?provider=no-such-provider")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200", recorder.Code)
	}
	payload := decode(t, recorder)
	if !payload.OK || payload.Supported {
		t.Fatalf("ok/supported = %v/%v，期望 true/false", payload.OK, payload.Supported)
	}
	if payload.Provider != "no-such-provider" {
		t.Errorf("provider = %q，期望原样回显归一后的 id", payload.Provider)
	}
	if len(payload.Methods) != 0 {
		t.Errorf("methods = %+v，期望空数组", payload.Methods)
	}
	// 空数组必须序列化成 []，不能是 null：调用方按数组消费。
	raw := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	if methods, ok := raw["methods"].([]any); !ok || len(methods) != 0 {
		t.Errorf("methods 原始值 = %#v，期望空数组", raw["methods"])
	}
}

func TestProviderIDIsNormalized(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=%20CLAUDE%20"))
	if payload.Provider != "claude" {
		t.Fatalf("provider = %q，期望 claude", payload.Provider)
	}
	if !payload.Supported || len(payload.Methods) != 1 {
		t.Fatalf("supported/methods = %v/%+v，期望 true 且恰好一个认证方式", payload.Supported, payload.Methods)
	}
}

func TestHostAuthArtifactMissing(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
	if !payload.Supported {
		t.Fatalf("supported = false，claude 有宿主凭据产物，应当支持")
	}
	method := methodByAuthMode(t, payload, string(mustAuthMode(t, "claude")))
	source := sourceByID(t, method, "claude-host-local")
	if source.Available {
		t.Fatalf("available = true，凭据文件不存在时不该判可用")
	}
	if !source.Installable {
		t.Errorf("installable = false，claude 合同声明了可分发的 CLI 包，应当判可安装")
	}
	if source.Reason != reasonClientNotInstalled {
		t.Errorf("reason = %q，期望 %q", source.Reason, reasonClientNotInstalled)
	}
	if method.PreferredSourceID != "" {
		t.Errorf("preferredSourceId = %q，期望空", method.PreferredSourceID)
	}
	if method.InstallableSourceID != "claude-host-local" {
		t.Errorf("installableSourceId = %q，期望 claude-host-local", method.InstallableSourceID)
	}
	if method.LocalSourceAvailable {
		t.Errorf("localSourceAvailable = true，期望 false")
	}
}

func TestHostAuthArtifactPresent(t *testing.T) {
	hostHomeDir := t.TempDir()
	writeFile(t, hostHomeDir, ".claude", ".credentials.json")
	handler := newTestHandler(t, hostHomeDir, nil)
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude"))
	method := methodByAuthMode(t, payload, "oauth-browser")
	source := sourceByID(t, method, "claude-host-local")
	if !source.Available || source.Reason != "" {
		t.Fatalf("available/reason = %v/%q，期望 true/空", source.Available, source.Reason)
	}
	if !source.DirectImport || source.Kind != kindLocal || source.RequiresApp != appCLI {
		t.Errorf("来源声明不符：%+v", source)
	}
	if method.PreferredSourceID != "claude-host-local" || !method.LocalSourceAvailable {
		t.Errorf("preferred/local = %q/%v，期望 claude-host-local/true", method.PreferredSourceID, method.LocalSourceAvailable)
	}
	if source.Installable || method.InstallableSourceID != "" {
		t.Errorf("installable/installableSourceId = %v/%q，来源可用时不该再给安装方案",
			source.Installable, method.InstallableSourceID)
	}
	// implementation 在 Node 里是函数句柄，Go 恒为 null（键必须存在）。
	raw := map[string]any{}
	if err := json.Unmarshal(request(t, handler, http.MethodGet, Path+"?provider=claude").Body.Bytes(), &raw); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	methods := raw["methods"].([]any)
	sources := methods[0].(map[string]any)["sources"].([]any)
	implementation, present := sources[0].(map[string]any)["implementation"]
	if !present || implementation != nil {
		t.Errorf("implementation = %#v（present=%v），期望存在且为 null", implementation, present)
	}
}

func TestOptionalArtifactDoesNotCountAsLoginState(t *testing.T) {
	// gemini 的必选产物是 oauth_creds.json，google_accounts.json 是可选产物。
	hostHomeDir := t.TempDir()
	writeFile(t, hostHomeDir, ".gemini", "google_accounts.json")
	handler := newTestHandler(t, hostHomeDir, nil)
	source := sourceByID(t, methodByAuthMode(t, decode(t, request(t, handler, http.MethodGet, Path+"?provider=gemini")), "oauth-browser"), "gemini-host-local")
	if source.Available {
		t.Fatalf("available = true，必选产物缺失时不该判可用")
	}

	writeFile(t, hostHomeDir, ".gemini", "oauth_creds.json")
	source = sourceByID(t, methodByAuthMode(t, decode(t, request(t, handler, http.MethodGet, Path+"?provider=gemini")), "oauth-browser"), "gemini-host-local")
	if !source.Available {
		t.Fatalf("available = false，必选产物存在、可选产物缺失时应判可用")
	}
}

func TestCredentialFileExistsButUnreadable(t *testing.T) {
	// 只判存在性：文件不可读也必须判可用（读内容算指纹不属于本包边界）。
	hostHomeDir := t.TempDir()
	path := writeFile(t, hostHomeDir, ".codex", "auth.json")
	if err := os.Chmod(path, 0o000); err != nil {
		t.Fatalf("改权限失败: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	if _, err := os.ReadFile(path); err == nil {
		t.Skip("当前用户仍可读该文件（可能以 root 运行），本用例无意义")
	}
	handler := newTestHandler(t, hostHomeDir, nil)
	source := sourceByID(t, methodByAuthMode(t, decode(t, request(t, handler, http.MethodGet, Path+"?provider=codex")), "oauth-browser"), "codex-host-local")
	if !source.Available {
		t.Fatalf("available = false，凭据文件存在但不可读时仍应判可用")
	}
}

func TestHostHomeUnknownHidesLocalSource(t *testing.T) {
	handler := newTestHandler(t, "", nil)
	source := sourceByID(t, methodByAuthMode(t, decode(t, request(t, handler, http.MethodGet, Path+"?provider=claude")), "oauth-browser"), "claude-host-local")
	if source.Available {
		t.Fatalf("available = true，宿主 HOME 未知时不该判可用")
	}
}

func TestCLIProbeForHostScanSources(t *testing.T) {
	hostHomeDir := t.TempDir()
	found := newTestHandler(t, hostHomeDir, func(name string) (string, error) {
		if name == "cline" {
			return "/fake/cline", nil
		}
		return "", errors.New("not found")
	})
	source := sourceByID(t, methodByAuthMode(t, decode(t, request(t, found, http.MethodGet, Path+"?provider=cline")), "oauth-browser"), "cline-host-scan")
	if !source.Available {
		t.Fatalf("available = false，LookPath 命中时应判可用")
	}
	if source.Handler != "host-account-scan" || source.DirectImport {
		t.Errorf("来源声明不符：%+v", source)
	}

	missing := newTestHandler(t, hostHomeDir, nil)
	source = sourceByID(t, methodByAuthMode(t, decode(t, request(t, missing, http.MethodGet, Path+"?provider=cline")), "oauth-browser"), "cline-host-scan")
	if source.Available {
		t.Fatalf("available = true，CLI 不在 PATH 也不在落点目录时不该判可用")
	}
	// cline 合同声明了可分发的 CLI 包：没装但有安装方案。
	if !source.Installable || source.Reason != reasonClientNotInstalled {
		t.Errorf("installable/reason = %v/%q，期望 true/%q",
			source.Installable, source.Reason, reasonClientNotInstalled)
	}
}

func TestCodeBuddyFamilyUsesSharedScanSource(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	for _, provider := range []string{"codebuddy", "codebuddycn", "workbuddy", "workbuddycn"} {
		payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider="+provider))
		method := methodByAuthMode(t, payload, "oauth-browser")
		source := sourceByID(t, method, provider+"-host-scan")
		if source.Description != familyHostScanDescription {
			t.Errorf("%s: description = %q", provider, source.Description)
		}
		if source.Available {
			t.Errorf("%s: available = true，CLI 未安装时不该判可用", provider)
		}
	}
}

func TestKiroSourcesWithoutIDELogin(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), nil)
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=kiro"))
	if len(payload.Methods) != 2 {
		t.Fatalf("methods = %+v，期望两个认证方式", payload.Methods)
	}
	// 设备码两条可用且不依赖客户端，排在前面。
	if payload.Methods[0].AuthMode != "oauth-device" {
		t.Fatalf("methods[0] = %q，期望 oauth-device", payload.Methods[0].AuthMode)
	}
	device := payload.Methods[0]
	if device.PreferredSourceID != "kiro-device-code" {
		t.Errorf("preferredSourceId = %q，期望 kiro-device-code", device.PreferredSourceID)
	}
	if got := []string{device.Sources[0].ID, device.Sources[1].ID}; got[0] != "kiro-device-code" || got[1] != "kiro-social-device-code" {
		t.Errorf("sources = %v，期望按 id 稳定序", got)
	}
	if device.LocalSourceAvailable {
		t.Errorf("localSourceAvailable = true，期望 false")
	}

	refresh := methodByAuthMode(t, payload, "oauth-refresh-token")
	ide := sourceByID(t, refresh, "kiro-ide-local")
	if ide.Available {
		t.Fatalf("kiro-ide-local available = true，IDE 登录态不存在时不该判可用")
	}
	// 桌面端的可安装性取决于合同有没有为该平台声明安装落点（macOS 有，其它平台没有），
	// 这里按同一判定取期望值，锁的是「有方案 → client_not_installed，没有 → client_unavailable」
	// 这条 Node 的 reason 阶梯。
	kiroDefinition, known := handler.catalog.Get("kiro")
	if !known {
		t.Fatalf("kiro 不在内置合同里")
	}
	expectedReason := reasonClientUnavailable
	if installableFromContract(kiroDefinition, appDesktop) {
		expectedReason = reasonClientNotInstalled
	}
	if ide.RequiresApp != appDesktop || ide.Reason != expectedReason {
		t.Errorf("requiresApp/reason = %q/%q，期望 %q", ide.RequiresApp, ide.Reason, expectedReason)
	}
	if refresh.PreferredSourceID != "kiro-paste-token" {
		t.Errorf("preferredSourceId = %q，期望回落到 kiro-paste-token", refresh.PreferredSourceID)
	}
	if refresh.LocalSourceAvailable {
		t.Errorf("localSourceAvailable = true，期望 false")
	}
}

func TestKiroSourcesWithIDELogin(t *testing.T) {
	hostHomeDir := t.TempDir()
	writeFile(t, hostHomeDir, ".aws", "sso", "cache", "kiro-auth-token.json")
	handler := newTestHandler(t, hostHomeDir, nil)
	payload := decode(t, request(t, handler, http.MethodGet, Path+"?provider=kiro"))
	// 本机来源可用 → 本机来源优先，认证方式顺序也跟着变。
	if payload.Methods[0].AuthMode != "oauth-refresh-token" {
		t.Fatalf("methods[0] = %q，期望 oauth-refresh-token（本机来源优先）", payload.Methods[0].AuthMode)
	}
	refresh := payload.Methods[0]
	if refresh.Sources[0].ID != "kiro-ide-local" {
		t.Errorf("sources[0] = %q，期望 kiro-ide-local", refresh.Sources[0].ID)
	}
	if refresh.PreferredSourceID != "kiro-ide-local" || !refresh.LocalSourceAvailable {
		t.Errorf("preferred/local = %q/%v，期望 kiro-ide-local/true", refresh.PreferredSourceID, refresh.LocalSourceAvailable)
	}
	device := methodByAuthMode(t, payload, "oauth-device")
	if !device.Sources[0].Available || !device.Sources[1].Available {
		t.Errorf("设备码来源应当恒可用：%+v", device.Sources)
	}
}

// mustAuthMode 返回 Provider 声明里应当被选中的宿主来源认证方式。
func mustAuthMode(t *testing.T, provider string) providers.AuthMode {
	t.Helper()
	handler := newTestHandler(t, t.TempDir(), nil)
	definition, ok := handler.catalog.Get(provider)
	if !ok {
		t.Fatalf("Provider %q 不在内置合同里", provider)
	}
	return providers.AuthMode(defaultHostAuthMode(definition))
}
