package webuitoolappsettingswriteapi

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

// fakeCatalog 只做 ID 归一化查询，模拟 Provider 合同的白名单行为。
type fakeCatalog struct{ ids []string }

func (catalog fakeCatalog) Get(id string) (providers.Definition, bool) {
	for _, candidate := range catalog.ids {
		if strings.EqualFold(candidate, strings.TrimSpace(id)) {
			return providers.Definition{ID: candidate, Presentation: providers.Presentation{Label: candidate}}, true
		}
	}
	return providers.Definition{}, false
}

func newTestCatalog() fakeCatalog { return fakeCatalog{ids: []string{"claude", "codex"}} }

// newTestDatabase 建临时数据根并返回 app-state.db 路径（表由第一次写入创建）。
func newTestDatabase(t *testing.T) string {
	t.Helper()
	databasePath, err := appstate.DatabasePath(t.TempDir())
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	return databasePath
}

func newTestHandler(t *testing.T, databasePath string) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Providers:  newTestCatalog(),
		Store:      DatabaseStore{DatabasePath: databasePath},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// put 发一次 PUT 请求；appId 通过 PathValue 注入，模拟路由匹配结果。
func put(handler http.Handler, appID string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPut, SettingsPath, strings.NewReader(body))
	request.SetPathValue("appId", appID)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	return payload
}

// readDocument 直接读回 app_kv 里的设置文档，用来确认真正落盘的内容。
func readDocument(t *testing.T, databasePath string) map[string]any {
	t.Helper()
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, toolPermissionSettingsKey)
	if err != nil || !found {
		t.Fatalf("ReadKV() found = %v, error = %v", found, err)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(raw), &document); err != nil {
		t.Fatalf("decode document %q: %v", raw, err)
	}
	return document
}

// writeDocument 预置一份设置文档，模拟 Node 之前写过的记录。
func writeDocument(t *testing.T, databasePath string, raw string) {
	t.Helper()
	if err := appstate.WriteKV(context.Background(), databasePath, toolPermissionSettingsKey, raw, 1); err != nil {
		t.Fatalf("WriteKV() error = %v", err)
	}
}

func documentApps(t *testing.T, databasePath string) map[string]any {
	t.Helper()
	document := readDocument(t, databasePath)
	if document["version"] != float64(toolPermissionSettingsVersion) {
		t.Fatalf("version = %#v", document["version"])
	}
	apps, ok := document["apps"].(map[string]any)
	if !ok {
		t.Fatalf("apps = %#v", document["apps"])
	}
	return apps
}

func TestUnauthorized(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: false},
		Providers:  newTestCatalog(),
		Store:      DatabaseStore{DatabasePath: newTestDatabase(t)},
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := put(handler, "claude", `{"maxPermission":false}`)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeBody(t, recorder); payload["error"] != "unauthorized" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	handler := newTestHandler(t, newTestDatabase(t))
	request := httptest.NewRequest(http.MethodGet, SettingsPath, nil)
	request.SetPathValue("appId", "claude")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPut {
		t.Fatalf("Allow = %q", allow)
	}
	if payload := decodeBody(t, recorder); payload["error"] != "method_not_allowed" {
		t.Fatalf("payload = %#v", payload)
	}
}

func TestUnknownAppReturns404(t *testing.T) {
	databasePath := newTestDatabase(t)
	recorder := put(newTestHandler(t, databasePath), "unknown-app", `{"maxPermission":false}`)
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["error"] != "unsupported_app" || payload["ok"] != false {
		t.Fatalf("payload = %#v", payload)
	}
	// 未知 appId 不能留下任何记录。
	if _, found, err := appstate.ReadKV(context.Background(), databasePath, toolPermissionSettingsKey); err != nil || found {
		t.Fatalf("未登记 appId 竟然写入了设置: found = %v, error = %v", found, err)
	}
}

func TestPartialMergeKeepsUntouchedFields(t *testing.T) {
	databasePath := newTestDatabase(t)
	writeDocument(t, databasePath, `{"version":1,"apps":{
		"claude":{"maxPermission":true,"applyToHost":false,"permissionArgs":["--permission-mode","bypassPermissions"],"updatedAt":11},
		"codex":{"maxPermission":false,"applyToHost":false,"permissionArgs":[],"updatedAt":22}
	}}`)
	recorder := put(newTestHandler(t, databasePath), "claude", `{"applyToHost":true}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	if payload["ok"] != true || payload["appId"] != "claude" || payload["provider"] != "claude" {
		t.Fatalf("payload = %#v", payload)
	}
	settings := payload["settings"].(map[string]any)
	if settings["maxPermission"] != true || settings["applyToHost"] != true {
		t.Fatalf("settings = %#v", settings)
	}
	args := settings["permissionArgs"].([]any)
	if len(args) != 2 || args[0] != "--permission-mode" || args[1] != "bypassPermissions" {
		t.Fatalf("permissionArgs 被覆盖了: %#v", args)
	}
	if settings["updatedAt"] == float64(11) || settings["updatedAt"].(float64) <= 0 {
		t.Fatalf("updatedAt 没有刷新: %#v", settings["updatedAt"])
	}
	apps := documentApps(t, databasePath)
	codex := apps["codex"].(map[string]any)
	if codex["maxPermission"] != false || codex["updatedAt"] != float64(22) {
		t.Fatalf("其它应用的记录被改动了: %#v", codex)
	}
}

func TestFullOverwrite(t *testing.T) {
	databasePath := newTestDatabase(t)
	writeDocument(t, databasePath, `{"version":1,"apps":{
		"claude":{"maxPermission":true,"applyToHost":false,"permissionArgs":["--permission-mode","bypassPermissions"],"updatedAt":11}
	}}`)
	recorder := put(newTestHandler(t, databasePath), "claude", `{"maxPermission":true,"applyToHost":false,"permissionArgs":["--auto"]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	settings := decodeBody(t, recorder)["settings"].(map[string]any)
	args := settings["permissionArgs"].([]any)
	if len(args) != 1 || args[0] != "--auto" {
		t.Fatalf("permissionArgs = %#v", args)
	}
	// 空数组同样是一次「整份覆盖」：显式清空参数列表。
	recorder = put(newTestHandler(t, databasePath), "claude", `{"permissionArgs":[]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	settings = decodeBody(t, recorder)["settings"].(map[string]any)
	if len(settings["permissionArgs"].([]any)) != 0 {
		t.Fatalf("permissionArgs = %#v", settings["permissionArgs"])
	}
}

func TestInvalidJSON(t *testing.T) {
	databasePath := newTestDatabase(t)
	recorder := put(newTestHandler(t, databasePath), "claude", `{"maxPermission":`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeBody(t, recorder); payload["error"] != "invalid_json" {
		t.Fatalf("payload = %#v", payload)
	}
	if _, found, err := appstate.ReadKV(context.Background(), databasePath, toolPermissionSettingsKey); err != nil || found {
		t.Fatalf("坏 JSON 竟然写入了设置: found = %v, error = %v", found, err)
	}
}

func TestRejectsInvalidPayload(t *testing.T) {
	cases := []struct {
		name string
		body string
		code string
	}{
		{name: "布尔字段类型错误", body: `{"maxPermission":"yes"}`, code: "invalid_permission_payload"},
		{name: "参数列表不是数组", body: `{"permissionArgs":"--auto"}`, code: "invalid_permission_payload"},
		{name: "参数元素不是字符串", body: `{"permissionArgs":[1]}`, code: "invalid_permission_payload"},
		{name: "没有可写字段", body: `{}`, code: "invalid_permission_payload"},
		{name: "关闭最大权限却写宿主", body: `{"maxPermission":false,"applyToHost":true}`, code: "apply_to_host_requires_max_permission"},
		{name: "关闭最大权限却选参数", body: `{"maxPermission":false,"permissionArgs":["--auto"]}`, code: "permission_args_requires_max_permission"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			databasePath := newTestDatabase(t)
			recorder := put(newTestHandler(t, databasePath), "claude", testCase.body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if payload := decodeBody(t, recorder); payload["error"] != testCase.code {
				t.Fatalf("payload = %#v", payload)
			}
			// 校验失败必须整笔回滚，不留半条记录。
			if _, found, err := appstate.ReadKV(context.Background(), databasePath, toolPermissionSettingsKey); err != nil || found {
				t.Fatalf("非法请求竟然写入了设置: found = %v, error = %v", found, err)
			}
		})
	}
}

func TestFirstWriteUsesDefaults(t *testing.T) {
	databasePath := newTestDatabase(t)
	recorder := put(newTestHandler(t, databasePath), "CLAUDE", `{"maxPermission":false}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	payload := decodeBody(t, recorder)
	// 大小写不敏感地命中合同，响应回规范 ID。
	if payload["appId"] != "claude" || payload["provider"] != "claude" {
		t.Fatalf("payload = %#v", payload)
	}
	settings := payload["settings"].(map[string]any)
	if settings["maxPermission"] != false || settings["applyToHost"] != false {
		t.Fatalf("settings = %#v", settings)
	}
	if args, ok := settings["permissionArgs"].([]any); !ok || len(args) != 0 {
		t.Fatalf("permissionArgs = %#v", settings["permissionArgs"])
	}
	apps := documentApps(t, databasePath)
	if _, ok := apps["claude"]; !ok {
		t.Fatalf("apps = %#v", apps)
	}
}

// TestConcurrentWritesDoNotClobber 守住「立即事务读改写」：并发写不同应用时，
// 每次写入都基于磁盘上的最新文档，不能把别的应用刚写的记录覆盖掉。
func TestConcurrentWritesDoNotClobber(t *testing.T) {
	databasePath := newTestDatabase(t)
	handler := newTestHandler(t, databasePath)
	const rounds = 6
	var group sync.WaitGroup
	for index := 0; index < rounds; index++ {
		for _, appID := range []string{"claude", "codex"} {
			group.Add(1)
			go func(appID string, index int) {
				defer group.Done()
				body := fmt.Sprintf(`{"maxPermission":true,"permissionArgs":["--auto-%d"]}`, index)
				if recorder := put(handler, appID, body); recorder.Code != http.StatusOK {
					t.Errorf("%s 第 %d 次写入 status = %d, body = %s", appID, index, recorder.Code, recorder.Body.String())
				}
			}(appID, index)
		}
	}
	group.Wait()
	apps := documentApps(t, databasePath)
	for _, appID := range []string{"claude", "codex"} {
		record, ok := apps[appID].(map[string]any)
		if !ok {
			t.Fatalf("%s 的记录丢了: %#v", appID, apps)
		}
		if args := record["permissionArgs"].([]any); len(args) != 1 {
			t.Fatalf("%s 的 permissionArgs = %#v", appID, args)
		}
	}
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); err == nil {
		t.Fatal("缺少依赖时 NewHandler() 应当报错")
	}
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Providers: newTestCatalog()}); err == nil {
		t.Fatal("缺少 Store 与 AIHomeDir 时 NewHandler() 应当报错")
	}
	// 只给 AIHomeDir 时按它推导 app-state.db，不必显式构造 Store。
	if _, err := NewHandler(Dependencies{
		Authorizer: fakeAuthorizer{allowed: true},
		Providers:  newTestCatalog(),
		AIHomeDir:  filepath.Dir(newTestDatabase(t)),
	}); err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
}
