package modelaliaswebui

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/madou1217/ai_home/application/modelalias"
)

type fakeService struct {
	records    []modelalias.Record
	generation int64
	err        error
	lastCreate modelalias.CreateInput
	lastUpdate modelalias.UpdateInput
	lastID     string
	lastEnable *bool
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
	handler, err := NewHandler(stubAuthorizer{allowed: allowed}, service)
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
