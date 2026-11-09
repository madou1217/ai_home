package webuitoolsettingsapi

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

func newTestCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("创建 Provider Catalog 失败: %v", err)
	}
	return catalog
}

func newTestHandler(t *testing.T, aiHomeDir string, home string) *Handler {
	t.Helper()
	source, err := OpenSettingsSource(aiHomeDir)
	if err != nil {
		t.Fatalf("打开设置数据源失败: %v", err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer:  allowAll{},
		Providers:   newTestCatalog(t),
		Settings:    source,
		HostHomeDir: home,
	})
	if err != nil {
		t.Fatalf("创建 Handler 失败: %v", err)
	}
	return handler
}

// requestSettings 用真实的 mux 模式发请求：路由注册形态（{appId} 通配 + 只挂 GET）
// 也是这份契约的一部分，直接调 handler 会漏掉它。
func requestSettings(t *testing.T, handler http.Handler, appID string) *httptest.ResponseRecorder {
	t.Helper()
	mux := http.NewServeMux()
	mux.Handle("GET "+Path+"/{appId}/settings", handler)
	request := httptest.NewRequest(http.MethodGet, Path+"/"+appID+"/settings", nil)
	recorder := httptest.NewRecorder()
	mux.ServeHTTP(recorder, request)
	return recorder
}

func decodeSettings(t *testing.T, recorder *httptest.ResponseRecorder) settingsResponse {
	t.Helper()
	var payload settingsResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func writeAppStateSettings(t *testing.T, aiHomeDir string, value string) {
	t.Helper()
	dbPath := filepath.Join(aiHomeDir, appStateDatabaseFileName)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("打开测试数据库失败: %v", err)
	}
	defer func() { _ = db.Close() }()
	if _, err := db.Exec(`CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`); err != nil {
		t.Fatalf("创建 app_kv 失败: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, 0)`,
		toolPermissionSettingsKey, value,
	); err != nil {
		t.Fatalf("写入设置记录失败: %v", err)
	}
}

// TestSettingsMissingFallsBackToDefaults：全新数据根（没有 app-state.db）不是错误，
// 设置与 capability 仍要完整返回，前端照常渲染。
func TestSettingsMissingFallsBackToDefaults(t *testing.T) {
	aiHomeDir := t.TempDir()
	home := t.TempDir()
	handler := newTestHandler(t, aiHomeDir, home)

	recorder := requestSettings(t, handler, "codex")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200 (%s)", recorder.Code, recorder.Body.String())
	}
	payload := decodeSettings(t, recorder)
	if !payload.OK || payload.AppID != "codex" || payload.Provider != "codex" {
		t.Fatalf("响应信封不符: %+v", payload)
	}
	if payload.Label != "ChatGPT" {
		t.Fatalf("label = %q, 期望 ChatGPT", payload.Label)
	}
	if !payload.Settings.MaxPermission || payload.Settings.ApplyToHost ||
		payload.Settings.PermissionArgs == nil || len(payload.Settings.PermissionArgs) != 0 ||
		payload.Settings.UpdatedAt != 0 {
		t.Fatalf("默认设置不符: %+v", payload.Settings)
	}
	capability := payload.Capability
	if !capability.MaxSupported {
		t.Fatalf("codex 应支持最大权限: %+v", capability)
	}
	if len(capability.MaxArgs) != 4 ||
		capability.MaxArgs[0] != "--sandbox" || capability.MaxArgs[1] != "danger-full-access" ||
		capability.MaxArgs[2] != "--ask-for-approval" || capability.MaxArgs[3] != "never" {
		t.Fatalf("maxArgs 不符: %+v", capability.MaxArgs)
	}
	if capability.PermissionCatalog.VerifiedCliVersion != "0.163.0" {
		t.Fatalf("目录版本不符: %+v", capability.PermissionCatalog)
	}
	if !capability.HostSupported || capability.HostFileID != "config" {
		t.Fatalf("codex 宿主配置应可写: %+v", capability)
	}
	expectPath := "~" + string(filepath.Separator) + filepath.Join(".codex", "config.toml")
	if capability.HostDisplayPath != expectPath {
		t.Fatalf("hostDisplayPath = %q, 期望 %q", capability.HostDisplayPath, expectPath)
	}
	if capability.HostExists {
		t.Fatalf("临时 HOME 下配置文件不应存在: %+v", capability)
	}
	if !capability.HostWritable || capability.HostRequiresElevation {
		t.Fatalf("临时 HOME 下应可写且不需要提权: %+v", capability)
	}
}

// TestSettingsReadFromAppState：设置必须来自 Node 写入的同一张 app_kv 表、同一个键。
func TestSettingsReadFromAppState(t *testing.T) {
	aiHomeDir := t.TempDir()
	home := t.TempDir()
	// provider 键故意用大小写混合，验证读取侧与 Node normalizeStore 一样做归一。
	writeAppStateSettings(t, aiHomeDir, `{"version":1,"apps":{"OpenCode":{"maxPermission":false,"applyToHost":false,"permissionArgs":["--auto"],"updatedAt":1730000000000}}}`)
	handler := newTestHandler(t, aiHomeDir, home)

	recorder := requestSettings(t, handler, "opencode")
	if recorder.Code != http.StatusOK {
		t.Fatalf("状态码 = %d, 期望 200 (%s)", recorder.Code, recorder.Body.String())
	}
	payload := decodeSettings(t, recorder)
	if payload.Settings.MaxPermission {
		t.Fatalf("maxPermission 应为 false: %+v", payload.Settings)
	}
	if len(payload.Settings.PermissionArgs) != 1 || payload.Settings.PermissionArgs[0] != "--auto" {
		t.Fatalf("permissionArgs 不符: %+v", payload.Settings)
	}
	if payload.Settings.UpdatedAt != 1730000000000 {
		t.Fatalf("updatedAt 不符: %+v", payload.Settings)
	}
	if payload.Label != "OpenCode" {
		t.Fatalf("label = %q, 期望 OpenCode", payload.Label)
	}
}

// TestSettingsInvalidJSONFallsBackToDefaults：损坏记录按未配置处理（Node bestEffort 语义）。
func TestSettingsInvalidJSONFallsBackToDefaults(t *testing.T) {
	aiHomeDir := t.TempDir()
	home := t.TempDir()
	writeAppStateSettings(t, aiHomeDir, "{not-json")
	handler := newTestHandler(t, aiHomeDir, home)

	payload := decodeSettings(t, requestSettings(t, handler, "claude"))
	if !payload.Settings.MaxPermission || payload.Settings.UpdatedAt != 0 {
		t.Fatalf("损坏记录应回退默认值: %+v", payload.Settings)
	}
}

// TestUnknownProviderIsUnsupportedApp：provider 是否存在只看 core/providers 合同。
func TestUnknownProviderIsUnsupportedApp(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), t.TempDir())
	recorder := requestSettings(t, handler, "not-a-provider")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("状态码 = %d, 期望 400", recorder.Code)
	}
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("错误响应不是合法 JSON: %v", err)
	}
	if payload.OK || payload.Error != "unsupported_app" {
		t.Fatalf("错误码不符: %+v", payload)
	}
}

// TestProviderWithoutHostProfile：没有登记宿主写入字段的 provider 必须明确 hostReason。
func TestProviderWithoutHostProfile(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), t.TempDir())
	payload := decodeSettings(t, requestSettings(t, handler, "gemini"))
	if payload.Capability.HostSupported {
		t.Fatalf("gemini 不应声明宿主写入: %+v", payload.Capability)
	}
	if payload.Capability.HostReason != "host_profile_unsupported" {
		t.Fatalf("hostReason = %q", payload.Capability.HostReason)
	}
}

// TestMenuLabelForMultiSiteFamily：多站点产品的标签必须带站点，单站产品不带后缀。
func TestMenuLabelForMultiSiteFamily(t *testing.T) {
	handler := newTestHandler(t, t.TempDir(), t.TempDir())
	payload := decodeSettings(t, requestSettings(t, handler, "qodercn"))
	if payload.Label != "Qoder · 国内站" {
		t.Fatalf("label = %q, 期望 Qoder · 国内站", payload.Label)
	}
	if payload.Provider != "qodercn" {
		t.Fatalf("provider = %q", payload.Provider)
	}
}

// TestHandlerRejectsWrongMethodAndKey：Go 只提供 GET；鉴权失败不能读数据。
func TestHandlerRejectsWrongMethodAndKey(t *testing.T) {
	source, err := OpenSettingsSource(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	handler, err := NewHandler(Dependencies{
		Authorizer: denyAll{},
		Providers:  newTestCatalog(t),
		Settings:   source,
	})
	if err != nil {
		t.Fatal(err)
	}
	recorder := requestSettings(t, handler, "codex")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("未授权状态码 = %d, 期望 401", recorder.Code)
	}

	authorized, err := NewHandler(Dependencies{
		Authorizer: allowAll{},
		Providers:  newTestCatalog(t),
		Settings:   source,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPut, Path+"/codex/settings", nil)
	request.SetPathValue("appId", "codex")
	wrongMethod := httptest.NewRecorder()
	authorized.ServeHTTP(wrongMethod, request)
	if wrongMethod.Code != http.StatusMethodNotAllowed {
		t.Fatalf("PUT 状态码 = %d, 期望 405", wrongMethod.Code)
	}
}

// TestSettingsSourceMissingAndCorruptFiles：数据源自身对缺失/损坏都要返回默认值。
func TestSettingsSourceMissingAndCorruptFiles(t *testing.T) {
	source, err := OpenSettingsSource(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	settings := source.Read(t.Context(), "codex")
	if !settings.MaxPermission || settings.PermissionArgs == nil {
		t.Fatalf("缺失数据库应返回默认值: %+v", settings)
	}

	brokenDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(brokenDir, appStateDatabaseFileName), []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}
	broken, err := OpenSettingsSource(brokenDir)
	if err != nil {
		t.Fatal(err)
	}
	settings = broken.Read(t.Context(), "codex")
	if !settings.MaxPermission {
		t.Fatalf("损坏数据库应返回默认值: %+v", settings)
	}
}
