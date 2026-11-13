package webuimanagementkeyapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	_ "modernc.org/sqlite"
)

const (
	currentKey     = "current-management-key-0123456789abcdef"
	replacementKey = "replacement-management-key-0123456789ab"
	generatedKey   = "generated-management-key-0123456789abcdef"
)

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

// failingStore 只让写入失败，读仍然走真实 app-state。
type failingStore struct {
	*Source
	updateErr error
}

func (store failingStore) UpdateServerConfig(context.Context, func(string, bool) (string, error)) error {
	return store.updateErr
}

// newTestStore 建一个真实的临时 sqlite app-state；present=false 表示没有 config:server 行。
func newTestStore(t *testing.T, stored string, present bool) *Source {
	t.Helper()
	directory := t.TempDir()
	path := filepath.Join(directory, appstate.DatabaseFileName)
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("open app-state: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec("CREATE TABLE app_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)"); err != nil {
		t.Fatalf("create app_kv: %v", err)
	}
	if present {
		if _, err := db.Exec("INSERT INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)", serverConfigKey, stored, 1); err != nil {
			t.Fatalf("insert config:server: %v", err)
		}
	}
	source, err := OpenSource(directory)
	if err != nil {
		t.Fatalf("OpenSource() error = %v", err)
	}
	return source
}

func newTestHandler(t *testing.T, store Store, generator Generator) http.Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Store:      store,
		Generator:  generator,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func postRotate(t *testing.T, handler http.Handler, body string, bearer string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, Path, strings.NewReader(body))
	if bearer != "" {
		request.Header.Set("Authorization", "Bearer "+bearer)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func storedKey(t *testing.T, source *Source) string {
	t.Helper()
	raw, found, err := source.ReadServerConfig(context.Background())
	if err != nil || !found {
		t.Fatalf("ReadServerConfig() found=%v err=%v", found, err)
	}
	key, err := managementKeyFromConfig(raw, found)
	if err != nil {
		t.Fatalf("managementKeyFromConfig() error = %v", err)
	}
	return key
}

func TestNewHandlerRejectsMissingDependencies(t *testing.T) {
	if _, err := NewHandler(Dependencies{}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v，期望 ErrInvalidDependencies", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("NewHandler() error = %v，期望 ErrInvalidDependencies", err)
	}
}

func TestRotateRejectsUnauthorized(t *testing.T) {
	source := newTestStore(t, `{"port":8080,"managementKey":"`+currentKey+`"}`, true)
	handler, err := NewHandler(Dependencies{Authorizer: stubAuthorizer{allowed: false}, Store: source})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`"}`, currentKey)
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，期望 401", recorder.Code)
	}
	if key := storedKey(t, source); key != currentKey {
		t.Fatalf("未授权请求改动了配置: %q", key)
	}
}

func TestRotateRejectsNonPost(t *testing.T) {
	source := newTestStore(t, `{"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, nil)
	request := httptest.NewRequest(http.MethodGet, Path, nil)
	request.Header.Set("Authorization", "Bearer "+currentKey)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d，期望 405", recorder.Code)
	}
	if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
		t.Fatalf("Allow = %q，期望 POST", allow)
	}
}

func TestRotateRejectsWrongCurrentKey(t *testing.T) {
	source := newTestStore(t, `{"port":8080,"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, nil)
	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`"}`, "not-the-current-key-0123456789abcdef")
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，期望 401", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if payload["error"] != "webui_unauthorized" {
		t.Fatalf("error = %v，期望 webui_unauthorized", payload["error"])
	}
	if key := storedKey(t, source); key != currentKey {
		t.Fatalf("旧 Key 错误时配置被改动: %q", key)
	}
	// 错误信息与响应体都不能带出任何 Key 明文。
	for _, secret := range []string{currentKey, replacementKey} {
		if strings.Contains(recorder.Body.String(), secret) {
			t.Fatalf("响应体泄露了 Key 明文: %s", recorder.Body.String())
		}
	}
}

func TestRotateWithClientSuppliedKey(t *testing.T) {
	source := newTestStore(t, `{"port":8080,"proxyUrl":"http://proxy.local","managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, nil)

	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`"}`, currentKey)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200: %s", recorder.Code, recorder.Body.String())
	}
	if cacheControl := recorder.Header().Get("Cache-Control"); cacheControl != "no-store" {
		t.Fatalf("Cache-Control = %q，期望 no-store", cacheControl)
	}
	payload := decodeBody(t, recorder)
	if payload["ok"] != true || payload["managementKeyConfigured"] != true {
		t.Fatalf("响应字段不符: %v", payload)
	}
	if payload["generated"] != false {
		t.Fatalf("generated = %v，期望 false", payload["generated"])
	}
	if payload["managementKey"] != replacementKey {
		t.Fatalf("managementKey = %v，期望新 Key", payload["managementKey"])
	}
	if rotatedAt, ok := payload["rotatedAt"].(float64); !ok || rotatedAt <= 0 {
		t.Fatalf("rotatedAt = %v，期望毫秒时间戳", payload["rotatedAt"])
	}

	// 新 Key 落库，其它字段原样保留。
	raw, _, err := source.ReadServerConfig(context.Background())
	if err != nil {
		t.Fatalf("ReadServerConfig() error = %v", err)
	}
	var stored map[string]any
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatalf("落库内容不是 JSON: %v", err)
	}
	if stored["managementKey"] != replacementKey {
		t.Fatalf("落库 managementKey = %v，期望新 Key", stored["managementKey"])
	}
	if stored["port"] != float64(8080) || stored["proxyUrl"] != "http://proxy.local" {
		t.Fatalf("无关字段被覆盖: %v", stored)
	}

	// 旧 Key 失效、新 Key 生效：再轮换一次，只有新 Key 能过。
	if code := postRotate(t, handler, `{"managementKey":"`+generatedKey+`"}`, currentKey).Code; code != http.StatusUnauthorized {
		t.Fatalf("旧 Key 仍可用，status = %d", code)
	}
	if code := postRotate(t, handler, `{"managementKey":"`+generatedKey+`"}`, replacementKey).Code; code != http.StatusOK {
		t.Fatalf("新 Key 不可用，status = %d", code)
	}
	if key := storedKey(t, source); key != generatedKey {
		t.Fatalf("第二次轮换后 managementKey = %q", key)
	}
}

func TestRotateGeneratesKeyWhenBodyOmitsIt(t *testing.T) {
	source := newTestStore(t, `{"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, func() (string, error) { return generatedKey, nil })

	for _, body := range []string{"", "{}", `{"managementKey":"   "}`} {
		recorder := postRotate(t, handler, body, currentKey)
		if recorder.Code != http.StatusOK {
			t.Fatalf("body=%q status = %d，期望 200: %s", body, recorder.Code, recorder.Body.String())
		}
		payload := decodeBody(t, recorder)
		if payload["generated"] != true || payload["managementKey"] != generatedKey {
			t.Fatalf("body=%q 生成结果不符: %v", body, payload)
		}
		if key := storedKey(t, source); key != generatedKey {
			t.Fatalf("body=%q 生成的新 Key 未落库: %q", body, key)
		}
		// 复位，让下一轮仍以 currentKey 作为旧 Key。
		if err := source.UpdateServerConfig(context.Background(), func(string, bool) (string, error) {
			return `{"managementKey":"` + currentKey + `"}`, nil
		}); err != nil {
			t.Fatalf("复位失败: %v", err)
		}
	}
}

func TestRotateGeneratorFailure(t *testing.T) {
	source := newTestStore(t, `{"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, func() (string, error) {
		return "", errors.New("熵源不可用")
	})
	recorder := postRotate(t, handler, "{}", currentKey)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d，期望 500", recorder.Code)
	}
	payload := decodeBody(t, recorder)
	if payload["error"] != "management_key_generation_failed" {
		t.Fatalf("error = %v，期望 management_key_generation_failed", payload["error"])
	}
	if key := storedKey(t, source); key != currentKey {
		t.Fatalf("生成失败时配置被改动: %q", key)
	}
}

func TestRotateRejectsInvalidReplacement(t *testing.T) {
	source := newTestStore(t, `{"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, nil)

	cases := []struct {
		name   string
		body   string
		status int
		code   string
	}{
		{"太短", `{"managementKey":"short"}`, http.StatusBadRequest, "invalid_management_key"},
		{"含换行", `{"managementKey":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nbbbb"}`, http.StatusBadRequest, "invalid_management_key"},
		{"与当前相同", `{"managementKey":"` + currentKey + `"}`, http.StatusConflict, "management_key_unchanged"},
		{"不是 JSON", "{", http.StatusBadRequest, "invalid_payload"},
		{"不是对象", `[]`, http.StatusBadRequest, "invalid_payload"},
		{"类型不对", `{"managementKey":123}`, http.StatusBadRequest, "invalid_payload"},
		{"超长请求体", `{"managementKey":"` + strings.Repeat("a", maxRequestBytes) + `"}`, http.StatusBadRequest, "invalid_payload"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			recorder := postRotate(t, handler, testCase.body, currentKey)
			if recorder.Code != testCase.status {
				t.Fatalf("status = %d，期望 %d: %s", recorder.Code, testCase.status, recorder.Body.String())
			}
			if payload := decodeBody(t, recorder); payload["error"] != testCase.code {
				t.Fatalf("error = %v，期望 %s", payload["error"], testCase.code)
			}
			if key := storedKey(t, source); key != currentKey {
				t.Fatalf("非法请求改动了配置: %q", key)
			}
		})
	}
}

func TestRotatePersistFailure(t *testing.T) {
	source := newTestStore(t, `{"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, failingStore{Source: source, updateErr: errors.New("磁盘只读")}, nil)
	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`"}`, currentKey)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d，期望 500", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["error"] != "management_key_rotation_persist_failed" {
		t.Fatalf("error = %v，期望 management_key_rotation_persist_failed", payload["error"])
	}
	if strings.Contains(recorder.Body.String(), replacementKey) {
		t.Fatalf("响应体泄露了新 Key: %s", recorder.Body.String())
	}
}

func TestRotateWithoutConfiguredKey(t *testing.T) {
	source := newTestStore(t, "", false)
	handler := newTestHandler(t, source, nil)

	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`"}`, "")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d，期望 503", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["error"] != "management_key_not_configured" {
		t.Fatalf("error = %v，期望 management_key_not_configured", payload["error"])
	}
}

func TestRotateRejectsExternallyManagedKey(t *testing.T) {
	// config:server 没有 Key 但调用方持有有效 Bearer：当前 Key 来自启动参数/环境变量。
	source := newTestStore(t, "", false)
	handler := newTestHandler(t, source, nil)
	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`"}`, currentKey)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d，期望 409", recorder.Code)
	}
	if payload := decodeBody(t, recorder); payload["error"] != "management_key_external_source" {
		t.Fatalf("error = %v，期望 management_key_external_source", payload["error"])
	}
}

func TestRandomGeneratorProducesUsableKey(t *testing.T) {
	generator := NewRandomGenerator()
	first, err := generator()
	if err != nil {
		t.Fatalf("generator() error = %v", err)
	}
	if len(first) < minManagementKeyLength || len(first) > maxManagementKeyLength {
		t.Fatalf("生成 Key 长度 = %d，不在合法区间", len(first))
	}
	second, err := generator()
	if err != nil {
		t.Fatalf("generator() error = %v", err)
	}
	if first == second {
		t.Fatal("两次生成得到同一个 Key")
	}
	if failure := validateReplacement(first); failure != nil {
		t.Fatalf("生成 Key 未通过校验: %v", failure.code)
	}
}

func TestRotateWithProxySubmittedCurrentKey(t *testing.T) {
	source := newTestStore(t, `{"managementKey":"`+currentKey+`"}`, true)
	handler := newTestHandler(t, source, nil)

	// 携带内部 Go Core Key 作为 Authorization，但请求体里带上正确的 currentManagementKey 时放行并落库
	recorder := postRotate(t, handler, `{"managementKey":"`+replacementKey+`","currentManagementKey":"`+currentKey+`"}`, "ephemeral-go-core-key")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d，期望 200: %s", recorder.Code, recorder.Body.String())
	}
	if key := storedKey(t, source); key != replacementKey {
		t.Fatalf("期望写入新 Key %q，实际 %q", replacementKey, key)
	}

	// currentManagementKey 错误时仍拒绝
	badRec := postRotate(t, handler, `{"managementKey":"`+generatedKey+`","currentManagementKey":"wrong-key"}`, "ephemeral-go-core-key")
	if badRec.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d，期望 401", badRec.Code)
	}
}
