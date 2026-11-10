package webuiopenaimodelswriteapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	accountapp "github.com/madou1217/ai_home/application/accounts"
	accountcore "github.com/madou1217/ai_home/core/accounts"
	"github.com/madou1217/ai_home/internal/adapters/appstate"
	"github.com/madou1217/ai_home/internal/adapters/modelcatalogsettings"
)

const (
	testAccountRef = "acct_22222222222222222222"
	testModelID    = "gpt-5"
	testProvider   = "codex"
	seedUpdatedAt  = int64(1700000000000)
)

type allowAll struct{}

func (allowAll) Authorized(*http.Request) bool { return true }

type denyAll struct{}

func (denyAll) Authorized(*http.Request) bool { return false }

type fakeStore struct {
	calls int
	inner Store
}

func (store *fakeStore) UpdateSettings(
	ctx context.Context,
	mutate func(current modelcatalogsettings.Settings) (modelcatalogsettings.Settings, error),
) (modelcatalogsettings.Settings, error) {
	store.calls++
	if store.inner == nil {
		return modelcatalogsettings.Settings{}, errors.New("不应写入")
	}
	return store.inner.UpdateSettings(ctx, mutate)
}

type fakeRefresher struct {
	result RefreshResult
	err    error
	calls  int
}

func (refresher *fakeRefresher) Refresh(context.Context) (RefreshResult, error) {
	refresher.calls++
	return refresher.result, refresher.err
}

type fakeCatalog struct {
	catalog accountapp.AccountModelCatalog
	err     error
}

func (catalog fakeCatalog) ListAllAccountModels(context.Context) (accountapp.AccountModelCatalog, error) {
	return catalog.catalog, catalog.err
}

// newTestHandler 建临时 app-state.db 与写入依赖。
func newTestHandler(t *testing.T, dependencies Dependencies) (*Handler, string) {
	t.Helper()
	root := t.TempDir()
	databasePath, err := appstate.DatabasePath(root)
	if err != nil {
		t.Fatalf("DatabasePath() error = %v", err)
	}
	if dependencies.AIHomeDir == "" {
		dependencies.AIHomeDir = root
	}
	handler, err := NewHandler(dependencies)
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler, databasePath
}

// seedSettings 写入一份只含一条账号模型记录的设置文档。
func seedSettings(t *testing.T, databasePath string, document map[string]any) {
	t.Helper()
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatalf("marshal seed: %v", err)
	}
	if err := appstate.WriteKV(context.Background(), databasePath, modelcatalogsettings.DatabaseKey, string(encoded), time.Now().UnixMilli()); err != nil {
		t.Fatalf("seed settings: %v", err)
	}
}

func defaultDocument() map[string]any {
	return map[string]any{
		"version": 5,
		"accountModels": []any{
			map[string]any{
				"id":         testModelID,
				"provider":   testProvider,
				"accountRef": testAccountRef,
				"enabled":    true,
				"manual":     true,
				"createdAt":  seedUpdatedAt,
				"updatedAt":  seedUpdatedAt,
			},
		},
		"legacyModels": []any{},
		"updatedAt":    seedUpdatedAt,
	}
}

func readSettings(t *testing.T, databasePath string) modelcatalogsettings.Settings {
	t.Helper()
	raw, found, err := appstate.ReadKV(context.Background(), databasePath, modelcatalogsettings.DatabaseKey)
	if err != nil {
		t.Fatalf("ReadKV() error = %v", err)
	}
	if !found {
		t.Fatalf("设置文档缺失")
	}
	return modelcatalogsettings.Normalize(raw)
}

func catalogWithModel(t *testing.T) fakeCatalog {
	t.Helper()
	accountRef, err := accountcore.ParseAccountRef(testAccountRef)
	if err != nil {
		t.Fatalf("ParseAccountRef() error = %v", err)
	}
	model, err := accountapp.NewAccountModel(accountapp.AccountModelInput{
		AccountRef:        accountRef,
		ModelID:           testModelID,
		UpstreamAvailable: true,
		ManualPolicy:      accountapp.ModelPolicyInherit,
		UpdatedAt:         time.UnixMilli(seedUpdatedAt).UTC(),
	})
	if err != nil {
		t.Fatalf("NewAccountModel() error = %v", err)
	}
	return fakeCatalog{catalog: accountapp.AccountModelCatalog{
		Sets: []accountapp.AccountModelSet{{
			AccountRef: accountRef,
			ProviderID: testProvider,
			Models:     []accountapp.AccountModel{model},
		}},
	}}
}

func doRequest(handler http.Handler, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decodeError(t *testing.T, recorder *httptest.ResponseRecorder) errorResponse {
	t.Helper()
	var payload errorResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解码错误响应失败: %v; body=%s", err, recorder.Body.String())
	}
	return payload
}

func decodeDelete(t *testing.T, recorder *httptest.ResponseRecorder) deleteResponse {
	t.Helper()
	var payload deleteResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解码删除响应失败: %v; body=%s", err, recorder.Body.String())
	}
	return payload
}

func deleteBody(modelID string) string {
	encoded, _ := json.Marshal(map[string]any{
		"modelId":    modelID,
		"provider":   testProvider,
		"accountRef": testAccountRef,
	})
	return string(encoded)
}

func TestUnauthorized(t *testing.T) {
	store := &fakeStore{}
	handler, _ := newTestHandler(t, Dependencies{Authorizer: denyAll{}, Store: store})
	recorder := doRequest(handler, http.MethodPost, DeletePath, deleteBody(testModelID))
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
	if payload := decodeError(t, recorder); payload.Error.Code != "unauthorized" {
		t.Fatalf("code = %q", payload.Error.Code)
	}
	if store.calls != 0 {
		t.Fatalf("鉴权失败仍然写了存储: calls = %d", store.calls)
	}
}

func TestMethodNotAllowed(t *testing.T) {
	for _, target := range []string{RefreshPath, DeletePath} {
		handler, _ := newTestHandler(t, Dependencies{Authorizer: allowAll{}, Store: &fakeStore{}})
		recorder := doRequest(handler, http.MethodGet, target, "")
		if recorder.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s status = %d, want 405", target, recorder.Code)
		}
		if allow := recorder.Header().Get("Allow"); allow != http.MethodPost {
			t.Fatalf("%s Allow = %q", target, allow)
		}
	}
}

func TestRefreshWithoutRefresher(t *testing.T) {
	handler, _ := newTestHandler(t, Dependencies{Authorizer: allowAll{}, Store: &fakeStore{}})
	recorder := doRequest(handler, http.MethodPost, RefreshPath, "")
	if recorder.Code != http.StatusNotImplemented {
		t.Fatalf("status = %d, want 501; body=%s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeError(t, recorder); payload.Error.Code != "refresh_unavailable" {
		t.Fatalf("code = %q", payload.Error.Code)
	}
}

func TestRefreshSuccess(t *testing.T) {
	refresher := &fakeRefresher{result: RefreshResult{
		UpdatedAtMS: seedUpdatedAt,
		Models:      42,
		Accounts:    3,
		Sources:     2,
		Cached:      true,
		Source:      "probe",
	}}
	handler, _ := newTestHandler(t, Dependencies{
		Authorizer: allowAll{},
		Store:      &fakeStore{},
		Refresher:  refresher,
	})
	recorder := doRequest(handler, http.MethodPost, RefreshPath, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	var payload refreshResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解码刷新响应失败: %v", err)
	}
	if !payload.OK || !payload.Refreshed {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.UpdatedAtMS != seedUpdatedAt || payload.Models != 42 || payload.Accounts != 3 ||
		payload.Sources != 2 || !payload.Cached || payload.Source != "probe" {
		t.Fatalf("统计未照抄 Refresher: %+v", payload)
	}
	if refresher.calls != 1 {
		t.Fatalf("Refresher 调用次数 = %d", refresher.calls)
	}
}

func TestRefreshFailure(t *testing.T) {
	handler, _ := newTestHandler(t, Dependencies{
		Authorizer: allowAll{},
		Store:      &fakeStore{},
		Refresher:  &fakeRefresher{err: errors.New("探测失败")},
	})
	recorder := doRequest(handler, http.MethodPost, RefreshPath, "")
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", recorder.Code)
	}
	if payload := decodeError(t, recorder); payload.Error.Code != "refresh_failed" {
		t.Fatalf("code = %q", payload.Error.Code)
	}
}

func TestDeleteMissingModelID(t *testing.T) {
	handler, databasePath := newTestHandler(t, Dependencies{Authorizer: allowAll{}, Store: &fakeStore{}})
	seedSettings(t, databasePath, defaultDocument())
	recorder := doRequest(handler, http.MethodPost, DeletePath, `{"provider":"codex"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
	if payload := decodeError(t, recorder); payload.Error.Code != "missing_model" {
		t.Fatalf("code = %q", payload.Error.Code)
	}
}

func TestDeleteNotFound(t *testing.T) {
	handler, databasePath := newTestHandler(t, Dependencies{
		Authorizer: allowAll{},
		Catalog:    catalogWithModel(t),
	})
	seedSettings(t, databasePath, defaultDocument())
	recorder := doRequest(handler, http.MethodPost, DeletePath, deleteBody("gpt-4o"))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404; body=%s", recorder.Code, recorder.Body.String())
	}
	if payload := decodeError(t, recorder); payload.Error.Code != "model_not_found" {
		t.Fatalf("code = %q", payload.Error.Code)
	}
	// 没有命中时整笔事务回滚，文档的 updatedAt 不能被刷新。
	if settings := readSettings(t, databasePath); settings.UpdatedAtMS != seedUpdatedAt {
		t.Fatalf("settings.updatedAt = %d, want %d", settings.UpdatedAtMS, seedUpdatedAt)
	}
}

func TestDeleteSuccess(t *testing.T) {
	handler, databasePath := newTestHandler(t, Dependencies{
		Authorizer: allowAll{},
		Catalog:    catalogWithModel(t),
	})
	seedSettings(t, databasePath, defaultDocument())
	recorder := doRequest(handler, http.MethodPost, DeletePath, deleteBody(testModelID))
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", recorder.Code, recorder.Body.String())
	}
	payload := decodeDelete(t, recorder)
	if !payload.OK || !payload.Deleted {
		t.Fatalf("payload = %+v", payload)
	}
	if payload.SettingsUpdatedAtMS <= seedUpdatedAt {
		t.Fatalf("settingsUpdatedAt = %d, want > %d", payload.SettingsUpdatedAtMS, seedUpdatedAt)
	}
	settings := readSettings(t, databasePath)
	if len(settings.AccountModels) != 0 {
		t.Fatalf("accountModels = %+v, want empty", settings.AccountModels)
	}
	if settings.UpdatedAtMS != payload.SettingsUpdatedAtMS {
		t.Fatalf("落盘 updatedAt = %d, 响应 = %d", settings.UpdatedAtMS, payload.SettingsUpdatedAtMS)
	}
}

func TestDeleteIdempotent(t *testing.T) {
	handler, databasePath := newTestHandler(t, Dependencies{
		Authorizer: allowAll{},
		Catalog:    catalogWithModel(t),
	})
	seedSettings(t, databasePath, defaultDocument())

	first := doRequest(handler, http.MethodPost, DeletePath, deleteBody(testModelID))
	if first.Code != http.StatusOK || !decodeDelete(t, first).Deleted {
		t.Fatalf("首次删除 status = %d body = %s", first.Code, first.Body.String())
	}
	updatedAt := readSettings(t, databasePath).UpdatedAtMS

	second := doRequest(handler, http.MethodPost, DeletePath, deleteBody(testModelID))
	if second.Code != http.StatusOK {
		t.Fatalf("重复删除 status = %d, want 200; body=%s", second.Code, second.Body.String())
	}
	payload := decodeDelete(t, second)
	if payload.Deleted {
		t.Fatalf("重复删除 deleted = true, want false")
	}
	// 幂等重试不该再制造一次设置变更。
	if settings := readSettings(t, databasePath); settings.UpdatedAtMS != updatedAt {
		t.Fatalf("重复删除刷新了 updatedAt: %d → %d", updatedAt, settings.UpdatedAtMS)
	}
}
