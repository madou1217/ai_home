package webuiproviderhooksapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/madou1217/ai_home/core/providers"
)

type fakeAuthorizer struct{ allowed bool }

func (fake fakeAuthorizer) Authorized(*http.Request) bool { return fake.allowed }

func newCatalog(t *testing.T) *providers.Catalog {
	t.Helper()
	catalog, err := providers.NewCatalog(providers.BuiltinManifest())
	if err != nil {
		t.Fatalf("NewCatalog() error = %v", err)
	}
	return catalog
}

func newHandler(t *testing.T, catalog *providers.Catalog) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}, Catalog: catalog})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

// readHooks 发一次请求并保留原始 JSON 形状，供「空数组还是 null」这类断言使用。
func readHooks(t *testing.T, handler http.Handler) (map[string]any, map[string]map[string]any) {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", recorder.Code, recorder.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode %q: %v", recorder.Body.String(), err)
	}
	rows, ok := payload["providers"].([]any)
	if !ok {
		t.Fatalf("providers = %#v", payload["providers"])
	}
	byProvider := make(map[string]map[string]any, len(rows))
	for _, item := range rows {
		row, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("row = %#v", item)
		}
		byProvider[row["provider_id"].(string)] = row
	}
	if len(byProvider) != len(rows) {
		t.Fatalf("providers 有重复行: %d 行 / %d 个 id", len(rows), len(byProvider))
	}
	return payload, byProvider
}

func stringList(value any) []string {
	list, ok := value.([]any)
	if !ok {
		return nil
	}
	result := make([]string, 0, len(list))
	for _, item := range list {
		result = append(result, item.(string))
	}
	return result
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if value == target {
			return true
		}
	}
	return false
}

// TestProjectionCoversEveryProvider 锁住「不沉默缺席」：合同里每个 Provider 都要出现，
// 且 supported 必须与 SessionSync.Mode 一致。
func TestProjectionCoversEveryProvider(t *testing.T) {
	catalog := newCatalog(t)
	payload, rows := readHooks(t, newHandler(t, catalog))
	if payload["ok"] != true || payload["derived_by"] != derivedByGoPartial || payload["data_source"] != dataSource {
		t.Fatalf("envelope = %#v", payload)
	}
	definitions := catalog.List()
	if len(rows) != len(definitions) {
		t.Fatalf("providers = %d, want %d", len(rows), len(definitions))
	}
	for _, definition := range definitions {
		row, exists := rows[definition.ID]
		if !exists {
			t.Fatalf("provider %s 缺失", definition.ID)
		}
		wantsHook := definition.SessionSync.Mode == providers.SessionSyncHook
		if row["supported"] != wantsHook {
			t.Fatalf("provider %s: supported = %v, want %v", definition.ID, row["supported"], wantsHook)
		}
		if wantsHook {
			continue
		}
		if row["status"] != statusUnsupported {
			t.Fatalf("provider %s: status = %v, want %s", definition.ID, row["status"], statusUnsupported)
		}
		if row["reason"] == "" {
			t.Fatalf("provider %s: unsupported 但没有 reason", definition.ID)
		}
		if len(stringList(row["unfilled_fields"])) != 0 {
			t.Fatalf("provider %s: unsupported 却报告缺字段 %v", definition.ID, row["unfilled_fields"])
		}
	}
}

// TestEmptyProfileFieldsAreSurfacedAsEmpty 是「不许猜默认值」的核心守卫：
// 合同没有声明 target / timeoutUnit / eventMatchers 时，响应必须是空数组、空串、空对象，
// 而不是 null 或被补成 seconds / 空 matcher。
func TestEmptyProfileFieldsAreSurfacedAsEmpty(t *testing.T) {
	catalog := newCatalog(t)
	_, rows := readHooks(t, newHandler(t, catalog))
	row, exists := rows["codex"]
	if !exists {
		t.Fatal("codex 缺失")
	}
	if row["status"] != statusDegraded {
		t.Fatalf("status = %v, want %s", row["status"], statusDegraded)
	}
	target, exists := row["target"]
	if !exists {
		t.Fatal("target 键缺失，拒绝猜测就不能连空值都不返回")
	}
	if list, ok := target.([]any); !ok || len(list) != 2 || list[0] != ".codex" || list[1] != "hooks.json" {
		t.Fatalf("target = %#v, want [.codex hooks.json]", target)
	}
	matchers, exists := row["event_matchers"]
	if !exists {
		t.Fatal("event_matchers 键缺失")
	}
	if object, ok := matchers.(map[string]any); !ok || len(object) != 0 {
		t.Fatalf("event_matchers = %#v, want {}", matchers)
	}
	if row["timeout_unit"] != "" {
		t.Fatalf("timeout_unit = %#v, want 空串", row["timeout_unit"])
	}
	flag, exists := row["feature_flag"]
	if !exists || flag != nil {
		t.Fatalf("feature_flag = %#v (存在=%v), want null", flag, exists)
	}
	unfilled := stringList(row["unfilled_fields"])
	for _, field := range []string{"timeout_unit", "event_matchers"} {
		if !contains(unfilled, field) {
			t.Fatalf("unfilled_fields = %v, 缺少 %s", unfilled, field)
		}
	}
	if contains(unfilled, "adapter") {
		t.Fatalf("adapter 已由合同声明，不该算缺失: %v", unfilled)
	}
}

// TestDegradedIsAlwaysExplained 保证 degraded 不是一个没有下文的标签：
// 只有 supported 且确实缺字段时才能是 degraded，complete 则不许有 unfilled。
func TestDegradedIsAlwaysExplained(t *testing.T) {
	_, rows := readHooks(t, newHandler(t, newCatalog(t)))
	for id, row := range rows {
		unfilled := stringList(row["unfilled_fields"])
		switch row["status"] {
		case statusDegraded:
			if len(unfilled) == 0 {
				t.Fatalf("provider %s: degraded 但没有说明缺什么", id)
			}
			if row["supported"] != true {
				t.Fatalf("provider %s: unsupported 不能是 degraded", id)
			}
		case statusComplete:
			if len(unfilled) != 0 {
				t.Fatalf("provider %s: complete 却缺 %v", id, unfilled)
			}
		case statusUnsupported:
		default:
			t.Fatalf("provider %s: 未知 status %#v", id, row["status"])
		}
	}
}

// TestHookStatusClassifier 直接覆盖三档判定，含内置合同目前产不出的 complete。
func TestHookStatusClassifier(t *testing.T) {
	flag := true
	cases := []struct {
		name  string
		view  providerView
		wants string
	}{
		{
			name:  "unsupported 不算降级",
			view:  providerView{Supported: false, Reason: "sessionSync.mode=polling"},
			wants: statusUnsupported,
		},
		{
			name:  "缺 target 即降级",
			view:  providerView{Supported: true, Adapter: "json_hooks", TimeoutUnit: "seconds", EventMatchers: map[string]string{"x": "y"}, FeatureFlag: &flag},
			wants: statusDegraded,
		},
		{
			name:  "缺超时单位即降级",
			view:  providerView{Supported: true, Adapter: "json_hooks", Target: []string{".codex"}, EventMatchers: map[string]string{"x": "y"}},
			wants: statusDegraded,
		},
		{
			name:  "缺 matcher 即降级",
			view:  providerView{Supported: true, Adapter: "json_hooks", Target: []string{".codex"}, TimeoutUnit: "seconds"},
			wants: statusDegraded,
		},
		{
			name:  "字段齐全才 complete",
			view:  providerView{Supported: true, Adapter: "json_hooks", Target: []string{".codex"}, TimeoutUnit: "seconds", EventMatchers: map[string]string{"x": "y"}},
			wants: statusComplete,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			if got := hookStatus(testCase.view); got != testCase.wants {
				t.Fatalf("hookStatus() = %s, want %s", got, testCase.wants)
			}
		})
	}
}

// TestUnsupportedRejectsWriteFields 记录「不支持就别带写文件参数」这条边界。
func TestUnsupportedRejectsWriteFields(t *testing.T) {
	view := projectProvider(providers.Definition{
		ID:          "qoder",
		SessionSync: providers.SessionSync{Mode: providers.SessionSyncPolling},
	}, providers.DeriveHookProfile(providers.Definition{
		ID:          "qoder",
		SessionSync: providers.SessionSync{Mode: providers.SessionSyncPolling},
	}))
	if view.Status != statusUnsupported || view.Reason == "" {
		t.Fatalf("view = %#v", view)
	}
	if len(view.Target) != 0 || view.TimeoutUnit != "" || len(view.EventMatchers) != 0 || view.FeatureFlag != nil {
		t.Fatalf("unsupported 携带了写文件参数: %#v", view)
	}
}

func TestAuthAndMethod(t *testing.T) {
	catalog := newCatalog(t)
	handler, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: false}, Catalog: catalog})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized = %d", recorder.Code)
	}

	recorder = httptest.NewRecorder()
	newHandler(t, catalog).ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, Path, nil))
	if recorder.Code != http.StatusMethodNotAllowed || recorder.Header().Get("Allow") != http.MethodGet {
		t.Fatalf("POST = %d allow = %q", recorder.Code, recorder.Header().Get("Allow"))
	}
}

func TestNewHandlerRequiresDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{Authorizer: fakeAuthorizer{allowed: true}}); err != ErrInvalidDependencies {
		t.Fatalf("缺少 Catalog: err = %v", err)
	}
	if _, err := NewHandler(Dependencies{Catalog: newCatalog(t)}); err != ErrInvalidDependencies {
		t.Fatalf("缺少 Authorizer: err = %v", err)
	}
	var empty *Handler
	recorder := httptest.NewRecorder()
	empty.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, Path, nil))
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil handler = %d", recorder.Code)
	}
}
