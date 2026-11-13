package webuiproviderhooksapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func newInstallTestHandler(t *testing.T, hostHomeDir string) http.Handler {
	t.Helper()
	handler, err := NewInstallHandler(InstallDependencies{
		Authorizer:  fakeAuthorizer{allowed: true},
		Catalog:     newCatalog(t),
		HostHomeDir: hostHomeDir,
	})
	if err != nil {
		t.Fatalf("NewInstallHandler() error = %v", err)
	}
	return handler
}

func postInstall(t *testing.T, handler http.Handler, payload string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, InstallPath, strings.NewReader(payload))
	handler.ServeHTTP(recorder, request)
	var body map[string]any
	if recorder.Body.Len() > 0 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode %q: %v", recorder.Body.String(), err)
		}
	}
	return recorder, body
}

func firstInstallResult(t *testing.T, body map[string]any) map[string]any {
	t.Helper()
	results, ok := body["results"].([]any)
	if !ok || len(results) == 0 {
		t.Fatalf("results = %#v", body["results"])
	}
	result, ok := results[0].(map[string]any)
	if !ok {
		t.Fatalf("result = %#v", results[0])
	}
	return result
}

func readFileText(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return string(raw)
}

func decodeJSONFile(t *testing.T, path string) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal([]byte(readFileText(t, path)), &payload); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return payload
}

func installMetadata() map[string]any {
	return map[string]any{
		"receiverUrl":      "http://127.0.0.1:9999/hook",
		"senderScriptPath": "/opt/aih/sender.js",
		"codexVersion":     "0.158.0",
	}
}

func installPayload(t *testing.T, values map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(values)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	return string(raw)
}

func codexInstallPayload(t *testing.T, extra map[string]any) string {
	t.Helper()
	values := installMetadata()
	values["provider"] = "codex"
	for key, value := range extra {
		values[key] = value
	}
	return installPayload(t, values)
}

// TestInstallRejectsMissingConfirmationAndProvider 锁住 Node 的两条前置校验。
func TestInstallRejectsMissingConfirmationAndProvider(t *testing.T) {
	handler := newInstallTestHandler(t, t.TempDir())

	recorder, body := postInstall(t, handler, `{"providers":["codex"]}`)
	if recorder.Code != http.StatusBadRequest || body["error"] != "confirm_required" {
		t.Fatalf("confirm = %d %#v", recorder.Code, body)
	}

	recorder, body = postInstall(t, handler, `{"confirm":true}`)
	if recorder.Code != http.StatusBadRequest || body["error"] != "provider_required" {
		t.Fatalf("provider = %d %#v", recorder.Code, body)
	}

	recorder, body = postInstall(t, handler, `not-json`)
	if recorder.Code != http.StatusBadRequest || body["error"] != "invalid_payload" {
		t.Fatalf("json = %d %#v", recorder.Code, body)
	}
}

// TestInstallCodexWritesHooksAndFeatureFlag 覆盖 json_hooks + codex config.toml 开关。
func TestInstallCodexWritesHooksAndFeatureFlag(t *testing.T) {
	home := t.TempDir()
	codexDir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(codexDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	configPath := filepath.Join(codexDir, "config.toml")
	lineFeed := string(rune(10))
	if err := os.WriteFile(configPath, []byte("[features]"+lineFeed+"codex_hooks = false"+lineFeed), 0o644); err != nil {
		t.Fatalf("seed config: %v", err)
	}
	handler := newInstallTestHandler(t, home)

	recorder, body := postInstall(t, handler, codexInstallPayload(t, map[string]any{"dryRun": true}))
	if recorder.Code != http.StatusOK || body["ok"] != true {
		t.Fatalf("dryRun = %d %#v", recorder.Code, body)
	}
	result := firstInstallResult(t, body)
	if result["changed"] != true || result["targetKind"] != "hooks.json" {
		t.Fatalf("dryRun result = %#v", result)
	}
	if _, err := os.Stat(filepath.Join(codexDir, "hooks.json")); !os.IsNotExist(err) {
		t.Fatalf("dryRun 不应写 hooks.json: %v", err)
	}
	features, ok := result["codexFeatures"].(map[string]any)
	if !ok || features["changed"] != true || features["flagName"] != "hooks" {
		t.Fatalf("codexFeatures = %#v", result["codexFeatures"])
	}

	recorder, body = postInstall(t, handler, codexInstallPayload(t, map[string]any{"confirm": true}))
	if recorder.Code != http.StatusOK || body["ok"] != true {
		t.Fatalf("install = %d %#v", recorder.Code, body)
	}
	hooksPath := filepath.Join(codexDir, "hooks.json")
	hooksText := readFileText(t, hooksPath)
	if !strings.Contains(hooksText, managedHookMarker) {
		t.Fatalf("hooks.json 缺少托管标记: %s", hooksText)
	}
	hooks := objectValue(t, decodeJSONFile(t, hooksPath)["hooks"])
	sessionGroups := arrayValue(t, hooks["SessionStart"])
	group := objectValue(t, sessionGroups[0])
	if group["matcher"] != "startup|resume|clear|compact" {
		t.Fatalf("SessionStart matcher = %#v", group["matcher"])
	}
	handlers := arrayValue(t, group["hooks"])
	handlerPayload := objectValue(t, handlers[0])
	if handlerPayload["timeout"] != float64(10) {
		t.Fatalf("timeout = %#v", handlerPayload["timeout"])
	}
	command, _ := handlerPayload["command"].(string)
	for _, want := range []string{
		managedHookMarker,
		"--provider 'codex'",
		"--event 'SessionStart'",
		"http://127.0.0.1:9999/hook?provider=codex&event=SessionStart",
	} {
		if !strings.Contains(command, want) {
			t.Fatalf("command 缺少 %q: %s", want, command)
		}
	}
	if !strings.Contains(readFileText(t, configPath), "hooks = true") {
		t.Fatalf("config.toml 未打开 hooks 开关: %s", readFileText(t, configPath))
	}

	recorder, body = postInstall(t, handler, codexInstallPayload(t, map[string]any{"confirm": true}))
	if recorder.Code != http.StatusOK {
		t.Fatalf("reinstall = %d %#v", recorder.Code, body)
	}
	if firstInstallResult(t, body)["changed"] != false {
		t.Fatalf("第二次安装应幂等: %#v", firstInstallResult(t, body))
	}
}

func objectValue(t *testing.T, value any) map[string]any {
	t.Helper()
	object, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("不是对象: %#v", value)
	}
	return object
}

func arrayValue(t *testing.T, value any) []any {
	t.Helper()
	array, ok := value.([]any)
	if !ok || len(array) == 0 {
		t.Fatalf("不是非空数组: %#v", value)
	}
	return array
}

// TestInstallPreservesUserHooks 锁住「只撤销 AIH 托管 handler」。
func TestInstallPreservesUserHooks(t *testing.T) {
	home := t.TempDir()
	claudeDir := filepath.Join(home, ".claude")
	if err := os.MkdirAll(claudeDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	settingsPath := filepath.Join(claudeDir, "settings.json")
	seed, err := json.Marshal(map[string]any{
		"theme": "dark",
		"hooks": map[string]any{
			"Stop": []any{
				map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "echo user"}}},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal seed: %v", err)
	}
	if err := os.WriteFile(settingsPath, seed, 0o644); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
	handler := newInstallTestHandler(t, home)

	values := installMetadata()
	values["provider"] = "claude"
	values["confirm"] = true
	recorder, body := postInstall(t, handler, installPayload(t, values))
	if recorder.Code != http.StatusOK {
		t.Fatalf("install = %d %#v", recorder.Code, body)
	}
	if firstInstallResult(t, body)["changed"] != true {
		t.Fatalf("首次安装应报告 changed: %#v", firstInstallResult(t, body))
	}
	parsed := decodeJSONFile(t, settingsPath)
	if parsed["theme"] != "dark" {
		t.Fatalf("theme 被改: %#v", parsed["theme"])
	}
	text := readFileText(t, settingsPath)
	if !strings.Contains(text, "echo user") {
		t.Fatalf("用户 hook 被删除: %s", text)
	}
	if strings.Count(text, managedHookMarker) != 7 {
		t.Fatalf("托管 handler 数量不对: %s", text)
	}

	recorder, body = postInstall(t, handler, installPayload(t, values))
	if recorder.Code != http.StatusOK {
		t.Fatalf("reinstall = %d %#v", recorder.Code, body)
	}
	if firstInstallResult(t, body)["changed"] != false {
		t.Fatalf("第二次安装应幂等: %#v", firstInstallResult(t, body))
	}
}

// TestInstallAgyNamedHook 覆盖 agy_named_hooks 的具名对象形状。
func TestInstallAgyNamedHook(t *testing.T) {
	home := t.TempDir()
	handler := newInstallTestHandler(t, home)
	values := installMetadata()
	values["provider"] = "agy"
	values["confirm"] = true
	recorder, body := postInstall(t, handler, installPayload(t, values))
	if recorder.Code != http.StatusOK {
		t.Fatalf("install = %d %#v", recorder.Code, body)
	}
	parsed := decodeJSONFile(t, filepath.Join(home, ".gemini", "config", "hooks.json"))
	hook := objectValue(t, parsed[agyManagedHookName])
	if hook["enabled"] != true {
		t.Fatalf("agy hook 未启用: %#v", hook)
	}
	if _, exists := hook["PreInvocation"]; !exists {
		t.Fatalf("agy hook 缺少 PreInvocation: %#v", hook)
	}
}

// TestInstallOpenCodePlugin 覆盖插件桥文件写入与接收地址。
func TestInstallOpenCodePlugin(t *testing.T) {
	home := t.TempDir()
	configDir := filepath.Join(home, "opencode-config")
	t.Setenv("OPENCODE_CONFIG_DIR", configDir)
	handler := newInstallTestHandler(t, home)
	values := installMetadata()
	values["provider"] = "opencode"
	values["confirm"] = true
	recorder, body := postInstall(t, handler, installPayload(t, values))
	if recorder.Code != http.StatusOK {
		t.Fatalf("install = %d %#v", recorder.Code, body)
	}
	text := readFileText(t, filepath.Join(configDir, "plugin", "aih-session-hook.js"))
	for _, want := range []string{"http://127.0.0.1:9999/hook", "export default", "ctx.event.subscribe"} {
		if !strings.Contains(text, want) {
			t.Fatalf("opencode 插件缺少 %q", want)
		}
	}
}

// TestInstallUnsupportedProvider 如实报告合同没有 Hook 的 Provider。
func TestInstallUnsupportedProvider(t *testing.T) {
	handler := newInstallTestHandler(t, t.TempDir())
	recorder, body := postInstall(t, handler, `{"provider":"qoder","confirm":true}`)
	if recorder.Code != http.StatusBadRequest || body["ok"] != false {
		t.Fatalf("unsupported = %d %#v", recorder.Code, body)
	}
	if firstInstallResult(t, body)["error"] != "unsupported_provider" {
		t.Fatalf("result = %#v", firstInstallResult(t, body))
	}
}

func TestInstallMethodAndAuth(t *testing.T) {
	home := t.TempDir()
	handler := newInstallTestHandler(t, home)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, InstallPath, nil))
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("GET = %d", recorder.Code)
	}

	unauthorized, err := NewInstallHandler(InstallDependencies{
		Authorizer: fakeAuthorizer{}, Catalog: newCatalog(t), HostHomeDir: home,
	})
	if err != nil {
		t.Fatalf("NewInstallHandler() error = %v", err)
	}
	recorder = httptest.NewRecorder()
	unauthorized.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, InstallPath, strings.NewReader(`{}`)))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized = %d", recorder.Code)
	}
}
