package modelaliaswebui

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/modelalias"
)

type fakeService struct {
	records     []modelalias.Record
	generation  int64
	err         error
	lastCreate  modelalias.CreateInput
	lastUpdate  modelalias.UpdateInput
	lastID      string
	lastEnable  *bool
	lastReplace modelalias.ReplaceGroupInput
}

func (fake *fakeService) List() []modelalias.Record { return fake.records }

func (fake *fakeService) Create(_ context.Context, input modelalias.CreateInput) (modelalias.Record, int64, error) {
	fake.lastCreate = input
	if fake.err != nil {
		return modelalias.Record{}, 0, fake.err
	}
	return modelalias.Record{ID: "abcd1234", Alias: input.Alias, Target: input.Target}, 1, nil
}

func (fake *fakeService) Update(_ context.Context, id string, input modelalias.UpdateInput) (modelalias.Record, int64, error) {
	fake.lastID = id
	fake.lastUpdate = input
	if fake.err != nil {
		return modelalias.Record{}, 0, fake.err
	}
	return modelalias.Record{ID: id, Alias: "x", Target: "y"}, 2, nil
}

func (fake *fakeService) Delete(_ context.Context, id string) (int64, error) {
	fake.lastID = id
	if fake.err != nil {
		return 0, fake.err
	}
	return 3, nil
}

func (fake *fakeService) ReplaceGroup(_ context.Context, input modelalias.ReplaceGroupInput) ([]modelalias.Record, int64, error) {
	fake.lastReplace = input
	if fake.err != nil {
		return nil, 0, fake.err
	}
	return []modelalias.Record{{ID: "new1", Alias: "a", Target: "b"}}, 5, nil
}

func (fake *fakeService) SetEnabled(_ context.Context, id string, enabled bool) (int64, error) {
	fake.lastID = id
	fake.lastEnable = &enabled
	if fake.err != nil {
		return 0, fake.err
	}
	return 4, nil
}

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

func newHandler(t *testing.T, service Service, allowed bool) *Handler {
	t.Helper()
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: allowed},
		Service:    service,
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	return handler
}

func do(handler *Handler, method, target, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func decode(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v (%s)", err, recorder.Body.String())
	}
	return payload
}

func TestHandlerRejectsUnauthorized(t *testing.T) {
	handler := newHandler(t, &fakeService{}, false)
	if recorder := do(handler, http.MethodGet, Path, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestHandlerListReturnsEmptyArrayNotNull(t *testing.T) {
	handler := newHandler(t, &fakeService{}, true)
	recorder := do(handler, http.MethodGet, Path, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	payload := decode(t, recorder)
	aliases, ok := payload["aliases"].([]any)
	if !ok {
		t.Fatalf("aliases 不是数组: %v", payload["aliases"])
	}
	if len(aliases) != 0 {
		t.Fatalf("aliases = %d, want 0", len(aliases))
	}
}

func TestHandlerCreatePassesFields(t *testing.T) {
	service := &fakeService{}
	handler := newHandler(t, service, true)
	recorder := do(handler, http.MethodPost, Path, `{"alias":" fast ","target":"glm-5.3-flash","provider":"zcode","priority":7,"enabled":false}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if service.lastCreate.Alias != " fast " || service.lastCreate.Provider != "zcode" {
		t.Fatalf("create input = %+v", service.lastCreate)
	}
	if service.lastCreate.Priority != 7 {
		t.Fatalf("priority = %d, want 7", service.lastCreate.Priority)
	}
	// enabled=false 是指针：必须原样传下去，不能被当成「未提供」。
	if service.lastCreate.Enabled == nil || *service.lastCreate.Enabled {
		t.Fatalf("enabled 未按 false 传递: %v", service.lastCreate.Enabled)
	}
}

func TestHandlerCreateRequiresAliasAndTarget(t *testing.T) {
	handler := newHandler(t, &fakeService{}, true)
	recorder := do(handler, http.MethodPost, Path, `{"alias":"x"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestHandlerUpdateDeleteToggleRouting(t *testing.T) {
	service := &fakeService{}
	handler := newHandler(t, service, true)

	if recorder := do(handler, http.MethodPut, Path+"/abcd1234", `{"priority":3}`); recorder.Code != http.StatusOK {
		t.Fatalf("update status = %d", recorder.Code)
	}
	if service.lastID != "abcd1234" || service.lastUpdate.Priority == nil || *service.lastUpdate.Priority != 3 {
		t.Fatalf("update 路由错误: id=%q input=%+v", service.lastID, service.lastUpdate)
	}

	if recorder := do(handler, http.MethodPost, Path+"/abcd1234/enabled", `{"enabled":false}`); recorder.Code != http.StatusOK {
		t.Fatalf("toggle status = %d", recorder.Code)
	}
	if service.lastEnable == nil || *service.lastEnable {
		t.Fatalf("toggle 未传递 false: %v", service.lastEnable)
	}

	if recorder := do(handler, http.MethodDelete, Path+"/abcd1234", ""); recorder.Code != http.StatusOK {
		t.Fatalf("delete status = %d", recorder.Code)
	}
}

func TestHandlerMapsDomainErrors(t *testing.T) {
	cases := []struct {
		err  error
		want int
	}{
		{modelalias.ErrAliasNotFound, http.StatusNotFound},
		{modelalias.ErrDuplicateAlias, http.StatusConflict},
		{modelalias.ErrInvalidAlias, http.StatusBadRequest},
	}
	for _, testCase := range cases {
		handler := newHandler(t, &fakeService{err: testCase.err}, true)
		recorder := do(handler, http.MethodDelete, Path+"/abcd1234", "")
		if recorder.Code != testCase.want {
			t.Fatalf("%v → status %d, want %d", testCase.err, recorder.Code, testCase.want)
		}
	}
}

func TestHandlerRejectsUnsupportedMethod(t *testing.T) {
	handler := newHandler(t, &fakeService{}, true)
	if recorder := do(handler, http.MethodPatch, Path, ""); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}

// 写入成功后必须触发一次目录重建：否则「改了别名但要等下次刷新才生效」，
// 用户会以为没保存。
func TestHandlerRefreshesCatalogAfterWrites(t *testing.T) {
	service := &fakeService{}
	refreshes := 0
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Service:    service,
		Refresh:    func(context.Context) error { refreshes++; return nil },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	do(handler, http.MethodPost, Path, `{"alias":"a","target":"b"}`)
	do(handler, http.MethodPut, Path+"/id1", `{"priority":1}`)
	do(handler, http.MethodPost, Path+"/id1/enabled", `{"enabled":false}`)
	do(handler, http.MethodDelete, Path+"/id1", "")
	if refreshes != 4 {
		t.Fatalf("刷新次数 = %d, want 4", refreshes)
	}
}

// 刷新失败不能让写请求失败：别名已经落库，下一次构建仍会带上它。
func TestHandlerRefreshFailureDoesNotFailWrite(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Service:    &fakeService{},
		Refresh:    func(context.Context) error { return errors.New("refresh failed") },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	if recorder := do(handler, http.MethodPost, Path, `{"alias":"a","target":"b"}`); recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", recorder.Code)
	}
}

// 服务报错时不能刷新（没有变化可应用）。
func TestHandlerSkipsRefreshWhenWriteFails(t *testing.T) {
	refreshes := 0
	handler, _ := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Service:    &fakeService{err: modelalias.ErrAliasNotFound},
		Refresh:    func(context.Context) error { refreshes++; return nil },
	})
	do(handler, http.MethodDelete, Path+"/id1", "")
	if refreshes != 0 {
		t.Fatalf("失败写入触发了 %d 次刷新", refreshes)
	}
}

func TestHandlerReplaceGroupPassesIDsAndRecords(t *testing.T) {
	service := &fakeService{}
	handler := newHandler(t, service, true)
	recorder := do(handler, http.MethodPost, Path+"/replace", `{"replaceIds":["old1"],"records":[{"alias":"a","target":"b","priority":2}]}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if len(service.lastReplace.ReplaceIDs) != 1 || service.lastReplace.ReplaceIDs[0] != "old1" {
		t.Fatalf("replaceIds = %v", service.lastReplace.ReplaceIDs)
	}
	if len(service.lastReplace.Records) != 1 || service.lastReplace.Records[0].Alias != "a" {
		t.Fatalf("records = %+v", service.lastReplace.Records)
	}
	if service.lastReplace.Records[0].Priority != 2 {
		t.Fatalf("priority = %d", service.lastReplace.Records[0].Priority)
	}
	payload := decode(t, recorder)
	aliases, ok := payload["aliases"].([]any)
	if !ok || len(aliases) != 1 {
		t.Fatalf("aliases = %v", payload["aliases"])
	}
	if payload["generation"].(float64) != 5 {
		t.Fatalf("generation = %v", payload["generation"])
	}
}

func TestHandlerReplaceGroupRejectsMissingFields(t *testing.T) {
	handler := newHandler(t, &fakeService{}, true)
	// records 里缺 target：整组拒绝，不能只写一半。
	recorder := do(handler, http.MethodPost, Path+"/replace", `{"replaceIds":[],"records":[{"alias":"a"}]}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestHandlerListsTargets(t *testing.T) {
	handler, err := NewHandler(Dependencies{
		Authorizer: stubAuthorizer{allowed: true},
		Service:    &fakeService{},
		Targets:    func() map[string][]string { return map[string][]string{"codex": {"gpt-5.1"}} },
	})
	if err != nil {
		t.Fatalf("NewHandler() error = %v", err)
	}
	recorder := do(handler, http.MethodGet, Path+"/targets", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	payload := decode(t, recorder)
	targets, ok := payload["targets"].(map[string]any)
	if !ok {
		t.Fatalf("targets = %v", payload["targets"])
	}
	if len(targets["codex"].([]any)) != 1 {
		t.Fatalf("codex targets = %v", targets["codex"])
	}
}

// 目录还没构建完时返回 503 而不是空表：让前端能区分「暂时没有」与「还没就绪」。
func TestHandlerTargetsUnavailable(t *testing.T) {
	handler := newHandler(t, &fakeService{}, true)
	if recorder := do(handler, http.MethodGet, Path+"/targets", ""); recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", recorder.Code)
	}
}
