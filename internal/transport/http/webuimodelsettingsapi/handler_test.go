package webuimodelsettingsapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

const testRefA = "acct_11111111111111111111"

type testAuthorizer struct{ allow bool }

func (authorizer testAuthorizer) Authorized(*http.Request) bool { return authorizer.allow }

type recordingStore struct {
	calls    int
	document map[string]any
	saved    modelcatalogsettings.Settings
	err      error
}

func (store *recordingStore) Save(_ context.Context, document any) (modelcatalogsettings.Settings, error) {
	store.calls++
	store.document, _ = document.(map[string]any)
	if store.err != nil {
		return modelcatalogsettings.Settings{}, store.err
	}
	return store.saved, nil
}

func newTestHandler(t *testing.T, store Store) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{Authorizer: testAuthorizer{allow: true}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	return handler
}

func performRequest(handler http.Handler, method string, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, Path, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeBody[T any](t *testing.T, recorder *httptest.ResponseRecorder) T {
	t.Helper()
	var payload T
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("响应不是合法 JSON: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func databasePath(t *testing.T) string {
	t.Helper()
	return filepath.Join(t.TempDir(), appstate.DatabaseFileName)
}

// TestPutNormalizesAndPersists 验证 PUT 把任意版本文档交给 v5 归一化并整份落盘。
func TestPutNormalizesAndPersists(t *testing.T) {
	path := databasePath(t)
	handler := newTestHandler(t, DatabaseStore{DatabasePath: path})
	body := "{" +
		"\"version\": 4," +
		"\"updatedAt\": 1," +
		"\"accountModels\": [{" +
		"\"id\": \"Claude-Sonnet-4\", \"provider\": \"claude\", \"accountRef\": \" acct_11111111111111111111 \"," +
		"\"manual\": true, \"defaultModel\": true, \"description\": \"  主力  \"}]," +
		"\"models\": [{\"id\": \"glm-5\", \"provider\": \"zcode\", \"enabled\": false}]" +
		"}"
	recorder := performRequest(handler, http.MethodPut, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	response := decodeBody[responseView](t, recorder)
	if !response.OK || response.Settings.Version != modelcatalogsettings.SettingsVersion {
		t.Fatalf("response = %+v", response)
	}
	if len(response.Settings.AccountModels) != 1 || len(response.Settings.LegacyModels) != 1 {
		t.Fatalf("settings = %+v", response.Settings)
	}
	accountModel := response.Settings.AccountModels[0]
	if accountModel.ID != "Claude-Sonnet-4" || accountModel.AccountRef != testRefA || !accountModel.Manual || !accountModel.DefaultModel || accountModel.Description != "主力" {
		t.Fatalf("accountModel = %+v", accountModel)
	}
	if response.Settings.LegacyModels[0].Enabled {
		t.Fatalf("legacyModels = %+v", response.Settings.LegacyModels)
	}
	if response.SettingsUpdatedAt <= 1 || response.Settings.UpdatedAtMS != response.SettingsUpdatedAt {
		t.Fatalf("updatedAt = %+v", response)
	}

	stored, err := modelcatalogsettings.Load(context.Background(), path)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if stored.UpdatedAtMS != response.SettingsUpdatedAt || len(stored.AccountModels) != 1 || len(stored.LegacyModels) != 1 {
		t.Fatalf("stored = %+v", stored)
	}
}

// TestPostAccepted 验证 POST 与 PUT 等价。
func TestPostAccepted(t *testing.T) {
	store := &recordingStore{saved: modelcatalogsettings.Settings{Version: 5, UpdatedAtMS: 7}}
	handler := newTestHandler(t, store)
	recorder := performRequest(handler, http.MethodPost, "{\"accountModels\": []}")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.calls != 1 {
		t.Fatalf("Save calls = %d", store.calls)
	}
	response := decodeBody[responseView](t, recorder)
	if !response.OK || response.SettingsUpdatedAt != 7 || response.Settings.Version != 5 {
		t.Fatalf("response = %+v", response)
	}
}

// TestRejectsWrongMethod 验证只开放 PUT/POST。
func TestRejectsWrongMethod(t *testing.T) {
	for _, method := range []string{http.MethodGet, http.MethodDelete} {
		store := &recordingStore{}
		recorder := performRequest(newTestHandler(t, store), method, "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d", method, recorder.Code)
		}
		if allow := recorder.Header().Get("Allow"); allow != "PUT, POST" {
			t.Fatalf("%s Allow = %q", method, allow)
		}
		if store.calls != 0 {
			t.Fatalf("%s 不应调用 Save", method)
		}
	}
}

// TestRejectsUnauthorized 验证缺管理密钥时失败关闭。
func TestRejectsUnauthorized(t *testing.T) {
	store := &recordingStore{}
	handler, err := NewHandler(Dependencies{Authorizer: testAuthorizer{allow: false}, Store: store})
	if err != nil {
		t.Fatalf("NewHandler: %v", err)
	}
	recorder := performRequest(handler, http.MethodPut, "{\"accountModels\": []}")
	if recorder.Code != http.StatusUnauthorized || recorder.Header().Get("WWW-Authenticate") != "Bearer" {
		t.Fatalf("status = %d, headers = %v", recorder.Code, recorder.Header())
	}
	if store.calls != 0 {
		t.Fatalf("Save calls = %d", store.calls)
	}
}

// TestRejectsInvalidJSON 验证坏 JSON 和夹带第二个文档都会被拒绝。
func TestRejectsInvalidJSON(t *testing.T) {
	cases := map[string]string{
		"truncated": "{\"accountModels\": ",
		"empty":     "",
		"trailing":  "{\"accountModels\": []}{\"accountModels\": []}",
	}
	for name, body := range cases {
		t.Run(name, func(t *testing.T) {
			store := &recordingStore{}
			recorder := performRequest(newTestHandler(t, store), http.MethodPut, body)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if error := decodeBody[errorView](t, recorder); error.Error != "invalid_json_body" {
				t.Fatalf("error = %+v", error)
			}
			if store.calls != 0 {
				t.Fatalf("Save calls = %d", store.calls)
			}
		})
	}
}

// TestRejectsNonObjectDocument 验证顶层必须是对象。
func TestRejectsNonObjectDocument(t *testing.T) {
	for _, body := range []string{"[]", "null", "\"settings\"", "5"} {
		store := &recordingStore{}
		recorder := performRequest(newTestHandler(t, store), http.MethodPut, body)
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d", body, recorder.Code)
		}
		if error := decodeBody[errorView](t, recorder); error.Error != "invalid_request_body" {
			t.Fatalf("%s error = %+v", body, error)
		}
		if store.calls != 0 {
			t.Fatalf("%s 不应调用 Save", body)
		}
	}
}

// TestRejectsInvalidDocumentShape 验证集合字段类型和「至少一个集合键」的约束。
func TestRejectsInvalidDocumentShape(t *testing.T) {
	cases := map[string]struct {
		body string
		code string
	}{
		"empty object":       {"{}", "missing_settings_document"},
		"unknown key":        {"{\"accountModel\": []}", "missing_settings_document"},
		"accountModels type": {"{\"accountModels\": {}}", "invalid_account_models"},
		"legacyModels type":  {"{\"legacyModels\": \"x\"}", "invalid_legacy_models"},
		"models type":        {"{\"models\": null}", "invalid_models"},
		"version type":       {"{\"accountModels\": [], \"version\": \"5\"}", "invalid_version"},
		"legacy models ok":   {"{\"models\": [{\"id\": \"m\"}]}", ""},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			store := &recordingStore{}
			recorder := performRequest(newTestHandler(t, store), http.MethodPut, testCase.body)
			if testCase.code == "" {
				if recorder.Code != http.StatusOK {
					t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
				}
				if store.calls != 1 {
					t.Fatalf("Save calls = %d", store.calls)
				}
				return
			}
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
			}
			if error := decodeBody[errorView](t, recorder); error.Error != testCase.code {
				t.Fatalf("error = %+v, want %q", error, testCase.code)
			}
			if store.calls != 0 {
				t.Fatalf("Save calls = %d", store.calls)
			}
		})
	}
}

// TestRejectsOversizedBody 验证超出上限的请求体返回 413。
func TestRejectsOversizedBody(t *testing.T) {
	body := "{\"accountModels\": [], \"padding\": \"" + strings.Repeat("a", maxBodyBytes) + "\"}"
	store := &recordingStore{}
	recorder := performRequest(newTestHandler(t, store), http.MethodPut, body)
	if recorder.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if store.calls != 0 {
		t.Fatalf("Save calls = %d", store.calls)
	}
}

// TestStoreFailure 验证写入失败返回 500 且不误报成功。
func TestStoreFailure(t *testing.T) {
	store := &recordingStore{err: errors.New("磁盘满")}
	recorder := performRequest(newTestHandler(t, store), http.MethodPost, "{\"accountModels\": []}")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", recorder.Code)
	}
	response := decodeBody[errorView](t, recorder)
	if response.OK || response.Error != "save_model_catalog_settings_failed" {
		t.Fatalf("response = %+v", response)
	}
}

// TestMissingDependenciesFailClosed 验证依赖缺失时构造与调用都失败关闭。
func TestMissingDependenciesFailClosed(t *testing.T) {
	if _, err := NewHandler(Dependencies{Store: &recordingStore{}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("missing authorizer error = %v", err)
	}
	if _, err := NewHandler(Dependencies{Authorizer: testAuthorizer{allow: true}}); !errors.Is(err, ErrInvalidDependencies) {
		t.Fatalf("missing store error = %v", err)
	}
	var handler *Handler
	recorder := performRequest(handler, http.MethodPut, "{\"accountModels\": []}")
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("nil handler status = %d", recorder.Code)
	}
}
