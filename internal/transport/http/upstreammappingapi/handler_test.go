package upstreammappingapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	mappingapp "github.com/madou1217/ai_home/application/upstreammapping"
	mappingcore "github.com/madou1217/ai_home/core/upstreammapping"
	rulescore "github.com/madou1217/ai_home/core/upstreamrules"
)

type fakeService struct {
	groups      []mappingcore.Group
	err         error
	lastCreate  mappingapp.CreateInput
	lastUpdate  mappingapp.UpdateInput
	lastID      string
	lastVersion *int64
}

func (fake *fakeService) List(context.Context) ([]mappingcore.Group, error) {
	if fake.err != nil {
		return nil, fake.err
	}
	return fake.groups, nil
}

func (fake *fakeService) Get(_ context.Context, id string) (mappingcore.Group, error) {
	fake.lastID = id
	if fake.err != nil {
		return mappingcore.Group{}, fake.err
	}
	return fake.groups[0], nil
}

func (fake *fakeService) Create(_ context.Context, input mappingapp.CreateInput) (mappingcore.Group, error) {
	fake.lastCreate = input
	if fake.err != nil {
		return mappingcore.Group{}, fake.err
	}
	return fake.groups[0], nil
}

func (fake *fakeService) Update(
	_ context.Context,
	id string,
	input mappingapp.UpdateInput,
) (mappingcore.Group, error) {
	fake.lastID = id
	fake.lastUpdate = input
	if fake.err != nil {
		return mappingcore.Group{}, fake.err
	}
	return fake.groups[0], nil
}

func (fake *fakeService) Delete(_ context.Context, id string, version *int64) error {
	fake.lastID = id
	fake.lastVersion = version
	return fake.err
}

type stubAuthorizer struct{ allowed bool }

func (stub stubAuthorizer) Authorized(*http.Request) bool { return stub.allowed }

func testRule(t *testing.T) rulescore.Rule {
	t.Helper()
	raw := `{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate limit"}]}`
	var rule rulescore.Rule
	if err := json.Unmarshal([]byte(raw), &rule); err != nil {
		t.Fatalf("解析规则失败: %v", err)
	}
	compiled, err := rulescore.NewRule(rule.Name(), rule.Kind(), rule.Enabled(), rule.Statuses(), rule.Matchers())
	if err != nil {
		t.Fatalf("编译规则失败: %v", err)
	}
	return compiled
}

func storedGroup(t *testing.T) mappingcore.Group {
	t.Helper()
	now := time.UnixMilli(1000).UTC()
	group, err := mappingcore.RestoreGroup(mappingcore.Input{
		ID:        "uem_0123456789ab",
		Name:      "测试组",
		Provider:  mappingcore.ScopeAll,
		Enabled:   boolPointer(true),
		Entries:   mappingcore.EntriesFromRules([]rulescore.Rule{testRule(t)}),
		Position:  0,
		Version:   1,
		CreatedAt: now,
		UpdatedAt: now,
	})
	if err != nil {
		t.Fatalf("RestoreGroup() error = %v", err)
	}
	return group
}

func boolPointer(value bool) *bool { return &value }

func newTestHandler(t *testing.T, service Service, allowed bool) *Handler {
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

func TestHandlerRejectsUnauthorized(t *testing.T) {
	handler := newTestHandler(t, &fakeService{}, false)
	if recorder := do(handler, http.MethodGet, Path, ""); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", recorder.Code)
	}
}

func TestHandlerListReturnsEmptyArrayNotNull(t *testing.T) {
	handler := newTestHandler(t, &fakeService{}, true)
	recorder := do(handler, http.MethodGet, Path, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	groups, ok := payload["groups"].([]any)
	if !ok || len(groups) != 0 {
		t.Fatalf("groups = %v, want 空数组", payload["groups"])
	}
	if payload["version"].(float64) != 1 {
		t.Fatalf("version = %v, want 1", payload["version"])
	}
}

func TestHandlerCreateRequiresRules(t *testing.T) {
	handler := newTestHandler(t, &fakeService{}, true)
	recorder := do(handler, http.MethodPost, Path, `{"name":"组"}`)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestHandlerCreatePassesFields(t *testing.T) {
	service := &fakeService{groups: []mappingcore.Group{storedGroup(t)}}
	handler := newTestHandler(t, service, true)
	body := `{
		"id":"uem_0123456789ab",
		"name":" 组 ",
		"description":"说明",
		"provider":"codex",
		"enabled":false,
		"rules":[{"kind":"rate_limited","matchers":[{"source":"body","operator":"contains","value":"rate"}]}]
	}`
	recorder := do(handler, http.MethodPost, Path, body)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if service.lastCreate.ID != "uem_0123456789ab" || service.lastCreate.Name != " 组 " {
		t.Fatalf("create input = %+v", service.lastCreate)
	}
	if service.lastCreate.Enabled == nil || *service.lastCreate.Enabled {
		t.Fatalf("enabled 未按 false 传递: %v", service.lastCreate.Enabled)
	}
	if len(service.lastCreate.Rules) != 1 {
		t.Fatalf("rules = %d, want 1", len(service.lastCreate.Rules))
	}
	payload := map[string]any{}
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("解析响应失败: %v", err)
	}
	group, ok := payload["group"].(map[string]any)
	if !ok || group["id"] != "uem_0123456789ab" {
		t.Fatalf("响应 group = %v", payload["group"])
	}
	if _, ok := payload["groups"].([]any); !ok {
		t.Fatalf("响应缺少 groups: %v", payload)
	}
}

func TestHandlerRejectsUnknownSubpath(t *testing.T) {
	handler := newTestHandler(t, &fakeService{}, true)
	recorder := do(handler, http.MethodGet, Path+"/one/two", "")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", recorder.Code)
	}
}

func TestHandlerMapsServiceErrors(t *testing.T) {
	cases := []struct {
		err  error
		want int
	}{
		{mappingcore.ErrGroupNotFound, http.StatusNotFound},
		{mappingcore.ErrGroupConflict, http.StatusConflict},
		{mappingcore.ErrGroupExists, http.StatusConflict},
		{mappingcore.ErrGroupLimit, http.StatusBadRequest},
		{mappingcore.ErrUnknownProvider, http.StatusBadRequest},
		{mappingcore.ErrInvalidGroup, http.StatusBadRequest},
	}
	for _, testCase := range cases {
		handler := newTestHandler(t, &fakeService{err: testCase.err}, true)
		recorder := do(handler, http.MethodDelete, Path+"/uem_0123456789ab", "")
		if recorder.Code != testCase.want {
			t.Fatalf("%v → status %d, want %d", testCase.err, recorder.Code, testCase.want)
		}
	}
}

func TestHandlerDeletePassesVersion(t *testing.T) {
	service := &fakeService{groups: []mappingcore.Group{storedGroup(t)}}
	handler := newTestHandler(t, service, true)
	recorder := do(handler, http.MethodDelete, Path+"/uem_0123456789ab?version=3", "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if service.lastID != "uem_0123456789ab" || service.lastVersion == nil || *service.lastVersion != 3 {
		t.Fatalf("delete 参数 = id=%q version=%v", service.lastID, service.lastVersion)
	}
}

func TestHandlerRejectsInvalidVersionQuery(t *testing.T) {
	handler := newTestHandler(t, &fakeService{}, true)
	recorder := do(handler, http.MethodDelete, Path+"/uem_0123456789ab?version=abc", "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", recorder.Code)
	}
}

func TestHandlerUpdatePassesVersion(t *testing.T) {
	service := &fakeService{groups: []mappingcore.Group{storedGroup(t)}}
	handler := newTestHandler(t, service, true)
	recorder := do(handler, http.MethodPut, Path+"/uem_0123456789ab", `{"name":"新","version":7}`)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	if service.lastID != "uem_0123456789ab" || service.lastUpdate.Version == nil || *service.lastUpdate.Version != 7 {
		t.Fatalf("update 参数 = id=%q version=%v", service.lastID, service.lastUpdate.Version)
	}
	if service.lastUpdate.Name == nil || *service.lastUpdate.Name != "新" {
		t.Fatalf("update name = %v", service.lastUpdate.Name)
	}
}

func TestHandlerRejectsUnsupportedMethod(t *testing.T) {
	handler := newTestHandler(t, &fakeService{}, true)
	if recorder := do(handler, http.MethodPatch, Path, ""); recorder.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", recorder.Code)
	}
}
